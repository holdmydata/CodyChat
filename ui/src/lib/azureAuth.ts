import { invoke } from '@tauri-apps/api/core';

// Azure AI Foundry connector configuration + Entra device-code auth client
// wrappers. Actual token acquisition/refresh/storage lives in Rust
// (src-tauri/src/azure_auth.rs) — the Microsoft identity platform's
// device-code endpoints aren't reliably CORS-safe from a webview fetch, and
// the refresh token is sensitive enough to warrant OS credential storage
// rather than this module's plaintext localStorage. This module only holds
// non-secret config (mirrors lib/mcp.ts's split) and thin invoke() wrappers.

export interface AzureConfig {
  tenantId: string;
  clientId: string;
  /** Resource hostname, e.g. "my-resource.openai.azure.com" — scheme/trailing slash tolerated and stripped. */
  resourceEndpoint: string;
  /** Deployment name, e.g. "model-router" — Azure OpenAI deployments are user-named, so this is typed in directly rather than fetched from a list. */
  deployment: string;
}

const AZURE_CONFIG_KEY = 'ollama-ui:azure-config';
const EMPTY_CONFIG: AzureConfig = { tenantId: '', clientId: '', resourceEndpoint: '', deployment: '' };

// Azure AI resource-access scope — covers Azure OpenAI/Foundry deployments.
// openid/profile/offline_access are appended Rust-side (azure_start_device_code)
// rather than here, since every sign-in needs them regardless of resource scope.
const AZURE_SCOPE = 'https://cognitiveservices.azure.com/.default';
// Pinned to a specific, current GA api-version rather than left open —
// Azure OpenAI's api-version is a real breaking-change surface between
// releases, and an unpinned "latest" isn't an option this API offers.
const AZURE_API_VERSION = '2024-10-21';

export function loadAzureConfig(): AzureConfig {
  try {
    const raw = localStorage.getItem(AZURE_CONFIG_KEY);
    if (!raw) return EMPTY_CONFIG;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || !parsed) return EMPTY_CONFIG;
    const p = parsed as Partial<AzureConfig>;
    return {
      tenantId: p.tenantId ?? '',
      clientId: p.clientId ?? '',
      resourceEndpoint: p.resourceEndpoint ?? '',
      deployment: p.deployment ?? '',
    };
  } catch {
    return EMPTY_CONFIG;
  }
}

export function saveAzureConfig(config: AzureConfig): void {
  localStorage.setItem(AZURE_CONFIG_KEY, JSON.stringify(config));
}

export function azureChatCompletionsUrl(config: AzureConfig): string {
  const host = config.resourceEndpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${host}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${AZURE_API_VERSION}`;
}

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface DeviceCodeInfoRaw {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceCode(tenantId: string, clientId: string): Promise<DeviceCodeInfo> {
  const raw = await invoke<DeviceCodeInfoRaw>('azure_start_device_code', {
    tenant_id: tenantId,
    client_id: clientId,
    scope: AZURE_SCOPE,
  });
  return {
    userCode: raw.user_code,
    verificationUri: raw.verification_uri,
    expiresIn: raw.expires_in,
    interval: raw.interval,
  };
}

export type DevicePollResult =
  | { state: 'pending' }
  | { state: 'signed_in'; upn: string | null }
  | { state: 'error'; message: string };

export async function pollDeviceCode(): Promise<DevicePollResult> {
  return invoke<DevicePollResult>('azure_poll_device_code');
}

// Called by azureFoundry.ts immediately before every request — cached/
// refreshed silently on the Rust side, so this is cheap to call per turn.
export async function getAzureAccessToken(tenantId: string, clientId: string): Promise<string> {
  return invoke<string>('azure_get_access_token', { tenant_id: tenantId, client_id: clientId });
}

// Best-effort session resume from the keyring-stored refresh token — null
// means "not signed in" (no stored credential, or it's no longer valid),
// never throws.
export async function restoreAzureSession(tenantId: string, clientId: string): Promise<string | null> {
  return invoke<string | null>('azure_restore_session', { tenant_id: tenantId, client_id: clientId });
}

export async function azureSignOut(tenantId: string, clientId: string): Promise<void> {
  await invoke('azure_sign_out', { tenant_id: tenantId, client_id: clientId });
}
