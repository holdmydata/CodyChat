# References

Parent: [[MEMORY]]

- [loopx](https://github.com/huangruiteng/loopx) — control-plane/state kernel for long-running agent work. Python 3.11+, stdlib-only, MIT. See [[Architecture/Backend]].
- [nanoclaw](https://nanoclaw.dev/) — personal-agent runtime: Node.js host, per-session Docker containers (Bun + Claude Agent SDK), skill registry, credential vault, messaging-first. See [[Architecture/Backend]].
- [Ollama API](http://localhost:11434) — local instance used for all model calls so far. Relevant endpoints: `/api/tags` (list models), `/api/chat` (streaming chat). Client implementation validated in `ui/src/lib/ollama.ts`.
- Main model: [`unsloth/Qwen3.8-27B-GGUF`](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) — 27B dense hybrid (Gated-DeltaNet + Gated-Attention layers), 262K context extendable to 1M, thinking mode on by default, vision-capable (image/video input, cannot generate images), upstream-designed for tool-calling and long-horizon agentic tasks. See [[Architecture/Backend]] for the local-build tool-calling caveat.
- Small tool-calling-capable local models (for dispatch, per [[Architecture/Backend]]): `gemma4:26b`, `qwen3.5:9b`.
