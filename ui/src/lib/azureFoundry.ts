import type { StreamChatArgs } from './ollama';
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
// management-plane permissions this app doesn't ask for. The deployment
// name is configured directly in Settings (see AzureSettings.tsx) instead
// of picked from a fetched list.
//
// `baseUrl` in StreamChatArgs is unused here (kept only so this satisfies
// the same StreamChatArgs shape useChat.ts already threads through for
// every backend) — the real target URL comes from the persisted
// AzureConfig instead.
export async function streamChat(args: StreamChatArgs): Promise<string> {
  const config = loadAzureConfig();
  if (!config.tenantId || !config.clientId || !config.resourceEndpoint || !config.deployment) {
    throw new Error('Azure backend is not fully configured — set tenant, client, resource endpoint, and deployment in Settings.');
  }
  const token = await getAzureAccessToken(config.tenantId, config.clientId);
  const { baseUrl: _baseUrl, ...rest } = args;
  return streamOpenAIWireChat(azureChatCompletionsUrl(config), { Authorization: `Bearer ${token}` }, rest);
}
