import { useRef, useState, useEffect } from 'react';
import type { ChatParams, Conversation, ToolCall } from '../types';
import type { ActivityStep } from '../hooks/useChat';
import { ModelPicker } from './ModelPicker';
import { SettingsPanel } from './SettingsPanel';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { ToolApprovalPrompt } from './ToolApprovalPrompt';
import { TurnFlowGraph } from './ActivityTracker';

interface ChatWindowProps {
  conversation: Conversation;
  baseUrl: string;
  onModelChange: (model: string) => void;
  onSystemPromptChange: (prompt: string) => void;
  onParamsChange: (params: ChatParams) => void;
  isStreaming: boolean;
  error: string | null;
  onSend: (content: string) => void;
  onStop: () => void;
  pendingToolCall: ToolCall | null;
  onApproveToolCall: () => void;
  onDenyToolCall: () => void;
  activitySteps: ActivityStep[];
}

export function ChatWindow({
  conversation,
  baseUrl,
  onModelChange,
  onSystemPromptChange,
  onParamsChange,
  isStreaming,
  error,
  onSend,
  onStop,
  pendingToolCall,
  onApproveToolCall,
  onDenyToolCall,
  activitySteps,
}: ChatWindowProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelListRefreshKey, setModelListRefreshKey] = useState(0);
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
      <header className="chat-window__header">
        <ModelPicker
          baseUrl={baseUrl}
          value={conversation.model}
          onChange={onModelChange}
          refreshKey={modelListRefreshKey}
        />
        <button
          className="chat-window__settings-toggle"
          onClick={() => setSettingsOpen((v) => !v)}
        >
          {settingsOpen ? 'Hide settings' : 'Settings'}
        </button>
      </header>

      {settingsOpen && (
        <SettingsPanel
          baseUrl={baseUrl}
          model={conversation.model}
          systemPrompt={conversation.systemPrompt}
          onSystemPromptChange={onSystemPromptChange}
          params={conversation.params}
          onParamsChange={onParamsChange}
          onModelCreated={() => setModelListRefreshKey((k) => k + 1)}
        />
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

      <MessageInput
        disabled={!conversation.model}
        isStreaming={isStreaming}
        onSend={handleSend}
        onStop={onStop}
      />
    </div>
  );
}
