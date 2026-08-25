import { invoke } from '@tauri-apps/api/core';
import { callMcpTool, parseMcpToolName } from './mcp';
import { indexDocument, searchMemory } from './memory';
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

interface ReadFileResult {
  content: string;
  source_type: string;
}

interface WebFetchResult {
  content: string;
  source_type: string;
  final_url: string;
}

export interface SkillContext {
  baseUrl: string;
  conversationId: string;
}

// Runs a skill by calling the matching Tauri command. Callers are expected
// to have already gated this behind user approval — this function doesn't
// know or care whether that happened, same as skills.rs on the Rust side.
export async function executeSkill(call: ToolCall, ctx: SkillContext): Promise<string> {
  const mcpRef = parseMcpToolName(call.name);
  if (mcpRef) {
    return callMcpTool(mcpRef.serverId, mcpRef.toolName, call.arguments);
  }
  switch (call.name) {
    case 'read_file': {
      // The Rust command doesn't know about `remember` — it only detects
      // and reports source_type. Whether to actually index the content is
      // decided here, from the model's own argument, matching this app's
      // explicit-opt-in posture (nothing gets remembered just because it
      // was read).
      const result = await invoke<ReadFileResult>('read_file', call.arguments);
      if (call.arguments.remember === true) {
        const path = String(call.arguments.path ?? '');
        void indexDocument(ctx.baseUrl, result.source_type, path, result.content);
      }
      return result.content;
    }
    case 'write_file': {
      // Mirrors read_file's remember handling exactly: the Rust command
      // just writes the file, whether to also index the content is decided
      // here from the model's own argument, same explicit-opt-in posture
      // (nothing gets remembered just because it was written).
      //
      // memory_type distinguishes *what kind* of memory this is, not just
      // that it's remembered: 'build_output' (a real artifact — code, a
      // game, a document) vs. 'learned_reference' (a deliberately distilled
      // summary written *for future retrieval*, e.g. after reading a big
      // doc once so a later run can search_memory instead of re-reading
      // it). Constrained to a known set (not free text) so search_memory's
      // source_type filter stays meaningful instead of fragmenting into
      // whatever label a given run happened to invent. Defaults to
      // 'build_output' for prompts written before this existed.
      await invoke('write_file', call.arguments);
      if (call.arguments.remember === true) {
        const path = String(call.arguments.path ?? '');
        const content = String(call.arguments.content ?? '');
        const memoryType = call.arguments.memory_type === 'learned_reference' ? 'learned_reference' : 'build_output';
        void indexDocument(ctx.baseUrl, memoryType, path, content);
      }
      return 'File written successfully.';
    }
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
    case 'web_fetch': {
      // No remember flag here, unlike read_file/write_file — tried that
      // first and it didn't hold up live: given the shortcut, the model
      // remembered raw fetches verbatim instead of following the
      // system-prompt hint to write_file a distilled memory_type:
      // 'learned_reference' summary. Removing the affordance forces that
      // path instead of relying on a soft prompt nudge (see skills.rs's
      // web_fetch comment for the full incident).
      const result = await invoke<WebFetchResult>('web_fetch', call.arguments);
      return result.content;
    }
    case 'search_memory': {
      const query = String(call.arguments.query ?? '');
      const topK = typeof call.arguments.top_k === 'number' ? call.arguments.top_k : 5;
      const sourceType = typeof call.arguments.source_type === 'string' ? call.arguments.source_type : undefined;
      if (!query.trim()) return 'No search query provided.';
      const matches = await searchMemory(ctx.baseUrl, query, topK, ctx.conversationId, sourceType);
      if (matches.length === 0) return 'No relevant past context found.';
      return matches
        .map((m) => {
          // conversation_subject is only populated once someone's actually
          // generated one for that conversation (see memory.ts's
          // updateConversationSubject) — most existing conversations won't
          // have one yet, so this falls back to the plain role label rather
          // than showing an empty `from ""`.
          const label =
            m.sourceType === 'chat_message'
              ? m.conversationSubject
                ? `${m.role}, from "${m.conversationSubject}"`
                : m.role
              : `${m.sourceType}: ${m.sourcePath}`;
          return `[${new Date(m.createdAt).toISOString()}] (${label}): ${m.content}`;
        })
        .join('\n---\n');
    }
    default:
      throw new Error(`unknown skill: ${call.name}`);
  }
}
