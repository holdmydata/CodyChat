# Build Timeline

Parent: [[MEMORY]]

Assumptions locked in 2026-08-14: heavy-focus time budget (phases measured in days, not weeks); harness ([[Architecture/Backend]]) and shell ([[Architecture/Frontend]]) built **in parallel**, not sequentially; converge once both have a stable enough contract to talk over IPC.

## Phase 1 (days 1–4) — parallel tracks, no convergence yet

- **Harness track:** minimal Ollama client + skill-dispatch loop wired to loopx's objective/todo/gate/evidence objects, run **headless via CLI** against one toy task: a **read-only Kanban-board-reader popup** (Tauri/Rust) that parses and renders `docs/Kanban.md`. Deliberately the same tech family as the real shell, but disposable and read-only — proves the loopx/harness loop, and previews companion/game-menu presentation styling, before either touches the real app. See [[MEMORY]].
- **Shell track:** Tauri skeleton — window chrome, corner-pop/always-on-top behavior, tray icon, drag regions, basic IPC. Port the existing React chat components from `ui/` in as the initial content pane.

## Phase 2 (days 4–8) — converge — **done, 2026-08-14**

- [x] Wire the loopx-driven harness into the Tauri shell over local IPC/HTTP, so the shell renders live objective/todo/gate state, not just chat bubbles. Natural home for the newspaper/blog-style digest view. Built as a direct Tauri command (`get_loopx_digest`), not the originally-imagined HTTP server — see [[Architecture/Frontend]].
- [x] First real skill: something OS-level (file read/write, shell exec) gated behind explicit confirmation, echoing nanoclaw's vault/gate instinct. Proves the "runs on the computer" story without betting everything on it being safe by default. Built: `read_file`, model-directed via `qwen3.5:9b`, confirmation gate proved to actually block on denial — see [[Architecture/Backend]].

Remaining Phase 2 loose ends, all low-priority/deferred, tracked on [[Kanban]]: the digest view being more visual/graph-modular, the popout-run-viewer idea (not committed — waits on an actual autonomous loop existing), the 27B tools-capability investigation, and `.gitignore` housekeeping once git is initialized.

## Phase 3 (days 8–14) — polish + a finished toy artifact

- Apply glassmorphic styling now that layout/IPC is proven.
- Push the toy task through to a genuinely finished output using the harness across several sittings — this is what actually exercises loopx's multi-session handoff.
- **Stretch, only once confidence is high:** point the harness at its own UI code as a second toy task (dogfooding). Not phase 1 — an agent editing its own live runtime is a bad first date.

## Phase 4 (2+ weeks out) — deferred

- Image-generation backend (see [[Architecture/Backend]] multi-backend note).
- SillyTavern/companion presentation modes (see [[Architecture/Frontend]]).
- Messaging integrations, additional skills, whatever else falls out of actually using it.

## Risk note

The riskiest sequencing mistake is starting glass styling or the self-editing stretch goal before Phase 2's convergence — both assume a stable IPC contract that doesn't exist yet.
