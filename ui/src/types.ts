export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ActivityStatus = 'pending_approval' | 'running' | 'done' | 'denied' | 'error';

export interface ActivityStep {
  id: string;
  toolName: string;
  argsSummary: string;
  status: ActivityStatus;
  resultSummary?: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  thinking?: string;
  /** Present on assistant messages that requested one or more tool calls. */
  toolCalls?: ToolCall[];
  /** Present on 'tool' role messages — which call this result responds to. */
  toolCallId?: string;
  /**
   * Snapshot of the full tool-call step log for the turn this message
   * concludes (final answer, or the max-iterations stop notice) — lets the
   * activity log survive after streaming ends instead of vanishing with
   * the live ActivityTracker.
   */
  activitySteps?: ActivityStep[];
  createdAt: number;
}

export interface ChatParams {
  temperature: number;
  topP: number;
  numCtx: number;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  params: ChatParams;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** When true, this conversation's messages are never indexed into vector memory (see lib/memory.ts). Undefined/false means indexing is on, same as every existing stored conversation before this field existed. */
  memoryDisabled?: boolean;
}

export const DEFAULT_PARAMS: ChatParams = {
  temperature: 0.8,
  topP: 0.9,
  numCtx: 8192,
};
