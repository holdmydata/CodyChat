//! File-system skills the model can request via tool-calling. Ported from
//! harness/skills.py's read_file, plus new write_file and list_directory,
//! now that tool-calling is wired into the live chat UI rather than only a
//! standalone Python script (see docs/Architecture/Backend.md).
//!
//! Deliberately no path sandboxing — approval (gated in the frontend
//! before invoke() is ever called; see ToolApprovalPrompt.tsx) is the
//! safety boundary here, matching how this project is meant to work.

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::json;

const MAX_READ_BYTES: usize = 200_000;
const MAX_DIR_ENTRIES: usize = 500;

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    let truncated = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    Ok(String::from_utf8_lossy(truncated).into_owned())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!(
                "parent directory does not exist: {}",
                parent.display()
            ));
        }
    }
    fs::write(p, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    name: String,
    is_dir: bool,
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(p).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
        });
        if entries.len() >= MAX_DIR_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Single source of truth for the tool JSON schemas sent to Ollama's
/// `tools` field — the frontend fetches this via invoke() rather than
/// hardcoding a duplicate copy in TypeScript.
#[tauri::command]
pub fn get_tool_definitions() -> serde_json::Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a text file from disk.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute path to the file to read"}
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write text content to a file on disk, creating it if it doesn't exist or overwriting it if it does.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute path to the file to write"},
                        "content": {"type": "string", "description": "Full text content to write"}
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "List the files and subdirectories in a directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute path to the directory to list"}
                    },
                    "required": ["path"]
                }
            }
        }
    ])
}
