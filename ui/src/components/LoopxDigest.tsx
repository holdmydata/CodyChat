import { useEffect, useRef, useState } from 'react';
import { getLoopxDigest, type GoalDigest } from '../lib/loopx';
import type { LoopState } from '../hooks/useAutonomousLoop';

const POLL_INTERVAL_MS = 8000;
const DEFAULT_MAX_TODOS = 1;

interface LoopxDigestProps {
  loopState: LoopState;
  stopReason: string | null;
  todosCompleted: number;
  currentGoalId: string | null;
  onStart: (goalId: string, maxTodos: number) => void;
  onStop: () => void;
}

export function LoopxDigest({ loopState, stopReason, todosCompleted, currentGoalId, onStart, onStop }: LoopxDigestProps) {
  const [goals, setGoals] = useState<GoalDigest[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [maxTodos, setMaxTodos] = useState(DEFAULT_MAX_TODOS);
  const fetching = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      if (fetching.current) return; // skip if the previous WSL round-trip hasn't finished
      fetching.current = true;
      getLoopxDigest()
        .then((data) => {
          if (!cancelled) {
            setGoals(data);
            setFetchError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setFetchError(String(err));
        })
        .finally(() => {
          fetching.current = false;
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (fetchError) {
    return <div className="loopx-digest loopx-digest--error">Failed to load loopx digest: {fetchError}</div>;
  }

  if (!goals) {
    return <div className="loopx-digest">Loading…</div>;
  }

  const running = loopState !== 'idle' && loopState !== 'stopped';

  return (
    <div className="loopx-digest">
      <div className="loopx-digest__run-controls">
        <label className="loopx-digest__max-todos">
          <span>Max todos per run</span>
          <input
            type="number"
            min={1}
            max={20}
            value={maxTodos}
            onChange={(e) => setMaxTodos(Math.max(1, Number(e.target.value) || 1))}
            disabled={running}
          />
        </label>
        {running && (
          <p className="loopx-digest__run-status">
            Running against <code>{currentGoalId}</code> — {loopState} ({todosCompleted} completed)
            <button type="button" onClick={onStop}>
              Stop
            </button>
          </p>
        )}
        {!running && loopState === 'stopped' && stopReason && (
          <p className="loopx-digest__run-status loopx-digest__run-status--stopped">Last run stopped: {stopReason}</p>
        )}
      </div>

      {goals.map((goal) => (
        <article key={goal.goal_id} className="loopx-digest__card">
          <h3>{goal.goal_id}</h3>
          {goal.error ? (
            <p className="loopx-digest__error">{goal.error}</p>
          ) : (
            <>
              <p className="loopx-digest__counts">
                {goal.todo_done}/{goal.todo_total} todos done · quota {goal.quota_state}
              </p>
              {goal.next_todo ? (
                <p className="loopx-digest__next">Next: {goal.next_todo.text}</p>
              ) : (
                <p className="loopx-digest__next loopx-digest__next--idle">Nothing queued</p>
              )}
              {/* Runs a real turn in the chat window using the app's own tool-approval
                  pipeline — see useAutonomousLoop.ts. Deliberately not offered when
                  nothing's queued, even though the button would just no-op cleanly either
                  way, since there's nothing meaningful to click into. */}
              <button
                type="button"
                className="loopx-digest__run-button"
                onClick={() => onStart(goal.goal_id, maxTodos)}
                disabled={running || !goal.next_todo}
              >
                Start autonomous run
              </button>
            </>
          )}
        </article>
      ))}
    </div>
  );
}
