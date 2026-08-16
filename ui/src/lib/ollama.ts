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
}

export interface BakedParams {
  numCtx?: number;
  temperature?: number;
  topP?: number;
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
