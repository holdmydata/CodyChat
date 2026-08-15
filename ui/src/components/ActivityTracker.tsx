import type { ActivityStep } from '../hooks/useChat';

interface ActivityTrackerProps {
  steps: ActivityStep[];
}

export const STATUS_ICON: Record<ActivityStep['status'], string> = {
  pending_approval: '⏸',
  running: '⏳',
  done: '✅',
  denied: '🚫',
  error: '⚠️',
};

export function ActivityTracker({ steps }: ActivityTrackerProps) {
  if (steps.length === 0) return null;

  return (
    <div className="activity-tracker">
      {steps.map((step) => (
        <div key={step.id} className={`activity-tracker__step activity-tracker__step--${step.status}`}>
          <span className="activity-tracker__icon">{STATUS_ICON[step.status]}</span>
          <code className="activity-tracker__tool">{step.toolName}</code>
          <span className="activity-tracker__args">({step.argsSummary})</span>
          {step.resultSummary && <span className="activity-tracker__result">→ {step.resultSummary}</span>}
        </div>
      ))}
    </div>
  );
}
