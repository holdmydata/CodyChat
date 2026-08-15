import { invoke } from '@tauri-apps/api/core';
import { callMcpTool, parseMcpToolName } from './mcp';
import type { ToolCall } from '../types';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

// Tool definitions come from Rust (skills.rs::get_tool_definitions) — single
// source of truth for the JSON schemas sent to Ollama's `tools` field,
// rather than a duplicate hardcoded copy here that could drift.
export async function getToolDefinitions(): Promise<ToolDefinition[]> {
  return invoke<ToolDefinition[]>('get_tool_definitions');
}

interface DirEntryInfo {
  name: string;
  is_dir: boolean;
}

interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

// Runs a skill by calling the matching Tauri command. Callers are expected
// to have already gated this behind user approval — this function doesn't
// know or care whether that happened, same as skills.rs on the Rust side.
export async function executeSkill(call: ToolCall): Promise<string> {
  const mcpRef = parseMcpToolName(call.name);
  if (mcpRef) {
    return callMcpTool(mcpRef.serverId, mcpRef.toolName, call.arguments);
  }
  switch (call.name) {
    case 'read_file':
      return invoke<string>('read_file', call.arguments);
    case 'write_file':
      await invoke('write_file', call.arguments);
      return 'File written successfully.';
    case 'edit_file':
      return invoke<string>('edit_file', call.arguments);
    case 'list_directory': {
      const entries = await invoke<DirEntryInfo[]>('list_directory', call.arguments);
      return JSON.stringify(entries);
    }
    case 'search_files': {
      const matches = await invoke<SearchMatch[]>('search_files', call.arguments);
      if (matches.length === 0) return 'No matches found.';
      return matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
    }
    case 'execute_command': {
      const result = await invoke<CommandOutput>('execute_command', call.arguments);
      const parts = [`exit code: ${result.exit_code ?? '(killed)'}`];
      if (result.timed_out) parts.push('(timed out and was killed)');
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
      return parts.join('\n\n');
    }
    default:
      throw new Error(`unknown skill: ${call.name}`);
  }
}
