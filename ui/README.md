# Ollama Chat UI

A minimal, modular chat UI for Ollama — not the stock Open WebUI, built to be read top-to-bottom and extended.

## Run it

```
npm install
npm run dev
```

Ollama must be reachable at the base URL set in the Settings panel (default `http://localhost:11434`). If you serve the UI from anywhere other than `localhost:5173`, add that origin to `OLLAMA_ORIGINS` before starting Ollama, e.g.:

```
setx OLLAMA_ORIGINS "http://localhost:5173"
```

## Structure

- `src/lib/ollama.ts` — the only file that talks to Ollama's HTTP API (`/api/tags`, `/api/chat` streaming). This is the seam to swap in your own harness: replace `streamChat`/`listModels` with calls into your backend and nothing else in the app needs to change.
- `src/lib/themes.ts` — theme packs: the registry (built-in packs), import/sanitize (packs are shareable JSON — the file IS the pack), persistence, and apply (CSS variables injected scoped to `data-theme`). See below.
- `src/types.ts` — `Message`, `Conversation`, `ChatParams`.
- `src/hooks/useConversations.ts` — conversation CRUD, persisted to `localStorage`. Swap for a real backend/store later.
- `src/hooks/useChat.ts` — send/stream/abort logic for the active conversation.
- `src/components/` — `Sidebar`, `ModelPicker`, `SettingsPanel` (system prompt, temperature, top_p, context length, base URL), `ThemePicker` (titlebar 🎨 popover: pick a pack, import packs by pasted JSON or file), `ChatWindow`, `MessageBubble`, `MessageInput`. Each is a plain, single-purpose component with no cross-cutting state — compose or replace freely.

## Themes

Every component reads colors exclusively from the CSS custom properties in `src/index.css` — no hardcoded colors — so a complete reskin is just a new palette. That palette is a **theme pack**: a small shareable JSON object (`{ id, name, author?, description?, scheme?, vars }` where `vars` maps CSS variable names to color values).

- **Built-in packs** (`lib/themes.ts`): `auto` (follows the OS light/dark setting — the default), `light`, `dark`, and `psyduck-yellow` (first accent-variant pack). Built-ins are defined in TS rather than CSS so the picker can render them with swatches and blurbs; their values mirror the base/system-dark palettes in `index.css` — if you restyle `index.css`, update them to match.
- **Importing packs**: the 🎨 titlebar picker (next to the ☰/⚙ toggles) accepts a pasted JSON object or a pack file (read through the `read_theme_pack` Tauri command). Pack files are untrusted input — `sanitizeThemePack` regex-checks every id/var-name and requires plain color literals before anything is injected; invalid entries are skipped, never applied. Unknown `vars` keys are skipped rather than failed, so a pack can introduce a variable a future component uses.
- **Applying**: `data-theme` on `<html>` + a persistent `<style>` element injecting the pack's variables scoped to `:root[data-theme="…"]` (which beats both the base palette and the system-dark override, now scoped to `:root:not([data-theme])` in `index.css`). All pack colors stay translucent `rgba()` on purpose — they're meant to pick up the Mica/Acrylic backdrop once that's rendering (see `docs/Kanban.md` Backlog).
- Theme is **app-level**, not per-conversation (the Settings panel stays model/prompt/params only). Active theme persists to `ollama-ui:active-theme`, imported packs to `ollama-ui:themes` — same `localStorage` pattern as the base URL and sidebar state.

## Notes

- Streaming, abort (Stop button), and per-conversation system prompt / sampling params all work end-to-end against a real Ollama instance.
- Markdown rendering is intentionally bare (code fences only) — swap in a real renderer in `MessageBubble.tsx` when you need it.
- Model "thinking" tokens (for models that emit them) are received but not rendered — only `message.content` is shown. Surface `message.thinking` in `MessageBubble` if you want to expose reasoning traces.
