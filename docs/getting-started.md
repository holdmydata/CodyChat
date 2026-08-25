# Getting started

A practical walkthrough for running CodyChat for the first time — what to install, how to connect a model, and how to turn on the features that aren't on by default.

## Prerequisites

- [Node.js](https://nodejs.org) (for the frontend build)
- The [Rust toolchain](https://rustup.rs) (for Tauri — the desktop shell)
- A model backend to talk to. Pick one to start:
  - [Ollama](https://ollama.com) — the default, zero-config option. Install it, pull a model (`ollama pull qwen3.5:9b` or similar), and it's ready.
  - Any OpenAI-compatible server (llama-server, LM Studio, vLLM) — already running, with tool-calling enabled if you want tool use (llama-server: start it with `--jinja`).
  - Azure AI Foundry / Azure OpenAI — see [Connecting Azure AI Foundry](#connecting-azure-ai-foundry) below; this one needs some Azure-side setup before it'll work.

## Install and run

```sh
cd ui
npm install
npm run tauri dev
```

The first launch opens as a small corner-anchored widget. Click the expand icon in the titlebar for the full window.

## Connecting a backend

Open Settings (⚙ in the titlebar) → General → **Backend**. Three options:

- **Ollama** — point "Ollama base URL" at your instance (default `http://localhost:11434`). Pick a model from the dropdown once it loads.
- **OpenAI-compatible** — point "Server base URL" at your running server (e.g. `http://localhost:8080` for llama-server). There's no model list to pick from — whichever model the server was launched with is the one you get.
- **Azure AI Foundry** — see below.

### Connecting Azure AI Foundry

This one authenticates through your own Azure tenant, so there's real one-time setup on the Azure side before it'll work:

1. **Create an Entra ID App Registration** (Azure Portal → Microsoft Entra ID → App registrations → New registration). No redirect URI needed.
2. Under **Authentication** → **Advanced settings**, turn on **"Allow public client flows"**. Without this, sign-in fails outright.
3. Under **API permissions**, add a delegated permission for **Cognitive Services** (`user_impersonation`), and grant admin consent.
4. On the **Azure OpenAI / AI Foundry resource** you want to use, go to **Access control (IAM)** and assign yourself (or a group you're in) the **"Cognitive Services OpenAI User"** role. This is separate from step 1–3 — without it, sign-in succeeds but chat calls will fail with a 403. For more than a couple of people, create an Entra ID security group, assign the role to the group once, and manage membership there instead of per-user.
5. Copy the **Application (client) ID** and **Directory (tenant) ID** from the App Registration's Overview page.
6. In CodyChat: Settings → General → Backend → **Azure AI Foundry**, fill in Tenant ID, Client ID, the resource's bare endpoint hostname (not a `/api/projects/...` project URL — the plain host your own quickstart code samples use), and the deployment name you want to talk to. Click **Sign in with Microsoft** and follow the device-code prompt.

Each conversation's "Model" field should match the deployment name you're targeting — Azure deployments aren't listable from the app the way Ollama/OpenAI-compatible models are, so it's a plain text field, not a picker.

## Tool-calling and approvals

Every tool call — reading a file, running a shell command, fetching a URL — shows a real Approve/Deny prompt before it runs, with a risk badge (Read-only / Write / Execute). Nothing executes silently. Turn individual tools on/off, or auto-approve read-only calls, in Settings → Tools.

The model can also trigger a genuine multiple-choice prompt (via the `ask_user_choice` tool) instead of asking you to type a free-form reply — useful for "pick one of these options" questions.

## Memory

Your messages get indexed into a local vector store automatically (unless you turn it off per-conversation in Settings). The model can `search_memory` to pull in relevant context from past conversations on its own — nothing leaves your machine, there's no separate server process.

## Autonomous runs

Instead of one-shot chat, a conversation can run against a project's `AGENT_TASKS.md` — a plain Obsidian-Kanban-compatible markdown file with `## Ready` / `## Done` lanes. The loop picks the next unchecked task, runs it through the same tool-approval pipeline as normal chat, and checks it off with evidence when done. No external CLI or dependency — just a markdown file your project already has (or CodyChat creates one).

## Governance telemetry (optional)

If you want visibility into usage — tokens, estimated cost, duration, which user/model — across everyone using the app, point Settings → General → **Governance telemetry** at an Application Insights connection string (from that resource's Overview page in the Azure Portal). Every chat turn fires a best-effort `ChatCompletion` custom event; leave the field blank to skip this entirely.

## Theming

Settings → Theme has a handful of built-in packs (Auto, Light, Dark, Psycho Duck, League Hextech) and accepts custom packs — a small JSON file mapping a fixed set of CSS variables to colors. Import one by pasting JSON or picking a file.

## Where to go next

- [Root README](../README.md) for the full feature list.
- [`ui/README.md`](../ui/README.md) for how the frontend code is structured, if you're extending it.
