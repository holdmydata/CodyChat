<p align="center">
  <img src="codychatbanner.png" alt="CodyChat" width="720">
</p>

<p align="center">
  A custom desktop chat agent — local-first by default, tool-using, and yours to reskin.
</p>

---

CodyChat is a Tauri (Rust) desktop shell around a React/TypeScript chat UI. It's built to work like an agentic coding assistant — real tool-calling with per-call approval, a searchable memory, autonomous task runs — and it's model-agnostic about where the model actually runs: a local [Ollama](https://ollama.com) instance by default (no account, no cloud dependency, nothing leaves your machine unless a tool you approved needs to), or point it at any OpenAI-compatible server or an Azure AI Foundry deployment instead.

## Features

### Chat
- Streaming chat, with a collapsible "thought process" breakout for models that emit thinking tokens.
- Two presentation modes, switchable in Settings: a plain flat scrollback, or a **spatial** mode — the same conversation rendered with WebGL glow/animation polish (Three.js kept strictly to non-interactive decoration; every interactive surface stays real DOM/CSS).
- Paste an image straight into the message box for vision-capable models.
- Per-conversation system prompt, temperature / top-p / context length, and "save as custom model" (bakes a system prompt + sampling params into a real Ollama model via `/api/create` — Ollama only).

### Three backends, switchable in Settings
- **Ollama** — the default, zero-config local option.
- **OpenAI-compatible** — any server speaking the OpenAI chat-completions wire format (llama-server, LM Studio, vLLM).
- **Azure AI Foundry** — a deployment-addressed Azure OpenAI/Foundry resource, authenticated via Entra ID device-code sign-in (refresh token held in the OS credential store, never in app storage). See [`docs/getting-started.md`](docs/getting-started.md) for the Azure-side setup this needs.

### Tool-calling, gated by explicit approval
- Built-in tools: `read_file`, `write_file`, a patch-style `edit_file` (find/replace, not a full overwrite), `list_directory`, `search_files` (grep-like), `execute_command` (shell), `web_fetch` (SSRF-guarded — blocks loopback/private/link-local addresses, pinned redirects), `search_memory`, and `ask_user_choice` (a real clickable multiple-choice prompt, for when the model has a small fixed set of options to offer rather than an open-ended question).
- Every call shows a real in-app Approve/Deny prompt with a risk badge (Read-only / Write / Execute) before it runs — nothing executes silently.
- **MCP connector support** — hook up external [Model Context Protocol](https://modelcontextprotocol.io) servers as additional tools, through the same approval flow.
- **RAM/VRAM forecaster** in Settings — estimates whether a model will actually fit before you load it, reacting live to the context-length slider (Ollama only).

### Governance telemetry (optional)
- Point Settings at an Application Insights connection string and every chat turn — across all three backends — logs a best-effort `ChatCompletion` event: tokens, estimated cost, duration, model, and who made the call. Leave it unset to skip entirely; nothing is sent anywhere by default.

### Memory
- Local vector memory (`sqlite-vec` + `nomic-embed-text` embeddings, no separate server process) — the model can `search_memory` on demand instead of everything living only in the current context window.
- A 3D memory graph view for actually *seeing* what's been remembered and how it clusters, not just querying it blind.

### Autonomous runs
- An autonomous loop mode, not just one-shot request/response chat — pulls its next task from a plain per-project `AGENT_TASKS.md` file (Obsidian-Kanban-plugin-compatible markdown), runs it through the same tool-approval pipeline as normal chat, and writes evidence back on completion. No external dependency: no separate CLI, no WSL, just a markdown file each project already has.

### Companion duck
- A right-side docked panel (toggle from the titlebar) with its own persistent, separate conversation — a small companion with pose-based avatar art that reacts to what's actually happening (idle, thinking, talking, a happy pop when it replies).

### Theming & visuals
- **Theme packs** — the whole UI reads colors from a small set of CSS variables, so a full reskin is just a shareable JSON palette. Built-ins: Auto (follows the OS), Light, Dark, Psycho Duck, and League Hextech. Import a pack by pasting JSON or picking a file.
- Bundled fonts (Quicksand, Fredoka, Nunito Sans — confirmed OFL-licensed before vendoring) so theme-requested fonts actually render, not just on machines that happen to have them installed.
- A real vector icon set ([lucide-react](https://lucide.dev)) throughout, recoloring per-theme via `currentColor`.

### Window & tray
- Frameless widget-style window — tray icon, corner-pop positioning, slide-in/out animation, and a one-click expand/collapse between a compact widget and the full window.

## Getting started

Prerequisites: [Node.js](https://nodejs.org), the [Rust toolchain](https://rustup.rs) (for Tauri), and a model backend — a running local [Ollama](https://ollama.com) instance is the fastest way to start.

```sh
cd ui
npm install
npm run tauri dev
```

Ollama is expected at `http://localhost:11434` by default — configurable in Settings, along with the OpenAI-compatible and Azure AI Foundry alternatives. See [`docs/getting-started.md`](docs/getting-started.md) for a fuller walkthrough — connecting each backend (including the one-time Azure setup), enabling tools, memory, autonomous runs, and governance telemetry.

## Project structure

- **`ui/`** — the actual app: Tauri (Rust) shell + React/TS frontend. See [`ui/README.md`](ui/README.md) for how the frontend is structured and where the backend seam is.
- **`docs/`** — public reference material ([`getting-started.md`](docs/getting-started.md), `system_info.md`; more may land here over time). Planning/decision history lives in a private, local-only vault that isn't part of this repo.
- **`harness/`** — early Python-based agent/harness experiments (Ollama tool-dispatch prototype), superseded by the live Rust/TS implementation in `ui/`.

## Status

Actively evolving, pre-1.0. One known cosmetic gap: real window transparency (Windows 11 Mica/Acrylic) doesn't render yet, so the app currently looks solid rather than glassy — the whole theme system is already built to pick it up automatically once that's resolved.
