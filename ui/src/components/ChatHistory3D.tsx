import { useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import type { Conversation } from '../types';
import { MessageBubble } from './MessageBubble';
import { readCssColor, useThemeVersion } from '../lib/threeTheme';

interface ChatHistory3DProps {
  conversation: Conversation;
  isStreaming: boolean;
  error: string | null;
}

// v3 — every earlier version (a camera flying through a 3D timeline; then
// a vertical feed with a camera that scrolled/panned to follow it) kept
// hitting the same root problem from a different angle: a moving camera is
// not the same thing as a scrollable list, no matter how it's tuned. Real
// live feedback across several rounds (tilt on scroll, then pan instead of
// scroll, cards clipped/cut off) all traced back to that one mismatch.
// This version drops camera navigation entirely:
//   - Scrolling is real, native DOM scroll — same scrollRef/autoScroll
//     pattern ChatWindow already uses for the flat view, not reinvented.
//   - Messages render via the actual MessageBubble component, full content,
//     no truncation or click-to-expand indirection needed at all.
//   - Three.js is used for exactly one thing: a fixed, non-interactive
//     ambient particle backdrop. It never drives navigation or sizing, so
//     it can't reintroduce this bug class.
const IDLE_DURATION = 5; // seconds — CSS idle-glow loop length, see App.css

// Deterministic per-message phase so idle glow pulses aren't synchronized
// across cards — reused for its negative animation-delay trick (starts each
// card's loop partway through, no JS animation frame loop needed for this).
function phaseFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return h / 1000;
}

// Fixed camera, no controls, pointer-events disabled at the CSS level
// (see .chat-history-3d__backdrop) — purely decorative, cannot be
// scrolled, dragged, or zoomed, so it has no way to reintroduce the
// camera-navigation problems the rest of this component deliberately
// avoids.
function Backdrop({ color }: { color: string }) {
  return (
    <Canvas camera={{ position: [0, 0, 5] }}>
      <ambientLight intensity={0.5} />
      <Sparkles count={140} scale={[9, 16, 6]} size={2.2} speed={0.12} noise={1} opacity={0.5} color={color} />
    </Canvas>
  );
}

export function ChatHistory3D({ conversation, isStreaming, error }: ChatHistory3DProps) {
  const themeVersion = useThemeVersion();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Same pattern as ChatWindow.tsx: only auto-follow new content if the
  // user is already near the bottom, and the ref is the source of truth
  // read synchronously by the scroll handler / auto-scroll effect.
  const shouldAutoScrollRef = useRef(true);
  const [autoScroll, setAutoScroll] = useState(true);

  const setAutoScrollValue = (value: boolean) => {
    shouldAutoScrollRef.current = value;
    setAutoScroll(value);
  };

  const handleScroll = () => {
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

  // Same fix as ChatWindow.tsx's flat view: pasted images decode/lay out
  // asynchronously, so a still-loading image can grow the list's real
  // height after the scroll-to-bottom effect above already ran against the
  // pre-image height — re-run it once any such image settles.
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

  // Same fix as ChatWindow.tsx's flat view: ToolApprovalPrompt and the
  // autonomous-loop/Continue bands are flex siblings of .chat-history-3d
  // itself (rendered by the parent ChatWindow, outside this component), so
  // mounting/unmounting one resizes this scroll container's own
  // clientHeight without ever moving scrollTop or firing a scroll event —
  // exactly what made "Jump to Latest" pop up right when approving/denying
  // a tool call. A ResizeObserver on the container catches that directly.
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

  const jumpToBottom = () => {
    setAutoScrollValue(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  // Only the ambient backdrop still needs theme-reactive color reading
  // (readCssColor/useThemeVersion, from lib/threeTheme.ts) — the message
  // cards themselves are plain CSS now (--card-glow custom properties set
  // per role class in App.css), which already re-themes for free through
  // the normal CSS cascade with no JS observer needed.
  void themeVersion; // dependency only — see useThemeVersion's doc comment
  const accentColor = `#${readCssColor('--accent', '#4a90d9').getHexString()}`;

  return (
    <div className="chat-history-3d">
      <div className="chat-history-3d__backdrop" aria-hidden="true">
        <Backdrop color={accentColor} />
      </div>
      <div className="chat-history-3d__messages" ref={scrollRef} onScroll={handleScroll}>
        {conversation.messages.length === 0 && (
          <div className="chat-window__empty">Say something to get started.</div>
        )}
        {conversation.messages.map((m, i) => (
          <div
            key={m.id}
            className={`chat-history-3d__card chat-history-3d__card--${m.role}`}
            style={{ animationDelay: `0s, -${phaseFor(m.id) * IDLE_DURATION}s` }}
          >
            <MessageBubble message={m} isStreaming={isStreaming && i === conversation.messages.length - 1} />
          </div>
        ))}
        {error && <div className="chat-window__error">{error}</div>}
      </div>
      {!autoScroll && (
        <button type="button" className="chat-history-3d__jump-to-bottom" onClick={jumpToBottom}>
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
