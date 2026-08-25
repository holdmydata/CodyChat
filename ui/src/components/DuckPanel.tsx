import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useChat } from '../hooks/useChat';
import { useDuckConversation } from '../hooks/useDuckConversation';
import { ChatWindow } from './ChatWindow';
import type { Message } from '../types';

type DuckPose = 'idle' | 'thinking' | 'talking' | 'happy';

// Image files aren't shipped with the app — see
// docs/companion-duck-architecture.md's asset spec. Drop them in
// public/fonts/-style at public/duck/<name>.png and they're picked up with
// zero further code changes; until then this renders nothing (no broken-
// image icon), same "degrade quietly" posture as an unset theme font.
const POSE_SRC: Record<Exclude<DuckPose, 'talking'>, string> = {
  idle: '/duck/duck-idle.png',
  thinking: '/duck/duck-thinking.png',
  happy: '/duck/duck-happy.png',
};
const TALK_CLOSED_SRC = '/duck/duck-talk-closed.png';
const TALK_OPEN_SRC = '/duck/duck-talk-open.png';

// How long the one-shot "happy" pop plays after a reply finishes, before
// falling back to idle — long enough to notice, short enough that it
// still reads as a reaction to *this* reply, not a stuck state.
const HAPPY_DURATION_MS = 2200;

// 'talking' only once real reply content is actually streaming; 'thinking'
// covers everything else while a turn is in flight — pre-thinking silence,
// <thinking> text itself, *and* tool-calling rounds (which produce no
// spoken content at all). Previously excluded any round with toolCalls
// set from ever counting as "thinking," which meant a turn that ends up
// calling a tool jumped straight to a mouth-flapping "talking" pose with
// nothing actually being said — real bug, caught live.
function computePose(messages: Message[], isStreaming: boolean, justReplied: boolean): DuckPose {
  if (justReplied) return 'happy';
  if (!isStreaming) return 'idle';
  const last = messages[messages.length - 1];
  return last?.role === 'assistant' && last.content ? 'talking' : 'thinking';
}

// Small idle-pose icon next to the panel title, replacing the placeholder
// 🦆 emoji — same "fail silently, no broken-image icon" posture as
// DuckAvatar below, own tiny failed-state since it's a single fixed image
// rather than something that switches per pose.
function DuckHeaderIcon() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img className="duck-panel__title-icon" src={POSE_SRC.idle} alt="" onError={() => setFailed(true)} />;
}

// A single <img> per pose except 'talking', which stacks two frames and
// lets a CSS keyframe hard-cut between them (steps(1), not a cross-fade —
// reads as a mouth flap, not a dissolve). onError hides a pose's own <img>
// silently rather than showing a broken-image icon, so the avatar area
// just stays visually quiet for whichever poses haven't been dropped in
// yet instead of looking broken.
function DuckAvatar({ pose }: { pose: DuckPose }) {
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const markFailed = (src: string) => setFailed((prev) => new Set(prev).add(src));

  if (pose === 'talking') {
    return (
      <div className={`duck-avatar duck-avatar--${pose}`}>
        {!failed.has(TALK_CLOSED_SRC) && (
          <img src={TALK_CLOSED_SRC} alt="" onError={() => markFailed(TALK_CLOSED_SRC)} />
        )}
        {!failed.has(TALK_OPEN_SRC) && (
          <img
            className="duck-avatar__talk-open"
            src={TALK_OPEN_SRC}
            alt=""
            onError={() => markFailed(TALK_OPEN_SRC)}
          />
        )}
      </div>
    );
  }

  const src = POSE_SRC[pose];
  if (failed.has(src)) return <div className={`duck-avatar duck-avatar--${pose}`} />;
  return (
    <div className={`duck-avatar duck-avatar--${pose}`}>
      <img src={src} alt="" onError={() => markFailed(src)} />
    </div>
  );
}

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

  // One-shot "happy" pop when a reply actually finishes — tracks the
  // isStreaming true->false edge rather than just "isStreaming is false"
  // (which is also true before the very first message, and would fire
  // happy on mount) or a message-count change (which fires on the user's
  // own message too, before any reply exists yet).
  const wasStreamingRef = useRef(false);
  const [justReplied, setJustReplied] = useState(false);
  useEffect(() => {
    const last = conversation?.messages[conversation.messages.length - 1];
    const justFinished =
      wasStreamingRef.current && !isStreaming && last?.role === 'assistant' && Boolean(last.content);
    wasStreamingRef.current = isStreaming;
    if (justFinished) {
      setJustReplied(true);
      const timer = setTimeout(() => setJustReplied(false), HAPPY_DURATION_MS);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, conversation]);

  const pose = computePose(conversation?.messages ?? [], isStreaming, justReplied);

  return (
    <div className={`duck-panel${open ? ' duck-panel--open' : ''}`} aria-hidden={!open}>
      <div className="duck-panel__header">
        <span className="duck-panel__title">
          <DuckHeaderIcon /> {conversation?.title ?? 'Cody'}
        </span>
        <button type="button" className="duck-panel__close" onClick={onClose} aria-label="Close duck panel">
          <X size={16} />
        </button>
      </div>
      <DuckAvatar pose={pose} />
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
          onClearContext={async () => setMessages(conversation.id, [])}
        />
      )}
    </div>
  );
}
