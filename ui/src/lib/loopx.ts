import { invoke } from '@tauri-apps/api/core';

export interface NextTodo {
  todo_id: string;
  text: string;
  priority: string;
  action_kind: string;
}

export interface GoalDigest {
  goal_id: string;
  should_run: boolean;
  quota_state: string;
  todo_total: number;
  todo_open: number;
  todo_done: number;
  next_todo: NextTodo | null;
  error: string | null;
}

export function getLoopxDigest(): Promise<GoalDigest[]> {
  return invoke<GoalDigest[]>('get_loopx_digest');
}

// The write-side operations behind a real autonomous run (see
// useAutonomousLoop.ts) — goal_id is the only identifier the frontend ever
// needs; agent_id/project_dir are resolved server-side from the same
// TRACKED_GOALS whitelist get_loopx_digest already iterates (loopx.rs), so
// an unknown goal_id fails loudly instead of shelling into an arbitrary path.

export function completeTodo(goalId: string, todoId: string, evidence: string): Promise<void> {
  return invoke('loopx_complete_todo', { goal_id: goalId, todo_id: todoId, evidence });
}

export function refreshLoopxState(goalId: string): Promise<void> {
  return invoke('loopx_refresh_state', { goal_id: goalId });
}

export function spendSlot(goalId: string, slots = 1): Promise<void> {
  return invoke('loopx_spend_slot', { goal_id: goalId, slots });
}
