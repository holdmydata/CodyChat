mod commands;
mod mcp;
mod skills;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewWindow, WindowEvent,
};

// Tracks always-on-top state ourselves rather than querying the window,
// since WebviewWindow doesn't expose a getter for it.
struct AlwaysOnTop(AtomicBool);

// True when the window is currently the larger "full experience" size,
// false when it's the small tray-popup widget. Drives two things: whether
// losing focus should auto-hide the window (Widget: yes, matching how a
// tray popup is expected to behave — dismiss on click-away, like Windows'
// own Calendar flyout; Full: no, it should act like a normal app window
// that stays open while you use other apps), and what size "reopen from
// tray" resets to (always Widget, regardless of whichever mode it was in
// before it was last hidden — the tray icon's job is specifically to pop
// up the compact widget, not resume wherever you left off).
struct FullMode(AtomicBool);

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

// New attempt (2026-08-15) at the still-open Mica investigation (see
// docs/Kanban.md). DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE, ...)
// (inside window_vibrancy::apply_mica, called right after this) only
// requests the backdrop — on a window that's already created/mapped, DWM
// doesn't always repaint its non-client frame just because the attribute
// changed. SWP_FRAMECHANGED is the documented signal for "the window's
// frame characteristics changed, recompute it" without actually moving,
// resizing, reordering, or stealing focus from the window (all the other
// SWP_NO* flags exist specifically to make this a no-op geometry-wise).
// Ruled out first: the previously-logged "next lead" (WebView2's own
// compositor background) turned out to already be handled automatically —
// wry sets ICoreWebView2Controller2::SetDefaultBackgroundColor to fully
// transparent (0,0,0,0) whenever tauri.conf.json has "transparent": true,
// which this app's config already does (confirmed by reading wry 0.55.1's
// own source, not assumed).
#[cfg(target_os = "windows")]
fn force_dwm_frame_recalc(window: &WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };

    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(win32_handle) = handle.as_raw() else { return };
    let hwnd = HWND(win32_handle.hwnd.get() as *mut _);
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

const CORNER_MARGIN: i32 = 24;
const SLIDE_STEPS: u64 = 16;
const SLIDE_DURATION_MS: u64 = 220;
// The compact widget — close to the pre-"half-screen-default" original
// scaffold size, small enough to actually read as a tray popup rather
// than a full window. Full mode still uses half the monitor's work area,
// computed in full_size() below.
const WIDGET_WIDTH: u32 = 420;
const WIDGET_HEIGHT: u32 = 620;

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

// Logical, not physical, pixels — the real bug this fixes: WIDGET_WIDTH/
// HEIGHT as PhysicalSize meant the actual usable webview area shrank by
// the monitor's scale factor (e.g. 420 physical px at 150% DPI scaling is
// only 280 CSS px), which is exactly why the model picker and message
// input were overflowing the window in the first live test. LogicalSize
// is scaled by the platform automatically, so 420x620 here really does
// mean 420x620 CSS pixels of content area regardless of DPI. full_size()
// below stays PhysicalSize on purpose — it's derived from the monitor's
// own physical work area, which already scales proportionally with DPI
// and doesn't have this problem.
fn widget_size() -> tauri::LogicalSize<f64> {
    tauri::LogicalSize::new(WIDGET_WIDTH as f64, WIDGET_HEIGHT as f64)
}

fn full_size(window: &WebviewWindow) -> Option<tauri::PhysicalSize<u32>> {
    let monitor = window.primary_monitor().ok()??;
    let work_area = monitor.work_area();
    Some(tauri::PhysicalSize::new(work_area.size.width / 2, work_area.size.height / 2))
}

fn centered_position(window: &WebviewWindow, size: tauri::PhysicalSize<u32>) -> Option<tauri::PhysicalPosition<i32>> {
    let monitor = window.primary_monitor().ok()??;
    let work_area = monitor.work_area();
    let x = work_area.position.x + (work_area.size.width as i32 - size.width as i32) / 2;
    let y = work_area.position.y + (work_area.size.height as i32 - size.height as i32) / 2;
    Some(tauri::PhysicalPosition::new(x.max(0), y.max(0)))
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

// Shows the window as the compact widget: correct size + corner-anchored
// position, sliding in from off-screen, and resets FullMode to false. This
// is what every "reopen" path converges on (tray left-click, Show/Hide
// menu, Pop to Corner menu) so they all give the same predictable
// starting state instead of resuming whatever size the window happened to
// be at when it was last hidden — the tray icon's job is specifically the
// compact widget.
fn show_as_widget(app: &tauri::AppHandle, window: &WebviewWindow) {
    let _ = window.set_size(widget_size());
    app.state::<FullMode>().0.store(false, Ordering::SeqCst);
    pop_to_corner(window);
    let _ = app.emit("window-shown-as-widget", ());
}

fn toggle_visibility(app: &tauri::AppHandle, window: &WebviewWindow) {
    let visible = window.is_visible().unwrap_or(true);
    if visible {
        hide_with_slide(window);
    } else {
        show_as_widget(app, window);
    }
}

fn toggle_always_on_top(app: &tauri::AppHandle, window: &WebviewWindow) {
    let state = app.state::<AlwaysOnTop>();
    let next = !state.0.load(Ordering::SeqCst);
    state.0.store(next, Ordering::SeqCst);
    let _ = window.set_always_on_top(next);
}

// Invoked by the custom titlebar's close (✕) button — this is a tray-first
// app, not a close-to-exit one, so "closing" the window hides it to the
// tray rather than quitting. The same behavior also applies to any other
// close-request path (Alt+F4, etc.) via the CloseRequested handler
// registered in run() below; this command exists for the in-app button
// specifically, which has no native close event to intercept.
#[tauri::command]
fn close_to_tray(window: WebviewWindow) {
    hide_with_slide(&window);
}

// Invoked by the "expand" control — grows the widget into the larger
// "full experience" window, centered rather than corner-anchored (a
// window sized to half the monitor pinned to the bottom-right corner
// would read as awkwardly off-center for something meant to feel like the
// main app surface, not a popup).
#[tauri::command]
fn expand_window(app: tauri::AppHandle, window: WebviewWindow) {
    let Some(size) = full_size(&window) else { return };
    let _ = window.set_size(size);
    if let Some(pos) = centered_position(&window, size) {
        let _ = window.set_position(pos);
    }
    app.state::<FullMode>().0.store(true, Ordering::SeqCst);
}

// The reverse of expand_window — shrinks back to the widget size,
// corner-anchored like every other widget-mode appearance.
#[tauri::command]
fn collapse_window(app: tauri::AppHandle, window: WebviewWindow) {
    let _ = window.set_size(widget_size());
    app.state::<FullMode>().0.store(false, Ordering::SeqCst);
    if let Some((resting, _)) = resting_position(&window) {
        let _ = window.set_position(resting);
    }
}

// A real Windows toast with Approve/Deny buttons — bypasses
// tauri-plugin-notification entirely for this one, since its action-button
// support is mobile-only (see the Cargo.toml comment). Called from
// useChat.ts's requestApproval when the window isn't focused, so a pending
// tool call while the widget is hidden/backgrounded isn't invisible.
//
// wait_for_action blocks the calling thread until the user interacts with
// the toast (or it's dismissed/closed), so this runs on its own detached
// thread rather than the async command handler — the app only ever has one
// tool call pending approval at a time (useChat.ts processes them
// sequentially), so at most one of these threads is ever alive.
//
// Known, accepted limitation: if the user resolves the approval from the
// in-app UI first, this notification isn't proactively dismissed — the
// wait_for_action handle can't be closed externally once it's moved onto
// this thread, and Windows toasts drop out of the way (into the Action
// Center) on their own after a few seconds regardless, so a
// no-longer-relevant notification lingering briefly is a minor, common
// rough edge rather than a functional problem.
//
// rename_all = "snake_case": tool_name/args_summary are multi-word params —
// without this, Tauri matches JS argument keys as camelCase by default
// (toolName/argsSummary), not the snake_case this codebase uses everywhere
// else. Already a real, confirmed bug once this session (edit_file); not
// repeating it here.
#[tauri::command(rename_all = "snake_case")]
fn notify_pending_approval(app: tauri::AppHandle, tool_name: String, args_summary: String) {
    std::thread::spawn(move || {
        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&format!("Approve {tool_name}?"))
            .body(&args_summary)
            .action("approve", "Approve")
            .action("deny", "Deny");

        let handle = match notification.show() {
            Ok(h) => h,
            Err(e) => {
                log::error!("failed to show approval notification: {e}");
                return;
            }
        };

        handle.wait_for_action(|action| {
            // Anything other than an explicit button click (a plain body
            // click, dismissal, or timeout) all collapse to the same
            // "__closed" identifier in notify-rust's Windows backend, with
            // no way to tell them apart here — so this deliberately only
            // acts on the two real buttons and no-ops otherwise, rather
            // than guessing what a bare click meant.
            if action == "approve" || action == "deny" {
                let _ = app.emit("tool-approval-action", action);
            }
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AlwaysOnTop(AtomicBool::new(false)))
        .manage(FullMode(AtomicBool::new(false)))
        .manage(mcp::McpState::new())
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

            #[cfg(target_os = "windows")]
            force_dwm_frame_recalc(&window);

            // Starts as the compact widget, not the old half-screen
            // default — the widget is the primary surface now; the
            // larger "full experience" size is an explicit expand.
            let _ = window.set_size(widget_size());

            // Tray-first close: the custom titlebar's ✕ (close_to_tray
            // command) and this handler both converge on the same
            // hide-to-tray behavior, but this one also catches close
            // paths the in-app button can't — Alt+F4 and any other
            // native close request. Quit (tray menu) still really exits:
            // app.exit(0) terminates the process directly without ever
            // requesting a window close, so it never reaches this
            // handler. Also auto-hides on focus loss, but only in Widget
            // mode — a tray popup is expected to dismiss when you click
            // away (matching e.g. Windows' own Calendar flyout); Full
            // mode is left alone so it can act like a normal app window
            // that stays open while you use other apps.
            let event_window = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    hide_with_slide(&event_window);
                }
                WindowEvent::Focused(false) => {
                    let app = event_window.app_handle();
                    let is_full = app.state::<FullMode>().0.load(Ordering::SeqCst);
                    if !is_full && event_window.is_visible().unwrap_or(false) {
                        hide_with_slide(&event_window);
                    }
                }
                _ => {}
            });

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
                        "show_hide" => toggle_visibility(app, &window),
                        "pop_corner" => show_as_widget(app, &window),
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
                            toggle_visibility(app, &window);
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
            commands::read_theme_pack,
            skills::read_file,
            skills::write_file,
            skills::edit_file,
            skills::list_directory,
            skills::search_files,
            skills::execute_command,
            skills::get_tool_definitions,
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_call_tool,
            close_to_tray,
            expand_window,
            collapse_window,
            notify_pending_approval
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
