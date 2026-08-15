# MeanSquares CodyChat

A modular starter for a custom Ollama-backed agent/harness — deliberately not the stock Open WebUI. Git-initialized locally (2026-08-14, no remote yet) — each subproject (`ui/`, `toys/kanban-reader/`, `harness/`) has its own `.gitignore` covering `node_modules`, Rust `target/`, and per-project loopx state (`.loopx/`, `.codex/goals/`).

## Layout

- `ui/` — working React + Vite + TS chat scaffold, talks directly to a local Ollama instance (`http://localhost:11434`). See `ui/README.md` for structure and the extension point (`ui/src/lib/ollama.ts`) where a real harness replaces direct Ollama calls. This is a starting point, not the final delivery shell.
- `docs/` — Obsidian vault holding all planning/decision context. **Start at `docs/MEMORY.md`** — it's the running decisions log and links out to architecture notes and the build timeline. Read it before making architectural changes; update it when a real decision gets made (not for routine code changes).

## Current direction (see `docs/MEMORY.md` for the full log)

- Backend: adopting [loopx](https://github.com/huangruiteng/loopx) as a control-plane layer above a hand-rolled Ollama-calling harness.
- Frontend: `ui/`'s React components are meant to be reused inside a Tauri desktop shell (glass-style aesthetic), not shipped as a browser webui.
- Timeline and phase breakdown: `docs/Timeline.md`.

## Working conventions

No committed code conventions beyond what's in `ui/README.md` yet — this repo is early. When in doubt, match the style already used in `ui/src/`.
