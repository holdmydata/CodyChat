import { useCallback, useEffect, useRef, useState } from 'react';
import {
  azureSignOut,
  loadAzureConfig,
  pollDeviceCode,
  restoreAzureSession,
  saveAzureConfig,
  startDeviceCode,
  type AzureConfig,
  type DeviceCodeInfo,
} from '../lib/azureAuth';

export type AzureAuthState = 'signed-out' | 'authenticating' | 'signed-in' | 'error';

export interface AzureAuthStatus {
  state: AzureAuthState;
  deviceCode?: DeviceCodeInfo;
  account?: string | null;
  error?: string;
}

// Config persists across restarts (like every other Settings field); the
// live auth *status* below is session state, restored via a best-effort
// silent refresh on mount (restoreAzureSession) rather than assumed —
// mirrors useMcpServers.ts's "config persists, live connection doesn't"
// split, except Azure's refresh token genuinely does let this restore
// straight to signed-in instead of requiring a fresh Connect click.
export function useAzureAuth() {
  const [config, setConfigState] = useState<AzureConfig>(loadAzureConfig);
  const [status, setStatus] = useState<AzureAuthStatus>({ state: 'signed-out' });
  // Guards against a stale poll loop (from a sign-in the user abandoned or
  // retried) still running and clobbering state after a newer one started.
  const pollTokenRef = useRef(0);

  const setConfig = useCallback((next: AzureConfig) => {
    setConfigState(next);
    saveAzureConfig(next);
  }, []);

  useEffect(() => {
    if (!config.tenantId || !config.clientId) return;
    let cancelled = false;
    restoreAzureSession(config.tenantId, config.clientId)
      .then((upn) => {
        if (cancelled || upn === null) return;
        setStatus({ state: 'signed-in', account: upn });
      })
      .catch(() => {
        // Best-effort — staying signed-out is the correct fallback.
      });
    return () => {
      cancelled = true;
    };
    // Only re-check on the identity fields actually used by the lookup —
    // editing resourceEndpoint/deployment shouldn't re-trigger a restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.tenantId, config.clientId]);

  const signIn = useCallback(async () => {
    if (!config.tenantId || !config.clientId) {
      setStatus({ state: 'error', error: 'Tenant ID and Client ID are required.' });
      return;
    }
    const myToken = ++pollTokenRef.current;
    try {
      const deviceCode = await startDeviceCode(config.tenantId, config.clientId);
      if (pollTokenRef.current !== myToken) return;
      setStatus({ state: 'authenticating', deviceCode });

      const deadline = Date.now() + deviceCode.expiresIn * 1000;
      while (pollTokenRef.current === myToken && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, deviceCode.interval * 1000));
        if (pollTokenRef.current !== myToken) return;
        const result = await pollDeviceCode();
        if (result.state === 'pending') continue;
        if (result.state === 'signed_in') {
          setStatus({ state: 'signed-in', account: result.upn });
        } else {
          setStatus({ state: 'error', error: result.message });
        }
        return;
      }
      if (pollTokenRef.current === myToken) {
        setStatus({ state: 'error', error: 'Sign-in expired before it was completed.' });
      }
    } catch (err) {
      if (pollTokenRef.current !== myToken) return;
      setStatus({ state: 'error', error: (err as Error).message ?? String(err) });
    }
  }, [config.tenantId, config.clientId]);

  const cancelSignIn = useCallback(() => {
    pollTokenRef.current++;
    setStatus({ state: 'signed-out' });
  }, []);

  const signOut = useCallback(async () => {
    pollTokenRef.current++;
    try {
      await azureSignOut(config.tenantId, config.clientId);
    } catch {
      // Best-effort — reflect signed-out in the UI regardless.
    }
    setStatus({ state: 'signed-out' });
  }, [config.tenantId, config.clientId]);

  return { config, setConfig, status, signIn, cancelSignIn, signOut };
}
