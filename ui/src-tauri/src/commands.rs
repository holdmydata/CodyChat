//! Tauri commands the React frontend can call. Kept separate from the
//! window-chrome logic in lib.rs, which is pure Rust with no IPC involved.

use std::fs;
use std::process::Command;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    tauri_version: String,
}

#[tauri::command]
pub fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
    }
}

// Real filesystem facts, fetched once per session and folded into the
// system prompt (see useChat.ts) so the model has actual paths to work
// with instead of guessing (it defaulted to `/home/...` on a live test —
// see docs/Architecture/Frontend.md).
#[derive(Serialize)]
pub struct EnvironmentInfo {
    os: String,
    home_dir: String,
    documents_dir: String,
    desktop_dir: String,
    downloads_dir: String,
    project_root: String,
}

#[tauri::command]
pub fn get_environment_info() -> EnvironmentInfo {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let home_path = std::path::PathBuf::from(&home);

    // Fixes a real, recurring gap (docs/Kanban.md): this env context used
    // to only cover generic OS folders, so the model had no way to know the
    // project itself lives on D:, not C: — it had to be corrected mid-
    // conversation. CARGO_MANIFEST_DIR is baked in at *compile* time as
    // this crate's own directory (.../ui/src-tauri); two levels up is the
    // actual repo root (ui/src-tauri -> ui -> repo root). Correct for how
    // this app is actually used today (built and run on the same dev
    // machine) — if the repo is ever moved after a build, this goes stale
    // until the next rebuild, same class of staleness as any other
    // compile-time path baked into a binary.
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    EnvironmentInfo {
        os: std::env::consts::OS.to_string(),
        documents_dir: home_path.join("Documents").display().to_string(),
        desktop_dir: home_path.join("Desktop").display().to_string(),
        downloads_dir: home_path.join("Downloads").display().to_string(),
        home_dir: home,
        project_root,
    }
}

// RAM/VRAM forecaster (SettingsPanel.tsx): lets the model picker warn
// before you pick a model too big for this machine, instead of finding out
// after a slow/failed load. RAM comes straight from the OS
// (GlobalMemoryStatusEx — always available on Windows, no subprocess).
// VRAM has no equivalent official Win32 API for *dedicated GPU* memory
// (Win32_VideoController.AdapterRAM via WMI is a known-broken 32-bit field
// that misreports for any card >4GB on modern Windows), so this shells out
// to `nvidia-smi` instead, which reports real numbers directly from the
// driver. Only covers NVIDIA — AMD/Intel GPUs report `gpu_name: None` and
// the frontend explains the gap rather than pretending to know.
#[derive(Serialize)]
pub struct SystemResources {
    total_ram_bytes: u64,
    available_ram_bytes: u64,
    gpu_name: Option<String>,
    total_vram_bytes: Option<u64>,
    available_vram_bytes: Option<u64>,
}

#[cfg(windows)]
fn ram_stats() -> Result<(u64, u64), String> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    unsafe { GlobalMemoryStatusEx(&mut status) }.map_err(|e| e.to_string())?;
    Ok((status.ullTotalPhys, status.ullAvailPhys))
}

#[cfg(not(windows))]
fn ram_stats() -> Result<(u64, u64), String> {
    Err("RAM detection is only implemented on Windows".to_string())
}

// nvidia-smi's CSV output for a single GPU, e.g. "NVIDIA GeForce RTX 4070,
// 12282, 9840" (name, total MiB, free MiB) — takes the first line/GPU only,
// same simplification as this app's other single-adapter assumptions.
fn nvidia_vram() -> Option<(String, u64, u64)> {
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first_line = text.lines().next()?;
    let parts: Vec<&str> = first_line.split(',').map(|s| s.trim()).collect();
    if parts.len() < 3 {
        return None;
    }
    let name = parts[0].to_string();
    let total_mib: u64 = parts[1].parse().ok()?;
    let free_mib: u64 = parts[2].parse().ok()?;
    const MIB: u64 = 1024 * 1024;
    Some((name, total_mib * MIB, free_mib * MIB))
}

#[tauri::command]
pub fn get_system_resources() -> Result<SystemResources, String> {
    let (total_ram_bytes, available_ram_bytes) = ram_stats()?;
    let (gpu_name, total_vram_bytes, available_vram_bytes) = match nvidia_vram() {
        Some((name, total, free)) => (Some(name), Some(total), Some(free)),
        None => (None, None, None),
    };
    Ok(SystemResources {
        total_ram_bytes,
        available_ram_bytes,
        gpu_name,
        total_vram_bytes,
        available_vram_bytes,
    })
}

// Theme pack import (lib/themes.ts::readThemePackFile): reads a pack file
// from disk through the Rust shell rather than a webview file input, same
// posture as the read_file/write_file skills — the frontend never touches
// the disk directly. No validation here; sanitizeThemePack on the JS side
// is what decides whether the contents are usable before anything is
// injected as CSS.
#[tauri::command]
pub fn read_theme_pack(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

const ROUTER_CONFIG_FILENAME: &str = "router_config.json";

// Seeded to disk on first run (see lib.rs's .setup()) so there's always
// something valid to route against — small/medium/large map straight onto
// the deployments the user described wanting (phi-4-mini-reasoning for
// cheap/classification work, gpt-5.6-luna for planning/agent work, a
// Claude deployment as the complexity-overflow tier). classifierDeployment
// defaults to the small tier's own deployment — no separate deployment is
// needed just to classify.
pub const DEFAULT_ROUTER_CONFIG: &str = r#"{
  "classifierDeployment": "phi-4-mini-reasoning",
  "complexityThreshold": 90,
  "roles": {
    "small": "phi-4-mini-reasoning",
    "medium": "gpt-5.6-luna",
    "large": "claude-sonnet-4.5"
  },
  "taskRoutes": {
    "classification": "small",
    "summary": "small",
    "email": "small",
    "metadata": "small",
    "api": "small",
    "planning": "medium",
    "agent": "medium"
  }
}
"#;

// Deliberately takes no path argument, unlike read_theme_pack above — this
// is an admin-managed file at one fixed, predictable location (the app's
// own data dir), not something a user imports/picks per call. Editing the
// mapping is meant to be "an admin edits this file," not exposed anywhere
// in the end-user Settings UI.
#[tauri::command]
pub fn get_router_config(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join(ROUTER_CONFIG_FILENAME);
    fs::read_to_string(&path).map_err(|e| format!("{}: {}", path.display(), e))
}

// Surfaced read-only in Settings so whoever administers the mapping can
// find the file without digging through Tauri's own docs for where
// app_data_dir resolves to on a given machine.
#[tauri::command]
pub fn get_router_config_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(ROUTER_CONFIG_FILENAME).display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_theme_pack_returns_file_contents() {
        let path = std::env::temp_dir().join(format!("theme_pack_test_{}.json", std::process::id()));
        let contents = "{\"id\":\"test\",\"name\":\"Test\",\"vars\":{\"accent\":\"#000000\"}}";
        fs::write(&path, contents).unwrap();

        let result = read_theme_pack(path.display().to_string());

        fs::remove_file(&path).ok();
        assert_eq!(result.unwrap(), contents);
    }

    #[test]
    fn read_theme_pack_errors_on_missing_file() {
        let missing = std::env::temp_dir().join("theme_pack_test_does_not_exist.json");
        assert!(read_theme_pack(missing.display().to_string()).is_err());
    }

    #[test]
    fn project_root_resolves_two_levels_above_src_tauri() {
        let info = get_environment_info();
        // CARGO_MANIFEST_DIR two levels up should land on the repo root
        // that actually contains this crate, whatever machine/path it was
        // built on — checked structurally rather than against a hardcoded
        // "D:\...\CodyChat" string so the test doesn't itself go stale on
        // the next rename.
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let expected = manifest_dir.parent().and_then(|p| p.parent()).unwrap();
        assert_eq!(info.project_root, expected.display().to_string());
        // And it should actually contain this repo's known top-level dirs.
        let root = std::path::Path::new(&info.project_root);
        assert!(root.join("ui").is_dir());
        assert!(root.join("docs").is_dir());
    }
}
