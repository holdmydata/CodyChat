import type { AzureAuthStatus } from '../hooks/useAzureAuth';
import type { AzureConfig } from '../lib/azureAuth';

interface AzureSettingsProps {
  config: AzureConfig;
  onConfigChange: (config: AzureConfig) => void;
  status: AzureAuthStatus;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onSignOut: () => void;
}

// Reuses mcp-servers' row/status/actions classes rather than introducing a
// parallel stylesheet — visually this is the same "external connector,
// config + connect flow + status" shape as an MCP server row (see
// McpServers.tsx), just with an OAuth sign-in instead of a spawn/connect.
export function AzureSettings({ config, onConfigChange, status, onSignIn, onCancelSignIn, onSignOut }: AzureSettingsProps) {
  const set = (field: keyof AzureConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onConfigChange({ ...config, [field]: e.target.value });

  return (
    <div className="mcp-servers">
      <h4 className="settings-menu__subheading">Azure AI Foundry</h4>
      <p className="settings-menu__hint">
        Points at a deployment on an Azure OpenAI / Azure AI Foundry resource (e.g. a "model-router" deployment).
        Requires an Entra ID app registration with "Allow public client flows" enabled.
      </p>

      <label className="settings-panel__field">
        <span>Tenant ID</span>
        <input type="text" value={config.tenantId} onChange={set('tenantId')} placeholder="00000000-0000-0000-0000-000000000000" />
      </label>
      <label className="settings-panel__field">
        <span>Client ID</span>
        <input type="text" value={config.clientId} onChange={set('clientId')} placeholder="00000000-0000-0000-0000-000000000000" />
      </label>
      <label className="settings-panel__field">
        <span>Resource endpoint</span>
        <input
          type="text"
          value={config.resourceEndpoint}
          onChange={set('resourceEndpoint')}
          placeholder="my-resource.openai.azure.com"
        />
      </label>
      <label className="settings-panel__field">
        <span>Deployment name</span>
        <input type="text" value={config.deployment} onChange={set('deployment')} placeholder="model-router" />
      </label>

      <div className="mcp-servers__row">
        <div className="mcp-servers__info">
          <div className="mcp-servers__name-line">
            <span className="mcp-servers__name">Sign-in</span>
            <span className={`mcp-servers__status${status.state === 'signed-in' ? ' mcp-servers__status--connected' : status.state === 'error' ? ' mcp-servers__status--error' : ''}`}>
              {status.state === 'signed-out' && 'Not signed in'}
              {status.state === 'authenticating' && 'Waiting for sign-in…'}
              {status.state === 'signed-in' && (status.account ? `Signed in as ${status.account}` : 'Signed in')}
              {status.state === 'error' && 'Sign-in failed'}
            </span>
          </div>
          {status.state === 'authenticating' && status.deviceCode && (
            <p className="settings-menu__hint">
              Go to <strong>{status.deviceCode.verificationUri}</strong> and enter code{' '}
              <code>{status.deviceCode.userCode}</code>
            </p>
          )}
          {status.state === 'error' && status.error && <pre className="mcp-servers__error">{status.error}</pre>}
        </div>
        <div className="mcp-servers__actions">
          {status.state === 'signed-in' ? (
            <button type="button" onClick={onSignOut}>
              Sign out
            </button>
          ) : status.state === 'authenticating' ? (
            <button type="button" onClick={onCancelSignIn}>
              Cancel
            </button>
          ) : (
            <button type="button" onClick={onSignIn} disabled={!config.tenantId || !config.clientId}>
              Sign in with Microsoft
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
