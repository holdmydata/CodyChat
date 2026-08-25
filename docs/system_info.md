# System Info — AI Agent Memory & Architecture

A living record of this AI harness's capabilities, memory system, and how it all works together.

## What this system is

- A **local-first** desktop application built with:
  - **Tauri** (Rust) for the desktop shell + native IPC commands
  - **React + TypeScript** for the chat UI and tool-call wiring
  - **Ollama** running locally as the LLM engine (`qwen3.8-27b` main model, `qwen3.5:9b` for dispatch)
  - A plain per-project `AGENT_TASKS.md` (Obsidian-Kanban-plugin markdown) as the task source for autonomous loops — no external process

## Core architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Desktop Window (Tauri)                  │
│  ┌─────────────────┐  ┌───────────────────────────────────┐ │
│  │   Titlebar      │  │  Chat / Message Area              │ │
│  │ (theme picker,  │◄─┤  - React components render         │ │
│  │  settings, etc) │  │    messages, tool calls            │ │
│  └─────────────────┘  │  - Streaming thinking tokens       │ │
│                       │    streamed + rendered inline       │ │
│  ┌─────────────────┐  │  - Tool approval prompts           │ │
│  │  Activity Log   │  │    (in-app & OS toast)             │ │
│  │ (turn-flow)     │  │                                     │ │
│  └─────────────────┘  └───────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Skill Dispatch Layer (Rust)                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  skills.rs: read_file, write_file, edit_file,           │ │
│  │         list_directory, search_files, execute_command,  │ │
│  │         mcp_call_tool, web_fetch                         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                       ▲                                      │
│                  StreamChat loop (bounded)                   │
│                    - useChat.ts                              │
│                    - context budgeting                        │
│                    - tool call approval gating                 │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Ollama API (localhost:11434)               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  /api/chat                                               │ │
│  │    - models: qwen3.8-27b, qwen3.5:9b                     │ │
│  │    - tools: native JSON-RPC tool calling                  │ │
│  │    - thinking mode: streamed thinking tokens              │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Memory system: `search_memory` + vector store

### Architecture

- **Backend**: `sqlite-vec` extension to SQLite (no separate server)
- **Embeddings**: `nomic-embed-text` model via Ollama (`/api/embed`)
- **Retrieval**: KNN search with metadata filtering (`source_type`, `conversation_id`)
- **Tool**: `search_memory(file_path?, source_type?, conversation_id?)` 
  - Model-approved read-only tool (gated, not always-on)
  - Called via the standard approval pipeline

### Memory item types

| source_type | Description |
|--------------|-------------|
| `web_page` | Fetched pages from `web_fetch` skill |
| `file_read` | Files indexed via `read_file` + `remember: true` |
| `agent_evidence` | Autonomous-loop task execution evidence (from `buildEvidence()`) |
| `code_output` | Build artifacts, game outputs, etc. |

### How retrieval works

1. User asks a question in chat
2. Model decides to call `search_memory` (via tool-calling)
3. Tool approval prompt appears (auto-approved for read-only by `autoApproveReadOnly` setting)
4. Rust command queries sqlite-vec KNN
5. Results filtered by `source_type` and injected into context
6. Model synthesizes answer using retrieved info

### Why this matters

- **Cross-conversation memory**: Facts persist across chat sessions
- **Document-aware**: "This is a PDF about X" vs. "this is code for Y"
- **Privacy-preserving**: Everything local, no cloud backend
- **Opt-in indexing**: `remember: true` flag on file reads (not automatic)

## MCP Tool Connector

### Design

- Hand-written JSON-RPC 2.0 stdio client in Rust (`src-tauri/src/mcp.rs`)
- Per-server connection state keyed by server ID
- Tools qualified as `mcp__<serverId>__<toolName>` (Claude-compatible naming)
- Merged into Ollama's tool list via `useChat`

### Connection lifecycle

1. User adds config in Settings → Tools → MCP Servers
2. Click "Connect" spawns subprocess (`npx server.js`, etc.)
3. stdio handshake (`initialize` request/response)
4. `tools/list` call returns available tools
5. Subsequent calls routed via background thread + channel map

### Connection posture

- **Manual connect only** (no auto-connect on launch)
- Arbitrary external processes (`.cmd`, `.bat`, anything the user configures)
- Uses existing `execute_command` wrapper for Windows shims (`npx`, etc.)

## Theme Pack System

### Architecture

- UI consumes colors exclusively from ~12 CSS custom properties (`--bg`, `--text-h`, etc.)
- Theme pack = JSON object of `{ id, name, vars: { --var-name: value } }`
- Packs injected via `<style>` block scoped to `:root[data-theme="…"]`
- Validation: IDs/names regex-checked, values must be plain color literals

### Built-in packs

- `auto`: Uses system preference (no explicit `data-theme`)
- `light` / `dark`: Base palettes
- `psyduck-yellow`: First accent variant
- `cody-duck`: Brand colors (Cody's duck)
- Plus any imported community packs

### Security posture

Untrusted pack input → inject CSS text:
- Unknown vars are skipped (forward-compatible)
- Invalid entries skipped rather than failing the whole pack
- Never injects non-color values or malicious CSS

## Presentation Modes

### Chat view (default)

- Flat, scrollable message stream
- Supports thinking tokens + tool-call renderings
- Markdown rendering (`react-markdown` + `remark-breaks`)

### Spatial/3D view

- Three.js-based presentation mode
- Swappable with chat view (not a replacement)
- For companion character or game-menu-style presentations

## Glass/Mica Transparency Status

**Ongoing investigation**: Windows Mica/Acrylic backdrop not rendering despite:
- Correct `tauri.conf.json` `"transparent": true` setting
- WebView2 HTML transparency (`html, body { background: transparent }`)
- `DwmExtendFrameIntoClientArea` frame recalc attempt

This is a native-Windows-compositor issue, not TypeScript/Rust code. Next leads after exhausting local source reading: external Windows API research or accepting the limitation while keeping "glass-ready" translucent colors.

## Known limitations (honest documentation)

1. **Mica transparency**: Still bugged on Windows (compositor + WebView2 interaction)
2. **Font customization**: Requires local font installation (no bundling of Google Fonts)
3. **Image generation**: Ollama vision models can't generate images; needs separate ComfyUI/SDXL backend (Phase 2+)
4. **Context overflow**: Large file reads can still exceed model context; retry logic helps but not guaranteed
5. **Memory embeddings**: `nomic-embed-text` is general-purpose, not code-specialized

## Future direction

- **Enterprise packaging**: Tauri bundler in place (`tauri build`), installer tested
- **Multi-backend chat**: Abstract Ollama out so Databricks/Azure AI Foundry can be added as alternatives
- **Autonomous run UI**: `AGENT_TASKS.md`-driven agent loops with visible activity feed
- **Memory graph visualization**: KNN-based node graph showing memory item relationships

---

*Last updated: 2026-08-17*  
*Maintained by the app itself and its owner's notes*  
*[If you're reading this via `search_memory`: this file documents the AI system that wrote it!]* 🦆💫