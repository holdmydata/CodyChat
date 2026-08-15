//! Tauri commands the React frontend can call. Kept separate from the
//! window-chrome logic in lib.rs, which is pure Rust with no IPC involved.

use std::process::Command;

use serde::Serialize;

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
}

#[tauri::command]
pub fn get_environment_info() -> EnvironmentInfo {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let home_path = std::path::PathBuf::from(&home);
    EnvironmentInfo {
        os: std::env::consts::OS.to_string(),
        documents_dir: home_path.join("Documents").display().to_string(),
        desktop_dir: home_path.join("Desktop").display().to_string(),
        downloads_dir: home_path.join("Downloads").display().to_string(),
        home_dir: home,
    }
}

// loopx digest: queries loopx directly via WSL (loopx needs a real POSIX
// environment, see docs/Architecture/Backend.md) rather than through a
// separately-run server process. Mirrors harness/loopx_client.py's
// goal_digest(), duplicated here in Rust on purpose so the shell doesn't
// depend on a manually-started Python process just to show live state.

#[derive(Serialize, Clone)]
pub struct NextTodo {
    todo_id: String,
    text: String,
    priority: String,
    action_kind: String,
}

#[derive(Serialize, Clone)]
pub struct GoalDigest {
    goal_id: String,
    should_run: bool,
    quota_state: String,
    todo_total: u64,
    todo_open: u64,
    todo_done: u64,
    next_todo: Option<NextTodo>,
    error: Option<String>,
}

struct TrackedGoal {
    goal_id: &'static str,
    agent_id: &'static str,
    project_dir: &'static str,
}

const TRACKED_GOALS: &[TrackedGoal] = &[
    TrackedGoal {
        goal_id: "meansquares-shell-goal",
        agent_id: "ollama-harness-01",
        project_dir: r"d:\MeanSquares\AI\ui",
    },
    TrackedGoal {
        goal_id: "kanban-reader-goal",
        agent_id: "ollama-harness-01",
        project_dir: r"d:\MeanSquares\AI\toys\kanban-reader",
    },
];

fn to_wsl_path(windows_path: &str) -> String {
    let drive = windows_path.chars().next().unwrap_or('c').to_ascii_lowercase();
    let rest = windows_path[2..].replace('\\', "/");
    format!("/mnt/{drive}{rest}")
}

fn empty_digest(goal_id: &str, error: String) -> GoalDigest {
    GoalDigest {
        goal_id: goal_id.to_string(),
        should_run: false,
        quota_state: String::new(),
        todo_total: 0,
        todo_open: 0,
        todo_done: 0,
        next_todo: None,
        error: Some(error),
    }
}

fn fetch_one(goal: &TrackedGoal) -> GoalDigest {
    let wsl_project = to_wsl_path(goal.project_dir);
    let bash_cmd = format!(
        "cd {} && /home/devuser/.local/bin/loopx --format json quota should-run --goal-id {} --agent-id {} --runtime-profile generic_cli",
        wsl_project, goal.goal_id, goal.agent_id
    );

    let output = match Command::new("wsl")
        .args(["-d", "Ubuntu", "--", "bash", "-c", &bash_cmd])
        .output()
    {
        Ok(o) => o,
        Err(e) => return empty_digest(goal.goal_id, e.to_string()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let data: serde_json::Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(e) => return empty_digest(goal.goal_id, format!("bad JSON from loopx: {e}")),
    };

    let summary = &data["agent_todo_summary"];
    let selected = &data["selected_todo"];
    let next_todo = selected.is_object().then(|| NextTodo {
        todo_id: selected["todo_id"].as_str().unwrap_or_default().to_string(),
        text: selected["text"].as_str().unwrap_or_default().to_string(),
        priority: selected["priority"].as_str().unwrap_or_default().to_string(),
        action_kind: selected["action_kind"].as_str().unwrap_or_default().to_string(),
    });

    GoalDigest {
        goal_id: goal.goal_id.to_string(),
        should_run: data["should_run"].as_bool().unwrap_or(false),
        quota_state: data["quota"]["state"].as_str().unwrap_or("unknown").to_string(),
        todo_total: summary["total_count"].as_u64().unwrap_or(0),
        todo_open: summary["open_count"].as_u64().unwrap_or(0),
        todo_done: summary["done_count"].as_u64().unwrap_or(0),
        next_todo,
        error: None,
    }
}

#[tauri::command]
pub fn get_loopx_digest() -> Vec<GoalDigest> {
    TRACKED_GOALS.iter().map(fetch_one).collect()
}
