// Governance telemetry — every chat turn, across every backend, emitted as
// an Application Insights custom event (tokens/cost/duration/user/
// application/agent/model), so usage is visible in the same resource group
// dashboarding already exists for rather than a bespoke local viewer.
// Fire-and-forget: a telemetry failure must never block or surface as a
// chat error, same "courtesy, not correctness" posture as useChat.ts's
// notifyIfHidden.

const GOVERNANCE_CONFIG_KEY = 'ollama-ui:governance-config';
const APPLICATION_NAME = 'CodyChat';

export interface GovernanceConfig {
  /** Application Insights connection string, e.g. "InstrumentationKey=...;IngestionEndpoint=https://...". Pasted from the resource's Overview page in the Azure Portal. */
  connectionString: string;
  /** Fallback 'user' identity for governance events when the active backend has no signed-in Azure account (e.g. plain Ollama usage) — free text, not validated against anything. */
  fallbackUserName: string;
}

const EMPTY_CONFIG: GovernanceConfig = { connectionString: '', fallbackUserName: '' };

export function loadGovernanceConfig(): GovernanceConfig {
  try {
    const raw = localStorage.getItem(GOVERNANCE_CONFIG_KEY);
    if (!raw) return EMPTY_CONFIG;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || !parsed) return EMPTY_CONFIG;
    const p = parsed as Partial<GovernanceConfig>;
    return { connectionString: p.connectionString ?? '', fallbackUserName: p.fallbackUserName ?? '' };
  } catch {
    return EMPTY_CONFIG;
  }
}

export function saveGovernanceConfig(config: GovernanceConfig): void {
  localStorage.setItem(GOVERNANCE_CONFIG_KEY, JSON.stringify(config));
}

// A connection string is "InstrumentationKey=...;IngestionEndpoint=...;..."
// (order not guaranteed, extra fields ignored). IngestionEndpoint defaults
// to the classic global collector if the connection string doesn't specify
// a region-specific one — both accept the same /v2/track envelope.
function parseConnectionString(connectionString: string): { instrumentationKey: string; ingestionEndpoint: string } | null {
  const fields = Object.fromEntries(
    connectionString
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return idx === -1 ? [part, ''] : [part.slice(0, idx), part.slice(idx + 1)];
      })
  );
  const instrumentationKey = fields.InstrumentationKey;
  if (!instrumentationKey) return null;
  const ingestionEndpoint = (fields.IngestionEndpoint ?? 'https://dc.services.visualstudio.com').replace(/\/+$/, '');
  return { instrumentationKey, ingestionEndpoint };
}

// Best-effort, user-maintained price-per-1000-tokens table — there's no
// live pricing API this app calls. Unmatched models (any local Ollama
// model, or an Azure deployment name not listed here) report cost: null
// rather than a wrong guess. Edit this table by hand as pricing changes or
// new models get used.
const PRICE_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'model-router': { input: 0.0025, output: 0.01 },
};

function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number | null {
  const price = PRICE_PER_1K_TOKENS[model];
  if (!price) return null;
  return (promptTokens / 1000) * price.input + (completionTokens / 1000) * price.output;
}

export interface GovernanceEventInput {
  user: string;
  agent: string;
  model: string;
  backend: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export function logGovernanceEvent(input: GovernanceEventInput): void {
  const config = loadGovernanceConfig();
  if (!config.connectionString) return;
  const parsed = parseConnectionString(config.connectionString);
  if (!parsed) return;

  const cost = estimateCostUsd(input.model, input.promptTokens, input.completionTokens);
  const envelope = {
    name: 'Microsoft.ApplicationInsights.Event',
    time: new Date().toISOString(),
    iKey: parsed.instrumentationKey,
    data: {
      baseType: 'EventData',
      baseData: {
        ver: 2,
        name: 'ChatCompletion',
        properties: {
          user: input.user || 'unknown',
          application: APPLICATION_NAME,
          agent: input.agent || 'untitled',
          model: input.model,
          backend: input.backend,
        },
        measurements: {
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          totalTokens: input.promptTokens + input.completionTokens,
          durationMs: input.durationMs,
          ...(cost !== null ? { costUsd: cost } : {}),
        },
      },
    },
  };

  fetch(`${parsed.ingestionEndpoint}/v2/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  }).catch(() => {
    // Best-effort — never surfaces to the chat UI.
  });
}
