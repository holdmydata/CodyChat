import { useRef, useState, useEffect } from 'react';
import type { Conversation, ToolCall } from '../types';
import type { ActivityStep } from '../hooks/useChat';
import { ModelPicker } from './ModelPicker';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { ToolApprovalPrompt } from './ToolApprovalPrompt';
import { TurnFlowGraph } from './ActivityTracker';

interface ChatWindowProps {
  conversation: Conversation;
  baseUrl: string;
  onModelChange: (model: string) => void;
  isStreaming: boolean;
  error: string | null;
  onSend: (content: string) => void;
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

  useEffect(() => {
    setAutoScrollValue(true);
  }, [conversation.id]);

  const handleSend = (content: string) => {
    setAutoScrollValue(true);
    onSend(content);
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

      {isStreaming && <TurnFlowGraph steps={activitySteps} variant="live" />}

      {pendingToolCall && (
        <ToolApprovalPrompt call={pendingToolCall} onApprove={onApproveToolCall} onDeny={onDenyToolCall} />
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
