import { useRef, useState, useEffect } from 'react';
import type { Conversation, ToolCall } from '../types';
import type { ActivityStep } from '../hooks/useChat';
import type { LoopState } from '../hooks/useAutonomousLoop';
import type { PresentationMode } from '../lib/presentation';
import { ModelPicker } from './ModelPicker';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { ToolApprovalPrompt } from './ToolApprovalPrompt';
import { TurnFlowGraph } from './ActivityTracker';
import { ChatHistory3D } from './ChatHistory3D';

interface ChatWindowProps {
  conversation: Conversation;
  baseUrl: string;
  onModelChange: (model: string) => void;
  isStreaming: boolean;
  error: string | null;
  onSend: (content: string, images?: string[]) => void;
  onStop: () => void;
  pendingToolCall: ToolCall | null;
  onApproveToolCall: () => void;
  onDenyToolCall: () => void;
  activitySteps: ActivityStep[];
  /** True when a turn is paused at the tool-call iteration cap and can be resumed. */
  canContinue: boolean;
  onContinue: () => void;
  /** True in the compact tray-widget window — the model picker doesn't fit there and isn't the point of that surface. */
  compact?: boolean;
  /** Bumped by Settings → General's "Save as custom model" so the picker refreshes without needing to be the one that triggered the save. */
  modelListRefreshKey?: number;
  /** Autonomous loop status (see useAutonomousLoop.ts) — shown as a band above the input, same treatment as chat-window__continue, since a run happening here is just a normal turn started from loopx state instead of typed input. */
  loopState?: LoopState;
  loopStopReason?: string | null;
  loopTodosCompleted?: number;
  onStopLoop?: () => void;
  /** Swaps the message-history region only — header, approval prompts, and the input box stay unconditionally 2D regardless of mode. */
  presentationMode: PresentationMode;
}

export function ChatWindow({
  conversation,
  baseUrl,
  onModelChange,
  isStreaming,
  error,
  onSend,
  onStop,
  pendingToolCall,
  onApproveToolCall,
  onDenyToolCall,
  activitySteps,
  canContinue,
  onContinue,
  compact,
  modelListRefreshKey,
  loopState = 'idle',
  loopStopReason,
  loopTodosCompleted = 0,
  onStopLoop,
  presentationMode,
}: ChatWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Only auto-follow new content if the user is already near the bottom —
  // otherwise streaming tokens/thinking updates yank them back down every
  // time they try to scroll up and read earlier messages mid-response. The
  // ref is the source of truth read synchronously by the scroll handler and
  // the auto-scroll effect; autoScroll (state) mirrors it purely so the
  // "jump to latest" button can react to it.
  const shouldAutoScrollRef = useRef(true);
  const [autoScroll, setAutoScroll] = useState(true);

  const setAutoScrollValue = (value: boolean) => {
    shouldAutoScrollRef.current = value;
    setAutoScroll(value);
  };

  const handleMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScrollValue(distanceFromBottom < 60);
  };

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [conversation.messages]);

  // Pasted images decode/lay out asynchronously — by the time one finishes
  // loading and grows the message list's real height, the scroll-to-bottom
  // effect above already ran against the pre-image height, silently
  // leaving the view short of the true bottom. Re-runs the same pinned
  // scroll once any still-loading image in the list settles.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rescroll = () => {
      if (shouldAutoScrollRef.current) el.scrollTo({ top: el.scrollHeight });
    };
    const images = Array.from(el.querySelectorAll('img')).filter((img) => !img.complete);
    images.forEach((img) => img.addEventListener('load', rescroll, { once: true }));
    return () => images.forEach((img) => img.removeEventListener('load', rescroll));
  }, [conversation.messages]);

  // Real, reported bug: "Jump to Latest" would pop up right when
  // approving/denying a tool call. Root cause is layout, not scroll logic —
  // ToolApprovalPrompt (and the autonomous-loop/Continue bands) are flex
  // siblings of this scroll container, not children of it, so when one
  // mounts or unmounts it resizes the *container's own* clientHeight
  // (squeezed while a prompt is showing, released once it's gone). That
  // changes distanceFromBottom's arithmetic without ever moving scrollTop,
  // so it isn't caught by the effects above (keyed on message content) or
  // by handleMessagesScroll (only runs on an actual scroll event, which a
  // pure sibling resize doesn't necessarily fire). A ResizeObserver on the
  // container itself catches this directly, and generalizes to every other
  // sibling band that comes and goes the same way, not just this one.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) el.scrollTo({ top: el.scrollHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setAutoScrollValue(true);
  }, [conversation.id]);

  const handleSend = (content: string, images?: string[]) => {
    setAutoScrollValue(true);
    onSend(content, images);
  };

  const jumpToBottom = () => {
    setAutoScrollValue(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="chat-window">
      {!compact && (
        <header className="chat-window__header">
          <ModelPicker
            baseUrl={baseUrl}
            value={conversation.model}
            onChange={onModelChange}
            refreshKey={modelListRefreshKey}
          />
        </header>
      )}

      {presentationMode === 'spatial' ? (
        <ChatHistory3D conversation={conversation} isStreaming={isStreaming} error={error} />
      ) : (
        <div className="chat-window__messages-wrap">
          <div className="chat-window__messages" ref={scrollRef} onScroll={handleMessagesScroll}>
            {conversation.messages.length === 0 && (
              <div className="chat-window__empty">Say something to get started.</div>
            )}
            {conversation.messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                isStreaming={isStreaming && i === conversation.messages.length - 1}
              />
            ))}
            {error && <div className="chat-window__error">{error}</div>}
          </div>
          {!autoScroll && (
            <button
              type="button"
              className="chat-window__jump-to-bottom"
              onClick={jumpToBottom}
            >
              ↓ Jump to latest
            </button>
          )}
        </div>
      )}

      {isStreaming && <TurnFlowGraph steps={activitySteps} variant="live" />}

      {pendingToolCall && (
        <ToolApprovalPrompt call={pendingToolCall} onApprove={onApproveToolCall} onDeny={onDenyToolCall} />
      )}

      {loopState !== 'idle' && (
        <div className={`chat-window__continue chat-window__loop-status chat-window__loop-status--${loopState}`}>
          <span>
            {loopState === 'fetching' && 'Autonomous run: checking loopx for the next todo…'}
            {loopState === 'running' && `Autonomous run: working (${loopTodosCompleted} completed so far)…`}
            {loopState === 'reporting' && 'Autonomous run: reporting evidence back to loopx…'}
            {loopState === 'stopped' && `Autonomous run stopped: ${loopStopReason ?? 'unknown reason'}`}
          </span>
          {loopState !== 'stopped' && onStopLoop && (
            <button type="button" onClick={onStopLoop}>
              Stop
            </button>
          )}
        </div>
      )}

      {!isStreaming && !pendingToolCall && canContinue && (
        <div className="chat-window__continue">
          <span>Paused after too many tool calls in a row.</span>
          <button type="button" onClick={onContinue}>
            Continue
          </button>
        </div>
      )}

      <MessageInput
        disabled={!conversation.model}
        isStreaming={isStreaming}
        onSend={handleSend}
        onStop={onStop}
      />
    </div>
  );
}
