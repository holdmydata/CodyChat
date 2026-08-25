import { useCallback, useEffect, useState } from 'react';
import type { AzureAuthStatus } from '../hooks/useAzureAuth';
import type { AzureConfig } from '../lib/azureAuth';
import { getRouterConfigPath, loadRouterConfig } from '../lib/router';

interface AzureSettingsProps {
  config: AzureConfig;
  onConfigChange: (config: AzureConfig) => void;
  status: AzureAuthStatus;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onSignOut: () => void;
  /** Clears useChat's cached router config so the next turn re-reads router_config.json — see useChat.ts's invalidateRouterConfigCache. */
  onRouterConfigReload: () => void;
}

type RouterStatus =
  | { state: 'loading' }
  | { state: 'ok'; path: string }
  | { state: 'error'; path: string | null; message: string };

// Reuses mcp-servers' row/status/actions classes rather than introducing a
// parallel stylesheet — visually this is the same "external connector,
// config + connect flow + status" shape as an MCP server row (see
// McpServers.tsx), just with an OAuth sign-in instead of a spawn/connect.
export function AzureSettings({
  config,
  onConfigChange,
  status,
  onSignIn,
  onCancelSignIn,
  onSignOut,
  onRouterConfigReload,
}: AzureSettingsProps) {
  const set = (field: keyof AzureConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onConfigChange({ ...config, [field]: e.target.value });

  // Which deployment actually handles a given message is decided per-turn
  // by the router (lib/router.ts) against an admin-managed JSON file, not
  // typed in here — this block just surfaces whether that file is present
  // and valid, and where to find it, since there's no in-app editor for it
  // by design.
  const [routerStatus, setRouterStatus] = useState<RouterStatus>({ state: 'loading' });
  const refreshRouterStatus = useCallback(async () => {
    setRouterStatus({ state: 'loading' });
    let path: string | null = null;
    try {
      path = await getRouterConfigPath();
      await loadRouterConfig();
      setRouterStatus({ state: 'ok', path });
    } catch (err) {
      setRouterStatus({ state: 'error', path, message: (err as Error).message });
    }
  }, []);
  useEffect(() => {
    void refreshRouterStatus();
  }, [refreshRouterStatus]);

  return (
    <div className="mcp-servers">
      <h4 className="settings-menu__subheading">Azure AI Foundry</h4>
      <p className="settings-menu__hint">
        Each message is auto-routed to a deployment on this resource based on task/complexity — see "Model router
        config" below. Requires an Entra ID app registration with "Allow public client flows" enabled.
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

      <div className="mcp-servers__row">
        <div className="mcp-servers__info">
          <div className="mcp-servers__name-line">
            <span className="mcp-servers__name">Model router config</span>
            <span className={`mcp-servers__status${routerStatus.state === 'ok' ? ' mcp-servers__status--connected' : routerStatus.state === 'error' ? ' mcp-servers__status--error' : ''}`}>
              {routerStatus.state === 'loading' && 'Loading…'}
              {routerStatus.state === 'ok' && 'Loaded'}
              {routerStatus.state === 'error' && 'Failed to load'}
            </span>
          </div>
          {routerStatus.state !== 'loading' && routerStatus.path && (
            <p className="settings-menu__hint">
              Admin-managed — edit this file directly, not through the app: <code>{routerStatus.path}</code>
            </p>
          )}
          {routerStatus.state === 'error' && <pre className="mcp-servers__error">{routerStatus.message}</pre>}
        </div>
        <div className="mcp-servers__actions">
          <button
            type="button"
            onClick={() => {
              void refreshRouterStatus();
              onRouterConfigReload();
            }}
          >
            Reload router config
          </button>
        </div>
      </div>
    </div>
  );
}
