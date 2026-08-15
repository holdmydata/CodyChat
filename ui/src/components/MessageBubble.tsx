import { useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import type { ActivityStep, Message } from '../types';
import { STATUS_ICON } from './ActivityTracker';

// react-markdown renders straight to React elements rather than an HTML
// string, so there's no dangerouslySetInnerHTML/sanitization step needed
// for content coming from the model.
function CodeBlock({ className, children, ...props }: ComponentProps<'code'>) {
  // Fenced code gets a language-xxx className from remark; inline code
  // doesn't. That's the distinguishing signal now that react-markdown no
  // longer passes an explicit `inline` prop to custom code renderers.
  const isBlock = Boolean(className);
  if (!isBlock) {
    return (
      <code className="message__inline-code" {...props}>
        {children}
      </code>
    );
  }
  return (
    <pre className="message__code">
      <code {...props}>{children}</code>
    </pre>
  );
}

function renderContent(content: string) {
  return (
    <ReactMarkdown remarkPlugins={[remarkBreaks]} components={{ code: CodeBlock }}>
      {content}
    </ReactMarkdown>
  );
}

function ThinkingBreakout({ thinking, stillThinking }: { thinking: string; stillThinking: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="message__thinking-block">
      <button
        type="button"
        className="message__thinking-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`message__thinking-chevron ${expanded ? 'message__thinking-chevron--open' : ''}`}>
          ▸
        </span>
        {stillThinking ? 'Thinking…' : 'Thought process'}
      </button>
      {expanded && <div className="message__thinking">{thinking}</div>}
    </div>
  );
}

// Persists the ActivityTracker's live checklist onto the message that
// concludes a turn, so the step-by-step log doesn't vanish once streaming
// ends — the live tracker only exists while isStreaming is true.
//
// The inline view renders the same steps as a compact flow graph instead
// of a plain vertical list: each step is a small status node, connectors
// chain node to node, and the chain snakes across a 3-column grid so long
// logs stay inside the ~75%-wide bubble. Each step's label (tool / args /
// result) sits under its node. All of that is styled by
// .activity-tracker--log in App.css; the markup deliberately mirrors the
// live ActivityTracker's step shape, reusing the same classes.
function ActivityLogBreakout({ steps }: { steps: ActivityStep[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="message__thinking-block">
      <button
        type="button"
        className="message__thinking-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`message__thinking-chevron ${expanded ? 'message__thinking-chevron--open' : ''}`}>
          ▸
        </span>
        Activity log ({steps.length} step{steps.length === 1 ? '' : 's'})
      </button>
      {expanded && (
        <div className="activity-tracker activity-tracker--log" role="list" aria-label="Tool activity log">
          {steps.map((step) => (
            <div
              key={step.id}
              role="listitem"
              className={`activity-tracker__step activity-tracker__step--${step.status}`}
            >
              <span className="activity-tracker__icon">{STATUS_ICON[step.status]}</span>
              <code className="activity-tracker__tool">{step.toolName}</code>
              <span className="activity-tracker__args">({step.argsSummary})</span>
              {step.resultSummary && <span className="activity-tracker__result">→ {step.resultSummary}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MessageBubble({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  if (message.role === 'tool') {
    return (
      <div className="message message--tool">
        <div className="message__role">tool result</div>
        <pre className="message__tool-result">{message.content}</pre>
      </div>
    );
  }

  const hasToolCalls = Boolean(message.toolCalls?.length);
  const stillThinking = Boolean(isStreaming) && Boolean(message.thinking) && !message.content && !hasToolCalls;
  // Stream ended, model only ever emitted thinking (not a tool call either)
  // — most likely it ran out of context mid-thought and got truncated
  // before producing an answer.
  const endedWithNoContent = !isStreaming && Boolean(message.thinking) && !message.content && !hasToolCalls;

  return (
    <div className={`message message--${message.role}`}>
      <div className="message__role">{message.role}</div>
      {message.thinking && (
        <ThinkingBreakout thinking={message.thinking} stillThinking={stillThinking} />
      )}
      {message.activitySteps?.length ? <ActivityLogBreakout steps={message.activitySteps} /> : null}
      {hasToolCalls &&
        message.toolCalls!.map((call) => (
          <div key={call.id} className="message__tool-call">
            🔧 Called <code>{call.name}</code>
            <code className="message__tool-call-args">{JSON.stringify(call.arguments)}</code>
          </div>
        ))}
      {message.content ? (
        <div className="message__content">{renderContent(message.content)}</div>
      ) : stillThinking || hasToolCalls ? null : endedWithNoContent ? (
        <div className="message__content">
          <span className="message__empty">
            No response — the model likely ran out of context space while thinking. Try raising the
            context length in Settings, or ask a more focused question.
          </span>
        </div>
      ) : (
        <div className="message__content">
          <span className="message__typing">…</span>
        </div>
      )}
    </div>
  );
}
