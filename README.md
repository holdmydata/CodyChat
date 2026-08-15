<p align="center">
  <img src="codychatbanner.png" alt="CodyChat" width="720">
</p>

<p align="center">
  A custom, Ollama-backed desktop chat agent - for us, by me.
</p>

---

CodyChat is a Tauri (Rust) desktop shell around a React/TypeScript chat UI that talks directly to a local [Ollama](https://ollama.com) instance. It's built to work like an agentic coding assistant — real tool-calling with per-call approval, not just request/response chat — while staying fully local and model-agnostic.

## Features

- **Streaming chat** against any local Ollama model, with a collapsible "thought process" breakout for models that emit thinking tokens.
- **Real tool-calling, gated by explicit approval** — `read_file`, `write_file`, a patch-style `edit_file` (find/replace, not a full overwrite), `list_directory`, `search_files` (grep-like), and `execute_command` (shell). Every call shows a real in-app Approve/Deny prompt with a risk badge (Read-only / Write / Execute) before it runs — nothing executes silently.
- **MCP connector support** — hook up external [Model Context Protocol](https://modelcontextprotocol.io) servers as additional tools, alongside the built-ins, through the same approval flow.
- **Theme packs** — the whole UI reads colors from a small set of CSS variables, so a full reskin is just a shareable JSON palette. Built-ins: Auto (follows the OS), Light, Dark, and Psyduck Yellow. Import a pack by pasting JSON or picking a file.
- **Per-conversation settings** — system prompt, temperature / top-p / context length, and "save as custom model" (bakes a system prompt into a real Ollama model via `/api/create`).
- **Turn-flow activity graph** — see the actual shape of a run (thinking → tool call → tool call → answer) as a horizontal node chain, not just a flat log of steps.
- **Frameless widget-style window** — tray icon, corner-pop positioning, slide-in/out animation, always-on-top toggle.

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
- **`docs/`** — an Obsidian vault with the running planning/decision log, architecture notes, and task board. Start at `docs/MEMORY.md` if you want the full history of how this got built.
- **`harness/`** — early Python-based agent/harness experiments (Ollama tool-dispatch, [loopx](https://github.com/huangruiteng/loopx) control-plane integration).
- **`toys/kanban-reader/`** — a throwaway Tauri/Rust practice app (reads `docs/Kanban.md`), not part of the shipped product.

## Status

Actively evolving, pre-1.0. One known cosmetic gap: real window transparency (Windows 11 Mica/Acrylic) doesn't render yet, so the app currently looks solid rather than glassy — the whole theme system is already built to pick it up automatically once that's resolved.
