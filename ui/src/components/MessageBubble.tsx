import { useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import type { ActivityStep, Message, ToolCall } from '../types';
import { TurnFlowGraph } from './ActivityTracker';

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
        <div className="message__thinking-content">{thinking}</div>
      )}
    </div>
  );
}

// The turn's *final* message recaps the whole tool-call chain via
// TurnFlowGraph (collapsed by default — nothing selected until clicked),
// but every intermediate "assistant requested a tool call" message stays
// in the list permanently, separately from that recap. Previously this
// always rendered the full raw JSON args inline with no way to collapse
// it — exactly the "tool calls keep the details open" complaint. Collapsed
// by default here too, same chevron-toggle convention as
// ThinkingBreakout/ActivityLogBreakout, so a multi-step turn reads as a
// clean icon-and-name bar until you actually want to inspect one.
function ToolCallChip({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="message__tool-call">
      <button
        type="button"
        className="message__tool-call-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`message__thinking-chevron ${expanded ? 'message__thinking-chevron--open' : ''}`}>▸</span>
        🔧 Called <code>{call.name}</code>
      </button>
      {expanded && <code className="message__tool-call-args">{JSON.stringify(call.arguments)}</code>}
    </div>
  );
}

function ActivityLogBreakout({ steps, thinking }: { steps: ActivityStep[]; thinking?: string }) {
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
      {expanded && <TurnFlowGraph steps={steps} thinking={thinking} variant="log" />}
    </div>
  );
}

// Real, screenshot-reported gap: this always rendered the full result as a
// big always-open box, no toggle at all — the one place this session's
// "collapsed by default, click to expand" convention (ToolCallChip,
// ActivityLogBreakout, ThinkingBreakout) never actually got applied,
// because a tool *result* is a separate message/role from the tool *call*
// request ToolCallChip already covers. Collapsed to a one-line preview by
// default, same chevron-toggle language as everywhere else.
function ToolResultBubble({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = content.trim().split('\n')[0] ?? '';
  const preview = firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine;
  return (
    <div className="message message--tool">
      <button
        type="button"
        className="message__tool-result-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`message__thinking-chevron ${expanded ? 'message__thinking-chevron--open' : ''}`}>▸</span>
        <span className="message__role">tool result</span>
        {!expanded && preview && <span className="message__tool-result-preview">{preview}</span>}
      </button>
      {expanded && <pre className="message__tool-result">{content}</pre>}
    </div>
  );
}

export function MessageBubble({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  if (message.role === 'tool') {
    return <ToolResultBubble content={message.content} />;
  }

  const hasToolCalls = Boolean(message.toolCalls?.length);
  const hasActivitySteps = Boolean(message.activitySteps?.length);
  const stillThinking = Boolean(isStreaming) && Boolean(message.thinking) && !message.content && !hasToolCalls;
  // Stream ended, model only ever emitted thinking (not a tool call either)
  // — most likely it ran out of context mid-thought and got truncated
  // before producing an answer.
  const endedWithNoContent = !isStreaming && Boolean(message.thinking) && !message.content && !hasToolCalls;

  return (
    <div className={`message message--${message.role}`}>
      <div className="message__role">{message.role}</div>
      {/* A turn that made tool calls folds its final thinking into the
          flow graph below (as the last node, right before the answer) —
          a separate standalone toggle for the same text would just be the
          same content shown twice in two different widgets. Only turns
          with no activity steps at all get the plain standalone toggle. */}
      {message.thinking && !hasActivitySteps && (
        <ThinkingBreakout thinking={message.thinking} stillThinking={stillThinking} />
      )}
      {hasActivitySteps ? (
        <ActivityLogBreakout steps={message.activitySteps!} thinking={message.thinking} />
      ) : null}
      {hasToolCalls && message.toolCalls!.map((call) => <ToolCallChip key={call.id} call={call} />)}
      {message.images && message.images.length > 0 && (
        <div className="message__images">
          {message.images.map((base64, i) => (
            <img key={i} src={`data:image/png;base64,${base64}`} alt="Attached" className="message__image" />
          ))}
        </div>
      )}
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