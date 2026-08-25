import type { Message } from '../types';

// Trims the wire history sent to Ollama to fit within a conversation's
// numCtx, purely to avoid the crash — nothing here touches what's actually
// stored/displayed (conversation.messages, what MessageBubble renders).
// The user can always scroll up and see the full original tool output;
// only the outbound request payload gets compacted. See useChat.ts's call
// site (where toWireMessages is built) for how this plugs in.

// Ollama exposes no tokenizer to this app, and pulling one in just for a
// budget estimate is more than this needs — chars/4 is the standard rough
// heuristic (English text averages ~4 chars/token). It only needs to be
// right enough to trigger trimming before Ollama itself rejects the
// request, not exactly right.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const RESPONSE_HEADROOM_FRACTION = 0.25;
const MIN_RESPONSE_HEADROOM_TOKENS = 512;

// Reserves room for the model's own reply (and any further tool-call round
// in the same turn) — budgeting history all the way up to numCtx would
// leave no room for Ollama to actually generate anything.
export function budgetTokensFor(numCtx: number): number {
  return numCtx - Math.max(numCtx * RESPONSE_HEADROOM_FRACTION, MIN_RESPONSE_HEADROOM_TOKENS);
}

// Any single tool-result message over this fraction of the budget gets
// truncated on its own, regardless of age — a single huge fresh
// `read_file` result (up to 200KB raw text) shouldn't be able to blow the
// budget by itself before age-based collapsing below even gets a chance.
const MAX_SINGLE_MESSAGE_FRACTION = 0.4;
// How many of the most recent tool-result messages stay full (subject to
// the per-message ceiling above) before older ones start collapsing to
// short placeholders.
const KEEP_FULL_RECENT_TOOL_RESULTS = 2;

// What toWireMessages() actually sends to Ollama for a given message:
// `content`, plus (for assistant messages) every tool call's `arguments` —
// note `thinking` is NOT included there and so must not be counted here
// either, or this budget would trim more aggressively than the real wire
// payload requires. Tool-call arguments matter too: a `write_file` call
// embeds the entire file content being written as an argument, which can
// be just as large as a `read_file` result.
// Exported for the context-usage indicator (ContextMeter.tsx) — reuses the
// exact same accounting the trimmer itself budgets against (content + any
// tool-call arguments), rather than a separate, potentially-inconsistent
// estimate for what the UI displays vs. what actually gets sent.
export function messageTokens(m: Message): number {
  let tokens = estimateTokens(m.content);
  if (m.toolCalls?.length) {
    for (const call of m.toolCalls) {
      tokens += estimateTokens(JSON.stringify(call.arguments));
    }
  }
  return tokens;
}

function truncateToTokenCeiling(content: string, ceilingTokens: number): string {
  const ceilingChars = ceilingTokens * 4;
  if (content.length <= ceilingChars) return content;
  const note = '\n…[truncated to fit context budget]';
  return content.slice(0, Math.max(0, ceilingChars - note.length)) + note;
}

function collapseToolResult(m: Message): Message {
  const preview = m.content.slice(0, 300);
  return { ...m, content: `${preview}…[collapsed to save context — originally ${m.content.length} chars]` };
}

/**
 * Trims a message list to fit within `budgetTokens`, in three passes:
 * 1. cap any single tool-result message over MAX_SINGLE_MESSAGE_FRACTION
 *    of the budget
 * 2. collapse older tool-result messages to short placeholders, oldest
 *    first, keeping the most recent KEEP_FULL_RECENT_TOOL_RESULTS full
 * 3. (fallback, rare) collapse whole oldest plain content messages (no
 *    tool calls) to a one-line placeholder
 *
 * The single most recent user message (and everything after it) is never
 * touched — the current ask always has to get through. Runs on every
 * turn; short conversations hit the early-exit on line one and are
 * returned unchanged.
 */
export function trimMessagesToBudget(msgs: Message[], budgetTokens: number): Message[] {
  let total = msgs.reduce((sum, m) => sum + messageTokens(m), 0);
  if (total <= budgetTokens) return msgs;

  // Pass 1: per-message ceiling on tool results.
  const messageCeiling = Math.floor(budgetTokens * MAX_SINGLE_MESSAGE_FRACTION);
  let result = msgs.map((m) => {
    if (m.role !== 'tool') return m;
    const before = messageTokens(m);
    if (before <= messageCeiling) return m;
    const truncated = { ...m, content: truncateToTokenCeiling(m.content, messageCeiling) };
    total += messageTokens(truncated) - before;
    return truncated;
  });
  if (total <= budgetTokens) return result;

  // Index of the last user message — nothing at or after it is ever
  // trimmed by passes 2/3 below.
  let lastUserIdx = result.length;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  // Pass 2: collapse older tool results, oldest first.
  const toolIndices: number[] = [];
  for (let i = 0; i < lastUserIdx; i++) {
    if (result[i].role === 'tool') toolIndices.push(i);
  }
  const collapsible = toolIndices.slice(0, Math.max(0, toolIndices.length - KEEP_FULL_RECENT_TOOL_RESULTS));
  for (const i of collapsible) {
    if (total <= budgetTokens) break;
    const before = messageTokens(result[i]);
    const collapsed = collapseToolResult(result[i]);
    const after = messageTokens(collapsed);
    if (after >= before) continue;
    result = result.map((m, idx) => (idx === i ? collapsed : m));
    total += after - before;
  }
  if (total <= budgetTokens) return result;

  // Pass 3 (fallback): collapse whole oldest plain content messages
  // (users' earlier questions, an assistant's earlier final answers)
  // before the last user message, oldest first. Deliberately skips any
  // message with toolCalls — stripping an assistant message's toolCalls
  // would leave its paired tool-result message's tool_call_id dangling
  // (referencing a call no longer in history), an invalid wire payload,
  // not just an aggressive trim. A known, currently-unhandled edge case
  // this leaves open: an assistant message whose tool-call *arguments*
  // are themselves huge (e.g. a large write_file content argument) isn't
  // covered by any pass here — pass 1/2 only target role: 'tool' result
  // messages, which is the confirmed dominant real-world case.
  for (let i = 0; i < lastUserIdx && total > budgetTokens; i++) {
    const m = result[i];
    if (m.role === 'system' || m.toolCalls?.length) continue;
    const before = messageTokens(m);
    if (before === 0) continue;
    const placeholder: Message = { ...m, content: '[older message trimmed to fit context budget]' };
    const after = messageTokens(placeholder);
    if (after >= before) continue;
    result = result.map((mm, idx) => (idx === i ? placeholder : mm));
    total += after - before;
  }

  return result;
}
