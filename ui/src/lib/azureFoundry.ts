import type { StreamChatArgs, TokenUsage, WireMessage } from './ollama';
import { streamOpenAIWireChat } from './openaiCompat';
import { azureChatCompletionsUrl, getAzureAccessToken, loadAzureConfig } from './azureAuth';

// Azure AI Foundry / Azure OpenAI backend — deployment-addressed
// (https://{resource}/openai/deployments/{deployment}/chat/completions),
// same OpenAI chat-completions wire shape openaiCompat.ts already speaks,
// so this delegates to its shared streamOpenAIWireChat rather than
// re-implementing SSE parsing. The only real differences are the URL shape
// and requiring a bearer token, fetched fresh (cached/refreshed Rust-side)
// immediately before every request rather than passed in.
//
// No listModels/showModel here, unlike ollama.ts/openaiCompat.ts — Azure
// OpenAI deployments are user-named and listing them needs separate
// management-plane permissions this app doesn't ask for.
//
// No fixed deployment lives in AzureConfig at all — which deployment
// handles a given turn is decided per-message by lib/router.ts (task +
// complexity classification against the admin-managed router config), not
// configured once in Settings. `args.model` (StreamChatArgs' normal "which
// model" field, set by useChat.ts from the router's decision) is what
// picks the deployment here.
//
// `baseUrl` in StreamChatArgs is unused here (kept only so this satisfies
// the same StreamChatArgs shape useChat.ts already threads through for
// every backend) — the real target URL comes from the persisted
// AzureConfig's resourceEndpoint plus the routed deployment instead.
export async function streamChat(args: StreamChatArgs): Promise<string> {
  const config = loadAzureConfig();
  if (!config.tenantId || !config.clientId || !config.resourceEndpoint) {
    throw new Error('Azure backend is not fully configured — set tenant, client, and resource endpoint in Settings.');
  }
  if (!args.model) {
    throw new Error('No deployment resolved for this turn — check the router config in Settings → Azure AI Foundry.');
  }
  const token = await getAzureAccessToken(config.tenantId, config.clientId);
  const { baseUrl: _baseUrl, ...rest } = args;
  return streamOpenAIWireChat(azureChatCompletionsUrl(config, args.model), { Authorization: `Bearer ${token}` }, rest);
}

// One-shot, non-streaming call against an explicit deployment — used by
// lib/router.ts's classifier step, which isn't tied to any conversation's
// model/params the way the main streamChat above is, so it takes the
// deployment directly rather than through StreamChatArgs. temperature: 0
// deliberately, unlike the user's own configured sampling params — a
// classification/complexity judgment wants low variance, not creativity.
export async function chatOnce(
  deployment: string,
  messages: WireMessage[]
): Promise<{ content: string; usage: TokenUsage | null }> {
  const config = loadAzureConfig();
  if (!config.tenantId || !config.clientId || !config.resourceEndpoint) {
    throw new Error('Azure backend is not fully configured — set tenant, client, and resource endpoint in Settings.');
  }
  const token = await getAzureAccessToken(config.tenantId, config.clientId);
  const res = await fetch(azureChatCompletionsUrl(config, deployment), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: deployment, messages, stream: false, temperature: 0 }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Classifier request failed: ${res.status} ${res.statusText}${bodyText ? ` — ${bodyText}` : ''}`);
  }
  const data = await res.json();
  const content = typeof data.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '';
  const usage =
    typeof data.usage?.prompt_tokens === 'number' && typeof data.usage?.completion_tokens === 'number'
      ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
      : null;
  return { content, usage };
}
