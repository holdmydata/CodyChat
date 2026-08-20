<p align="center">
  <img src="codychatbanner.png" alt="CodyChat" width="720">
</p>

<p align="center">
  A custom, Ollama-backed desktop chat agent — local-first, tool-using, and yours to reskin.
</p>

---

CodyChat is a Tauri (Rust) desktop shell around a React/TypeScript chat UI that talks directly to a local [Ollama](https://ollama.com) instance. It's built to work like an agentic coding assistant — real tool-calling with per-call approval, a searchable memory, autonomous task runs — while staying fully local and model-agnostic. No account, no cloud dependency, nothing leaves your machine unless a tool you approved (like `web_fetch`) needs to.

<!--
  Screenshots go here — drop image files into docs/screenshots/ and
  reference them below, e.g.:

  <p align="center">
    <img src="docs/screenshots/chat.png" width="800" alt="Chat view">
  </p>
  <p align="center">
    <img src="docs/screenshots/spatial.png" width="800" alt="Spatial chat mode">
  </p>
-->

## Features

### Chat
- Streaming chat against any local Ollama model, with a collapsible "thought process" breakout for models that emit thinking tokens.
- Two presentation modes, switchable in Settings: a plain flat scrollback, or a **spatial** mode — the same conversation rendered with WebGL glow/animation polish (Three.js kept strictly to non-interactive decoration; every interactive surface stays real DOM/CSS).
- Paste an image straight into the message box for vision-capable models.
- Per-conversation system prompt, temperature / top-p / context length, and "save as custom model" (bakes a system prompt + sampling params into a real Ollama model via `/api/create`).

### Tool-calling, gated by explicit approval
- Built-in tools: `read_file`, `write_file`, a patch-style `edit_file` (find/replace, not a full overwrite), `list_directory`, `search_files` (grep-like), `execute_command` (shell), `web_fetch` (SSRF-guarded — blocks loopback/private/link-local addresses, pinned redirects), and `search_memory`.
- Every call shows a real in-app Approve/Deny prompt with a risk badge (Read-only / Write / Execute) before it runs — nothing executes silently.
- **MCP connector support** — hook up external [Model Context Protocol](https://modelcontextprotocol.io) servers as additional tools, through the same approval flow.
- **RAM/VRAM forecaster** in Settings — estimates whether a model will actually fit before you load it, reacting live to the context-length slider.

### Memory
- Local vector memory (`sqlite-vec` + `nomic-embed-text` embeddings, no separate server process) — the model can `search_memory` on demand instead of everything living only in the current context window.
- A 3D memory graph view for actually *seeing* what's been remembered and how it clusters, not just querying it blind.

### Autonomous runs
- A [loopx](https://github.com/huangruiteng/loopx)-driven autonomous loop mode — durable goals/todos/evidence logs and user-gated quotas, not just one-shot request/response chat.

### Companion duck
- A right-side docked panel (toggle from the titlebar) with its own persistent, separate conversation — a small companion with pose-based avatar art that reacts to what's actually happening (idle, thinking, talking, a happy pop when it replies).

### Theming & visuals
- **Theme packs** — the whole UI reads colors from a small set of CSS variables, so a full reskin is just a shareable JSON palette. Built-ins: Auto (follows the OS), Light, Dark, Psycho Duck, and League Hextech. Import a pack by pasting JSON or picking a file.
- Bundled fonts (Quicksand, Fredoka, Nunito Sans — confirmed OFL-licensed before vendoring) so theme-requested fonts actually render, not just on machines that happen to have them installed.
- A real vector icon set ([lucide-react](https://lucide.dev)) throughout, recoloring per-theme via `currentColor`.

### Window & tray
- Frameless widget-style window — tray icon, corner-pop positioning, slide-in/out animation, and a one-click expand/collapse between a compact widget and the full window.

## Getting started

Prerequisites: [Node.js](https://nodejs.org), the [Rust toolchain](https://rustup.rs) (for Tauri), and a running local [Ollama](https://ollama.com) instance.

```sh
cd ui
npm install
npm run tauri dev
```

Ollama is expected at `http://localhost:11434` by default — configurable in Settings.

## Project structure

- **`ui/`** — the actual app: Tauri (Rust) shell + React/TS frontend. See [`ui/README.md`](ui/README.md) for how the frontend is structured and where the harness extension point is.
- **`docs/`** — public reference material (currently `system_info.md`; more may land here over time). Planning/decision history lives in a private, local-only vault that isn't part of this repo.
- **`harness/`** — early Python-based agent/harness experiments (Ollama tool-dispatch, [loopx](https://github.com/huangruiteng/loopx) control-plane integration).
- **`toys/kanban-reader/`** — a throwaway Tauri/Rust practice app, not part of the shipped product.

## Status

Actively evolving, pre-1.0. One known cosmetic gap: real window transparency (Windows 11 Mica/Acrylic) doesn't render yet, so the app currently looks solid rather than glassy — the whole theme system is already built to pick it up automatically once that's resolved.
