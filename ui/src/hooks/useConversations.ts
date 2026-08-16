import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PARAMS, type Conversation, type Message } from '../types';

const STORAGE_KEY = 'ollama-ui:conversations';
const ACTIVE_KEY = 'ollama-ui:active-id';

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function makeId(): string {
  return crypto.randomUUID();
}

export function useConversations(defaultModel: string) {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY) || loadConversations()[0]?.id || null
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  const createConversation = useCallback(
    (model?: string) => {
      const now = Date.now();
      // Defaults to whichever model the most recent conversation used
      // (conversations is kept newest-first, see setConversations below) —
      // not a hardcoded model name, which will always eventually go stale
      // as the user's local Ollama catalog changes (this replaced a
      // previous hardcoded 'llama3.2' default that isn't a model most
      // users actually have pulled, showing up as "⚠ llama3.2 (not
      // found)" on every new chat). `defaultModel` is only the fallback
      // for the very first conversation ever, before any model has been
      // picked.
      const resolvedModel = model ?? conversations[0]?.model ?? defaultModel;
      const conversation: Conversation = {
        id: makeId(),
        title: 'New chat',
        model: resolvedModel,
        systemPrompt: '',
        params: { ...DEFAULT_PARAMS },
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      setConversations((prev) => [conversation, ...prev]);
      setActiveId(conversation.id);
      return conversation.id;
    },
    [conversations, defaultModel]
  );

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setActiveId((current) => (current === id ? null : current));
    },
    []
  );

  const updateConversation = useCallback((id: string, patch: Partial<Conversation>) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c))
    );
  }, []);

  const setMessages = useCallback((id: string, messages: Message[]) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, messages, updatedAt: Date.now() } : c))
    );
  }, []);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  return {
    conversations,
    active,
    activeId,
    setActiveId,
    createConversation,
    deleteConversation,
    updateConversation,
    setMessages,
  };
}
