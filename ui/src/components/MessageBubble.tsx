import { useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import type { ActivityStep, Message } from '../types';

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
      {expanded && (
        <div className="message__thinking-content" style={{ maxWidth: '100%', wordBreak: 'break-word' }}>
          {thinking}
        </div>
      )}
    </div>
  );
}

// Helper to render status icons consistent with ActivityTracker
function StatusIcon({ status }: { status: string }) {
  const icons: Record<string, string> = {
    pending_approval: '⏸',
    running: '⏳',
    done: '✅',
    denied: '🚫',
    error: '⚠️',
  };
  return <span className="activity-tracker__icon">{icons[status] || '⏳'}</span>;
}

function ActivityTrackerStep({ step }: { step: ActivityStep }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="message__thinking-block">
      <button
        type="button"
        className={`message__thinking-toggle ${expanded ? 'message__thinking-toggle--expanded' : ''}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${step.toolName} — ${expanded ? 'collapse' : 'expand'} activity details`}
      >
        <StatusIcon status={step.status} />
        <code className="message__thinking-tool">{step.toolName}</code>
        {expanded && (
          <>
            <span className="message__thinking-chevron">▼</span>
            {step.resultSummary && (
              <span className="message__thinking-result">→ {step.resultSummary}</span>
            )}
            {!step.resultSummary && step.status === 'error' && (
              <span className="message__thinking-error">No result available</span>
            )}
          </>
        )}
      </button>
    </div>
  );
}

function ActivityLogBreakout({ steps }: { steps: ActivityStep[] }) {
  return (
    <div className="message__thinking-block-list" role="list" aria-label="Tool activity log">
      {steps.map((step) => (
        <ActivityTrackerStep key={step.id} step={step} />
      ))}
    </div>
  );
}

export function MessageBubble({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  if (message.role === 'tool') {
    return (
      <div className="message message--tool">
        <div className="message__role">tool result</div>
        <pre className="message__tool-result" style={{ maxWidth: '100%', wordBreak: 'break-word' }}>{message.content}</pre>
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
            <code className="message__tool-call-args" style={{ maxWidth: '100%', wordBreak: 'break-word' }}>{JSON.stringify(call.arguments)}</code>
          </div>
        ))}
      {message.content ? (
        <div className="message__content">{renderContent(message.content)}</div>
      ) : stillThinking || hasToolCalls ? null : endedWithNoContent ? (
        <div className="message__content">
          <span className="message__empty" style={{ maxWidth: '100%', wordBreak: 'break-word' }}>
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