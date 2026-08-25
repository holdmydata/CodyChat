import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { getTaskDigest, listTasks, type TaskDigest as TaskDigestData, type TaskItem } from '../lib/tasks';
import type { LoopState } from '../hooks/useAutonomousLoop';
import type { ToolCall } from '../types';
import { ToolApprovalPrompt } from './ToolApprovalPrompt';
import { ChoicePrompt } from './ChoicePrompt';

const POLL_INTERVAL_MS = 8000;
const DEFAULT_MAX_TASKS = 1;

interface TaskDigestProps {
  loopState: LoopState;
  stopReason: string | null;
  todosCompleted: number;
  currentProjectId: string | null;
  onStart: (projectId: string, maxTasks: number) => void;
  onStop: () => void;
  /** Surfaced here too, not just in the chat window — an autonomous run's tool calls still need a real approval click, and this pane is exactly where someone watching a run would otherwise have no way to see or act on one. */
  pendingToolCall: ToolCall | null;
  onApproveToolCall: () => void;
  onDenyToolCall: () => void;
  onSelectToolChoice: (option: string) => void;
}

export function TaskDigest({
  loopState,
  stopReason,
  todosCompleted,
  currentProjectId,
  onStart,
  onStop,
  pendingToolCall,
  onApproveToolCall,
  onDenyToolCall,
  onSelectToolChoice,
}: TaskDigestProps) {
  const [projects, setProjects] = useState<TaskDigestData[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [maxTasks, setMaxTasks] = useState(DEFAULT_MAX_TASKS);
  const fetching = useRef(false);

  // Per-project "show all tasks" — deliberately on-demand (see listTasks's
  // own comment) rather than folded into the poll below, so opening it
  // can't make the digest load feel slower.
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [taskLists, setTaskLists] = useState<Record<string, TaskItem[]>>({});
  const [taskListErrors, setTaskListErrors] = useState<Record<string, string>>({});
  const [loadingTaskLists, setLoadingTaskLists] = useState<Set<string>>(new Set());

  const toggleTaskList = (projectId: string) => {
    if (expandedProjectId === projectId) {
      setExpandedProjectId(null);
      return;
    }
    setExpandedProjectId(projectId);
    if (taskLists[projectId] || loadingTaskLists.has(projectId)) return;
    setLoadingTaskLists((prev) => new Set(prev).add(projectId));
    listTasks(projectId)
      .then((items) => setTaskLists((prev) => ({ ...prev, [projectId]: items })))
      .catch((err) => setTaskListErrors((prev) => ({ ...prev, [projectId]: String(err) })))
      .finally(() =>
        setLoadingTaskLists((prev) => {
          const next = new Set(prev);
          next.delete(projectId);
          return next;
        })
      );
  };

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      if (fetching.current) return; // skip if the previous read hasn't finished
      fetching.current = true;
      getTaskDigest()
        .then((data) => {
          if (!cancelled) {
            setProjects(data);
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
    return <div className="task-digest task-digest--error">Failed to load task digest: {fetchError}</div>;
  }

  if (!projects) {
    return <div className="task-digest">Loading…</div>;
  }

  const running = loopState !== 'idle' && loopState !== 'stopped';

  return (
    <div className="task-digest">
      <div className="task-digest__run-controls">
        <label className="task-digest__max-tasks">
          <span>Max tasks per run</span>
          <input
            type="number"
            min={1}
            max={20}
            value={maxTasks}
            onChange={(e) => setMaxTasks(Math.max(1, Number(e.target.value) || 1))}
            disabled={running}
          />
        </label>
        {running && (
          <p className="task-digest__run-status">
            Running against <code>{currentProjectId}</code> — {loopState} ({todosCompleted} completed)
            <button type="button" onClick={onStop}>
              Stop
            </button>
          </p>
        )}
        {!running && loopState === 'stopped' && stopReason && (
          <p className="task-digest__run-status task-digest__run-status--stopped">Last run stopped: {stopReason}</p>
        )}
      </div>

      {pendingToolCall &&
        (pendingToolCall.name === 'ask_user_choice' ? (
          <ChoicePrompt call={pendingToolCall} onSelect={onSelectToolChoice} onCancel={onDenyToolCall} />
        ) : (
          <ToolApprovalPrompt call={pendingToolCall} onApprove={onApproveToolCall} onDeny={onDenyToolCall} />
        ))}

      {projects.map((project) => {
        // A run that stopped without completing (see useAutonomousLoop.ts's
        // completed-flag fix) leaves this same task still queued — labeling
        // the button "Retry" instead of "Start" for that specific case makes
        // clear this resumes interrupted work rather than starting fresh.
        const isRetry = !running && loopState === 'stopped' && project.project_id === currentProjectId;
        const expanded = expandedProjectId === project.project_id;
        return (
          <article key={project.project_id} className="task-digest__card">
            <h3>{project.project_id}</h3>
            {project.error ? (
              <p className="task-digest__error">{project.error}</p>
            ) : (
              <>
                <p className="task-digest__counts">
                  {project.task_done}/{project.task_total} tasks done
                </p>
                {project.next_task ? (
                  <p className="task-digest__next">Next: {project.next_task.text}</p>
                ) : (
                  <p className="task-digest__next task-digest__next--idle">Nothing queued</p>
                )}

                <button
                  type="button"
                  className="task-digest__toggle-tasks"
                  onClick={() => toggleTaskList(project.project_id)}
                >
                  {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  <span>{expanded ? 'Hide' : 'Show'} all tasks</span>
                </button>

                {expanded && (
                  <div className="task-digest__task-list">
                    {loadingTaskLists.has(project.project_id) ? (
                      <p className="task-digest__next--idle">Loading tasks…</p>
                    ) : taskListErrors[project.project_id] ? (
                      <p className="task-digest__error">Couldn't load: {taskListErrors[project.project_id]}</p>
                    ) : taskLists[project.project_id]?.length ? (
                      <ul>
                        {taskLists[project.project_id].map((t) => (
                          <li
                            key={`${t.status}:${t.text}`}
                            className={`task-digest__task-item task-digest__task-item--${t.status}`}
                          >
                            <span className="task-digest__task-status">{t.status}</span>
                            <span>{t.text}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="task-digest__next--idle">No tasks yet — add one under Ready in AGENT_TASKS.md.</p>
                    )}
                  </div>
                )}

                {/* Runs a real turn in the chat window using the app's own tool-approval
                    pipeline — see useAutonomousLoop.ts. Deliberately not offered when
                    nothing's queued, even though the button would just no-op cleanly either
                    way, since there's nothing meaningful to click into. */}
                <button
                  type="button"
                  className="task-digest__run-button"
                  onClick={() => onStart(project.project_id, maxTasks)}
                  disabled={running || !project.next_task}
                >
                  {isRetry ? 'Retry' : 'Start autonomous run'}
                </button>
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}
