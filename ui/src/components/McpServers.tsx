import { useState } from 'react';
import type { McpServerConfig } from '../lib/mcp';
import type { McpServerStatus } from '../hooks/useMcpServers';

interface McpServersProps {
  servers: McpServerConfig[];
  statusById: Record<string, McpServerStatus>;
  onAdd: (config: Omit<McpServerConfig, 'id'>) => void;
  onRemove: (id: string) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}

const STATUS_LABEL: Record<McpServerStatus['state'], string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
};

// Hand-curated, not pulled from a live registry — neither
// registry.modelcontextprotocol.io nor mcpservers.org actually rank by
// usage/popularity (checked directly, both are flat/unranked directories),
// so "most useful" can't be queried automatically. Picking a suggestion
// prefills the form below rather than connecting immediately: several of
// these need a path or API key only the user has, and manual-connect-only
// is this app's deliberate posture anyway (see below).
interface SuggestedServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  note: string;
}

const SUGGESTED_SERVERS: SuggestedServer[] = [
  {
    name: 'Filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\path\\to\\allow'],
    note: 'Edit the path arg to the folder you want exposed before adding.',
  },
  {
    name: 'Blender',
    command: 'uvx',
    args: ['blender-mcp'],
    note: 'Requires the BlenderMCP addon installed and running inside Blender first.',
  },
  {
    name: 'Obsidian',
    command: 'uvx',
    args: ['mcp-obsidian'],
    env: { OBSIDIAN_API_KEY: '', OBSIDIAN_HOST: '127.0.0.1', OBSIDIAN_PORT: '27124' },
    note: "Requires Obsidian's Local REST API community plugin enabled — get the API key from its settings.",
  },
];

// Settings → Tools → MCP servers. Config (name/command/args) persists
// across restarts; the live connection doesn't (see useMcpServers — manual
// connect only, on purpose). Args are entered as a single space-separated
// string and split naively — covers the common case (npx -y
// @scope/package /some/path) without pulling in a shell-quoting parser for
// the rare arg that contains its own spaces.
export function McpServers({ servers, statusById, onAdd, onRemove, onConnect, onDisconnect }: McpServersProps) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');

  const canAdd = name.trim().length > 0 && command.trim().length > 0;

  const parseEnvText = (text: string): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      if (key) env[key] = line.slice(idx + 1).trim();
    }
    return env;
  };

  const handleAdd = () => {
    if (!canAdd) return;
    const args = argsText.trim().length ? argsText.trim().split(/\s+/) : [];
    const env = parseEnvText(envText);
    onAdd({ name: name.trim(), command: command.trim(), args, ...(Object.keys(env).length ? { env } : {}) });
    setName('');
    setCommand('');
    setArgsText('');
    setEnvText('');
  };

  const applySuggestion = (s: SuggestedServer) => {
    setName(s.name);
    setCommand(s.command);
    setArgsText(s.args.join(' '));
    setEnvText(Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  };

  return (
    <div className="mcp-servers">
      <h4 className="settings-menu__subheading">MCP servers</h4>
      <p className="settings-menu__hint">
        Connect an external MCP server (stdio) to add its tools to what the model can call. Each tool call still
        goes through the same approval prompt as every built-in tool.
      </p>

      {servers.length > 0 && (
        <div className="mcp-servers__list">
          {servers.map((server) => {
            const status = statusById[server.id] ?? { state: 'disconnected' as const };
            const connected = status.state === 'connected';
            const connecting = status.state === 'connecting';
            return (
              <div key={server.id} className="mcp-servers__row">
                <div className="mcp-servers__info">
                  <div className="mcp-servers__name-line">
                    <span className="mcp-servers__name">{server.name}</span>
                    <span className={`mcp-servers__status mcp-servers__status--${status.state}`}>
                      {STATUS_LABEL[status.state]}
                      {connected && status.tools ? ` (${status.tools.length} tool${status.tools.length === 1 ? '' : 's'})` : ''}
                    </span>
                  </div>
                  <code className="mcp-servers__command">
                    {server.command} {server.args.join(' ')}
                  </code>
                  {server.env && Object.keys(server.env).length > 0 && (
                    <span className="mcp-servers__env-note">
                      {Object.keys(server.env).length} env var{Object.keys(server.env).length === 1 ? '' : 's'} set
                    </span>
                  )}
                  {status.state === 'error' && status.error && (
                    <pre className="mcp-servers__error">{status.error}</pre>
                  )}
                  {connected && status.tools && status.tools.length > 0 && (
                    <ul className="mcp-servers__tool-list">
                      {status.tools.map((t) => (
                        <li key={t.name}>
                          <code>{t.name}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="mcp-servers__actions">
                  {connected ? (
                    <button type="button" onClick={() => onDisconnect(server.id)}>
                      Disconnect
                    </button>
                  ) : (
                    <button type="button" onClick={() => onConnect(server.id)} disabled={connecting}>
                      {connecting ? 'Connecting…' : 'Connect'}
                    </button>
                  )}
                  <button type="button" className="mcp-servers__remove" onClick={() => onRemove(server.id)}>
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mcp-servers__suggestions">
        <span className="mcp-servers__suggestions-label">Suggested:</span>
        {SUGGESTED_SERVERS.map((s) => (
          <button
            key={s.name}
            type="button"
            className="mcp-servers__suggestion-chip"
            title={s.note}
            onClick={() => applySuggestion(s)}
          >
            {s.name}
          </button>
        ))}
      </div>

      <div className="mcp-servers__add">
        <label className="settings-panel__field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Filesystem" />
        </label>
        <label className="settings-panel__field">
          <span>Command</span>
          <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
        </label>
        <label className="settings-panel__field">
          <span>Arguments (space-separated)</span>
          <input
            type="text"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            placeholder="-y @modelcontextprotocol/server-filesystem D:\path"
          />
        </label>
        <label className="settings-panel__field">
          <span>Environment variables (optional, one KEY=VALUE per line)</span>
          <textarea
            className="mcp-servers__env-input"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder="OBSIDIAN_API_KEY=..."
            rows={2}
          />
        </label>
        <button type="button" onClick={handleAdd} disabled={!canAdd}>
          Add server
        </button>
      </div>
    </div>
  );
}
