//! Write-side loopx operations: reporting evidence back after an
//! autonomously-run turn (todo complete / refresh-state / quota spend-slot).
//! Companion to commands.rs's `get_loopx_digest`, which only reads state —
//! this is the other half needed for a real autonomous loop (see
//! docs/Kanban.md's "real autonomous loop" entry). Same WSL shell-out shape
//! `get_loopx_digest` already uses, ported line-for-line from
//! harness/loopx_client.py's `complete_todo`/`refresh_state`/`spend_slot`
//! rather than guessed — matches this project's established pattern
//! (loopx_client, ollama.py, kanban.rs, mcp.rs are all hand-rolled protocol
//! ports for the same "no runtime dependency on a manually-started Python
//! process" reason).

use std::process::Command;

use crate::commands::{to_wsl_path, TRACKED_GOALS};

const LOOPX_BIN: &str = "/home/devuser/.local/bin/loopx";
const WSL_DISTRO: &str = "Ubuntu";

// Resolves agent_id/project_dir from goal_id via the same TRACKED_GOALS
// whitelist get_loopx_digest already iterates — the frontend only ever
// needs to know a goal_id, never a raw filesystem path.
fn resolve_goal(goal_id: &str) -> Result<(&'static str, &'static str), String> {
    TRACKED_GOALS
        .iter()
        .find(|g| g.goal_id == goal_id)
        .map(|g| (g.agent_id, g.project_dir))
        .ok_or_else(|| format!("unknown goal_id: {goal_id}"))
}

// Matches Python's shlex.quote() exactly (harness/loopx_client.py's own
// `_run` escapes every arg this way before joining): wrap in single quotes,
// escape any embedded single quote as '\''. Needed specifically because
// `evidence` is arbitrary free text that could contain spaces, quotes, or
// shell metacharacters — every other arg here is a known-safe identifier,
// but evidence isn't, and quoting all args uniformly is simpler than
// special-casing just the one that needs it.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// Pure and testable without a real WSL call — the actual subprocess
// spawn/JSON-parse happens in run_loopx below.
fn build_bash_command(project_dir: &str, args: &[String]) -> String {
    let wsl_project = to_wsl_path(project_dir);
    let quoted_args: Vec<String> = args.iter().map(|a| shell_quote(a)).collect();
    format!("cd {} && {} {}", wsl_project, LOOPX_BIN, quoted_args.join(" "))
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn run_loopx(project_dir: &str, args: &[String]) -> Result<serde_json::Value, String> {
    let bash_cmd = build_bash_command(project_dir, args);

    let output = Command::new("wsl")
        .args(["-d", WSL_DISTRO, "--", "bash", "-c", &bash_cmd])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| {
        format!(
            "loopx returned non-JSON output (exit {:?}): stdout={:?} stderr={:?} ({e})",
            output.status.code(),
            truncate_chars(&stdout, 500),
            truncate_chars(&String::from_utf8_lossy(&output.stderr), 500)
        )
    })
}

// None of these three inspect the returned JSON for a loopx-level success/
// failure signal — matching harness/loopx_client.py exactly, which only
// ever treats a JSON-decode failure as an error and never checks the
// process exit code or response content otherwise. Preserved as-is rather
// than adding stricter checking the Python prototype never had.

#[tauri::command(rename_all = "snake_case")]
pub fn loopx_complete_todo(goal_id: String, todo_id: String, evidence: String) -> Result<(), String> {
    let (agent_id, project_dir) = resolve_goal(&goal_id)?;
    run_loopx(
        project_dir,
        &[
            "--format".into(),
            "json".into(),
            "todo".into(),
            "complete".into(),
            "--goal-id".into(),
            goal_id,
            "--agent-id".into(),
            agent_id.into(),
            "--todo-id".into(),
            todo_id,
            "--evidence".into(),
            evidence,
        ],
    )
    .map(|_| ())
}

#[tauri::command(rename_all = "snake_case")]
pub fn loopx_refresh_state(goal_id: String) -> Result<(), String> {
    let (agent_id, project_dir) = resolve_goal(&goal_id)?;
    run_loopx(
        project_dir,
        &[
            "--format".into(),
            "json".into(),
            "refresh-state".into(),
            "--goal-id".into(),
            goal_id,
            "--agent-id".into(),
            agent_id.into(),
        ],
    )
    .map(|_| ())
}

#[tauri::command(rename_all = "snake_case")]
pub fn loopx_spend_slot(goal_id: String, slots: u32) -> Result<(), String> {
    let (agent_id, project_dir) = resolve_goal(&goal_id)?;
    run_loopx(
        project_dir,
        &[
            "--format".into(),
            "json".into(),
            "quota".into(),
            "spend-slot".into(),
            "--goal-id".into(),
            goal_id,
            "--agent-id".into(),
            agent_id.into(),
            "--slots".into(),
            slots.to_string(),
            "--source".into(),
            "heartbeat".into(),
            "--execute".into(),
        ],
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_goal_finds_known_goal() {
        let (agent_id, project_dir) = resolve_goal("kanban-reader-goal").unwrap();
        assert_eq!(agent_id, "ollama-harness-01");
        assert!(project_dir.ends_with("kanban-reader"));
    }

    #[test]
    fn resolve_goal_errors_on_unknown_goal() {
        assert!(resolve_goal("not-a-real-goal").is_err());
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_quote("it's fine"), "'it'\\''s fine'");
        assert_eq!(shell_quote("plain text"), "'plain text'");
    }

    #[test]
    fn build_bash_command_matches_todo_complete_shape() {
        let cmd = build_bash_command(
            r"d:\MeanSquares\CodyChat\toys\kanban-reader",
            &[
                "--format".into(),
                "json".into(),
                "todo".into(),
                "complete".into(),
                "--goal-id".into(),
                "kanban-reader-goal".into(),
                "--agent-id".into(),
                "ollama-harness-01".into(),
                "--todo-id".into(),
                "todo_fa501099a20c".into(),
                "--evidence".into(),
                "Ran the check, clean.".into(),
            ],
        );
        assert_eq!(
            cmd,
            "cd /mnt/d/MeanSquares/CodyChat/toys/kanban-reader && \
             /home/devuser/.local/bin/loopx '--format' 'json' 'todo' 'complete' \
             '--goal-id' 'kanban-reader-goal' '--agent-id' 'ollama-harness-01' \
             '--todo-id' 'todo_fa501099a20c' '--evidence' 'Ran the check, clean.'"
        );
    }

    #[test]
    fn build_bash_command_matches_refresh_state_shape() {
        let cmd = build_bash_command(
            r"d:\MeanSquares\CodyChat\ui",
            &[
                "--format".into(),
                "json".into(),
                "refresh-state".into(),
                "--goal-id".into(),
                "meansquares-shell-goal".into(),
                "--agent-id".into(),
                "ollama-harness-01".into(),
            ],
        );
        assert_eq!(
            cmd,
            "cd /mnt/d/MeanSquares/CodyChat/ui && /home/devuser/.local/bin/loopx \
             '--format' 'json' 'refresh-state' '--goal-id' 'meansquares-shell-goal' \
             '--agent-id' 'ollama-harness-01'"
        );
    }

    #[test]
    fn build_bash_command_matches_spend_slot_shape() {
        let cmd = build_bash_command(
            r"d:\MeanSquares\CodyChat\ui",
            &[
                "--format".into(),
                "json".into(),
                "quota".into(),
                "spend-slot".into(),
                "--goal-id".into(),
                "meansquares-shell-goal".into(),
                "--agent-id".into(),
                "ollama-harness-01".into(),
                "--slots".into(),
                "1".into(),
                "--source".into(),
                "heartbeat".into(),
                "--execute".into(),
            ],
        );
        assert_eq!(
            cmd,
            "cd /mnt/d/MeanSquares/CodyChat/ui && /home/devuser/.local/bin/loopx \
             '--format' 'json' 'quota' 'spend-slot' '--goal-id' 'meansquares-shell-goal' \
             '--agent-id' 'ollama-harness-01' '--slots' '1' '--source' 'heartbeat' '--execute'"
        );
    }
}
