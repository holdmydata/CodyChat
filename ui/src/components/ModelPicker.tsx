import { useEffect, useState } from 'react';
import { listModels as listOllamaModels, type OllamaModel } from '../lib/ollama';
import { listModels as listOpenAIModels } from '../lib/openaiCompat';
import type { ChatBackend } from '../hooks/useChat';

interface ModelPickerProps {
  baseUrl: string;
  backend?: ChatBackend;
  value: string;
  onChange: (model: string) => void;
  refreshKey?: number;
}

export function ModelPicker({ baseUrl, backend = 'ollama', value, onChange, refreshKey }: ModelPickerProps) {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const listModels = backend === 'openai' ? listOpenAIModels : listOllamaModels;
    listModels(baseUrl)
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setError(null);
        // Deliberately does NOT auto-reassign the conversation's model when
        // it isn't in this fetch — that used to silently swap to
        // list[0].name, permanently overwriting a saved custom model
        // (whose system prompt is baked in server-side via /api/create) the
        // moment a listing lagged or genuinely came up short. A missing
        // model is now surfaced as its own option instead (see render
        // below) so the user can see what happened and choose explicitly,
        // rather than losing their selection without ever being told.
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, backend, refreshKey]);

  if (error) {
    return <span className="model-picker model-picker--error" title={error}>no models</span>;
  }

  const currentMissing = models.length > 0 && value && !models.some((m) => m.name === value);
  // A native <select> whose `value` prop doesn't match any <option> falls
  // back to silently displaying whichever option is first in DOM order —
  // it *looks* selected but isn't. That bit twice for real: a freshly
  // created conversation defaults to model: '' (App.tsx's DEFAULT_MODEL,
  // deliberately empty rather than guessing — see the no-auto-reassign
  // comment below), so the picker showed a real-looking model name while
  // the conversation's actual model stayed empty and the message input
  // stayed silently disabled; same illusion showed a phantom "selection"
  // in Settings when there was no active conversation at all. An explicit
  // placeholder option makes the select's displayed value match reality.
  const needsPlaceholder = models.length > 0 && !value;

  return (
    <select
      className={`model-picker${currentMissing ? ' model-picker--missing' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={currentMissing ? `"${value}" wasn't found on this server — pick a different model.` : undefined}
    >
      {models.length === 0 && <option value="">loading…</option>}
      {needsPlaceholder && <option value="">Select a model…</option>}
      {currentMissing && <option value={value}>⚠ {value} (not found)</option>}
      {models.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
