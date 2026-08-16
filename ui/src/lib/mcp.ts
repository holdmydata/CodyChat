import { invoke } from '@tauri-apps/api/core';

// MCP (Model Context Protocol) connector configuration + client wrappers.
// Connection lifecycle (spawned process, JSON-RPC handshake) lives in Rust
// (src-tauri/src/mcp.rs) since a child process can't be owned by the
// webview — this module only holds server *config* (persisted like every
// other app-level setting) and calls through invoke() for the rest.

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Optional env vars passed to the spawned process — needed by servers that authenticate this way (e.g. Obsidian's OBSIDIAN_API_KEY, GitHub's PAT). */
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  input_schema: unknown;
}

const MCP_SERVERS_KEY = 'ollama-ui:mcp-servers';

export function loadMcpServers(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem(MCP_SERVERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
  } catch {
    return [];
  }
}

export function saveMcpServers(servers: McpServerConfig[]): void {
  localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers));
}

export async function connectMcpServer(config: McpServerConfig): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>('mcp_connect', {
    id: config.id,
    command: config.command,
    args: config.args,
    env: config.env ?? {},
  });
}

export async function disconnectMcpServer(id: string): Promise<void> {
  await invoke('mcp_disconnect', { id });
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  return invoke<string>('mcp_call_tool', { id: serverId, tool_name: toolName, arguments: args });
}

// Tool names sent to Ollama must be unique across every source (built-in
// skills + every connected MCP server), and executeSkill needs to know
// which server a call belongs to when the model calls one back. Qualifying
// as `mcp__<serverId>__<toolName>` (double-underscore, same convention as
// Claude's own MCP tool naming) keeps that routable without a second
// lookup table.
const MCP_TOOL_PREFIX = 'mcp__';

export function mcpToolQualifiedName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`;
}

export function parseMcpToolName(qualified: string): { serverId: string; toolName: string } | null {
  if (!qualified.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = qualified.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf('__');
  if (idx === -1) return null;
  return { serverId: rest.slice(0, idx), toolName: rest.slice(idx + 2) };
}

// Structurally identical to skills.ts's ToolDefinition (avoids importing
// from skills.ts just for the type, which would make skills.ts <-> mcp.ts
// a two-way module dependency for no real reason).
export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export function mcpToolDefinition(serverId: string, tool: McpToolInfo): OllamaToolDefinition {
  return {
    type: 'function',
    function: {
      name: mcpToolQualifiedName(serverId, tool.name),
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}
