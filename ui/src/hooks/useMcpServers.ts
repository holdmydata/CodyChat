import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  connectMcpServer,
  disconnectMcpServer,
  loadMcpServers,
  mcpToolDefinition,
  saveMcpServers,
  type McpServerConfig,
  type McpToolInfo,
  type OllamaToolDefinition,
} from '../lib/mcp';

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpServerStatus {
  state: McpConnectionState;
  tools?: McpToolInfo[];
  error?: string;
}

// Manual connect only, deliberately — these are arbitrary external
// processes (npx, uvx, whatever the user configures), and auto-spawning
// them in the background on every app launch (before the user has even
// looked at Settings) is a worse default than an explicit Connect click.
// Config still persists across restarts; only the live connection doesn't.
export function useMcpServers() {
  const [servers, setServers] = useState<McpServerConfig[]>(loadMcpServers);
  const [statusById, setStatusById] = useState<Record<string, McpServerStatus>>({});

  useEffect(() => {
    saveMcpServers(servers);
  }, [servers]);

  const addServer = useCallback((config: Omit<McpServerConfig, 'id'>) => {
    setServers((prev) => [...prev, { ...config, id: crypto.randomUUID() }]);
  }, []);

  const removeServer = useCallback((id: string) => {
    disconnectMcpServer(id).catch(() => {});
    setServers((prev) => prev.filter((s) => s.id !== id));
    setStatusById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const connect = useCallback(
    async (id: string) => {
      const config = servers.find((s) => s.id === id);
      if (!config) return;
      setStatusById((prev) => ({ ...prev, [id]: { state: 'connecting' } }));
      try {
        const tools = await connectMcpServer(config);
        setStatusById((prev) => ({ ...prev, [id]: { state: 'connected', tools } }));
      } catch (err) {
        setStatusById((prev) => ({
          ...prev,
          [id]: { state: 'error', error: (err as Error).message ?? String(err) },
        }));
      }
    },
    [servers]
  );

  const disconnect = useCallback(async (id: string) => {
    setStatusById((prev) => ({ ...prev, [id]: { state: 'disconnected' } }));
    try {
      await disconnectMcpServer(id);
    } catch {
      // Best-effort — the connection status is already reflected as
      // disconnected regardless of whether the kill() on the Rust side
      // succeeded cleanly.
    }
  }, []);

  // Flattened tool defs for every currently-connected server, ready to
  // merge into the `tools` array useChat sends to Ollama.
  const mcpToolDefs: OllamaToolDefinition[] = useMemo(
    () =>
      servers.flatMap((config) => {
        const status = statusById[config.id];
        if (status?.state !== 'connected' || !status.tools) return [];
        return status.tools.map((tool) => mcpToolDefinition(config.id, tool));
      }),
    [servers, statusById]
  );

  return { servers, statusById, addServer, removeServer, connect, disconnect, mcpToolDefs };
}
