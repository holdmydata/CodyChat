import { invoke } from '@tauri-apps/api/core';

export interface MemoryGraphNode {
  itemId: number;
  sourceType: string;
  conversationId: string;
  content: string;
  createdAt: number;
}

export interface MemoryGraphEdge {
  from: number;
  to: number;
  distance: number;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

interface RawMemoryGraphNode {
  item_id: number;
  source_type: string;
  conversation_id: string;
  content: string;
  created_at: number;
}

interface RawMemoryGraph {
  nodes: RawMemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

export async function getMemoryGraph(neighborsPerNode: number): Promise<MemoryGraph> {
  const raw = await invoke<RawMemoryGraph>('get_memory_graph', { neighbors_per_node: neighborsPerNode });
  return {
    nodes: raw.nodes.map((n) => ({
      itemId: n.item_id,
      sourceType: n.source_type,
      conversationId: n.conversation_id,
      content: n.content,
      createdAt: n.created_at,
    })),
    edges: raw.edges,
  };
}

export interface MemoryItemDetail {
  itemId: number;
  sourceType: string;
  conversationId: string;
  role: string;
  messageId: string;
  sourcePath: string;
  content: string;
  createdAt: number;
}

interface RawMemoryItemDetail {
  item_id: number;
  source_type: string;
  conversation_id: string;
  role: string;
  message_id: string;
  source_path: string;
  content: string;
  created_at: number;
}

// Full, untruncated fetch for one item — the graph payload's node content
// is truncated for a lightweight overview; this is the on-demand "open the
// real thing" call the detail panel uses instead.
export async function getMemoryItem(itemId: number): Promise<MemoryItemDetail> {
  const raw = await invoke<RawMemoryItemDetail>('get_memory_item', { item_id: itemId });
  return {
    itemId: raw.item_id,
    sourceType: raw.source_type,
    conversationId: raw.conversation_id,
    role: raw.role,
    messageId: raw.message_id,
    sourcePath: raw.source_path,
    content: raw.content,
    createdAt: raw.created_at,
  };
}

export async function deleteMemoryItem(itemId: number): Promise<void> {
  await invoke('delete_memory_item', { item_id: itemId });
}
