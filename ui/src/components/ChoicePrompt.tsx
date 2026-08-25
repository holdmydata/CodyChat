import type { ToolCall } from '../types';

interface ChoicePromptProps {
  call: ToolCall;
  onSelect: (option: string) => void;
  onCancel: () => void;
}

// Rendered instead of ToolApprovalPrompt when the pending call is
// ask_user_choice (see useChat.ts's tool loop) — clicking an option both
// approves the call and supplies its result in one action, since for this
// tool the click *is* the answer, not a yes/no gate on running something
// else. Reuses ToolApprovalPrompt's outer .tool-approval treatment
// (border/glow/animation) for visual consistency, with its own option-grid
// styling underneath.
export function ChoicePrompt({ call, onSelect, onCancel }: ChoicePromptProps) {
  const question = typeof call.arguments.question === 'string' ? call.arguments.question : 'Choose an option:';
  const options = Array.isArray(call.arguments.options)
    ? call.arguments.options.filter((o): o is string => typeof o === 'string')
    : [];

  return (
    <div className="tool-approval tool-choice">
      <div className="tool-choice__question">{question}</div>
      {options.length > 0 ? (
        <div className="tool-choice__options">
          {options.map((option, i) => (
            <button key={`${option}-${i}`} type="button" className="tool-choice__option" onClick={() => onSelect(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : (
        <p className="tool-choice__question">(No options were provided.)</p>
      )}
      <button type="button" className="tool-choice__cancel" onClick={onCancel}>
        Dismiss
      </button>
    </div>
  );
}
