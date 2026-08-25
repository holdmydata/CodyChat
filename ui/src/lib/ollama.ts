import type { ChatParams, ToolCall } from '../types';

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

// The wire shape Ollama's /api/chat expects — distinct from the app's
// Message type, which carries UI-only fields (id, thinking, createdAt).
// Assistant messages that requested tool calls need tool_calls echoed back
// on replay; tool result messages use role "tool".
export interface WireMessage {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  /** Present on 'tool' role messages — links a result back to the call it answers. */
  tool_call_id?: string;
  /** Base64 image data, no `data:` prefix — Ollama's vision-model input format. */
  images?: string[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface StreamChatArgs {
  baseUrl: string;
  model: string;
  messages: WireMessage[];
  params: ChatParams;
  signal: AbortSignal;
  tools?: unknown[];
  onToken: (token: string) => void;
  onThinking?: (token: string) => void;
  onToolCalls?: (calls: ToolCall[]) => void;
  /** Fired once, when the backend reports prompt/completion token counts for the turn — see lib/governance.ts. Not every backend/response shape includes this. */
  onUsage?: (usage: TokenUsage) => void;
}

export interface BakedParams {
  numCtx?: number;
  temperature?: number;
  topP?: number;
}

// Architecture fields needed to estimate KV-cache size for the RAM/VRAM
// forecaster (resourceForecast.ts) — how much extra memory a given context
// length actually costs, not just the model's own weight size. Any of
// these can be null if a particular model's model_info doesn't expose them
// (older/nonstandard exports), in which case the forecaster falls back to
// a flatter estimate instead of a hard failure.
export interface ModelArchInfo {
  numLayers: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  /** Grouped-query attention uses fewer KV heads than query heads — falls back to headCount (== standard multi-head attention) when absent. */
  headCountKV: number | null;
}

export interface ModelInfo {
  capabilities: string[];
  parameterSize: string;
  quantization: string;
  contextLength: number | null;
  /** The Modelfile's baked-in SYSTEM prompt, e.g. from a custom model saved via createModel/'Save as custom model'. Empty for a plain base model. */
  system: string;
  /** Sampling params baked into the Modelfile (PARAMETER lines) — distinct from contextLength, which is the model's max, not a saved preference. */
  bakedParams: BakedParams;
  arch: ModelArchInfo;
}

// status/likelyContextOverflow let callers (useChat.ts's retry logic)
// distinguish "the conversation is probably too large for numCtx" from any
// other failure, without re-parsing the message string.
export class OllamaError extends Error {
  status?: number;
  likelyContextOverflow?: boolean;

  constructor(message: string, opts?: { status?: number; likelyContextOverflow?: boolean }) {
    super(message);
    this.status = opts?.status;
    this.likelyContextOverflow = opts?.likelyContextOverflow;
  }
}

const CONTEXT_OVERFLOW_HINT =
  ' (often means the conversation is too large for the context window — try a new conversation or raising context length in Settings)';

// Ollama's own error text doesn't carry a machine-readable "this was a
// context overflow" signal, so this is a heuristic over what it actually
// says — status 500 combined with wording used for the two real overflow
// shapes seen in this app's own history (a chat-template failure, and a
// generic "too large" response).
function looksLikeContextOverflow(status: number | undefined, detail: string): boolean {
  if (status === 500) return true;
  const lower = detail.toLowerCase();
  return lower.includes('context') || lower.includes('too large') || lower.includes('exceed');
}

export async function listModels(baseUrl: string): Promise<OllamaModel[]> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) {
    throw new OllamaError(`Failed to list models: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.models ?? [];
}

// The context-length key in model_info is family-prefixed (e.g.
// "qwen35.context_length", "llama.context_length") so there's no fixed key
// to look up — search for whichever one is present instead.
function findContextLength(modelInfo: Record<string, unknown>): number | null {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      return value;
    }
  }
  return null;
}

// Same family-prefix search as findContextLength, generalized to any
// suffix — model_info's keys are all shaped "{family}.{field}" with no
// fixed family name to look up directly.
function findBySuffix(modelInfo: Record<string, unknown>, suffix: string): number | null {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(suffix) && typeof value === 'number') {
      return value;
    }
  }
  return null;
}

function findArchInfo(modelInfo: Record<string, unknown>): ModelArchInfo {
  return {
    numLayers: findBySuffix(modelInfo, '.block_count'),
    embeddingLength: findBySuffix(modelInfo, '.embedding_length'),
    headCount: findBySuffix(modelInfo, '.attention.head_count'),
    headCountKV: findBySuffix(modelInfo, '.attention.head_count_kv'),
  };
}

// /api/show returns baked PARAMETER lines as a single newline-delimited
// string (e.g. "num_ctx  8192\ntemperature  1\ntop_k  20"), not structured
// JSON — confirmed against a real model's response, not assumed from docs.
// Only the three params this app's own sliders control are extracted.
function parseBakedParams(raw: string | undefined): BakedParams {
  const result: BakedParams = {};
  if (!raw) return result;
  for (const line of raw.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(\S+)/);
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isNaN(value)) continue;
    if (match[1] === 'num_ctx') result.numCtx = value;
    else if (match[1] === 'temperature') result.temperature = value;
    else if (match[1] === 'top_p') result.topP = value;
  }
  return result;
}

export async function showModel(baseUrl: string, model: string): Promise<ModelInfo> {
  const res = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    throw new OllamaError(`Failed to show model: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return {
    capabilities: data.capabilities ?? [],
    parameterSize: data.details?.parameter_size ?? '',
    quantization: data.details?.quantization_level ?? '',
    contextLength: findContextLength(data.model_info ?? {}),
    system: data.system ?? '',
    bakedParams: parseBakedParams(data.parameters),
    arch: findArchInfo(data.model_info ?? {}),
  };
}

// Creates (or, if `name` already exists, re-creates/updates) a persisted
// named model — Ollama's actual "custom instructions" mechanism, distinct
// from this app's local per-conversation system prompt. Near-instant: it
// layers a system prompt + parameters onto an existing model rather than
// copying/downloading weights, so no streaming/progress handling is needed.
// Passing `name === from` re-bases the model on its own current version,
// which is exactly "update this model in place" — Ollama's blob store is
// content-addressed, so the underlying weights are shared/untouched either
// way, only the system/parameter layer changes.
export async function createModel(
  baseUrl: string,
  name: string,
  from: string,
  system: string,
  parameters?: BakedParams
): Promise<void> {
  const body: Record<string, unknown> = { model: name, from, system, stream: false };
  if (parameters) {
    const wireParams: Record<string, number> = {};
    if (parameters.numCtx !== undefined) wireParams.num_ctx = parameters.numCtx;
    if (parameters.temperature !== undefined) wireParams.temperature = parameters.temperature;
    if (parameters.topP !== undefined) wireParams.top_p = parameters.topP;
    if (Object.keys(wireParams).length > 0) body.parameters = wireParams;
  }
  const res = await fetch(`${baseUrl}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new OllamaError(`Failed to create model: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.status !== 'success') {
    throw new OllamaError(`Model creation did not report success: ${JSON.stringify(data)}`);
  }
}

// Ollama's /api/embed (not the deprecated singular /api/embeddings, which
// uses a different request/response shape) — confirmed live against this
// machine's real Ollama before writing this, not assumed from docs. Response
// is always { embeddings: number[][] }, one vector per input, even for a
// single string.
export async function embedText(baseUrl: string, model: string, input: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) {
    throw new OllamaError(`Failed to embed text: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const vec = data.embeddings?.[0];
  if (!Array.isArray(vec)) {
    throw new OllamaError('Embed response missing embeddings[0]');
  }
  return vec;
}

// One-shot, non-streaming completion for short utility generations (e.g.
// the conversation-subject labeler, subject.ts) — not worth routing through
// the full streamChat/tool-loop machinery for a single plain text answer.
// think:false confirmed live via curl against this project's real Ollama
// instance (2026-08-20): a thinking-capable model (qwen3.5:9b) returned an
// immediate direct answer with no thinking field at all, rather than
// spending a reasoning pass on what's meant to be a cheap, quick label.
export async function chatOnce(baseUrl: string, model: string, messages: WireMessage[]): Promise<string> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, think: false }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new OllamaError(`Chat request failed: ${res.status} ${res.statusText}${bodyText ? ` — ${bodyText}` : ''}`);
  }
  const data = await res.json();
  return typeof data.message?.content === 'string' ? data.message.content : '';
}

// Streams a chat completion, invoking onToken for each content delta.
// Resolves with the full assembled response text once the stream ends.
export async function streamChat({
  baseUrl,
  model,
  messages,
  params,
  signal,
  tools,
  onToken,
  onThinking,
  onToolCalls,
  onUsage,
}: StreamChatArgs): Promise<string> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(tools ? { tools } : {}),
      options: {
        temperature: params.temperature,
        top_p: params.topP,
        num_ctx: params.numCtx,
      },
    }),
  });

  if (!res.ok || !res.body) {
    // Ollama's error responses carry real detail (e.g. a chat-template
    // rendering failure from context overflow) — surface it instead of a
    // bare status code, which gives no signal on what actually went wrong.
    const bodyText = await res.text().catch(() => '');
    let detail = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? bodyText);
    } catch {
      // not JSON — fall back to raw body text
    }
    const overflow = looksLikeContextOverflow(res.status, detail);
    const hint = overflow ? CONTEXT_OVERFLOW_HINT : '';
    throw new OllamaError(
      `Chat request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}${hint}`,
      { status: res.status, likelyContextOverflow: overflow }
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line);
      if (chunk.message?.thinking) {
        onThinking?.(chunk.message.thinking);
      }
      if (chunk.message?.tool_calls?.length) {
        const calls: ToolCall[] = chunk.message.tool_calls.map(
          (tc: { id?: string; function: { name: string; arguments: Record<string, unknown> } }, i: number) => ({
            id: tc.id ?? `call_${i}`,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })
        );
        onToolCalls?.(calls);
      }
      if (chunk.message?.content) {
        full += chunk.message.content;
        onToken(chunk.message.content);
      }
      if (chunk.done && typeof chunk.prompt_eval_count === 'number' && typeof chunk.eval_count === 'number') {
        onUsage?.({ promptTokens: chunk.prompt_eval_count, completionTokens: chunk.eval_count });
      }
      if (chunk.error) {
        // Same asymmetry fix as the initial-response path above — a
        // mid-stream error (arrives after a 200 OK, once the response has
        // already started) previously got no context-overflow hint at
        // all, even though this is a real path a too-large request can
        // fail through.
        const overflow = looksLikeContextOverflow(undefined, chunk.error);
        const hint = overflow ? CONTEXT_OVERFLOW_HINT : '';
        throw new OllamaError(`${chunk.error}${hint}`, { likelyContextOverflow: overflow });
      }
    }
  }

  return full;
}
