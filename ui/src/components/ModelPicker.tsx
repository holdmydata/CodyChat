import { useEffect, useState } from 'react';
import { listModels, type OllamaModel } from '../lib/ollama';

interface ModelPickerProps {
  baseUrl: string;
  value: string;
  onChange: (model: string) => void;
  refreshKey?: number;
}

export function ModelPicker({ baseUrl, value, onChange, refreshKey }: ModelPickerProps) {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
  }, [baseUrl, refreshKey]);

  if (error) {
    return <span className="model-picker model-picker--error" title={error}>no models</span>;
  }

  const currentMissing = models.length > 0 && value && !models.some((m) => m.name === value);

  return (
    <select
      className={`model-picker${currentMissing ? ' model-picker--missing' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={currentMissing ? `"${value}" wasn't found on this Ollama instance — pick a different model.` : undefined}
    >
      {models.length === 0 && <option value="">loading…</option>}
      {currentMissing && <option value={value}>⚠ {value} (not found)</option>}
      {models.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
