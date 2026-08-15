# Session Summary — 2026-08-14

## Current state

The Ollama harness project (Tauri desktop shell + loopx control plane + local Ollama models) has compressed through Phases 0–3 in one heavy-focus day:

- **Phase 0–1 (done):** React+Vite+TS chat scaffold in `ui/`; loopx installed in WSL2 Ubuntu and proven end-to-end (should_run → real Ollama call → todo complete with evidence → quota spend-slot); throwaway Tauri toy (`toys/kanban-reader/`) built with a tested `Kanban.md` parser; real shell stood up by adding `src-tauri/` to `ui/` via `tauri init`.
- **Phase 2 (done):** loopx digest wired into the shell as a direct Tauri command (`get_loopx_digest`, polls every 8s — pivoted off a separate HTTP server per user preference); Python skill dispatch built and proven live both directions (confirmed and declined).
- **Phase 3 (mostly done):** streamed thinking breakout + a real "stuck on Thinking…" bug diagnosed and fixed; model info + context slider via `/api/show`; `/api/create` custom-model saving; real Markdown rendering; auto/manual chat titles; glass styling landed partially (half-screen size, slide animation, corner-pop all confirmed — **Mica/Acrylic transparency still failing** after 3 source-verified fixes, moved to Backlog as an open investigation).
- **Headline milestone:** live tool-dispatch shipped in the actual chat UI — Rust `skills.rs` (`read_file`/`write_file`/`list_directory`), streamed `tool_calls` in `streamChat`, `useChat` rebuilt as a bounded agentic loop (6 iterations), in-app `ToolApprovalPrompt`. **User-confirmed end-to-end on the first real try**: approval prompt with real args → approve → file actually created. The "work like Claude Code" core capability exists.

## What's next

1. **User verification of the "To Test" lane** — the two newest builds are compiled clean but not yet exercised live: the live tool-call activity tracker (`ActivityTracker.tsx`) with polished approval-arg display, and auto-injected filesystem context (`get_environment_info` → system prompt, built after the model guessed Linux paths on Windows). Also still pending: custom-model save, chat titles, `read_file`/`list_directory` via the live UI.
2. **Phase 3 dogfooding** — push the toy through to a finished artifact across sessions, then point the harness at `docs/` or `ui/src/` for a small real fix. Expected to surface the two known tool gaps: a search/grep tool and a patch/diff-style edit (current `write_file` is full-overwrite only).
3. **Transparency investigation** — next lead: WebView2's own compositor background (`ICoreWebView2Controller2::put_DefaultBackgroundColor`) may be independently opaque.
4. **Beyond (Phase 4, not committed yet):** the `execute_command` tool (biggest remaining gap vs. Claude Code and the biggest risk jump — needs its own approval-UX decision before building), image-gen backend as a second dispatch target, companion presentation mode, cross-conversation memory.
