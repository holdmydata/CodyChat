import type { ToolCall } from '../types';
import type { WireMessage, OllamaModel, ModelInfo, StreamChatArgs } from './ollama';
import { OllamaError } from './ollama';

// A second backend for streamChat/listModels/showModel, targeting anything
// that speaks the OpenAI-compatible HTTP API — llama-server, LM Studio,
// vLLM, etc. all share this one wire protocol, so a single module covers
// all of them; no need for a connector per specific program. Reuses
// WireMessage/ModelInfo/OllamaModel/StreamChatArgs/OllamaError from
// ollama.ts rather than duplicating them — the shapes those already assume
// (tool_calls, images, error-with-status) line up closely enough with the
// OpenAI wire format that a separate type module would just be indirection.
//
// Deliberately no createModel/embedText equivalent here: llama-server and
// friends serve exactly one model per running instance (chosen at launch
// via --model), so there's no "list/create/save named models" concept to
// wrap the way Ollama has one. Callers that need those stay on Ollama.

function looksLikeContextOverflow(detail: string): boolean {
  const lower = detail.toLowerCase();
  return lower.includes('context') || lower.includes('too large') || lower.includes('exceed');
}

async function readErrorDetail(res: Response): Promise<string> {
  const bodyText = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
  } catch {
    // not JSON — fall back to raw body text
  }
  return bodyText;
}

export async function listModels(baseUrl: string): Promise<OllamaModel[]> {
  const res = await fetch(`${baseUrl}/v1/models`);
  if (!res.ok) {
    throw new OllamaError(`Failed to list models: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const list: { id: string }[] = data.data ?? [];
  return list.map((m) => ({ name: m.id, size: 0, modified_at: '' }));
}

// llama.cpp's own /props endpoint — not part of the OpenAI spec, but the
// only place a llama-server exposes n_ctx and the loaded model's path.
// Best-effort only: parameter size/quantization are sniffed from the
// filename (e.g. "...-27B-UD-Q3_K_XL.gguf"), and arch fields (layer count,
// head count, etc.) aren't exposed at all, so they stay null — same
// graceful fallback resourceForecast.ts already has for an Ollama model
// whose model_info happens to be missing those fields.
export async function showModel(baseUrl: string, _model: string): Promise<ModelInfo> {
  const res = await fetch(`${baseUrl}/props`);
  if (!res.ok) {
    throw new OllamaError(`Failed to fetch server props: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const modelPath: string = data.model_path ?? '';
  const fileName = modelPath.split(/[\\/]/).pop() ?? '';
  const sizeMatch = fileName.match(/(\d+(?:\.\d+)?)[Bb](?![a-zA-Z])/);
  const quantMatch = fileName.match(/(Q\d(?:_[KM0])*(?:_[A-Z]+)?|IQ\d[_A-Z0-9]*|BF16|F16|F32)/);
  const contextLength = data.default_generation_settings?.n_ctx ?? data.n_ctx ?? null;

  return {
    capabilities: [],
    parameterSize: sizeMatch ? `${sizeMatch[1]}B` : '',
    quantization: quantMatch ? quantMatch[1] : '',
    contextLength: typeof contextLength === 'number' ? contextLength : null,
    system: '',
    bakedParams: {},
    arch: { numLayers: null, embeddingLength: null, headCount: null, headCountKV: null },
  };
}

// OpenAI's content-parts form for a multimodal user message. Message.images
// only carries raw base64 (no mime prefix — see types.ts), so the mime type
// is lost by the time it gets here; defaulting to image/png covers the
// common case (pasted screenshots) but will mislabel a pasted JPEG.
function toOpenAIMessages(messages: WireMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.images?.length) {
      return {
        role: m.role,
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })),
        ],
      };
    }
    const wire: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls?.length) {
      wire.tool_calls = m.tool_calls.map((tc, i) => ({
        id: `call_${i}`,
        type: 'function',
        function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
      }));
    }
    if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
    return wire;
  });
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

// The actual OpenAI-wire streaming implementation, factored out so a
// second caller with a different URL/auth (azureFoundry.ts — Azure's
// chat-completions endpoint is the same wire shape, just deployment-URLed
// and bearer-token-authed) doesn't have to duplicate this ~120-line
// SSE/tool-call-accumulation loop. `url` and `extraHeaders` are the only
// things that differ between callers; everything else about the request
// body and response parsing is identical.
export async function streamOpenAIWireChat(
  url: string,
  extraHeaders: Record<string, string>,
  { model, messages, params, signal, tools, onToken, onThinking, onToolCalls, onUsage }: Omit<StreamChatArgs, 'baseUrl'>
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    signal,
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(messages),
      stream: true,
      // Without this, usage is only ever returned on a non-streaming
      // response — the streamed final chunk omits it entirely by default.
      stream_options: { include_usage: true },
      temperature: params.temperature,
      top_p: params.topP,
      ...(tools ? { tools } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await readErrorDetail(res);
    const overflow = looksLikeContextOverflow(detail);
    throw new OllamaError(`Chat request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`, {
      status: res.status,
      likelyContextOverflow: overflow,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const pendingCalls = new Map<number, PendingToolCall>();

  const flushToolCalls = () => {
    if (pendingCalls.size === 0) return;
    const calls: ToolCall[] = [...pendingCalls.values()].map((c) => {
      let args: Record<string, unknown> = {};
      try {
        args = c.args ? JSON.parse(c.args) : {};
      } catch {
        // Truncated/invalid JSON from a cut-off stream — surface an empty
        // args object rather than throwing away the whole turn's response.
      }
      return { id: c.id, name: c.name, arguments: args };
    });
    onToolCalls?.(calls);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      if (raw === '[DONE]') continue;

      let chunk: {
        choices?: {
          delta?: {
            content?: string;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string } | string;
      };
      try {
        chunk = JSON.parse(raw);
      } catch {
        continue;
      }

      if (chunk.error) {
        const detail = typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? '';
        throw new OllamaError(detail || 'Chat stream reported an error', {
          likelyContextOverflow: looksLikeContextOverflow(detail),
        });
      }

      const delta = chunk.choices?.[0]?.delta;
      const thinkingToken = delta?.reasoning_content ?? delta?.reasoning;
      if (thinkingToken) onThinking?.(thinkingToken);
      if (delta?.content) {
        full += delta.content;
        onToken(delta.content);
      }
      if (delta?.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          const existing = pendingCalls.get(tc.index);
          if (existing) {
            existing.args += tc.function?.arguments ?? '';
            if (tc.function?.name) existing.name = tc.function.name;
          } else {
            pendingCalls.set(tc.index, {
              id: tc.id ?? `call_${tc.index}`,
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          }
        }
      }
      if (chunk.choices?.[0]?.finish_reason === 'tool_calls') {
        flushToolCalls();
      }
      // Arrives on its own final chunk (with an empty choices array) once
      // stream_options.include_usage is set above — not attached to any
      // per-token delta.
      if (typeof chunk.usage?.prompt_tokens === 'number' && typeof chunk.usage?.completion_tokens === 'number') {
        onUsage?.({ promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens });
      }
    }
  }

  return full;
}

export async function streamChat({ baseUrl, ...args }: StreamChatArgs): Promise<string> {
  return streamOpenAIWireChat(`${baseUrl}/v1/chat/completions`, {}, args);
}
