import { useCallback, useRef, useState } from 'react';
import { completeTask, getTaskDigest } from '../lib/tasks';
import { indexDocument } from '../lib/memory';

export type LoopState = 'idle' | 'fetching' | 'running' | 'reporting' | 'stopped';

interface UseAutonomousLoopArgs {
  // Reuses useChat.ts's exact tool-calling/approval/streaming path — an
  // autonomous turn is not a separate execution mechanism, it's a normal
  // turn started from a synthesized prompt instead of typed input. "Plan
  // escape" governance is *already* enforced here: requestApproval still
  // blocks on any write/execute tool call exactly as it does for a human-
  // driven message, so a run only proceeds unattended through read-only
  // calls (see toolConfig.ts's autoApproveReadOnly) — any write/execute
  // call is the point a person has to be there, by construction, not by a
  // new check bolted on top.
  runAutonomousTurn: (promptText: string) => Promise<{ content: string; toolNames: string[]; completed: boolean }>;
  /** For indexing evidence into vector memory after each task — see the completeTask block below. */
  baseUrl: string;
}

// Real bug hit on the first live run (back when this was loopx-backed): a
// passive "Current task: {text}" prompt got answered as a conversational
// question ("great question, let me give you a rundown...") instead of
// actually executing the named command — the model never called
// execute_command at all. Same failure class this project already hit once
// before (2026-08-14, a generic instruction read as "explain this" instead
// of "do this") — fixed the same way: a much more imperative framing that
// explicitly rules out discussing/explaining and calls out execute_command
// by name when the task names a literal command to run. Note this doesn't
// make execute_command itself silent — it's still 'execute' risk tier
// (toolConfig.ts), so it still stops for a real approval click regardless
// of this prompt; only read-only calls proceed unattended.
// Real bug found 2026-08-20, from an actual live run against a non-UI
// project (cffb): the standing environment context injected into every turn
// (useChat.ts's envContextRef) reports this *app's* own project_root —
// correct for normal chat, but every tracked project isn't necessarily
// about this app at all (see tasks.rs's TRACKED_PROJECTS: kanban-reader,
// threejs-game, and cffb all live in their own separate directories). With
// no project-specific grounding, the model had nothing but the app's own
// folder to go on, so it read/gathered context from there instead of the
// actual target project — exactly what was observed live. projectDir comes
// straight from the same TRACKED_PROJECTS-backed digest (TaskDigest's
// project_dir field), so each task explicitly states where its real files
// live, overriding the app's own project_root for the scope of this one
// task rather than changing what every other conversation is grounded to.
function buildTaskPrompt(taskText: string, projectDir: string): string {
  return (
    'You are operating autonomously against this project\'s own task list — no one is watching this ' +
    'conversation right now. Actually perform the task below using your available tools; do not describe, ' +
    'explain, or discuss it instead of doing it. If the task names a specific command to run (e.g. "Run X"), ' +
    'execute that literal command for real via execute_command and report its actual output — a description ' +
    'of what the command or tool generally does is not a substitute for running it.\n\n' +
    `This task's project lives at: ${projectDir} — even if your standing environment context names a ` +
    "different default folder, that's this app's own codebase, not necessarily this task's. Start by listing " +
    "or reading files under this project's own path above, not the app's default folder, unless the task " +
    'explicitly says otherwise.\n\n' +
    `Task: ${taskText}`
  );
}

function buildEvidence(result: { content: string; toolNames: string[] }): string {
  const content = result.content.trim() ? result.content.trim().slice(0, 400) : '(no final content produced)';
  const tools = result.toolNames.length ? ` Tools used: ${result.toolNames.join(', ')}.` : '';
  return `Autonomous run: ${content}${tools}`;
}

// The loop's own governance, separate from and on top of the per-turn tool-
// approval gate above: a hard max-tasks step cap, always-on stop-on-error,
// stop when the tracked project reports nothing eligible to run, and a
// no-progress check (the same task selected twice in a row means the
// previous complete_task call didn't actually clear it — looping on that
// forever would be exactly the runaway-loop failure mode this exists to
// prevent). All four enforced in this function's own control flow, not left
// to the model's judgment — matches the "circuit breakers live outside the
// agent's own reasoning" principle this was designed against. Previously
// this same governance sat on top of loopx; it's unchanged by the 2026-08-22
// move off loopx onto a plain per-project AGENT_TASKS.md file (see
// tasks.rs) — none of it ever depended on loopx's own quota/spend-slot
// machinery, which this app never actually consumed.
export function useAutonomousLoop({ runAutonomousTurn, baseUrl }: UseAutonomousLoopArgs) {
  const [state, setState] = useState<LoopState>('idle');
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [todosCompleted, setTodosCompleted] = useState(0);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const stopRequestedRef = useRef(false);

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
  }, []);

  const start = useCallback(
    async (projectId: string, maxTasks: number) => {
      stopRequestedRef.current = false;
      setCurrentProjectId(projectId);
      setTodosCompleted(0);
      setStopReason(null);

      let lastTaskText: string | null = null;

      for (let i = 0; i < maxTasks; i++) {
        if (stopRequestedRef.current) {
          setState('stopped');
          setStopReason('Stopped by user.');
          return;
        }

        setState('fetching');
        let digest;
        try {
          const all = await getTaskDigest();
          digest = all.find((p) => p.project_id === projectId);
        } catch (err) {
          setState('stopped');
          setStopReason(`Failed to fetch task state: ${String(err)}`);
          return;
        }

        if (!digest || digest.error) {
          setState('stopped');
          setStopReason(digest?.error ?? `Unknown project: ${projectId}`);
          return;
        }
        if (!digest.should_run || !digest.next_task) {
          setState('stopped');
          setStopReason('No more tasks — nothing eligible to run in AGENT_TASKS.md\'s Ready lane.');
          return;
        }

        const task = digest.next_task;
        if (task.text === lastTaskText) {
          setState('stopped');
          setStopReason(`No progress: "${task.text}" was selected again after being reported complete.`);
          return;
        }
        lastTaskText = task.text;

        setState('running');
        let result: { content: string; toolNames: string[]; completed: boolean };
        try {
          result = await runAutonomousTurn(buildTaskPrompt(task.text, digest.project_dir));
        } catch (err) {
          setState('stopped');
          setStopReason(`Turn failed: ${String(err)}`);
          return;
        }

        if (stopRequestedRef.current) {
          setState('stopped');
          setStopReason('Stopped by user.');
          return;
        }

        // Real bug fixed 2026-08-20 (back when this reported to loopx): this
        // used to report every turn as done unconditionally, including ones
        // that got cut short by the tool-call safety cap or a context-
        // overflow retry failure — the tracker would then believe a task was
        // finished when it genuinely wasn't, with no way to tell from its
        // own state that anything had gone wrong. Stopping here instead (not
        // skipping to the next task) leaves this one still selectable on the
        // next run, and the reason is specific enough to act on rather than
        // a generic failure.
        if (!result.completed) {
          setState('stopped');
          setStopReason(
            `"${task.text}" didn't reach a real final answer this turn (hit the tool-call safety cap or a ` +
              "context-overflow retry that also failed) — stopped without marking it complete, so it's still " +
              'available to pick up again. Consider a smaller/more specific task, or raising context length in Settings.'
          );
          return;
        }

        setState('reporting');
        try {
          const evidence = buildEvidence(result);
          await completeTask(projectId, task.text, evidence);
          // Indexed as the agent's own growing experience log — distinct in
          // purpose from local-docs/MEMORY.md (the human/Claude-Code
          // engineering log): a future autonomous turn can search_memory
          // this instead of re-deriving context from scratch. Fire-and-
          // forget, same non-fatal posture as indexDocument's own internal
          // try/catch — a failure here shouldn't affect the loop, which has
          // already succeeded at writing real state back to AGENT_TASKS.md
          // above.
          void indexDocument(baseUrl, 'agent_evidence', `${projectId}:${task.text.slice(0, 60)}`, evidence);
        } catch (err) {
          setState('stopped');
          setStopReason(`Failed to write task completion back to AGENT_TASKS.md: ${String(err)}`);
          return;
        }

        setTodosCompleted((n) => n + 1);
      }

      setState('stopped');
      setStopReason(`Stopped: reached the max-tasks limit (${maxTasks}).`);
    },
    [runAutonomousTurn, baseUrl]
  );

  return { state, stopReason, todosCompleted, currentProjectId, start, stop };
}
