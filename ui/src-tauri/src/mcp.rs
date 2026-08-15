//! MCP (Model Context Protocol) client — connects to external MCP servers
//! over stdio and exposes their tools alongside the built-in skills (see
//! docs/Kanban.md: "MCP connector support"). Hand-rolled JSON-RPC 2.0 over
//! stdio rather than pulling in an SDK crate, matching this project's
//! existing posture (loopx_client, ollama.py, kanban.rs are all hand-rolled
//! protocol clients too) — the stdio transport is genuinely simple: one
//! JSON-RPC message per line, no framing beyond newlines.
//!
//! Connection lifecycle lives entirely in Rust (a spawned child process
//! can't be owned by the webview); the frontend (lib/mcp.ts) only holds
//! server *configuration* (command/args, persisted in localStorage like
//! everything else app-level) and calls these commands to connect/call/
//! disconnect. No sandboxing here, same posture as skills.rs: approval in
//! the frontend before invoke() is the safety boundary, not anything here.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStderr, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

const MCP_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_STDERR_BUFFER: usize = 4000;

// Baseline protocol version offered during initialize. Real MCP servers are
// generally lenient about minor version mismatches for this handshake; we
// don't currently do strict negotiation against the server's reported
// version (a real limitation, not an oversight — fine for a v1 client).
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

struct McpConnection {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    recent_stderr: Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct McpState(Mutex<HashMap<String, Arc<McpConnection>>>);

impl McpState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize, Clone)]
pub struct McpToolInfo {
    name: String,
    description: Option<String>,
    input_schema: Value,
}

fn kill(conn: &McpConnection) {
    if let Ok(mut child) = conn.child.lock() {
        let _ = child.kill();
    }
}

fn with_stderr(conn: &McpConnection, base_err: String) -> String {
    let stderr = conn.recent_stderr.lock().map(|s| s.clone()).unwrap_or_default();
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        base_err
    } else {
        format!("{base_err}\nserver stderr:\n{trimmed}")
    }
}

// Reads the child's stderr in the background so a full pipe buffer can't
// stall the process, and keeps a capped tail of it around — surfaced on
// connect failure since "did not respond in time" alone is a poor clue when
// the real cause is e.g. "npx: command not found".
fn drain_stderr(pipe: ChildStderr, buffer: Arc<Mutex<String>>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Ok(mut buf) = buffer.lock() {
                        buf.push_str(&line);
                        if buf.len() > MAX_STDERR_BUFFER {
                            let excess = buf.len() - MAX_STDERR_BUFFER;
                            buf.drain(0..excess);
                        }
                    }
                }
            }
        }
    });
}

fn write_line(conn: &McpConnection, msg: &Value) -> Result<(), String> {
    let mut line = msg.to_string();
    line.push('\n');
    let mut stdin = conn.stdin.lock().map_err(|_| "stdin lock poisoned".to_string())?;
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

fn send_notification(conn: &McpConnection, method: &str, params: Value) -> Result<(), String> {
    write_line(conn, &json!({"jsonrpc": "2.0", "method": method, "params": params}))
}

fn send_request(conn: &McpConnection, method: &str, params: Value) -> Result<Value, String> {
    let id = conn.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    conn.pending
        .lock()
        .map_err(|_| "pending-requests lock poisoned".to_string())?
        .insert(id, tx);

    write_line(conn, &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;

    let response = match rx.recv_timeout(MCP_REQUEST_TIMEOUT) {
        Ok(v) => v,
        Err(_) => {
            if let Ok(mut pending) = conn.pending.lock() {
                pending.remove(&id);
            }
            return Err(format!(
                "MCP server did not respond to '{method}' within {}s",
                MCP_REQUEST_TIMEOUT.as_secs()
            ));
        }
    };
    if let Some(err) = response.get("error") {
        return Err(format!("MCP error calling '{method}': {err}"));
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

// On Windows, `npx`/other .cmd shims can't be spawned directly by
// CreateProcess — the same wrinkle execute_command already works around by
// routing through `cmd /C`. Reused here for the exact same reason.
fn spawn_and_handshake(command: &str, args: &[String]) -> Result<McpConnection, String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c.args(args);
        c
    } else {
        let mut c = Command::new(command);
        c.args(args);
        c
    };
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch '{command}': {e}"))?;
    let stdin = child.stdin.take().ok_or("failed to open child stdin")?;
    let stdout = child.stdout.take().ok_or("failed to open child stdout")?;
    let stderr = child.stderr.take().ok_or("failed to open child stderr")?;

    let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
    let recent_stderr = Arc::new(Mutex::new(String::new()));
    drain_stderr(stderr, recent_stderr.clone());

    // One JSON-RPC message per line on stdout (the stdio transport's whole
    // framing scheme). Lines that aren't a response to a pending request
    // (server notifications, or anything malformed) are dropped — this is a
    // client, not a full bidirectional MCP peer.
    let reader_pending = pending.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(trimmed) else { continue };
                    let Some(id) = msg.get("id").and_then(|v| v.as_u64()) else { continue };
                    if let Ok(mut p) = reader_pending.lock() {
                        if let Some(tx) = p.remove(&id) {
                            let _ = tx.send(msg);
                        }
                    }
                }
            }
        }
    });

    Ok(McpConnection {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        next_id: AtomicU64::new(1),
        pending,
        recent_stderr,
    })
}

fn parse_tools_list(list_result: &Value) -> Vec<McpToolInfo> {
    list_result
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| McpToolInfo {
                    name: t.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    description: t.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    input_schema: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn do_handshake_and_list(conn: &McpConnection) -> Result<Vec<McpToolInfo>, String> {
    let init_params = json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "codychat", "version": "0.1.0"}
    });
    send_request(conn, "initialize", init_params)?;
    send_notification(conn, "notifications/initialized", json!({}))?;
    let list = send_request(conn, "tools/list", json!({}))?;
    Ok(parse_tools_list(&list))
}

#[tauri::command]
pub fn mcp_connect(
    state: State<McpState>,
    id: String,
    command: String,
    args: Vec<String>,
) -> Result<Vec<McpToolInfo>, String> {
    let conn = spawn_and_handshake(&command, &args)?;
    match do_handshake_and_list(&conn) {
        Ok(tools) => {
            let mut map = state.0.lock().map_err(|_| "MCP state lock poisoned".to_string())?;
            map.insert(id, Arc::new(conn));
            Ok(tools)
        }
        Err(e) => {
            let full = with_stderr(&conn, e);
            kill(&conn);
            Err(full)
        }
    }
}

#[tauri::command]
pub fn mcp_disconnect(state: State<McpState>, id: String) -> Result<(), String> {
    let conn = {
        let mut map = state.0.lock().map_err(|_| "MCP state lock poisoned".to_string())?;
        map.remove(&id)
    };
    if let Some(conn) = conn {
        kill(&conn);
    }
    Ok(())
}

// Same rename_all fix as skills.rs::edit_file — tool_name is multi-word and
// the frontend calls this with a snake_case key to match.
#[tauri::command(rename_all = "snake_case")]
pub fn mcp_call_tool(
    state: State<McpState>,
    id: String,
    tool_name: String,
    arguments: Value,
) -> Result<String, String> {
    let conn = {
        let map = state.0.lock().map_err(|_| "MCP state lock poisoned".to_string())?;
        map.get(&id)
            .cloned()
            .ok_or_else(|| format!("no active MCP connection: {id}"))?
    };
    let result = send_request(&conn, "tools/call", json!({"name": tool_name, "arguments": arguments}))?;
    if result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
        let text = extract_text(&result);
        return Err(if text.is_empty() { "MCP tool call failed".to_string() } else { text });
    }
    Ok(extract_text(&result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tools_list_reads_name_description_schema() {
        let raw = json!({
            "tools": [
                {"name": "search", "description": "Search things", "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}},
                {"name": "noop"}
            ]
        });
        let tools = parse_tools_list(&raw);
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "search");
        assert_eq!(tools[0].description.as_deref(), Some("Search things"));
        assert_eq!(tools[1].name, "noop");
        assert_eq!(tools[1].description, None);
        assert_eq!(tools[1].input_schema, json!({"type": "object", "properties": {}}));
    }

    #[test]
    fn parse_tools_list_handles_missing_tools_array() {
        assert!(parse_tools_list(&json!({})).is_empty());
    }

    #[test]
    fn extract_text_joins_text_content_blocks() {
        let result = json!({"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]});
        assert_eq!(extract_text(&result), "a\nb");
    }

    #[test]
    fn extract_text_returns_empty_for_no_content() {
        assert_eq!(extract_text(&json!({})), "");
    }
}