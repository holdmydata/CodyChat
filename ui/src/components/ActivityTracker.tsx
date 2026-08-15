import { useEffect, useState } from 'react';
import type { ActivityStep } from '../types';

export const STATUS_ICON: Record<ActivityStep['status'], string> = {
  pending_approval: '⏸',
  running: '⏳',
  done: '✅',
  denied: '🚫',
  error: '⚠️',
};

type FlowNode =
  | { id: string; kind: 'thinking'; label: string; detail: string }
  | { id: string; kind: 'tool'; label: string; status: ActivityStep['status']; detail: string };

function buildNodes(steps: ActivityStep[], thinking?: string): FlowNode[] {
  const nodes: FlowNode[] = steps.map((step) => {
    const parts = [step.argsSummary];
    if (step.resultSummary) parts.push(`→ ${step.resultSummary}`);
    else if (step.status === 'error') parts.push('No result available');
    return { id: step.id, kind: 'tool', label: step.toolName, status: step.status, detail: parts.join('\n') };
  });
  // The final message's own thinking happens *after* every tool call in the
  // turn (it's the reasoning that led to the eventual answer, once all tool
  // results were already in hand) — so it belongs at the end of the chain,
  // immediately before the answer content that renders below this graph.
  if (thinking) {
    nodes.push({ id: '__thinking', kind: 'thinking', label: 'Thinking', detail: thinking });
  }
  return nodes;
}

interface TurnFlowGraphProps {
  steps: ActivityStep[];
  /** The final message's own thinking text — omitted for the live in-progress tracker, which has no single "final" thinking yet. */
  thinking?: string;
  /**
   * 'live': the in-progress panel shown below the message list while
   * streaming — keeps its own bordered/backgrounded chrome and always
   * tracks the newest node so the most recent activity stays visible
   * without a click. 'log': the persisted recap inside a finished message
   * bubble — no chrome of its own (the bubble already provides it) and
   * nothing selected by default, matching the collapsed-by-default
   * "click to inspect" pattern the rest of the log breakout uses.
   */
  variant?: 'live' | 'log';
}

// A single turn can involve several thinking/tool-call round-trips before
// a final answer (prompt → thinking → tool call → thinking → tool call →
// output) — previously rendered as a flat vertical checklist of
// independently-collapsible rows. This renders the same underlying data
// (ActivityStep[] + the final message's thinking) as a compact horizontal
// chain instead: nodes connected by arrows, wrapping onto more rows as
// needed, with a single shared detail panel below showing whichever node
// is selected — same information, shaped like the run's actual flow
// rather than a list.
export function TurnFlowGraph({ steps, thinking, variant = 'log' }: TurnFlowGraphProps) {
  const nodes = buildNodes(steps, thinking);
  const isLive = variant === 'live';

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Live view follows the newest node automatically, same spirit as the
  // old live tracker showing every step auto-expanded — a manual
  // selection elsewhere in the chain isn't preserved once a new node
  // arrives, which matches "tailing" a run in progress rather than
  // pausing on an old step.
  useEffect(() => {
    if (isLive && nodes.length > 0) {
      setSelectedId(nodes[nodes.length - 1].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, nodes.length]);

  if (nodes.length === 0) return null;

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className={`turn-flow ${isLive ? 'turn-flow--live' : 'turn-flow--log'}`}>
      <div className="turn-flow__chain" role="list" aria-label={isLive ? 'Tool activity' : 'Tool activity log'}>
        {nodes.map((node, i) => (
          <div className="turn-flow__item" role="listitem" key={node.id}>
            {i > 0 && (
              <span className="turn-flow__connector" aria-hidden="true">
                →
              </span>
            )}
            <button
              type="button"
              className={[
                'turn-flow__node',
                `turn-flow__node--${node.kind}`,
                node.kind === 'tool' ? `turn-flow__node--${node.status}` : '',
                selectedId === node.id ? 'turn-flow__node--selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => setSelectedId((cur) => (cur === node.id ? null : node.id))}
              aria-pressed={selectedId === node.id}
              aria-label={`${node.label} — ${selectedId === node.id ? 'hide' : 'show'} details`}
            >
              <span className="turn-flow__node-icon">
                {node.kind === 'thinking' ? '🧠' : STATUS_ICON[node.status]}
              </span>
              <code className="turn-flow__node-label">{node.label}</code>
            </button>
          </div>
        ))}
      </div>
      {selected && <div className="turn-flow__detail">{selected.detail}</div>}
    </div>
  );
}
