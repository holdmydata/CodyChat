import { chatOnce } from './ollama';
import type { Message } from '../types';

// On-demand only (a button click in Sidebar), never automatic per-message —
// matches the stance already recorded in local-docs/MEMORY.md when this was
// first floated: eagerly summarizing every conversation was explicitly
// ruled out.

// Caps the digest sent to the model — a long-running conversation's full
// text could itself approach the model's context window, which would be a
// strange failure mode for a feature whose entire job is "make a short
// label." Keeps the start (sets up what the conversation was originally
// about) and the end (where it actually ended up) rather than just the
// tail, since those can diverge for a long conversation.
const MAX_DIGEST_CHARS = 6000;

const SUBJECT_SYSTEM_PROMPT =
  'You label conversations. Read the excerpt and reply with ONLY a short topic label for it: 3 to 6 words, ' +
  'title case, no trailing punctuation, no quotes, no preamble or explanation. Example reply: Fixing Login Timeout Bug';

function buildDigest(messages: Message[]): string {
  const lines = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`);
  let digest = lines.join('\n');
  if (digest.length > MAX_DIGEST_CHARS) {
    const half = Math.floor(MAX_DIGEST_CHARS / 2);
    digest = `${digest.slice(0, half)}\n…[middle trimmed]…\n${digest.slice(-half)}`;
  }
  return digest;
}

function sanitizeSubject(raw: string): string {
  let s = raw.trim().split('\n')[0].trim();
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  s = s.replace(/[.。]+$/, '').trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

export async function generateSubject(baseUrl: string, model: string, messages: Message[]): Promise<string> {
  const digest = buildDigest(messages);
  if (!digest) throw new Error('Nothing to summarize yet — send a message first.');

  const raw = await chatOnce(baseUrl, model, [
    { role: 'system', content: SUBJECT_SYSTEM_PROMPT },
    { role: 'user', content: digest },
  ]);
  const subject = sanitizeSubject(raw);
  if (!subject) throw new Error('Model returned an empty label.');
  return subject;
}

// Used by "Clear context" (ContextMeter.tsx) — floated 2026-08-20: rather
// than wiping history to nothing, replace it with a short real recap plus a
// pointer that the full original messages are still searchable. The
// "still searchable" half needs no new plumbing: every message is already
// indexed into vector memory as it's sent (see useChat.ts's indexMessage
// calls), regardless of whether the conversation gets cleared later — this
// only adds the recap and the reminder that the lookup path exists.
const CLEAR_SUMMARY_SYSTEM_PROMPT =
  'Summarize the key points, decisions, and any open threads from this conversation in 2 to 4 plain-prose sentences, ' +
  'written so someone resuming the conversation has enough context to continue it. No headers, no bullet points, no preamble.';

export async function summarizeForClear(baseUrl: string, model: string, messages: Message[]): Promise<string> {
  const digest = buildDigest(messages);
  if (!digest) throw new Error('Nothing to summarize.');

  const raw = await chatOnce(baseUrl, model, [
    { role: 'system', content: CLEAR_SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: digest },
  ]);
  const summary = raw.trim();
  if (!summary) throw new Error('Model returned an empty summary.');
  return summary;
}
