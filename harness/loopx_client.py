"""Thin wrapper around the loopx CLI.

loopx requires a real POSIX environment (fcntl) that native Windows Python
doesn't have, so every call shells out to `wsl -d Ubuntu -- loopx ...`. The
harness itself runs on native Windows Python so it can reach Ollama at
localhost:11434 directly, and only crosses into WSL for state calls.

We only read a handful of fields out of loopx's (very large) JSON responses —
should_run, the selected todo, and a couple of confirmation fields. Everything
else in the payload is ignored on purpose.
"""

from __future__ import annotations

import json
import shlex
import subprocess
from dataclasses import dataclass

LOOPX_BIN = "/home/devuser/.local/bin/loopx"
WSL_DISTRO = "Ubuntu"


class LoopxError(Exception):
    pass


def _to_wsl_path(windows_path: str) -> str:
    drive = windows_path[0].lower()
    rest = windows_path[2:].replace("\\", "/")
    return f"/mnt/{drive}{rest}"


def _run(args: list[str], project_dir: str) -> dict:
    wsl_project = _to_wsl_path(project_dir)
    quoted_args = " ".join(shlex.quote(a) for a in args)
    bash_cmd = f"cd {shlex.quote(wsl_project)} && {LOOPX_BIN} {quoted_args}"
    result = subprocess.run(
        ["wsl", "-d", WSL_DISTRO, "--", "bash", "-c", bash_cmd],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise LoopxError(
            f"loopx returned non-JSON output (exit {result.returncode}): "
            f"stdout={result.stdout[:500]!r} stderr={result.stderr[:500]!r}"
        ) from exc


@dataclass
class NextTodo:
    todo_id: str
    text: str
    priority: str
    action_kind: str


def should_run(goal_id: str, agent_id: str, project_dir: str) -> tuple[bool, NextTodo | None]:
    data = _run(
        [
            "--format", "json", "quota", "should-run",
            "--goal-id", goal_id, "--agent-id", agent_id,
            "--runtime-profile", "generic_cli",
        ],
        project_dir,
    )
    if not data.get("should_run"):
        return False, None
    selected = data.get("selected_todo")
    if not selected:
        return True, None
    return True, NextTodo(
        todo_id=selected["todo_id"],
        text=selected["text"],
        priority=selected.get("priority", ""),
        action_kind=selected.get("action_kind", ""),
    )


@dataclass
class GoalDigest:
    goal_id: str
    should_run: bool
    quota_state: str
    todo_total: int
    todo_open: int
    todo_done: int
    next_todo: NextTodo | None


def goal_digest(goal_id: str, agent_id: str, project_dir: str) -> GoalDigest:
    """Compact summary for shell display — reuses the same should-run call as
    should_run() but keeps a few more fields (counts, quota state) that a
    digest view needs. Deliberately still tiny next to loopx's raw payload.
    """
    data = _run(
        [
            "--format", "json", "quota", "should-run",
            "--goal-id", goal_id, "--agent-id", agent_id,
            "--runtime-profile", "generic_cli",
        ],
        project_dir,
    )
    summary = data.get("agent_todo_summary", {})
    selected = data.get("selected_todo")
    next_todo = (
        NextTodo(
            todo_id=selected["todo_id"],
            text=selected["text"],
            priority=selected.get("priority", ""),
            action_kind=selected.get("action_kind", ""),
        )
        if selected
        else None
    )
    return GoalDigest(
        goal_id=goal_id,
        should_run=bool(data.get("should_run")),
        quota_state=data.get("quota", {}).get("state", "unknown"),
        todo_total=summary.get("total_count", 0),
        todo_open=summary.get("open_count", 0),
        todo_done=summary.get("done_count", 0),
        next_todo=next_todo,
    )


def complete_todo(goal_id: str, agent_id: str, todo_id: str, evidence: str, project_dir: str) -> dict:
    return _run(
        [
            "--format", "json", "todo", "complete",
            "--goal-id", goal_id, "--agent-id", agent_id,
            "--todo-id", todo_id, "--evidence", evidence,
        ],
        project_dir,
    )


def refresh_state(goal_id: str, agent_id: str, project_dir: str) -> dict:
    return _run(
        ["--format", "json", "refresh-state", "--goal-id", goal_id, "--agent-id", agent_id],
        project_dir,
    )


def spend_slot(goal_id: str, agent_id: str, project_dir: str, slots: int = 1) -> dict:
    return _run(
        [
            "--format", "json", "quota", "spend-slot",
            "--goal-id", goal_id, "--agent-id", agent_id,
            "--slots", str(slots), "--source", "heartbeat", "--execute",
        ],
        project_dir,
    )
