import { invoke } from '@tauri-apps/api/core';

export interface NextTask {
  text: string;
}

export interface TaskDigest {
  project_id: string;
  should_run: boolean;
  task_total: number;
  task_open: number;
  task_done: number;
  next_task: NextTask | null;
  error: string | null;
  /** The real filesystem path this project's tasks are actually about — see useAutonomousLoop.ts's buildTaskPrompt for why this needs to reach the model explicitly. */
  project_dir: string;
}

export function getTaskDigest(): Promise<TaskDigest[]> {
  return invoke<TaskDigest[]>('get_task_digest');
}

// The write-side operation behind a real autonomous run (see
// useAutonomousLoop.ts) — projectId is the only identifier the frontend
// ever needs; project_dir is resolved server-side from the same
// TRACKED_PROJECTS whitelist get_task_digest already iterates (tasks.rs),
// so an unknown projectId fails loudly instead of touching an arbitrary path.
export function completeTask(projectId: string, taskText: string, evidence: string): Promise<void> {
  return invoke('complete_task', { project_id: projectId, task_text: taskText, evidence });
}

export interface TaskItem {
  text: string;
  status: 'open' | 'done';
}

// On-demand only — called only when TaskDigest.tsx's "Show all tasks"
// toggle is actually opened for a project, same as the digest the app used
// to fetch from loopx here (kept as a separate command so opening it can't
// slow down the digest poll itself).
export function listTasks(projectId: string): Promise<TaskItem[]> {
  return invoke<TaskItem[]>('list_tasks', { project_id: projectId });
}
