// Risk classification + enable/disable persistence for tools the model can
// call. Descriptions/schemas stay single-sourced from skills.rs
// (get_tool_definitions) — this only adds the UI-facing risk tier, which
// has no equivalent in a JSON Schema tool definition.
export type ToolRisk = 'read' | 'write' | 'execute';

const TOOL_RISK: Record<string, ToolRisk> = {
  read_file: 'read',
  list_directory: 'read',
  search_files: 'read',
  write_file: 'write',
  edit_file: 'write',
  execute_command: 'execute',
};

// Unclassified tools default to the middle tier rather than the most
// permissive one — a future tool nobody remembered to classify should read
// as "be careful," not "this is safe."
export function riskOf(toolName: string): ToolRisk {
  return TOOL_RISK[toolName] ?? 'write';
}

export const RISK_LABEL: Record<ToolRisk, string> = {
  read: 'Read-only',
  write: 'Write',
  execute: 'Execute',
};

const DISABLED_TOOLS_KEY = 'ollama-ui:disabled-tools';

// Tools in this set are stripped out of the `tools` list sent to Ollama
// entirely — the model can't see or request them, not just get denied on
// approval. Distinct from (and in addition to) the per-call approval gate
// every enabled tool still goes through.
export function loadDisabledTools(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_TOOLS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

export function saveDisabledTools(disabled: Set<string>): void {
  localStorage.setItem(DISABLED_TOOLS_KEY, JSON.stringify([...disabled]));
}
