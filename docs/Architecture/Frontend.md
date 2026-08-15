# Frontend / UI

Parent: [[MEMORY]]

## Current state

`ui/` is a working React + Vite + TS chat scaffold — model picker, streaming chat, per-conversation system prompt/params panel, direct calls to a local Ollama instance. See `ui/README.md`. It is **not** the final shell (see delivery decision below) — treat it as a source of reusable content-pane components, particularly `ui/src/lib/ollama.ts` as the seam where a real harness replaces direct Ollama calls.

## Presentation paradigms considered

Three distinct paradigms were floated, deliberately treated as separate skins/apps sharing a data layer rather than one UI that morphs between them — they imply different data shapes and update rhythms:

1. **Newspaper/blog-style** — generations presented as a feed of discrete published artifacts/headlines, not a chat stream.
2. **Game-engine / SillyTavern-style** — character cards, avatars, roleplay-style chat, stat tracking.
3. **Jarvis/companion-style** — ambient overlay, minimal persistent chrome.

**Leaning:** newspaper/blog-style fits best as the first mode, because loopx's natural output (objectives, decisions, evidence — see [[Backend]]) already reads like discrete reports rather than roleplay turns. The other two are future/separate front-ends, not near-term work.

## Delivery shell: Tauri, not a webui

Decided against a plain browser SPA. Requirement is a desktop widget: click an icon, it pops up in a corner or comes to front, runs in its own window/shell, and can help drive the computer (see [[Backend]] re: nanoclaw-inspired skills). That's window-manager-level behavior a browser tab can't do, and retrofitting it onto browser-only assumptions (routing, layout) later is worse than deciding it up front.

**Chosen shape:** Tauri — Rust shell (window management, tray/corner-pop behavior, OS-automation surface) + the existing React content pane from `ui/` inside it. Also gives the standing interest in learning Rust a real, scoped job (the shell) rather than forcing it onto the whole app.

**Aesthetic target:** glass-style (glassmorphism), applied once shell/IPC layout is proven — restyling a working shell is cheap; styling a moving target isn't. See [[Timeline]] Phase 3. Sharpened spec (2026-08-14): real transparency (not just a frameless window), roughly **half-screen size** (current skeleton is a small 460x640 widget), and a **slide-in/out animation** on show/hide rather than the instant toggle it has now.

### Glass styling attempt (2026-08-14) — partial, transparency unresolved

**Working, user-confirmed live:**
- Half-screen default size, computed from `monitor.work_area()` (not `.size()`) in `setup()`, replacing the fixed 460x640.
- Slide-in/out animation: Tauri has no native window-position animation API, so `animate_slide()` steps `set_position()` on a background thread with an ease-out-cubic interpolation (16 steps, 220ms). `WebviewWindow` is a cheap `Send`+`Sync` handle clone, safe to move into the spawned thread.
- Corner-pop positioning, including a **real bug found and fixed**: the window ran partially under the taskbar because `resting_position()` originally used `monitor.size()`/`.position()`, which cover the *full* monitor including the area behind the taskbar. Switched to `monitor.work_area()` (a `PhysicalRect` with `.position`/`.size` fields) everywhere position/size math happens.

**Not working, despite three separate targeted fixes, each verified against source before writing code:**
1. `window_vibrancy::apply_mica()` + `"transparent": true` in `tauri.conf.json` — no visible effect (solid color).
2. Read window-vibrancy's own README: it explicitly documents that Tauri users must set `html, body { background: transparent }` (a literal transparent value, not a translucent color) or Mica can't composite at all. Fixed `index.css` accordingly (moved the translucent look to panel-level `--bg`/`--bg-alt` instead) — still no visible blur, just went from a solid color to solid grey.
3. Read window-vibrancy's actual Windows implementation (`windows.rs` in the crate source) and confirmed it correctly calls the modern `DWMWA_SYSTEMBACKDROP_TYPE` API — but never calls `DwmExtendFrameIntoClientArea`. For a **frameless** window (`decorations: false`), Mica needs a "glass sheet" (`-1`-margin frame extension) covering the client area or DWM has nothing to paint the backdrop material into and silently falls back to a flat fill. Added `extend_frame_into_client_area()` via direct `windows`/`raw-window-handle` crate calls (`Cargo.toml`: `windows` with `Win32_Foundation`, `Win32_Graphics_Dwm`, `Win32_UI_Controls` features — note `MARGINS` lives in `Win32::UI::Controls`, not `Win32::Graphics::Dwm`, despite the DWM function needing it) — **still no visible effect**.

Confirmed Windows' system-wide "Transparency effects" setting is on, ruling out the single cheapest explanation. **Next lead, not yet tried:** WebView2 has its own independent compositor background (`ICoreWebView2Controller2::put_DefaultBackgroundColor`) that may remain opaque regardless of what's applied to the native window behind it — a different layer than anything attempted so far. Moved to Backlog as an open investigation rather than left ambiguous. Worth restating: this entire problem lives at the Rust/native-Windows layer — TypeScript/React only ever controlled the CSS *colors* sitting on top, never the actual compositing.

### Live tool-dispatch in the chat UI (Phase 3, 2026-08-14) — the actual point of this project

Prompted directly: "It should be able to write files (with approval)... maybe have the ability to open a folder... kinda my whole thing with how we have it running" — i.e., work like Claude Code. See [[Backend]] for why this meant porting dispatch out of the standalone Python harness and into Rust, not extending the Python script.

**Rust (`src-tauri/src/skills.rs`):**
- `read_file` (200KB cap), `write_file` (errors if the parent directory doesn't exist, otherwise creates/overwrites), `list_directory` (capped at 500 entries, sorted). **Deliberately no path sandboxing** — approval, gated in the frontend before `invoke()` is ever called, is the safety boundary, matching how the user explicitly wants this to work.
- `get_tool_definitions` returns the JSON schemas as a single source of truth — the frontend fetches them via `invoke()` rather than keeping a hardcoded TS copy that could drift from the Rust command signatures.

**Streaming + tool calls:** verified via `curl` *before* writing frontend code that `tool_calls` arrive correctly in a **streamed** response — thinking tokens stream normally, then a complete `tool_calls` object arrives in one chunk (not token-by-token) while `done: false`, then a final `done: true` chunk. This meant the existing thinking-stream UX (built earlier this session) didn't need to be sacrificed for tool support. `lib/ollama.ts::streamChat` gained a `tools` param and an `onToolCalls` callback; a `WireMessage` type was introduced distinct from the UI `Message` type, since Ollama's replay format needs `tool_calls` echoed on assistant messages and `role: "tool"` result messages that don't fit the simple role/content shape.

**The agentic loop (`useChat.ts`):** `runTurn()` streams one turn; if `tool_calls` comes back, it awaits UI approval per call (a `Promise` resolved by `ToolApprovalPrompt` button clicks, stored in a ref so `stop()` can also resolve it as declined — otherwise hitting Stop mid-approval would hang forever), executes via `lib/skills.ts::executeSkill()` (maps tool name → matching `invoke()` call) or records a decline, appends the result as a wire message, and recurses. Bounded to 6 iterations to stop a runaway loop that never produces a final answer.

**UI:** `ToolApprovalPrompt.tsx` — inline Approve/Deny in the chat window, not a terminal prompt. `MessageBubble.tsx` renders tool-call chips (🔧 `name`(args)) and tool-result messages as a distinct compact bubble; the earlier "ran out of context" no-content fallback was updated so a tool-call-only assistant message (empty `content` by design) doesn't falsely trigger it.

**User-confirmed live, full loop, first real try:** asked `qwen3.5:9b` to write a file, saw the real approval prompt with real path/content args, approved, and the file was actually created in the correct folder — verified by the user opening it, not assumed. `write_file` is proven this way; `read_file`/`list_directory` share the identical dispatch path but haven't been individually exercised live yet (tracked in "To Test").

**Follow-up idea, not built:** a per-conversation "working directory" so the model doesn't need full absolute paths for every skill call — floated by the user immediately after the successful test.

### Live tool-call activity tracker + approval prompt polish (Phase 3, 2026-08-14)

After the tool-dispatch milestone landed, the user asked for a way to *see* what's happening during a turn with tool calls — explicitly comparing it to how Claude Code surfaces `TodoWrite` progress. Reframed the existing "popout run viewer"/"digest view" backlog items as answering a different question (project-level loopx state, a snapshot) — this is per-turn, in-conversation, live tool-call status, so it's a new component rather than a polish pass on the digest.

**`useChat.ts`:** added `ActivityStep` (`{ id, toolName, argsSummary, status, resultSummary? }`, `status` one of `pending_approval | running | done | denied | error`) and `activitySteps` state, reset at the start of every `sendMessage()` call. Populated from the same points in the agentic loop that already existed: `onToolCalls` pushes one step per call (`pending_approval`), the per-call approval/execute loop flips each step to `running` → `done`/`error`/`denied` as it resolves. No new data source — this rides the exact sequencing the loop already had, it just externalizes it as state instead of only mutating message content.

**`ActivityTracker.tsx`:** new component, renders the current turn's `activitySteps` as a compact list (status icon, tool name, truncated args, truncated result) — a checklist rather than the JSON-heavy tool-call chips already in `MessageBubble`. Rendered in `ChatWindow.tsx` only while `isStreaming` is true, so it's a live-turn view, not a permanent log (the message transcript already has that).

**`ToolApprovalPrompt.tsx` polish:** was an unconditional `JSON.stringify(args, null, 2)` dump — fine for a short path, unreadable for a full `write_file` content payload. Now shows one truncated line per argument by default with a "Show full arguments" toggle for the raw JSON when the user actually needs to verify exact content before approving.

**Shared helper:** `lib/format.ts` (`summarizeValue`/`summarizeArgs`, plain length-capped truncation) used by both the tracker and the approval prompt so truncation behavior stays consistent between the two.

`tsc --noEmit` clean. Not yet exercised live — no Rust changes this round, so no `cargo check` needed; tracked in [[Kanban]] "To Test."

### Real filesystem context auto-injected into the system prompt (Phase 3, 2026-08-14)

Surfaced immediately by a live test: asked the model to write an SVG into "my documents folder," and with no idea it was running on Windows or where anything actually lives, it guessed a Linux-style path (`/home/yellow_duck.svg`). One `write_file` call reported success (Windows resolves a leading `/` against the current drive, so it landed somewhere, just not the intended folder), then the model kept issuing more tool calls trying to locate/verify the real folder until it hit `MAX_TOOL_ITERATIONS` (6) — the safety cap did its job, but the underlying cause was that the model had zero grounding in the real filesystem. This is the lightweight half of the previously-backlogged "working directory concept" — OS-level facts, not yet per-conversation project scoping (that fuller version stays backlogged).

**Rust (`commands.rs::get_environment_info`):** reads `USERPROFILE` (falling back to `HOME`), reports `std::env::consts::OS` plus `home`/`documents`/`desktop`/`downloads` derived via `PathBuf::join` (correct separator per OS, no new crate dependency — deliberately not using the `dirs` crate since this project is Windows-first and the env-var lookup is a couple of lines).

**Frontend (`lib/environment.ts` → `useChat.ts`):** `getEnvironmentInfo()` invokes the command and maps snake_case to camelCase; `formatEnvironmentContext()` renders it as a short instructional block ("You are running on windows... Use these exact paths... do not guess or invent a path"). `useChat.ts` fetches it once per session (`envContextRef`, same lazy-fetch-once pattern already used for `toolsRef`/tool definitions) and prepends it ahead of the user's own per-conversation `systemPrompt` in every turn's history — both are optional and joined with a blank line, so an empty custom system prompt doesn't leave a stray separator.

`cargo check` and `tsc --noEmit` both clean. Not yet exercised live.

### First real dogfooding test (Phase 3, 2026-08-14) — tool dispatch works, small-model instruction-following was the real gap

Pointed `qwen3.5:9b` at the project's own `docs/` folder through the live chat UI: "read `docs/MEMORY.md` and `docs/Kanban.md`, then write a summary to `docs/Session-Summary-2026-08-14.md`." First attempt looked like a failure — the transcript showed a generic "I've reviewed your Kanban board, how would you like to work with it?" reply with no tool calls visible in the pasted text at all.

**Actually diagnosed by reading the full transcript, not guessed at:** both `read_file` calls *did* fire and returned the real file contents (verified by eye against the actual files — exact match). The model's own visible reasoning showed the real failure: after reading two large documents, one literally titled "Kanban," it talked itself into "the user hasn't asked me to do anything yet, I should ask how to help" instead of continuing to the write step it had already been given. Tool dispatch, streaming, and multi-call sequencing were never broken — a small model lost the thread on a compound (read → read → write) instruction once a lot of document content landed in context.

**Fix wasn't code — just a more imperative retry** ("now call write_file..."), which completed the full chain correctly. The written file was read back and verified accurate, not hallucinated. This also incidentally proves `read_file` live through the real UI (`write_file` was already proven; `list_directory` remains the one unexercised skill).

**Worth watching, not yet acted on:** if this recurs on other compound requests, the fix would likely be a short standing instruction in the auto-injected system context (same mechanism as the environment-context fix above) — something like "complete every step of a multi-step request, including file writes, without pausing to ask permission you already have." Not built since a single clearer prompt resolved it this time; revisit if it becomes a pattern rather than a one-off.

### Scroll-jacking during streaming fixed (Phase 3, 2026-08-14)

Surfaced by the user directly: couldn't scroll up to read earlier messages while a response was still streaming — the view kept snapping back to the bottom. Root cause: `ChatWindow.tsx`'s auto-scroll `useEffect` was keyed on `conversation.messages`, which changes on *every* streamed token and thinking-update (`onMessagesChange` replaces the array on each chunk in `useChat.ts`), so it unconditionally called `scrollTo` the bottom dozens of times a second during a response — overriding any manual scroll-up immediately.

**Fix:** the standard chat-UI "follow bottom unless the user has moved away" pattern. `shouldAutoScrollRef` tracks whether the user is within ~60px of the bottom, updated via an `onScroll` handler on `.chat-window__messages`; the auto-scroll effect only fires `scrollTo` when that ref is true. Re-armed (forced back to `true`) on sending a new message and on switching conversations, so the common case (you just sent something, or just opened a chat) still snaps to the latest content — it only backs off once the user has deliberately scrolled away during an in-progress response.

Pure frontend change, `tsc --noEmit` clean, hot-reloads in the already-running dev instance. Not yet manually re-verified.

### Persistent activity log (Phase 3, 2026-08-14)

Surfaced by the same session that hit the 6-call safety cap asking the model for "a new logo" — there's no image-generation tool (`write_file` is text-only; image-gen/ComfyUI stays a backlogged Phase 4 item), so the model presumably kept retrying something it fundamentally couldn't produce until it hit `MAX_TOOL_ITERATIONS`. Wanting to review what actually happened, the user found the `ActivityTracker` checklist had already vanished — it's pure ephemeral state, only rendered while `isStreaming` is true.

**Fix:** `Message` (`types.ts`) gained an optional `activitySteps?: ActivityStep[]` field. `ActivityStatus`/`ActivityStep` moved from `useChat.ts` into `types.ts` (the shared type file) so `Message` could reference them without a circular import; `useChat.ts` re-exports both for existing consumers. A new `activityStepsRef`, updated in lockstep with the `activitySteps` state via a small `updateActivitySteps` wrapper, lets the code read the *current* full step list synchronously (state alone would risk a stale closure read at the moment of stamping). The accumulated list gets stamped onto whichever message concludes the turn — the final-answer message (the `if (!toolCalls)` branch, meaning this round produced no further calls) or the max-iterations stop notice — so a turn that spans several tool-call rounds still gets one consolidated log on its last message, not one per round.

**UI:** `MessageBubble.tsx` renders it as a collapsed-by-default "Activity log (N steps)" breakout, structurally identical to the existing thinking-block toggle, reusing `ActivityTracker`'s exported `STATUS_ICON` map so the live and persisted views look the same.

`tsc --noEmit` clean, pure frontend, hot-reloads in the running dev instance. Not yet manually re-verified.

### 500 mid-dogfood diagnosed: context overflow, not a wire-format bug (Phase 3, 2026-08-14)

Hit live during the ActivityTracker.tsx restyle dogfood test (reading `App.css` on top of an already-substantial conversation): `Chat request failed: 500 Internal Server Error`, with no further detail surfaced in the UI.

**Diagnosed via the actual Ollama server log** (`%LOCALAPPDATA%\Ollama\server.log`), not guessed — same investigative pattern as the earlier "stuck on Thinking forever" bug. Found the real error: `srv operator(): got exception... Jinja Exception: No user query found in messages` — the model's own chat template (Qwen-family tool-calling templates commonly scan backward through messages for the last real user turn) raised a hard validation exception rather than silently degrading. The request immediately before the failure was already `n_tokens = 6386` of `n_ctx_slot = 8192` (~78% full, `n_keep = 4` — almost nothing preserved on a trim); the next request's added content plausibly pushed Ollama's context-fitting logic to trim the original user message out of what the template ever saw. **Same root cause class as the earlier context-truncation bug** — this model/template just fails loudly instead of silently going blank.

**Ruled out a real alternative hypothesis before settling on this one:** initially suspected the wire format was missing `tool_call_id` (confirmed true — `Message.toolCallId` existed but `toWireMessages` silently dropped it, sending bare `{role: "tool", content: "..."}` with nothing linking a result to its call). Tested this directly against the live Ollama instance via `curl` with several reproductions closely matching the real scenario — sequential tool-call rounds, five rounds deep, and multiple tool calls returned in a single assistant turn (parallel calls, the case most likely to need an ID for disambiguation) — **none reproduced the 500**, which is what pointed back to context size as the actual driver rather than message shape.

**Fixed two things regardless:**
1. `WireMessage` gained `tool_call_id`; `toWireMessages` now includes it for tool-role messages. A genuine correctness gap independent of whether it caused this specific incident.
2. `streamChat` (`lib/ollama.ts`) now reads and surfaces Ollama's actual error response on failure (parses `error`/`error.message` from JSON, falls back to raw text) instead of throwing a bare status code, plus appends a context-overflow hint specifically on 500s. The next time this happens, the UI will say something actionable instead of a generic "500 Internal Server Error."

Practical mitigation for the user in the meantime: start a fresh conversation or raise context length in Settings before dogfood turns that read large files. Also reinforces the already-backlogged search/grep-tool idea — full-file reads burn context fast, and this is a second, independent reason (not just `read_file`'s byte cap) to prefer targeted excerpts over whole-file reads once a real search tool exists.

`tsc --noEmit` clean. Not yet manually re-verified live.

### Real shell built (2026-08-14)

Added `src-tauri/` directly to the existing `ui/` project via `tauri init --ci` (identifier `dev.meansquares.shell`) — not a new scaffold, since `ui/`'s React components already are the intended content pane. Tracked under its own loopx goal (`meansquares-shell-goal`, project = `ui/`), separate from the toy's goal.

- **Window:** frameless (`decorations: false`), 460x640 default (bumped from an initial 380x560 that smooshed the sidebar+chat layout in testing), resizable, `shadow: true`.
- **Tray icon:** menu with Show/Hide, Pop to Corner, Toggle Always on Top, Quit. Left-click toggles visibility. `pop_to_corner` positions the window at the primary monitor's bottom-right (24px margin) via `window.primary_monitor()` + `set_position()`.
- **Always-on-top:** tracked via an `AtomicBool` in Tauri app state (`WebviewWindow` has no getter for its own always-on-top state), toggled via `set_always_on_top()`.
- **Drag-to-move:** `data-tauri-drag-region` on a titlebar div in `App.tsx`, containing a sidebar-collapse toggle button. **Gotcha worth remembering:** Tauri v2 requires an explicit `core:window:allow-start-dragging` permission in `capabilities/default.json` for the drag region to actually work — it's not in the default `tauri init` scaffold (only `core:default`), so dragging silently failed (a rejected-promise console error, not a build error) even though everything else about the drag region looked correctly wired. Interactive children (the toggle button) inside a drag-region element still receive normal clicks without extra config.
- **Sidebar:** collapsible via the titlebar toggle, state persisted to `localStorage`, defaults to expanded.

### loopx digest view (Phase 2, 2026-08-14)

A second titlebar toggle swaps the chat view for `LoopxDigest.tsx` — a newspaper/blog-style feed of cards, one per tracked loopx goal (todo counts, quota state, next queued item). Polls a `get_loopx_digest` Tauri command every 8s via `invoke()`, with an in-flight guard so overlapping WSL round-trips don't stack up.

**Architecture note — no separate server.** The first version was an HTTP status server (`harness/status_server.py`, Python stdlib) that the frontend polled via `fetch`. User feedback was clear: didn't want a process they had to remember to start manually. Rewrote as a direct Tauri command (`src-tauri/src/commands.rs::get_loopx_digest`) that shells into WSL itself — `Command::new("wsl").args([...])`, parses with `serde_json::Value`. This duplicates the WSL-shell-out logic that already exists in `harness/loopx_client.py::goal_digest()` (same fields extracted, same loopx CLI call), but the duplication is small (~60 lines) and worth it: no runtime dependency on a Python process staying alive. `status_server.py` was deleted rather than left around unused. See [[Backend]] for the loopx-side detail.

**Known limitation, called out explicitly to the user:** this is a *snapshot* (todo counts + next item), not a live "agent is doing X right now" feed. A genuinely live activity view needs an actual autonomous loop running and reporting as it works — see the popout-run-viewer idea on [[Kanban]].

### Thinking breakout + streaming-state bug (Phase 3, 2026-08-14)

`message.thinking` streams the same way `content` does — Ollama emits `chunk.message.thinking` deltas before `content` starts, `lib/ollama.ts::streamChat` now has an `onThinking` callback alongside `onToken` for it. `MessageBubble.tsx` renders it as a collapsed-by-default breakout above the answer (label: "Thinking…" while active, "Thought process" once content starts), matching the Claude/ChatGPT-style click-to-expand pattern.

**Real bug, found via user report and diagnosed properly rather than guessed at:** a response got stuck showing "Thinking…" indefinitely. Checked the actual `llama-server` runner process (`Get-Process`, found by memory footprint rather than an obvious name) and Ollama's `server.log` rather than assuming either "it's just slow" or "my code is broken." The request had genuinely completed — 200 OK, 1m31s — but hit `n_ctx_slot=4096` and got `truncated=1` while still in the thinking phase, so `content` stayed empty forever. **The actual bug was in the UI's state derivation, not Ollama or the model:** "still thinking" was computed only from the message's own fields (thinking non-empty, content empty), with no reference to whether the stream had actually ended — so a thinking-only truncated response was indistinguishable from one still in progress. Fix: `ChatWindow` now passes `isStreaming` only to the currently-active (last) message; `MessageBubble` shows an explicit "no response — likely ran out of context" message once a stream ends with no content, instead of an ambiguous forever-pending state. Also bumped `DEFAULT_PARAMS.numCtx` 4096→8192 (new conversations only) to make this less likely to recur on substantive questions to thinking models — flagged as a real RAM/VRAM tradeoff, not a free change.

### Model info in Settings (Phase 3, 2026-08-14)

`lib/ollama.ts::showModel()` calls `/api/show`, returns `{ capabilities, parameterSize, quantization, contextLength }`. The context-length field is family-prefixed in Ollama's `model_info` (e.g. `qwen35.context_length`, would be `llama.context_length` for a different family) — no fixed key name, so `findContextLength()` scans for whichever key ends in `.context_length` rather than hardcoding one.

`SettingsPanel` fetches this on model change, shows param size/quantization/capabilities (as badges) above the existing fields, and makes the context-length slider's `max` track the model's real limit instead of a fixed 32768 — clamping the saved value down if switching to a shorter-context model leaves it out of range.

**Turned up a real finding along the way:** `/api/show`'s `capabilities` list for the local 27B build includes `tools` — unlike `/api/tags`'s list, which didn't. The two endpoints report inconsistent capability lists for the same model; the earlier "missing tools capability" wrinkle (see [[Backend]]) wasn't a real gap, just querying the less-complete endpoint.

**Built (2026-08-14): custom model creation.** `lib/ollama.ts::createModel(baseUrl, name, from, system)` — POST `/api/create` with `stream:false`. Verified live before writing any code (real create + `/api/show` verify + delete cycle via curl, Ollama `0.32.12`): near-instant, since it layers a system prompt onto an existing model rather than copying/downloading weights — no streaming/progress UI needed. `SettingsPanel` gained a "Save as custom model" row (name input, sanitized to Ollama's allowed charset, disabled until a model + non-empty system prompt exist); `ModelPicker` gained a `refreshKey` prop so `ChatWindow` can force a re-fetch after a successful save, so the new model shows up without an app restart. This is genuinely separate from the per-conversation system prompt setting above — that's local-only; this persists a real named Ollama model other tools can also see.

### Real Markdown rendering (Phase 3, 2026-08-14)

Previously `MessageBubble.tsx` only special-cased triple-backtick fences with a hand-rolled regex split — headers, bold, lists, links all showed as literal text. Replaced with `react-markdown` (renders straight to React elements rather than an HTML string, so no `dangerouslySetInnerHTML`/sanitization step is needed for model-generated content) plus `remark-breaks` (treats single newlines as line breaks — models format with those constantly, and strict CommonMark would otherwise mash consecutive lines into one paragraph). Custom `code` component distinguishes inline vs. fenced code by checking for a `language-xxx` className (react-markdown v10 dropped the old `inline` prop that used to make this trivial).

### Real write collision during ui/src/ dogfooding (Phase 3, 2026-08-14)

After the context-overflow fix, retried the `ActivityTracker.tsx` restyle dogfood test in a fresh conversation. The model's result was genuinely good: a vertical timeline with connector lines between steps (colored by status), a pulsing accent ring on the in-progress step, a dashed ring for "awaiting approval," `prefers-reduced-motion` support, and `role="list"`/`role="listitem"`/`aria-label` accessibility — while correctly preserving the `STATUS_ICON` export and `steps` prop exactly as instructed, and correctly leaving the `.activity-tracker--log` (persisted-log) modifier alone.

**While that turn was in flight, a separate concurrent edit was also being made to the same file** — the "jump to latest" scroll button's CSS. The model's `write_file` for `App.css` landed after and, being a full-file overwrite (not a patch), silently dropped the concurrent rules. Caught immediately via `git diff` — only possible because git had been set up earlier in this same session specifically anticipating this class of risk — confirmed exactly what was lost, and reapplied it on top of the model's redesign without touching its work. `tsc --noEmit` confirmed everything still compiled together afterward.

This is the first *concrete* evidence (not a predicted risk) that a patch/diff-style edit tool is needed — promoted in [[Kanban]] Backlog with this incident as direct justification, ahead of the more speculative "would help with a large file" framing it had before.

Separately: the model also overthought this task (re-attempting the same kind of change repeatedly rather than converging), hitting the 6-call safety cap again — the second time this exact pattern has happened (the duck SVG test was the first). See the "converge quickly" instruction added below in response.

### Standing "converge quickly" instruction (Phase 3, 2026-08-14)

Two separate real incidents — the duck SVG write test and the ActivityTracker.tsx CSS restyle above — both ended the same way: the model kept re-attempting the same kind of change speculatively instead of converging on an answer, burning through most of `MAX_TOOL_ITERATIONS` (6) before the safety cap fired. Flagged the first time as a "watch item, not worth fixing on one occurrence"; the second occurrence crossed that bar.

**Fix:** `AGENT_BEHAVIOR_HINT` (`useChat.ts`) — a short standing instruction ("work efficiently... converge on a final answer within a few tool calls... don't loop trying to perfect it"), always folded into the system prompt via the same `systemParts` mechanism as the environment-context fix, ahead of environment facts and the user's own system prompt. Pure text, no new hooks — unlike earlier edits to this area, this one can't trigger the hook-count HMR crash class.

`tsc --noEmit` clean. Not yet manually re-verified whether it actually reduces the overthinking pattern.
