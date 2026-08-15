import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface NextTodo {
  todo_id: string;
  text: string;
  priority: string;
  action_kind: string;
}

interface GoalDigest {
  goal_id: string;
  should_run: boolean;
  quota_state: string;
  todo_total: number;
  todo_open: number;
  todo_done: number;
  next_todo: NextTodo | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 8000;

export function LoopxDigest() {
  const [goals, setGoals] = useState<GoalDigest[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const fetching = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      if (fetching.current) return; // skip if the previous WSL round-trip hasn't finished
      fetching.current = true;
      invoke<GoalDigest[]>('get_loopx_digest')
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

  return (
    <div className="loopx-digest">
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
            </>
          )}
        </article>
      ))}
    </div>
  );
}
