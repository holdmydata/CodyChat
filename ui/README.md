# CodyChat frontend

The Tauri (Rust) + React/TypeScript app described in the [root README](../README.md). This doc is about how the code itself is laid out, for anyone extending or reading through it.

## Run it

```sh
npm install
npm run tauri dev
```

A local Ollama instance (or another backend — see below) needs to be reachable at whatever base URL Settings is pointed at (default `http://localhost:11434`).

## Backend seam

Three interchangeable backend modules, one per `ChatBackend` value, each exporting a `streamChat` (and where applicable `showModel`/`listModels`) with the same shape:

- `src/lib/ollama.ts` — Ollama's native `/api/*` wire format. The original, most fully-featured backend (model creation/baking, embeddings, `/api/show` metadata).
- `src/lib/openaiCompat.ts` — the OpenAI-compatible chat-completions format shared by llama-server/LM Studio/vLLM. Exports `streamOpenAIWireChat`, the actual SSE-parsing implementation — reused by `azureFoundry.ts` rather than duplicated.
- `src/lib/azureFoundry.ts` — Azure AI Foundry / Azure OpenAI, deployment-addressed and Entra-token-authed (token acquisition lives in Rust, see below). Delegates to `openaiCompat.ts`'s shared SSE parser.

`src/hooks/useChat.ts` picks the right module via a small lookup table (`CHAT_BACKENDS`) and drives everything else — streaming, the tool-calling loop, context-window budgeting/retry, activity logging — identically regardless of which backend is active. Swapping in your own backend means adding a fourth module with the same shape and a case in that lookup.

## Tool-calling loop

`useChat.ts`'s `runTurn` is a bounded agentic loop: stream a reply, and if the model requests tool calls, run each one through an approval gate (`requestApproval`) before executing it via `src/lib/skills.ts::executeSkill`, feed the results back, and recurse (capped by `MAX_TOOL_ITERATIONS`). Tool JSON schemas are single-sourced from the Rust side (`src-tauri/src/skills.rs::get_tool_definitions`) rather than duplicated in TS.

The approval resolver carries `boolean | string`, not just a yes/no — a string resolution is used directly as the tool's result. This is what lets `ask_user_choice` (a tool that presents clickable options instead of running anything) reuse the exact same pause/resume mechanic as every other tool, rendered by `ChoicePrompt.tsx` instead of the normal `ToolApprovalPrompt.tsx`.

MCP (Model Context Protocol) servers plug into the same tool list — `src/lib/mcp.ts` + `src/hooks/useMcpServers.ts` own server config/connection state, `src-tauri/src/mcp.rs` owns the actual subprocess + JSON-RPC stdio client.

## Other structure

- `src/types.ts` — `Message`, `Conversation`, `ChatParams`, `ToolCall`.
- `src/hooks/useConversations.ts` — conversation CRUD, persisted to `localStorage`.
- `src/hooks/useAzureAuth.ts` — Entra device-code sign-in state; the actual token acquisition/refresh/keyring storage lives in `src-tauri/src/azure_auth.rs`.
- `src/hooks/useAutonomousLoop.ts` — drives a conversation against a project's `AGENT_TASKS.md` (see `src/lib/tasks.ts` / `src-tauri/src/tasks.rs`) instead of one-shot chat.
- `src/lib/memory.ts` — vector memory client (`search_memory`/indexing), backed by `src-tauri/src/memory.rs` (sqlite-vec, no separate server).
- `src/lib/governance.ts` — best-effort Application Insights telemetry per model call, across every backend.
- `src/lib/themes.ts` — theme packs (see below).
- `src/components/` — `Sidebar`, `ModelPicker`, `SettingsMenu`/`SettingsPanel`, `AzureSettings`, `ThemePicker`, `ChatWindow`, `MessageBubble`, `MessageInput`, `ToolApprovalPrompt`/`ChoicePrompt`, `DuckPanel` (companion), `MemoryGraphView`, `TaskDigest`. Each is a plain, single-purpose component.

## Themes

Every component reads colors exclusively from the CSS custom properties in `src/index.css` — no hardcoded colors — so a complete reskin is just a new palette. That palette is a **theme pack**: a small shareable JSON object (`{ id, name, author?, description?, scheme?, vars, font? }` where `vars` maps CSS variable names to color values).

- **Built-in packs** (`lib/themes.ts`): `auto` (follows the OS light/dark setting — the default), `light`, `dark`, `psycho-duck`, and `hextech` (League of Legends-inspired). Built-ins are defined in TS rather than CSS so the picker can render them with swatches and blurbs; their values mirror the base/system-dark palettes in `index.css` — if you restyle `index.css`, update them to match.
- **Importing packs**: the 🎨 titlebar picker (or Settings → Theme) accepts a pasted JSON object or a pack file (read through the `read_theme_pack` Tauri command). Pack files are untrusted input — `sanitizeThemePack` regex-checks every id/var-name and requires plain color literals before anything is injected; invalid entries are skipped, never applied. Unknown `vars` keys are skipped rather than failed, so a pack can introduce a variable a future component uses.
- **Applying**: `data-theme` on `<html>` + a persistent `<style>` element injecting the pack's variables scoped to `:root[data-theme="…"]`.
- Theme is **app-level**, not per-conversation. Active theme persists to `ollama-ui:active-theme`, imported packs to `ollama-ui:themes` — same `localStorage` pattern used throughout Settings.
