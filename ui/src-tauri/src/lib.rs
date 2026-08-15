mod commands;
mod skills;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

// Tracks always-on-top state ourselves rather than querying the window,
// since WebviewWindow doesn't expose a getter for it.
struct AlwaysOnTop(AtomicBool);

// window-vibrancy's apply_mica() sets DWMWA_SYSTEMBACKDROP_TYPE, which is
// correct but insufficient on its own for a frameless (decorations:false)
// window: without a native titlebar, DWM has no "glass sheet" extended into
// the client area to paint the backdrop material into, so it silently falls
// back to a flat fill instead of Mica. Extending the frame with -1 margins
// (a full sheet of glass covering the whole window) is what actually makes
// it paint. Confirmed by reading window-vibrancy 0.6.0's source directly —
// it never calls this API.
#[cfg(target_os = "windows")]
fn extend_frame_into_client_area(window: &WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
    use windows::Win32::UI::Controls::MARGINS;

    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(win32_handle) = handle.as_raw() else { return };
    let hwnd = HWND(win32_handle.hwnd.get() as *mut _);
    let margins = MARGINS {
        cxLeftWidth: -1,
        cxRightWidth: -1,
        cyTopHeight: -1,
        cyBottomHeight: -1,
    };
    unsafe {
        let _ = DwmExtendFrameIntoClientArea(hwnd, &margins);
    }
}

const CORNER_MARGIN: i32 = 24;
const SLIDE_STEPS: u64 = 16;
const SLIDE_DURATION_MS: u64 = 220;

// Tauri has no native window-position animation API, so this steps
// set_position() on a background thread with an eased interpolation. Runs
// off the main thread so it doesn't block the event loop; WebviewWindow is
// a cheap Send+Sync handle clone, safe to move into the thread.
fn animate_slide(
    window: WebviewWindow,
    from: tauri::PhysicalPosition<i32>,
    to: tauri::PhysicalPosition<i32>,
    then_hide: bool,
) {
    std::thread::spawn(move || {
        let step_delay = std::time::Duration::from_millis(SLIDE_DURATION_MS / SLIDE_STEPS);
        for i in 0..=SLIDE_STEPS {
            let t = i as f64 / SLIDE_STEPS as f64;
            let eased = 1.0 - (1.0 - t).powi(3); // ease-out cubic
            let x = from.x as f64 + (to.x - from.x) as f64 * eased;
            let y = from.y as f64 + (to.y - from.y) as f64 * eased;
            let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
            std::thread::sleep(step_delay);
        }
        let _ = window.set_position(to);
        if then_hide {
            let _ = window.hide();
        }
    });
}

fn resting_position(window: &WebviewWindow) -> Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalPosition<i32>)> {
    let monitor = window.primary_monitor().ok()??;
    // work_area(), not size()/position() — those cover the full monitor
    // including the area behind the taskbar, which pushed the window's
    // bottom edge under it. work_area excludes the taskbar.
    let work_area = monitor.work_area();
    let window_size = window.outer_size().ok()?;

    let x = work_area.position.x + work_area.size.width as i32 - window_size.width as i32 - CORNER_MARGIN;
    let y = work_area.position.y + work_area.size.height as i32 - window_size.height as i32 - CORNER_MARGIN;
    let resting = tauri::PhysicalPosition::new(x.max(0), y.max(0));
    // Off-screen below the work area's bottom edge — the slide-in start /
    // slide-out end position.
    let offscreen = tauri::PhysicalPosition::new(resting.x, work_area.position.y + work_area.size.height as i32);
    Some((resting, offscreen))
}

fn pop_to_corner(window: &WebviewWindow) {
    let Some((resting, offscreen)) = resting_position(window) else {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    };
    let _ = window.set_position(offscreen);
    let _ = window.show();
    let _ = window.set_focus();
    animate_slide(window.clone(), offscreen, resting, false);
}

fn hide_with_slide(window: &WebviewWindow) {
    let Some((_, offscreen)) = resting_position(window) else {
        let _ = window.hide();
        return;
    };
    let current = window.outer_position().unwrap_or(offscreen);
    animate_slide(window.clone(), current, offscreen, true);
}

fn toggle_visibility(window: &WebviewWindow) {
    let visible = window.is_visible().unwrap_or(true);
    if visible {
        hide_with_slide(window);
    } else {
        pop_to_corner(window);
    }
}

fn toggle_always_on_top(app: &tauri::AppHandle, window: &WebviewWindow) {
    let state = app.state::<AlwaysOnTop>();
    let next = !state.0.load(Ordering::SeqCst);
    state.0.store(next, Ordering::SeqCst);
    let _ = window.set_always_on_top(next);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(AlwaysOnTop(AtomicBool::new(false)))
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window must exist");

            // Real glass transparency (Windows 11 Mica, falling back to
            // Acrylic on older/unsupported configs) — decorations:false
            // alone only gives a frameless window, not actual backdrop
            // blur. Requires "transparent": true on the window in
            // tauri.conf.json too, or the webview surface paints opaque
            // regardless of what's applied to the native frame behind it.
            #[cfg(target_os = "windows")]
            extend_frame_into_client_area(&window);

            if window_vibrancy::apply_mica(&window, None).is_err() {
                let _ = window_vibrancy::apply_acrylic(&window, None);
            }

            // Half-screen default size instead of the fixed 460x640 in
            // tauri.conf.json (kept there as a min-size safety rail for
            // monitors this can't query). Based on work_area, not the full
            // monitor size, so a half-height window doesn't itself start
            // out tall enough to run under the taskbar once positioned.
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let work_area = monitor.work_area();
                let half = tauri::PhysicalSize::new(work_area.size.width / 2, work_area.size.height / 2);
                let _ = window.set_size(half);
            }

            let show_hide = MenuItem::with_id(app, "show_hide", "Show / Hide", true, None::<&str>)?;
            let pop_corner = MenuItem::with_id(app, "pop_corner", "Pop to Corner", true, None::<&str>)?;
            let always_on_top =
                MenuItem::with_id(app, "always_on_top", "Toggle Always on Top", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&show_hide, &pop_corner, &always_on_top, &separator, &quit],
            )?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let Some(window) = app.get_webview_window("main") else {
                        return;
                    };
                    match event.id.as_ref() {
                        "show_hide" => toggle_visibility(&window),
                        "pop_corner" => pop_to_corner(&window),
                        "always_on_top" => toggle_always_on_top(app, &window),
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            toggle_visibility(&window);
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::get_loopx_digest,
            commands::get_environment_info,
            skills::read_file,
            skills::write_file,
            skills::list_directory,
            skills::get_tool_definitions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
