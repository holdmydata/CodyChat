import { useCallback, useRef, useState } from 'react';
import { completeTodo, getLoopxDigest, refreshLoopxState, spendSlot } from '../lib/loopx';
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
  runAutonomousTurn: (promptText: string) => Promise<{ content: string; toolNames: string[] }>;
  /** For indexing evidence into vector memory after each todo — see the completeTodo block below. */
  baseUrl: string;
}

// Real bug hit on the first live run: a passive "Current task: {text}" prompt
// got answered as a conversational question ("great question about loopx,
// let me give you a rundown...") instead of actually executing the named
// command — the model never called execute_command at all. Same failure
// class this project already hit once before (2026-08-14, a generic
// instruction read as "explain this" instead of "do this") — fixed the
// same way: a much more imperative framing that explicitly rules out
// discussing/explaining and calls out execute_command by name when the todo
// names a literal command to run. Note this doesn't make execute_command
// itself silent — it's still 'execute' risk tier (toolConfig.ts), so it
// still stops for a real approval click regardless of this prompt; only
// read-only calls proceed unattended.
function buildTodoPrompt(todoText: string): string {
  return (
    'You are operating autonomously against this project\'s own todo list — no one is watching this ' +
    'conversation right now. Actually perform the task below using your available tools; do not describe, ' +
    'explain, or discuss it instead of doing it. If the task names a specific command to run (e.g. "Run X"), ' +
    'execute that literal command for real via execute_command and report its actual output — a description ' +
    'of what the command or tool generally does is not a substitute for running it.\n\n' +
    `Task: ${todoText}`
  );
}

function buildEvidence(result: { content: string; toolNames: string[] }): string {
  const content = result.content.trim() ? result.content.trim().slice(0, 400) : '(no final content produced)';
  const tools = result.toolNames.length ? ` Tools used: ${result.toolNames.join(', ')}.` : '';
  return `Autonomous run: ${content}${tools}`;
}

// The loop's own governance, separate from and on top of the per-turn tool-
// approval gate above: a hard max-todos step cap, always-on stop-on-error,
// stop when loopx itself says nothing is left to do, and a no-progress
// check (the same todo selected twice in a row means the previous
// `todo complete` didn't actually clear it — looping on that forever would
// be exactly the runaway-loop failure mode this exists to prevent). All
// four enforced in this function's own control flow, not left to the
// model's judgment — matches the "circuit breakers live outside the
// agent's own reasoning" principle this was designed against.
export function useAutonomousLoop({ runAutonomousTurn, baseUrl }: UseAutonomousLoopArgs) {
  const [state, setState] = useState<LoopState>('idle');
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [todosCompleted, setTodosCompleted] = useState(0);
  const [currentGoalId, setCurrentGoalId] = useState<string | null>(null);
  const stopRequestedRef = useRef(false);

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
  }, []);

  const start = useCallback(
    async (goalId: string, maxTodos: number) => {
      stopRequestedRef.current = false;
      setCurrentGoalId(goalId);
      setTodosCompleted(0);
      setStopReason(null);

      let lastTodoId: string | null = null;

      for (let i = 0; i < maxTodos; i++) {
        if (stopRequestedRef.current) {
          setState('stopped');
          setStopReason('Stopped by user.');
          return;
        }

        setState('fetching');
        let digest;
        try {
          const all = await getLoopxDigest();
          digest = all.find((g) => g.goal_id === goalId);
        } catch (err) {
          setState('stopped');
          setStopReason(`Failed to fetch loopx state: ${String(err)}`);
          return;
        }

        if (!digest || digest.error) {
          setState('stopped');
          setStopReason(digest?.error ?? `Unknown goal: ${goalId}`);
          return;
        }
        if (!digest.should_run || !digest.next_todo) {
          setState('stopped');
          setStopReason('No more todos — loopx reports nothing eligible to run.');
          return;
        }

        const todo = digest.next_todo;
        if (todo.todo_id === lastTodoId) {
          setState('stopped');
          setStopReason(`No progress: "${todo.text}" was selected again after being reported complete.`);
          return;
        }
        lastTodoId = todo.todo_id;

        setState('running');
        let result: { content: string; toolNames: string[] };
        try {
          result = await runAutonomousTurn(buildTodoPrompt(todo.text));
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

        setState('reporting');
        try {
          const evidence = buildEvidence(result);
          await completeTodo(goalId, todo.todo_id, evidence);
          await refreshLoopxState(goalId);
          await spendSlot(goalId, 1);
          // Indexed as the agent's own growing experience log — distinct in
          // purpose from docs/MEMORY.md (the human/Claude-Code engineering
          // log): a future autonomous turn can search_memory this instead
          // of re-deriving context from scratch, which is exactly what cost
          // this session real context budget (a turn had to read the full,
          // huge MEMORY.md just to learn how loopx works). Fire-and-forget,
          // same non-fatal posture as indexDocument's own internal
          // try/catch — a failure here shouldn't affect the loop, which has
          // already succeeded at reporting real state to loopx above.
          void indexDocument(baseUrl, 'agent_evidence', `${goalId}:${todo.todo_id}`, evidence);
        } catch (err) {
          setState('stopped');
          setStopReason(`Failed to report evidence back to loopx: ${String(err)}`);
          return;
        }

        setTodosCompleted((n) => n + 1);
      }

      setState('stopped');
      setStopReason(`Stopped: reached the max-todos limit (${maxTodos}).`);
    },
    [runAutonomousTurn, baseUrl]
  );

  return { state, stopReason, todosCompleted, currentGoalId, start, stop };
}
