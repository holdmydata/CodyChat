import { useState } from 'react';
import type { ToolCall } from '../types';
import { summarizeValue } from '../lib/format';
import { RISK_LABEL, riskOf } from '../lib/toolConfig';

interface ToolApprovalPromptProps {
  call: ToolCall;
  onApprove: () => void;
  onDeny: () => void;
}

export function ToolApprovalPrompt({ call, onApprove, onDeny }: ToolApprovalPromptProps) {
  const [expanded, setExpanded] = useState(false);
  const args = Object.entries(call.arguments);
  const risk = riskOf(call.name);

  return (
    <div className={`tool-approval tool-approval--${risk}`}>
      <div className="tool-approval__header">
        <div className="tool-approval__title">
          <span className={`tool-approval__risk-badge tool-approval__risk-badge--${risk}`}>
            {RISK_LABEL[risk]}
          </span>
          <span className="tool-approval__call">
            Model wants to run <code>{call.name}</code>
          </span>
        </div>
        <div className="tool-approval__actions">
          <button type="button" className="tool-approval__deny" onClick={onDeny}>
            Deny
          </button>
          <button type="button" className="tool-approval__approve" onClick={onApprove}>
            Approve
          </button>
        </div>
      </div>
      {args.length > 0 && (
        <div className="tool-approval__body">
          {expanded ? (
            <pre className="tool-approval__args">{JSON.stringify(call.arguments, null, 2)}</pre>
          ) : (
            <ul className="tool-approval__args-summary">
              {args.map(([key, value]) => (
                <li key={key}>
                  <code>{key}</code>: {summarizeValue(value, 120)}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="tool-approval__expand" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show summary' : 'Show full arguments'}
          </button>
        </div>
      )}
    </div>
  );
}
