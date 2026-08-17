# loopx — quick reference (distilled for future-you)

Full context: `docs/Architecture/Backend.md` (integration notes), `harness/loopx_client.py`
(the live wrapper — copy exact CLI syntax from there). This file exists so a `search_memory`
hit is enough to use loopx without re-reading the huge docs.

## What it is
loopx is a lightweight **state kernel** (goals, ordered todos, user gates, evidence logs, quota).
Not an inference engine. It governs long-running agent work: objective → kernel (gates/todos/
quota) → bounded agent turn → evidence writeback → next iteration. Python 3.11+, stdlib-only.

## The one hard rule: it only runs inside WSL
loopx's CLI depends on Python's `fcntl` — **Unix-only**. Native Windows Python cannot run it at
all (Git Bash doesn't help; it's still native Windows). Never try to run it directly.

**Invocation pattern** (from `harness/loopx_client.py`):

```
wsl -d Ubuntu -- bash -c "cd /mnt/d/MeanSquares/CodyChat/<project> && /home/devuser/.local/bin/loopx <subcommand> ..."
```

- Distro: `Ubuntu`, user `devuser` (passwordless sudo). Binary: `/home/devuser/.local/bin/loopx`.
- Windows paths map `D:\...` → `/mnt/d/...`.
- Always put `--format json` first; loopx emits JSON on stdout. Success = `"ok": true` in the JSON.
- The harness runs on native Windows Python (reaches Ollama at `localhost:11434` directly) and
  only crosses into WSL for state calls.
- **Windows→WSL inline one-liners mangle quotes.** If args are non-trivial, write a small bash
  script file and run it through `wsl -d Ubuntu -- bash /path/to/script.sh` instead.
- Don't be alarmed by payload size: e.g. `quota should-run` returns 300+ lines of JSON. Only a
  handful of fields matter; ignore the rest.

## Identity conventions (project-wide — do not invent new ones)
- **`agent_id` is always `ollama-harness-01`** — the single registered agent identity used for
  every goal in this project (kanban-reader-goal, ollama-harness-goal, meansquares-shell-goal,
  threejs-game-goal, ...). Reuse it for any new goal.
- **`goal_id` convention: `<project-name>-goal`** (e.g. `threejs-game-goal`). One loopx goal per
  project dir; each project dir holds its own state.

## State layout (per project dir)
- `.loopx/registry.json` — local registry (goal, adapter, coordination incl. `registered_agents`).
- `.codex/goals/<goal_id>/ACTIVE_GOAL_STATE.md` — active goal state (objective + todos).
- Global registry lives at `/home/devuser/.codex/loopx` (`common_runtime_root`); loopx syncs it
  automatically on writes.
- **Always `.gitignore` both `.loopx/` and `.codex/goals/`** in the project dir (bootstrap
  itself says so — state may contain private evidence). Mirror `toys/kanban-reader/.gitignore`.

## Bootstrapping a new goal — the exact sequence
`bootstrap` → `register-agent` → `todo add` (then verify with `status`):

1. **`bootstrap`** — create the goal in the project dir: pass the new `goal_id` and the
   objective text. Creates `.loopx/registry.json` + `.codex/goals/<goal_id>/ACTIVE_GOAL_STATE.md`,
   syncs the global registry. For an empty dir use `--no-onboarding-scan`; for a headless/custom
   harness (not Codex App) use `--codex-app-heartbeat no` to skip the gate.
2. **`register-agent`** — register `ollama-harness-01` on the goal (`--goal-id`, `--agent-id`),
   syncs globally.
3. **`todo add`** — add the first real task with priority (P0 for the initial task). Todo IDs
   come back as `todo_<hex>`; **they are deterministic** (same inputs → same IDs), which matters
   if you ever have to rebuild.
4. **`status`** — confirm: expect goal state like `connected_without_run`, the new P0 todo as
   `next_agent_todo`, `handoff_state: ready_waiting_for_run` (the harness's `should_run` will
   then pick it up).

If the exact flags for a subcommand are in doubt, run `loopx <subcommand> --help` inside WSL —
cheap and authoritative.

## The steady-state run loop (what `harness/loopx_client.py` wraps)
All calls go through the WSL pattern above, from the project dir:

```
--format json quota should-run --goal-id <goal> --agent-id ollama-harness-01 --runtime-profile generic_cli
--format json todo complete   --goal-id <goal> --agent-id ollama-harness-01 --todo-id <id> --evidence "<genuine evidence>"
--format json refresh-state   --goal-id <goal> --agent-id ollama-harness-01
--format json quota spend-slot --goal-id <goal> --agent-id ollama-harness-01 --slots 1 --source heartbeat --execute
```

- Read only: `should_run`, `selected_todo.{todo_id,text,priority,action_kind}`, `quota.state`,
  `agent_todo_summary` counts.
- Complete todos with **real evidence** describing what was actually done/validated; never mark
  work done that didn't happen (proven end-to-end 2026-08-14 with a throwaway smoke-test todo).
- `todo complete` refuses re-updating an already-done todo — if a prior run prematurely marked
  a todo done, complete with a note documenting the correction, then `refresh-state`.
- Proven full cycle: `should_run` → real Ollama call → `todo complete` (evidence) →
  `refresh-state` → `quota spend-slot`.

## Gotchas (learned the hard way)
- **`fcntl` is the reason for WSL** — see top. No workaround exists in native Windows Python.
- **Scaffold-with-`--force` tools wipe state dirs.** `npm create tauri-app -- --force` once
  silently deleted the whole `toys/kanban-reader/` dir, destroying the bootstrapped goal, agent,
  and all todos. Never point a force-overwrite generator at a dir holding `.loopx/` /
  `.codex/goals/` without checking first. Recovery path: `loopx retire-global-goal --execute`
  (cleans the orphaned global entry) → fresh `bootstrap` + `register-agent` + same `todo add`s
  (deterministic IDs make this painless).
- **Repo moves leave stale paths in the registry.** After the repo rename
  (`/mnt/d/MeanSquares/AI/...` → `/mnt/d/MeanSquares/CodyChat/...`) a pre-rename path in
  `.loopx/registry.json` caused a real write-side failure. If the project dir moves, fix the
  registry's `repo` path (loopx's own check/writeback surfaces the mismatch).
- Stale global entries (`source_registry_missing` / `state_file_missing`) are retired with
  `loopx retire-global-goal` (preview first, then `--execute`).
