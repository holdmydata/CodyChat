import { useEffect, useState } from 'react';
import { messageTokens } from '../lib/contextBudget';
import type { Message } from '../types';

interface ContextMeterProps {
  /** Resets the busy state on a conversation switch — this component doesn't remount between conversations (ChatWindow doesn't key on conversation.id), so without this a clear started just before switching could leave the button stuck showing "Clearing…" for the next conversation. */
  conversationId: string;
  messages: Message[];
  numCtx: number;
  onClear: () => Promise<void>;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Estimate only — Ollama exposes no real tokenizer to this app, same
// char/4 heuristic contextBudget.ts already trims against (see its own
// comment for why that's good enough here). Warn/danger thresholds are
// fractions of the conversation's own numCtx, not the trimmer's
// response-headroom-reduced budget — close enough to be a useful early
// warning without requiring the user to understand two different numbers.
const WARN_FRACTION = 0.7;
const DANGER_FRACTION = 0.9;

export function ContextMeter({ conversationId, messages, numCtx, onClear }: ContextMeterProps) {
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    setClearing(false);
  }, [conversationId]);

  const used = messages.reduce((sum, m) => sum + messageTokens(m), 0);
  const fraction = numCtx > 0 ? Math.min(1, used / numCtx) : 0;
  const level = fraction >= DANGER_FRACTION ? 'danger' : fraction >= WARN_FRACTION ? 'warn' : 'ok';

  const handleClear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await onClear();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      className="context-meter"
      title={`~${used.toLocaleString()} of ${numCtx.toLocaleString()} tokens estimated (rough character-based estimate, not an exact tokenizer count)`}
    >
      <div className="context-meter__bar">
        <div
          className={`context-meter__fill context-meter__fill--${level}`}
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <span className="context-meter__label">
        {formatTokens(used)} / {formatTokens(numCtx)}
      </span>
      {messages.length > 0 && (
        <button
          type="button"
          className="context-meter__clear"
          onClick={handleClear}
          disabled={clearing}
          aria-label="Compact this conversation's message history into a short recap"
          title="Replaces older history with a short recap. Nothing is lost — the original messages stay searchable in memory."
        >
          {clearing ? 'Clearing…' : 'Clear'}
        </button>
      )}
    </div>
  );
}
