import { describe, expect, it } from 'vitest';
import { budgetTokensFor, estimateTokens, trimMessagesToBudget } from './contextBudget';
import type { Message } from '../types';

let nextId = 0;
function msg(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  nextId += 1;
  return { id: `m${nextId}`, content: '', createdAt: 0, ...partial };
}

describe('estimateTokens', () => {
  it('estimates roughly one token per 4 characters', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('budgetTokensFor', () => {
  it('reserves 25% headroom for a large context', () => {
    expect(budgetTokensFor(8192)).toBe(8192 - 2048);
  });

  it('reserves at least 512 tokens of headroom for a small context', () => {
    expect(budgetTokensFor(1024)).toBe(1024 - 512);
  });
});

describe('trimMessagesToBudget', () => {
  it('is a no-op when the conversation is already under budget', () => {
    const msgs = [msg({ role: 'user', content: 'hello' }), msg({ role: 'assistant', content: 'hi there' })];
    const result = trimMessagesToBudget(msgs, 1000);
    expect(result).toBe(msgs);
  });

  it('truncates a single oversized tool result rather than dropping it', () => {
    const msgs = [
      msg({ role: 'user', content: 'read the file' }),
      msg({ role: 'tool', content: 'x'.repeat(20_000), toolCallId: 'call_1' }),
    ];
    const result = trimMessagesToBudget(msgs, 1000);
    const toolMsg = result.find((m) => m.role === 'tool')!;
    expect(toolMsg.content.length).toBeLessThan(20_000);
    expect(toolMsg.content).toContain('truncated to fit context budget');
  });

  it('collapses older tool results before newer ones', () => {
    // Sized so each individual tool message stays under pass 1's
    // per-message ceiling (this test targets pass 2's age-based collapse
    // in isolation) while the total still exceeds the budget.
    const msgs = [
      msg({ role: 'user', content: 'do three things' }),
      msg({ role: 'tool', content: 'oldest result '.repeat(100), toolCallId: 'call_1' }),
      msg({ role: 'tool', content: 'middle result '.repeat(100), toolCallId: 'call_2' }),
      msg({ role: 'tool', content: 'newest result '.repeat(100), toolCallId: 'call_3' }),
      msg({ role: 'user', content: 'what did you find?' }),
    ];
    const result = trimMessagesToBudget(msgs, 1000);
    const [, oldest, middle, newest] = result;
    expect(oldest.content).toContain('collapsed to save context');
    expect(middle.content).not.toContain('collapsed to save context');
    expect(newest.content).not.toContain('collapsed to save context');
  });

  it('never drops or collapses the most recent user message', () => {
    const msgs = [
      msg({ role: 'tool', content: 'y'.repeat(5000), toolCallId: 'call_1' }),
      msg({ role: 'tool', content: 'y'.repeat(5000), toolCallId: 'call_2' }),
      msg({ role: 'tool', content: 'y'.repeat(5000), toolCallId: 'call_3' }),
      msg({ role: 'user', content: 'this is the current question, keep me intact' }),
    ];
    const result = trimMessagesToBudget(msgs, 50);
    const lastUser = result[result.length - 1];
    expect(lastUser.role).toBe('user');
    expect(lastUser.content).toBe('this is the current question, keep me intact');
  });

  it('does not strip toolCalls from an assistant message in the fallback pass (would orphan the paired tool result)', () => {
    const msgs = [
      msg({
        role: 'assistant',
        content: 'writing the file now',
        toolCalls: [{ id: 'call_1', name: 'write_file', arguments: { path: 'x', content: 'z'.repeat(5000) } }],
      }),
      msg({ role: 'tool', content: 'File written successfully.', toolCallId: 'call_1' }),
      msg({ role: 'user', content: 'current question' }),
    ];
    const result = trimMessagesToBudget(msgs, 50);
    const assistantMsg = result.find((m) => m.role === 'assistant')!;
    expect(assistantMsg.toolCalls).toBeDefined();
    expect(assistantMsg.toolCalls?.[0]?.id).toBe('call_1');
  });

  it('leaves a system message untouched if one happens to be present in the input', () => {
    const msgs = [
      msg({ role: 'system', content: 's'.repeat(5000) }),
      msg({ role: 'tool', content: 't'.repeat(5000), toolCallId: 'call_1' }),
      msg({ role: 'user', content: 'current question' }),
    ];
    const result = trimMessagesToBudget(msgs, 50);
    const systemMsg = result.find((m) => m.role === 'system')!;
    expect(systemMsg.content).toBe('s'.repeat(5000));
  });
});
