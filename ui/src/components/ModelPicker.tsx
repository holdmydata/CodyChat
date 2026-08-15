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
        if (list.length > 0 && !list.some((m) => m.name === value)) {
          onChange(list[0].name);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, refreshKey]);

  if (error) {
    return <span className="model-picker model-picker--error" title={error}>no models</span>;
  }

  return (
    <select
      className="model-picker"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {models.length === 0 && <option value="">loading…</option>}
      {models.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
