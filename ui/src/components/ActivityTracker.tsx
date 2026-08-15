import { useState } from 'react';
import type { ActivityStep } from '../hooks/useChat';

interface ActivityTrackerProps {
  steps: ActivityStep[];
  collapsedByDefault?: boolean;
}

export const STATUS_ICON: Record<ActivityStep['status'], string> = {
  pending_approval: '⏸',
  running: '⏳',
  done: '✅',
  denied: '🚫',
  error: '⚠️',
};

// Exported so MessageBubble's persisted "Activity log" can reuse this
// exact component instead of maintaining its own duplicate copy — a
// second copy previously drifted out of sync (unstyled classes, a second
// STATUS_ICON, dropped argsSummary).
export function ActivityTrackerStep({ step, collapsed }: { step: ActivityStep; collapsed: boolean }) {
  const [expanded, setExpanded] = useState(!collapsed);

  return (
    <div className="activity-tracker__step-wrapper">
      <button
        type="button"
        className={`activity-tracker__step-title activity-tracker__step-title--${step.status} ${expanded ? 'activity-tracker__step-title--expanded' : ''}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${step.toolName} — ${expanded ? 'collapse' : 'expand'} activity details`}
      >
        <span className="activity-tracker__status-icon">{STATUS_ICON[step.status]}</span>
        <code className="activity-tracker__tool">{step.toolName}</code>
        {expanded && (
          <>
            <span className="activity-tracker__separator">▼</span>
            <span className="activity-tracker__args">({step.argsSummary})</span>
            {step.resultSummary && (
              <span className="activity-tracker__result">→ {step.resultSummary}</span>
            )}
            {!step.resultSummary && step.status === 'error' && (
              <span className="activity-tracker__error">No result available</span>
            )}
          </>
        )}
      </button>
    </div>
  );
}

export function ActivityTracker({ steps, collapsedByDefault = false }: ActivityTrackerProps) {
  if (steps.length === 0) return null;

  return (
    <div className="activity-tracker" role="list" aria-label="Tool activity">
      {steps.map((step) => (
        <ActivityTrackerStep key={step.id} step={step} collapsed={collapsedByDefault} />
      ))}
    </div>
  );
}
