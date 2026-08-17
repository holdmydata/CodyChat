//! File-system skills the model can request via tool-calling. Ported from
//! harness/skills.py's read_file, plus new write_file and list_directory,
//! now that tool-calling is wired into the live chat UI rather than only a
//! standalone Python script (see docs/Architecture/Backend.md).
//!
//! Deliberately no path sandboxing — approval (gated in the frontend
//! before invoke() is ever called; see ToolApprovalPrompt.tsx) is the
//! safety boundary here, matching how this project is meant to work.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use serde_json::json;

const MAX_READ_BYTES: usize = 200_000;
const MAX_DIR_ENTRIES: usize = 500;

// `source_type` is the single source of truth for how this file's content
// was read — the frontend's optional "remember" indexing step (see
// lib/skills.ts) tags the memory entry with this rather than re-deriving
// the file type itself from the extension a second time.
#[derive(Serialize)]
pub struct ReadFileResult {
    content: String,
    source_type: String,
}

#[tauri::command]
pub fn read_file(path: String) -> Result<ReadFileResult, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }

    let is_pdf = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));

    if is_pdf {
        // pdf_extract does real layout-aware text extraction (not just a
        // raw byte dump — PDFs aren't UTF-8 text) — confirmed against the
        // crate's real 0.7.12 source (extract_text's signature/error type)
        // before writing this, same discipline as everything else built
        // this session.
        let text = pdf_extract::extract_text(p).map_err(|e| format!("failed to extract PDF text: {e}"))?;
        let bytes = text.into_bytes();
        let truncated = &bytes[..bytes.len().min(MAX_READ_BYTES)];
        return Ok(ReadFileResult {
            content: String::from_utf8_lossy(truncated).into_owned(),
            source_type: "pdf".to_string(),
        });
    }

    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    let truncated = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    Ok(ReadFileResult {
        content: String::from_utf8_lossy(truncated).into_owned(),
        source_type: "text_file".to_string(),
    })
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

// edit_file: patch-style edit (find exact old_string, replace with
// new_string) rather than write_file's full-overwrite semantics — see
// docs/Kanban.md. write_file replacing an entire file's content is what
// caused a real write collision (a concurrent unrelated edit to App.css was
// silently dropped by an overwrite). Matching Claude Code's own Edit tool
// shape deliberately: old_string must match the file's *current* on-disk
// content exactly and uniquely (unless replace_all), so a stale read from
// earlier in the conversation fails loudly instead of silently clobbering
// whatever changed underneath it.

// rename_all = "snake_case": Tauri's command macro defaults to matching
// incoming JS argument keys as camelCase against the Rust parameter names
// (so `old_string` here would only match an `oldString` key sent from JS).
// Every argument name here is snake_case to match the JSON tool schema sent
// to Ollama (see get_tool_definitions below) and the model's own tool-call
// arguments, which are forwarded to invoke() unmodified — this opts the
// command out of the camelCase default so those keys actually match. Real
// bug, caught live: the model's edit_file call failed with "missing
// required key oldString" until this was added.
#[tauri::command(rename_all = "snake_case")]
pub fn edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if old_string.is_empty() {
        return Err("old_string must not be empty".to_string());
    }
    let content = fs::read_to_string(p).map_err(|e| e.to_string())?;
    let count = content.matches(old_string.as_str()).count();
    if count == 0 {
        return Err(
            "old_string not found — it must match the file's current content exactly \
             (whitespace included). Re-read the file if it may have changed."
                .to_string(),
        );
    }
    let replace_all = replace_all.unwrap_or(false);
    if count > 1 && !replace_all {
        return Err(format!(
            "old_string matches {count} locations — add more surrounding context to make it \
             unique, or pass replace_all: true to replace all of them"
        ));
    }
    let new_content = if replace_all {
        content.replace(old_string.as_str(), new_string.as_str())
    } else {
        content.replacen(old_string.as_str(), new_string.as_str(), 1)
    };
    fs::write(p, &new_content).map_err(|e| e.to_string())?;
    let n = if replace_all { count } else { 1 };
    Ok(format!("Replaced {n} occurrence(s) in {path}"))
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

// search_files: a grep-like tool so the model can locate a pattern across a
// codebase without paying read_file's per-file 200KB cap / context-budget
// cost on every file it needs to check (see docs/Kanban.md backlog item).
// Same no-sandboxing posture as the rest of this file — approval in the
// frontend is the safety boundary, not a path allowlist here.

const SEARCH_DEFAULT_MAX_RESULTS: usize = 200;
const SEARCH_HARD_MAX_RESULTS: usize = 1000;
const SEARCH_MAX_FILES_SCANNED: usize = 20_000;
const SEARCH_MAX_FILE_BYTES: usize = 2_000_000;

// Directories that are almost never useful to grep and can make a search
// pathologically slow (build output, VCS internals, dependency trees).
const SEARCH_SKIP_DIRS: &[&str] = &[
    "node_modules", "target", ".git", "dist", "build", ".venv", "venv",
    "__pycache__", ".loopx", ".codex", ".next", "coverage", ".cache",
];

#[derive(Serialize)]
pub struct SearchMatch {
    path: String,
    line: usize,
    text: String,
}

fn is_probably_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

// Deliberately not a full glob engine (no crate pulled in for it) — just the
// two shapes that cover almost every real request: an extension filter
// ("*.rs") or a plain filename substring.
fn file_matches_glob(file_name: &str, glob: &str) -> bool {
    if let Some(ext) = glob.strip_prefix("*.") {
        return file_name
            .rsplit('.')
            .next()
            .map(|e| e.eq_ignore_ascii_case(ext))
            .unwrap_or(false);
    }
    file_name.to_lowercase().contains(&glob.to_lowercase())
}

fn search_dir(
    dir: &Path,
    re: &Regex,
    file_glob: Option<&str>,
    matches: &mut Vec<SearchMatch>,
    files_scanned: &mut usize,
    max_results: usize,
) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if matches.len() >= max_results || *files_scanned >= SEARCH_MAX_FILES_SCANNED {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if is_dir {
            if SEARCH_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            search_dir(&path, re, file_glob, matches, files_scanned, max_results);
            continue;
        }

        *files_scanned += 1;
        if let Some(glob) = file_glob {
            if !file_matches_glob(&name, glob) {
                continue;
            }
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        if bytes.len() > SEARCH_MAX_FILE_BYTES || is_probably_binary(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                matches.push(SearchMatch {
                    path: path.display().to_string(),
                    line: i + 1,
                    text: line.chars().take(300).collect(),
                });
                if matches.len() >= max_results {
                    return;
                }
            }
        }
    }
}

// Same rename_all fix as edit_file above — file_glob/case_sensitive/
// max_results are all multi-word and would otherwise only match camelCase
// keys from JS, not the snake_case ones in get_tool_definitions' schema.
#[tauri::command(rename_all = "snake_case")]
pub fn search_files(
    path: String,
    pattern: String,
    file_glob: Option<String>,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let cased_pattern = if case_sensitive.unwrap_or(false) {
        pattern
    } else {
        format!("(?i){pattern}")
    };
    let re = Regex::new(&cased_pattern).map_err(|e| format!("invalid pattern: {e}"))?;
    let limit = max_results
        .unwrap_or(SEARCH_DEFAULT_MAX_RESULTS)
        .min(SEARCH_HARD_MAX_RESULTS);

    let mut matches = Vec::new();
    let mut files_scanned = 0usize;
    search_dir(root, &re, file_glob.as_deref(), &mut matches, &mut files_scanned, limit);
    Ok(matches)
}

// execute_command: shell access, the biggest capability gap vs. Claude Code
// per docs/Kanban.md. Highest-risk skill here by a wide margin (arbitrary
// command execution vs. fixed file operations), but it goes through the
// exact same per-call approval gate every other skill does — nothing here
// grants it a bypass. See ToolApprovalPrompt.tsx / lib/toolConfig.ts for the
// risk-tier badge shown to the user before they approve one.

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_MAX_OUTPUT_BYTES: usize = 100_000;

#[derive(Serialize)]
pub struct CommandOutput {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

fn truncate_output(bytes: Vec<u8>) -> String {
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.len() > COMMAND_MAX_OUTPUT_BYTES {
        format!(
            "{}\n…(truncated, {} bytes total)",
            &text[..COMMAND_MAX_OUTPUT_BYTES],
            text.len()
        )
    } else {
        text
    }
}

// Same rename_all fix as edit_file above — working_dir is multi-word.
#[tauri::command(rename_all = "snake_case")]
pub fn execute_command(command: String, working_dir: Option<String>) -> Result<CommandOutput, String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    if let Some(dir) = &working_dir {
        cmd.current_dir(dir);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdout_pipe = child.stdout.take().ok_or("failed to capture stdout")?;
    let mut stderr_pipe = child.stderr.take().ok_or("failed to capture stderr")?;

    // Drain both pipes on background threads concurrently with the wait
    // loop below — reading only after the process exits risks a classic
    // deadlock if the child fills a pipe buffer before it ever finishes.
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let mut timed_out = false;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None => {
                if start.elapsed() > COMMAND_TIMEOUT {
                    let _ = child.kill();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stdout = truncate_output(stdout_handle.join().unwrap_or_default());
    let mut stderr = truncate_output(stderr_handle.join().unwrap_or_default());
    if timed_out {
        stderr = format!(
            "{stderr}\n(command timed out after {}s and was killed)",
            COMMAND_TIMEOUT.as_secs()
        );
    }

    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code: if timed_out { None } else { status.code() },
        timed_out,
    })
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
                "description": "Read the contents of a text file from disk. PDF files are automatically text-extracted (not read as raw bytes).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute path to the file to read"},
                        "remember": {"type": "boolean", "description": "Set true to also save this file's content into long-term memory for later recall via search_memory (e.g. when the user asks you to remember/save a document). Defaults to false — reading a file does not save it unless explicitly asked."}
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write text content to a file on disk, creating it if it doesn't exist or fully overwriting it if it does. Prefer edit_file instead when changing part of an existing file — a full overwrite discards any content you didn't include, including changes made by something else since you last read the file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute path to the file to write"},
                        "content": {"type": "string", "description": "Full text content to write"},
                        "remember": {"type": "boolean", "description": "Set true to also save this file's content into long-term memory for later recall via search_memory. Defaults to false — writing a file does not save it unless explicitly asked."},
                        "memory_type": {"type": "string", "enum": ["build_output", "learned_reference"], "description": "Only used when remember is true. 'build_output': a real artifact you created (code, a document, a finished task output). 'learned_reference': a distilled summary you wrote specifically so a future turn can search_memory instead of re-reading a large source (e.g. after reading a big doc once, write a concise reference covering what it actually needs). Defaults to 'build_output' if omitted."}
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Make a targeted edit to an existing text file by replacing an exact snippet (old_string) with new text (new_string), instead of rewriting the whole file. old_string must match the file's current content exactly, including whitespace, and must be unique in the file unless replace_all is set — include enough surrounding context (a few lines) to make it unique. Prefer this over write_file whenever you're changing part of a file rather than creating one from scratch.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute path to the file to edit"},
                        "old_string": {"type": "string", "description": "Exact text to find, with enough context to be unique in the file"},
                        "new_string": {"type": "string", "description": "Text to replace old_string with"},
                        "replace_all": {"type": "boolean", "description": "Replace every occurrence of old_string instead of requiring exactly one match. Defaults to false."}
                    },
                    "required": ["path", "old_string", "new_string"]
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
        },
        {
            "type": "function",
            "function": {
                "name": "search_files",
                "description": "Search file contents under a directory for a regex pattern (grep-like), recursively, without reading whole files into context. Returns matching file paths, line numbers, and line text. Prefer this over read_file when looking for something across a codebase rather than in one already-known file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute path to the directory to search under (recursive)"},
                        "pattern": {"type": "string", "description": "Regular expression to match against each line"},
                        "file_glob": {"type": "string", "description": "Optional filename filter, e.g. '*.rs' or a substring like 'config'"},
                        "case_sensitive": {"type": "boolean", "description": "Defaults to false (case-insensitive)"},
                        "max_results": {"type": "integer", "description": "Cap on returned matches (default 200, hard max 1000)"}
                    },
                    "required": ["path", "pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "execute_command",
                "description": "Execute a shell command and capture its stdout, stderr, and exit code. Runs via cmd.exe on Windows. 30-second timeout; output truncated past 100KB. This is the highest-risk tool available — always requires explicit user approval before running, same as every other tool here.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "The shell command to run"},
                        "working_dir": {"type": "string", "description": "Optional absolute path to run the command from"}
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_memory",
                "description": "Search past conversations and remembered documents for relevant context using semantic similarity. Use this when the user references something discussed before, asks you to recall prior context or a saved document, or when earlier history would help answer the current question. Returns the most relevant matches, most similar first.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to search for, in natural language"},
                        "top_k": {"type": "integer", "description": "Maximum number of results to return (default 5)"},
                        "source_type": {"type": "string", "description": "Optional: narrow the search to one source type, e.g. 'pdf' to search only remembered PDFs, or 'chat_message' to search only past conversations. Omit to search everything."}
                    },
                    "required": ["query"]
                }
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, contents: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("edit_file_test_{}_{name}", std::process::id()));
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn edit_file_replaces_unique_match() {
        let path = temp_file("unique.txt", "hello world\nsecond line\n");
        let result = edit_file(
            path.display().to_string(),
            "hello world".to_string(),
            "goodbye world".to_string(),
            None,
        );
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();
        assert!(result.is_ok());
        assert_eq!(contents, "goodbye world\nsecond line\n");
    }

    #[test]
    fn edit_file_errors_when_old_string_not_found() {
        let path = temp_file("missing.txt", "hello world\n");
        let result = edit_file(
            path.display().to_string(),
            "not present".to_string(),
            "x".to_string(),
            None,
        );
        fs::remove_file(&path).ok();
        assert!(result.is_err());
    }

    #[test]
    fn edit_file_errors_on_ambiguous_match_without_replace_all() {
        let path = temp_file("dup.txt", "foo\nfoo\n");
        let result = edit_file(
            path.display().to_string(),
            "foo".to_string(),
            "bar".to_string(),
            None,
        );
        fs::remove_file(&path).ok();
        assert!(result.is_err());
    }

    #[test]
    fn edit_file_replace_all_replaces_every_match() {
        let path = temp_file("dup_all.txt", "foo\nfoo\n");
        let result = edit_file(
            path.display().to_string(),
            "foo".to_string(),
            "bar".to_string(),
            Some(true),
        );
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_file(&path).ok();
        assert!(result.is_ok());
        assert_eq!(contents, "bar\nbar\n");
    }
}
