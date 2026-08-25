// Risk classification + enable/disable persistence for tools the model can
// call. Descriptions/schemas stay single-sourced from skills.rs
// (get_tool_definitions) — this only adds the UI-facing risk tier, which
// has no equivalent in a JSON Schema tool definition.
export type ToolRisk = 'read' | 'write' | 'execute';

const TOOL_RISK: Record<string, ToolRisk> = {
  read_file: 'read',
  list_directory: 'read',
  search_files: 'read',
  search_memory: 'read',
  web_fetch: 'read',
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

const AUTO_APPROVE_READ_KEY = 'ollama-ui:auto-approve-read';

// When on, a 'read' risk-tier tool call (see riskOf above) skips the
// approval prompt entirely and runs immediately — everything else (write,
// execute, and any future unclassified tool defaulting to 'write') still
// requires an explicit click regardless of this setting. App-level, not
// per-conversation, same persistence pattern as disabledTools. Defaults to
// on: reads are safe by definition (that's the whole point of the risk
// tier), so prompting for every read_file/search_memory call by default
// was just friction, not safety — opt out in Settings if you want it back.
export function loadAutoApproveReadOnly(): boolean {
  return localStorage.getItem(AUTO_APPROVE_READ_KEY) !== 'false';
}

export function saveAutoApproveReadOnly(value: boolean): void {
  localStorage.setItem(AUTO_APPROVE_READ_KEY, String(value));
}

const AUTO_APPROVE_WRITE_KEY = 'ollama-ui:auto-approve-write';

// When on, a 'write' risk-tier call (write_file, edit_file) also skips the
// approval prompt — but only during interactive chat. 'execute' calls
// (execute_command — arbitrary shell, where an actual delete/destructive
// action would happen) always still ask, regardless of this setting, and
// so does every write/execute call made by the autonomous loop: that
// loop's whole safety model is "unattended runs only sail through
// read-only calls, anything else is the point a human has to be there"
// (see useAutonomousLoop.ts's runAutonomousTurn doc comment) — this toggle
// must not quietly punch through that for a background run nobody's
// watching. Off by default: unlike a read, a write has a real effect, so
// this is an explicit opt-in rather than a new default.
export function loadAutoApproveWrites(): boolean {
  return localStorage.getItem(AUTO_APPROVE_WRITE_KEY) === 'true';
}

export function saveAutoApproveWrites(value: boolean): void {
  localStorage.setItem(AUTO_APPROVE_WRITE_KEY, String(value));
}

const SAFE_COMMANDS_KEY = 'ollama-ui:safe-commands';
const AUTO_APPROVE_SAFE_COMMANDS_KEY = 'ollama-ui:auto-approve-safe-commands';

// Deliberately just read-only/diagnostic commands — nothing that writes,
// deletes, installs, or touches network/credentials. User-editable in
// Settings (Tools tab), but isSafeCommand's own metacharacter check below
// is the real defense, not this list — see its comment for why.
export const DEFAULT_SAFE_COMMANDS: readonly string[] = [
  'git status',
  'git diff',
  'git log',
  'git branch',
  'ls',
  'dir',
  'pwd',
  'cat',
  'type',
  'tsc --noEmit',
  'cargo check',
  'npm run lint',
  'npm test',
];

export function loadSafeCommands(): string[] {
  try {
    const raw = localStorage.getItem(SAFE_COMMANDS_KEY);
    if (!raw) return [...DEFAULT_SAFE_COMMANDS];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [...DEFAULT_SAFE_COMMANDS];
  } catch {
    return [...DEFAULT_SAFE_COMMANDS];
  }
}

export function saveSafeCommands(commands: string[]): void {
  localStorage.setItem(SAFE_COMMANDS_KEY, JSON.stringify(commands));
}

// Off by default, same reasoning as autoApproveWrites — this is opt-in
// automation, not a new default.
export function loadAutoApproveSafeCommands(): boolean {
  return localStorage.getItem(AUTO_APPROVE_SAFE_COMMANDS_KEY) === 'true';
}

export function saveAutoApproveSafeCommands(value: boolean): void {
  localStorage.setItem(AUTO_APPROVE_SAFE_COMMANDS_KEY, String(value));
}

// execute_command runs via `cmd /C <command>` on Windows / `sh -c` elsewhere
// (skills.rs) — real shell interpretation, not argv-array execution. So a
// prefix match against the safe list is not itself a safety boundary: `git
// status & del important.txt` still starts with "git status". The actual
// gate is that ANY shell metacharacter capable of chaining, redirecting, or
// substituting a second command disqualifies auto-approval outright,
// regardless of what precedes it — only after that check passes does the
// prefix match even get consulted. Deliberately conservative (rejects some
// legitimate uses, e.g. `git log --format="%H"`) since the failure mode of
// getting this wrong is silent unattended command execution.
const SHELL_METACHARACTERS = /[;&|<>`\n]|\$\(/;

export function isSafeCommand(command: string, safeCommands: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHARACTERS.test(trimmed)) return false;
  return safeCommands.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
}
