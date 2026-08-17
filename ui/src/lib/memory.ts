import { invoke } from '@tauri-apps/api/core';
import { embedText } from './ollama';

// nomic-embed-text specifically, not whatever chat model the conversation
// happens to be using — embeddings and chat completions are different
// model families in Ollama. Switching this later requires dropping and
// fully re-embedding the Rust side's memory_items table (dimension lock-in,
// see memory.rs) — not solved here, just flagged.
export const EMBEDDING_MODEL = 'nomic-embed-text';

interface RawMemoryMatch {
  source_type: string;
  conversation_id: string;
  role: string;
  created_at: number;
  message_id: string;
  source_path: string;
  content: string;
  distance: number;
}

export interface MemoryMatch {
  sourceType: string;
  conversationId: string;
  role: string;
  createdAt: number;
  messageId: string;
  sourcePath: string;
  content: string;
  distance: number;
}

// Shared by indexMessage/indexDocument below — embeds then writes, never
// throws to the caller (both call sites are fire-and-forget). A failure
// here shouldn't interrupt the actual chat turn, same non-fatal posture as
// notifyIfHidden.
async function indexItem(
  baseUrl: string,
  sourceType: string,
  conversationId: string,
  role: string,
  messageId: string,
  sourcePath: string,
  content: string,
  createdAt: number
): Promise<void> {
  try {
    if (!content.trim()) return;
    const embedding = await embedText(baseUrl, EMBEDDING_MODEL, content);
    await invoke('index_memory_item', {
      source_type: sourceType,
      conversation_id: conversationId,
      role,
      message_id: messageId,
      source_path: sourcePath,
      content,
      created_at: createdAt,
      embedding,
    });
  } catch (err) {
    console.error('indexItem failed (non-fatal):', err);
  }
}

export function indexMessage(
  baseUrl: string,
  conversationId: string,
  messageId: string,
  role: string,
  content: string,
  createdAt: number
): Promise<void> {
  return indexItem(baseUrl, 'chat_message', conversationId, role, messageId, '', content, createdAt);
}

// sourceType is whatever the Rust read_file command actually detected
// (see ReadFileResult in skills.rs) — the single source of truth for how
// the content was read, not re-derived from the file extension here.
// messageId doubles as the dedup key on the Rust side (see memory.rs's
// index_item_in), so it's set to sourcePath — a given file path re-read
// and re-remembered later just re-indexes idempotently, doesn't duplicate.
export function indexDocument(baseUrl: string, sourceType: string, sourcePath: string, content: string): Promise<void> {
  return indexItem(baseUrl, sourceType, '', '', sourcePath, sourcePath, content, Date.now());
}

export async function searchMemory(
  baseUrl: string,
  query: string,
  topK: number,
  excludeConversationId?: string,
  sourceType?: string
): Promise<MemoryMatch[]> {
  const embedding = await embedText(baseUrl, EMBEDDING_MODEL, query);
  const raw = await invoke<RawMemoryMatch[]>('search_memory', {
    embedding,
    top_k: topK,
    source_type: sourceType,
    exclude_conversation_id: excludeConversationId,
  });
  return raw.map((m) => ({
    sourceType: m.source_type,
    conversationId: m.conversation_id,
    role: m.role,
    createdAt: m.created_at,
    messageId: m.message_id,
    sourcePath: m.source_path,
    content: m.content,
    distance: m.distance,
  }));
}
