import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useChat } from '../hooks/useChat';
import { useDuckConversation } from '../hooks/useDuckConversation';
import { ChatWindow } from './ChatWindow';

interface DuckPanelProps {
  open: boolean;
  onClose: () => void;
  baseUrl: string;
  /**
   * The main app's current active model. No separate duck-specific model
   * picker (removed after live feedback — "it'll most likely always be
   * the current model being used") — the duck just tracks this live
   * instead, kept in sync below rather than only seeded once at creation.
   */
  defaultModel: string;
}

// Right-side docked panel, not a second window — see the "why not a
// separate Tauri window" reasoning logged in local-docs/MEMORY.md: this app
// has no multi-window plumbing yet (focus, positioning, always-on-top edge
// cases), and a docked panel is the same shape as the existing mainView
// swap / left Sidebar, just one more real-DOM surface instead of a new
// complexity class. Always mounted (not conditionally rendered on `open`)
// so open/close can both animate via a CSS class + transform instead of
// only the entrance; see .duck-panel/.duck-panel--open in App.css.
export function DuckPanel({ open, onClose, baseUrl, defaultModel }: DuckPanelProps) {
  const { conversation, setMessages, updateConversation } = useDuckConversation(defaultModel);

  // Keeps the duck on whatever model the main chat is currently using,
  // rather than a separate picker to maintain — only writes when they've
  // actually diverged, and never overwrites with an empty model (a
  // conversation with no main chat active yet), which would leave the
  // duck's input dead with no picker left to fix it.
  useEffect(() => {
    if (conversation && defaultModel && conversation.model !== defaultModel) {
      updateConversation(conversation.id, { model: defaultModel });
    }
  }, [conversation, defaultModel, updateConversation]);

  const {
    sendMessage,
    stop,
    isStreaming,
    error,
    pendingToolCall,
    approveToolCall,
    denyToolCall,
    activitySteps,
    continueTurn,
    canContinue,
  } = useChat({
    baseUrl,
    conversation,
    onMessagesChange: setMessages,
  });

  return (
    <div className={`duck-panel${open ? ' duck-panel--open' : ''}`} aria-hidden={!open}>
      <div className="duck-panel__header">
        <span className="duck-panel__title">🦆 {conversation?.title ?? 'Cody'}</span>
        <button type="button" className="duck-panel__close" onClick={onClose} aria-label="Close duck panel">
          <X size={16} />
        </button>
      </div>
      {conversation && (
        <ChatWindow
          conversation={conversation}
          baseUrl={baseUrl}
          onModelChange={(model) => updateConversation(conversation.id, { model })}
          isStreaming={isStreaming}
          error={error}
          onSend={(content, images) => sendMessage(content, images)}
          onStop={stop}
          pendingToolCall={pendingToolCall}
          onApproveToolCall={approveToolCall}
          onDenyToolCall={denyToolCall}
          activitySteps={activitySteps}
          canContinue={canContinue}
          onContinue={continueTurn}
          presentationMode="flat"
          compact
        />
      )}
    </div>
  );
}
