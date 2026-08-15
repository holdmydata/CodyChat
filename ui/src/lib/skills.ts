import { invoke } from '@tauri-apps/api/core';
import type { ToolCall } from '../types';

// Tool definitions come from Rust (skills.rs::get_tool_definitions) — single
// source of truth for the JSON schemas sent to Ollama's `tools` field,
// rather than a duplicate hardcoded copy here that could drift.
export async function getToolDefinitions(): Promise<unknown[]> {
  return invoke<unknown[]>('get_tool_definitions');
}

interface DirEntryInfo {
  name: string;
  is_dir: boolean;
}

// Runs a skill by calling the matching Tauri command. Callers are expected
// to have already gated this behind user approval — this function doesn't
// know or care whether that happened, same as skills.rs on the Rust side.
export async function executeSkill(call: ToolCall): Promise<string> {
  switch (call.name) {
    case 'read_file':
      return invoke<string>('read_file', call.arguments);
    case 'write_file':
      await invoke('write_file', call.arguments);
      return 'File written successfully.';
    case 'list_directory': {
      const entries = await invoke<DirEntryInfo[]>('list_directory', call.arguments);
      return JSON.stringify(entries);
    }
    default:
      throw new Error(`unknown skill: ${call.name}`);
  }
}
