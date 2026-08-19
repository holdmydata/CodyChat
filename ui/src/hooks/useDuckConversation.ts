import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PARAMS, type Conversation, type Message } from '../types';

const STORAGE_KEY = 'ollama-ui:duck-conversation';

// Base-pass persona (see docs/companion-duck-architecture.md for the fuller
// personality-config-file idea) — one hardcoded duck, not a swappable
// system yet. Deliberately short/casual: this is a companion chat, not a
// task-completion one, and shouldn't read like the main assistant with a
// costume on.
const DUCK_SYSTEM_PROMPT =
  "You are Cody, a small companion duck who lives inside this chat app, separate from the user's other conversations. " +
  'Be warm, a little playful and duck-ish (an occasional quack/chirp, used sparingly — not every message), and present ' +
  "as genuine company rather than a work tool, though you're happy to help if actually asked something. Keep replies " +
  'short and conversational, not long structured answers — this is a casual companion chat.';

function loadDuckConversation(): Conversation | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function makeId(): string {
  return crypto.randomUUID();
}

function createDuckConversation(model: string): Conversation {
  const now = Date.now();
  return {
    id: makeId(),
    title: 'Cody',
    model,
    systemPrompt: DUCK_SYSTEM_PROMPT,
    params: { ...DEFAULT_PARAMS },
    messages: [],
    createdAt: now,
    updatedAt: now,
    // Default off — a playful companion chat mixed into the same vector
    // memory search results as real work conversations is more likely to
    // be noise than useful recall. Real setting exists (memoryDisabled on
    // Conversation) so this can flip later without a schema change.
    memoryDisabled: true,
  };
}

// Single persisted conversation, not a list — the duck isn't part of the
// sidebar's conversation list (useConversations), it's one ongoing
// companion thread. Shaped to match what useChat/ChatWindow already expect
// (conversation + setMessages + updateConversation) so both can be reused
// directly instead of building duck-specific chat plumbing.
export function useDuckConversation(defaultModel: string) {
  const [conversation, setConversation] = useState<Conversation | null>(
    () => loadDuckConversation() ?? createDuckConversation(defaultModel)
  );

  useEffect(() => {
    if (conversation) localStorage.setItem(STORAGE_KEY, JSON.stringify(conversation));
  }, [conversation]);

  const setMessages = useCallback((_id: string, messages: Message[]) => {
    setConversation((prev) => (prev ? { ...prev, messages, updatedAt: Date.now() } : prev));
  }, []);

  const updateConversation = useCallback((_id: string, patch: Partial<Conversation>) => {
    setConversation((prev) => (prev ? { ...prev, ...patch, updatedAt: Date.now() } : prev));
  }, []);

  return { conversation, setMessages, updateConversation };
}
