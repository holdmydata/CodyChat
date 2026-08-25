// Standing behavioral hints folded into every turn's system prompt (see
// useChat.ts). Previously hardcoded constants — pulled out here so they can
// be viewed/edited/disabled from Settings → General without touching code,
// per direct request (2026-08-20) after the thinking-efficiency hint turned
// out to already be built but had no visible on/off switch or way to tune
// its wording for a specific model's behavior.

export type AgentHintId = 'convergence' | 'thinkingEfficiency' | 'memoryLabeling';

export interface AgentHintMeta {
  id: AgentHintId;
  title: string;
  description: string;
  defaultText: string;
}

export const AGENT_HINTS: AgentHintMeta[] = [
  {
    id: 'convergence',
    title: 'Converge quickly',
    description:
      'Added after real incidents (an SVG write, a CSS restyle) where the model kept re-attempting an already-workable ' +
      'change and burned through most of the tool-call safety cap second-guessing itself.',
    defaultText:
      'When using tools, work efficiently: make a plan, execute it, and converge on a final answer within a few tool calls. ' +
      "Avoid re-attempting the same kind of change speculatively or re-litigating an already-successful tool result. If a task is " +
      'inherently hard to get exactly right in one pass (e.g. hand-drafting detailed visual content like SVG art), do your best ' +
      'single attempt, briefly note any limitation, and stop rather than looping to perfect it.',
  },
  {
    id: 'thinkingEfficiency',
    title: 'Don’t draft content twice',
    description:
      'Targets a real measured cost: a thinking-mode model can fully draft a file’s content inside its own thinking ' +
      'block, then generate that same content again as the actual tool-call argument — thinking and output tokens ' +
      'generate at the same rate, so this roughly doubles generation time for identical text. The main lever for speeding ' +
      'up a large thinking model on file-writing turns.',
    defaultText:
      'When you need to write substantial content (code, a file, a long document), use your thinking to plan its structure and ' +
      "approach only — do not draft the full content there. Generate the actual content once, directly as the tool call's " +
      'argument, not twice.',
  },
  {
    id: 'memoryLabeling',
    title: 'Distill before remembering',
    description:
      'Without this, a read_file/web_fetch’s own remember flag stores the raw source verbatim, which makes later ' +
      'search_memory results long and unfocused for anything but a short source.',
    defaultText:
      "When you read_file or web_fetch something specifically to learn from it for later use (not just to answer the current " +
      "question), don't rely on that tool's own remember flag for it — it stores the raw source verbatim, which makes later " +
      'search_memory results long and unfocused, especially for a large page. Instead, after reading it, write_file a concise ' +
      "distilled summary of what's actually useful, with remember: true and memory_type: 'learned_reference'. Save the raw " +
      'source as-is only when it, itself, is short and worth keeping verbatim.',
  },
];

export interface AgentHintState {
  enabled: boolean;
  text: string;
}

export type AgentHintSettings = Record<AgentHintId, AgentHintState>;

// Exported so callers that don't (yet) wire in user-editable hint settings —
// e.g. the duck companion's own useChat call — still get the full default
// behavior rather than silently losing these hints entirely.
export function defaultAgentHintSettings(): AgentHintSettings {
  const out = {} as AgentHintSettings;
  for (const hint of AGENT_HINTS) {
    out[hint.id] = { enabled: true, text: hint.defaultText };
  }
  return out;
}

const STORAGE_KEY = 'ollama-ui:agent-hints';

// Merges saved state over defaults field-by-field rather than trusting the
// parsed JSON wholesale, so a hint added in a later version (or a
// corrupted/partial save) still comes back fully populated instead of
// silently missing from the system prompt.
export function loadAgentHints(): AgentHintSettings {
  const defaults = defaultAgentHintSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    for (const hint of AGENT_HINTS) {
      const saved = (parsed as Record<string, unknown>)[hint.id];
      if (saved && typeof saved === 'object') {
        const { enabled, text } = saved as Record<string, unknown>;
        defaults[hint.id] = {
          enabled: typeof enabled === 'boolean' ? enabled : true,
          text: typeof text === 'string' ? text : hint.defaultText,
        };
      }
    }
    return defaults;
  } catch {
    return defaults;
  }
}

export function saveAgentHints(settings: AgentHintSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// Order matches AGENT_HINTS (convergence → thinking-efficiency →
// memory-labeling); a disabled hint or one edited down to blank text is
// dropped rather than sent as an empty string.
export function resolveAgentHints(settings: AgentHintSettings): string[] {
  return AGENT_HINTS.filter((h) => settings[h.id]?.enabled && settings[h.id]?.text.trim()).map(
    (h) => settings[h.id].text
  );
}
