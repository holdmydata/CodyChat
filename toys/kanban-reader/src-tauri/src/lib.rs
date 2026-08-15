pub mod kanban;

use kanban::Board;

// Read-only by design (see docs/MEMORY.md) — this is a disposable practice
// app, not the real product shell, and must never write back to the board.
#[tauri::command]
fn read_kanban_board() -> Result<Board, String> {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let path = manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .join("docs")
        .join("Kanban.md");
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;
    Ok(kanban::parse(&contents))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_kanban_board])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
