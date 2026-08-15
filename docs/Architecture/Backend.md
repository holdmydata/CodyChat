# Backend / Harness

Parent: [[MEMORY]]

## loopx — control plane

[loopx](https://github.com/huangruiteng/loopx) is a lightweight state kernel for governing long-running agent work — not an inference or orchestration layer. It maintains five things:

1. Durable objective state — goals, scope, authority
2. Executable todos — ordered tasks with ownership/claims
3. User gates — concrete decision points instead of vague waiting
4. Evidence logs — compact run history and validated results
5. Quota management — scheduler hints, safe-fallback options

Mental model: objective → loopx kernel (gates, todos, quota) → bounded agent turn → evidence writeback → next iteration. Python 3.11+, stdlib-only, MIT-licensed, provider-agnostic.

**Decision:** adopt as-is rather than reimplementing (see [[MEMORY]]). It doesn't cost much to depend on — small, no runtime deps — and reimplementing it would eat into the heavy-focus timeline for a "Karpathy-style, own every line" payoff that isn't the actual goal here (the actual toy task is meant to exercise the harness on a real problem, not re-derive control-plane theory).

### Real-world integration notes (built 2026-08-14)

- **Platform requirement, discovered the hard way:** loopx's installer and CLI depend on Python's `fcntl` module, which is Unix-only. Native Windows Python cannot run it at all — this isn't a Git Bash/PATH issue, `fcntl` simply doesn't exist on Windows. **Fix:** installed WSL2 Ubuntu (WSL2 itself was already enabled via Docker Desktop; this just added a real distro) with a non-root default user (`devuser`, passwordless sudo). loopx lives entirely inside WSL; the harness itself runs on native Windows Python (so it can reach Ollama at `localhost:11434` directly) and shells out to `wsl -d Ubuntu -- /home/devuser/.local/bin/loopx ...` for every state call. See `harness/loopx_client.py`.
- **Complexity, in practice vs. in the README:** the README frames loopx as a "lightweight state kernel." In actual use it's considerably heavier — `quota should-run` alone returns 300+ lines of JSON covering Codex-App-specific automation/heartbeat contracts, promotion-readiness gates, canary tracking, and multi-agent coordination primitives, none of which apply to a solo custom-harness use case. It remains workable: the harness only reads a handful of fields (`should_run`, `selected_todo.todo_id/text/priority/action_kind`) and ignores the rest. Worth knowing going in so the payload size doesn't feel like something's wrong when you first see it.
- **Toy project state:** `toys/kanban-reader/` is the actual loopx-tracked project (`goal_id=kanban-reader-goal`), separate from `harness/` (the Python code that drives it). Registered agent identity: `agent_id=ollama-harness-01`. `.loopx/` and `.codex/goals/` inside that project directory hold loopx's state files — need `.gitignore`-ing once git is initialized (loopx's own bootstrap output says as much: they may contain private evidence).
- **Proven end-to-end (2026-08-14):** `should_run` → real Ollama call → `todo complete` with genuine evidence → `refresh-state` → `quota spend-slot`, all via `harness/loopx_client.py` from native Windows Python. The real P0/P1/P2 project todos were left open — a separate throwaway smoke-test todo was used to prove the mechanics without falsely marking real project work done.
- **Incident + fix (2026-08-14): `npm create tauri-app -- --force` wiped `.loopx/` and `.codex/goals/`.** Scaffolding the actual Tauri project into `toys/kanban-reader/` (the same directory loopx was already tracking) with `--force` silently deleted and recreated the whole directory rather than merging into it — destroying the bootstrapped goal, registered agent, and all three todos. No real project work was lost (the Tauri build itself hadn't started yet), but it's a real gotcha worth remembering: **scaffolding/generator tools with a "force overwrite" flag should be assumed to wipe a directory's existing contents, not merge, unless proven otherwise** — check before pointing one at a directory that already holds state you care about. Recovered via `loopx retire-global-goal --execute` (cleans the now-orphaned global registry entry) followed by a fresh `bootstrap` + `register-agent` + the same three `todo add` calls — todo IDs came back identical (they're deterministic, not random), so nothing had to be reconciled by hand.

## What loopx does *not* cover — still the harness's job

- Calling Ollama (model list, chat, streaming) — see `ui/src/lib/ollama.ts` for the request/response shape already validated against a live Ollama instance.
- Tool/skill dispatch and execution.
- Model routing (which local model handles which kind of turn).
- Any second backend (e.g. future image generation).

## nanoclaw — pattern reference, not a dependency

[nanoclaw](https://nanoclaw.dev/) is a personal-agent runtime: a single Node.js host orchestrating **per-session Docker containers**, each running Bun + the Claude Agent SDK. "Skills" are modular extensions installed on demand from a registry (`/add-telegram`, `/add-opencode`, ...), copied into the user's fork rather than shipped as one monolith. Credentials route through a vault rather than being held by agents directly. It's messaging-platform-first (WhatsApp, Telegram, Slack, Discord, Teams, iMessage).

**What's transferable here:** skills as installable, isolated modules, and *not* trusting an agent with raw OS/credential access by default. **What's not transferable as-is:** the Claude Agent SDK dependency and messaging-channel focus — this project runs local Ollama models and drives the desktop, which is a different job.

**Implication for the harness's skill layer:** first OS-level skill (Phase 2 of [[Timeline]]) should be gated behind explicit confirmation, echoing nanoclaw's vault/gate instinct, before any skill gets unsupervised OS access.

## Skill/tool-dispatch pattern (built 2026-08-14)

Deliberately not architected up front — Phase 1's toy task didn't need real dispatch, only a deterministic file-read. The shape was designed against Phase 2's first real skill instead of in the abstract, once there was something concrete to build against. Tracked under its own loopx goal (`ollama-harness-goal`, project = `harness/`), separate from the shell and toy goals.

**Model-directed dispatch** via Ollama's native tool-calling (`tools` in `/api/chat`) — the LLM decides when to invoke a skill. Verified the wire format directly with `curl` against `qwen3.5:9b` before writing any code: request carries a `tools` array (`{"type":"function","function":{name, description, parameters: <JSON schema>}}`), response carries `message.tool_calls` (`function.name`/`function.arguments`) with `content` empty when a tool call is made.

**Built, in `harness/`:**
- `ollama.py::chat()` — non-streaming, dict-based messages, `tools` param. Kept separate from the existing `Message`-dataclass-based `stream_chat()` (used by the plain UI chat) since tool-calling turns (assistant `tool_calls`, `role: "tool"` results) don't fit that simple role/content shape.
- `skills.py` — `SKILLS` registry, `TOOL_DEFINITIONS` (the JSON schemas sent to Ollama), and `dispatch(name, arguments, confirm)`. `confirm` is an injected callback, not a hardcoded prompt, so the gate can be swapped later (e.g. for a shell-driven confirmation UI) without touching dispatch logic. First skill: `read_file` (200KB cap, decode with `errors="replace"`, raises on non-file paths).
- `run_tool_demo.py` — one-shot CLI proof, `model = "qwen3.5:9b"` (explicitly not the 27B).

**Proved live, both directions:** a real prompt caused the model to call `read_file` with the correct path; after confirmation the skill executed and the model's *final* response correctly described the actual file content (not a hallucination off the function name). Separately verified `confirm=False` actually blocks execution (asserted the skill did not run) — the gate isn't just decorative.

**Confirmation gate today is a CLI y/n prompt** (`input()`), with an explicit `--auto-confirm` flag for non-interactive proof runs that logs plainly that no real human approved (this session's sandboxed shell has no real stdin). A real gate — surfaced in the shell UI rather than a terminal prompt — is follow-up work once the harness has an actual reason to run unattended.

### Superseded: dispatch moved to Rust (2026-08-14)

The above (`harness/skills.py`, `run_tool_demo.py`) was a real, correctly-working proof — but it was a standalone Python script nobody but the assistant had ever run. The actual chat UI never sent `tools` to Ollama at all, so none of this was reachable from the app the user would actually use. Surfaced explicitly when the user asked for the harness to "write files (with approval)... like we're doing here" and it became clear that ask couldn't be met by anything built so far.

**Decision (user-confirmed):** port dispatch into Rust (`ui/src-tauri/src/skills.rs`) rather than have Tauri manage the Python harness as a subprocess. Matches the established "no separate process" preference (same reasoning as the loopx digest pivot below) and avoids cross-process IPC complexity for zero benefit — the skills are just filesystem calls, and Rust already has full OS access from the Tauri process. `harness/skills.py`/`run_tool_demo.py` remain as a working reference/prototype but are no longer the live path. See [[Architecture/Frontend]] for the actual shipped implementation.

**Model-capability wrinkle — resolved (2026-08-14), wasn't a real gap.** `/api/tags` reported the local 27B build as `completion, vision` only — no `tools`. Checking `/api/show` instead (`{"model": "..."}`) shows `capabilities: ['tools', 'thinking', 'completion', 'vision']` for the *same* model — the two Ollama endpoints just report inconsistent capability lists for the same model; `/api/show` is the accurate, fuller one. Doesn't change the dispatch design (still routes through `qwen3.5:9b`, not the 27B, per the "harness builds tools, small models drive dispatch" intent above) but the model itself was never actually missing `tools`.

## Multi-backend note (deferred, not forgotten)

Image/comic-strip generation is deferred to v1+ (see [[MEMORY]]), but the tool-dispatch layer should be designed so a second backend (e.g. ComfyUI/SDXL for image gen) can be added later without restructuring how the harness routes calls. Don't hardwire the dispatch layer to "Ollama is the only backend."
