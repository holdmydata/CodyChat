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
- `src/types.ts` — `Message`, `Conversation`, `ChatParams`.
- `src/hooks/useConversations.ts` — conversation CRUD, persisted to `localStorage`. Swap for a real backend/store later.
- `src/hooks/useChat.ts` — send/stream/abort logic for the active conversation.
- `src/components/` — `Sidebar`, `ModelPicker`, `SettingsPanel` (system prompt, temperature, top_p, context length, base URL), `ChatWindow`, `MessageBubble`, `MessageInput`. Each is a plain, single-purpose component with no cross-cutting state — compose or replace freely.

## Notes

- Streaming, abort (Stop button), and per-conversation system prompt / sampling params all work end-to-end against a real Ollama instance.
- Markdown rendering is intentionally bare (code fences only) — swap in a real renderer in `MessageBubble.tsx` when you need it.
- Model "thinking" tokens (for models that emit them) are received but not rendered — only `message.content` is shown. Surface `message.thinking` in `MessageBubble` if you want to expose reasoning traces.
