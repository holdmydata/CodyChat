import { useEffect, useState } from 'react';
import { createModel, showModel, type ModelInfo } from '../lib/ollama';
import { ModelPicker } from './ModelPicker';
import type { ChatParams } from '../types';

interface SettingsPanelProps {
  baseUrl: string;
  model: string;
  onModelChange: (model: string) => void;
  /** Bumped after a custom-model save so the picker's fetched list refreshes without needing the header one to also be visible (it isn't, in compact/widget mode — see ChatWindow). */
  modelListRefreshKey?: number;
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  params: ChatParams;
  onParamsChange: (params: ChatParams) => void;
  onModelCreated?: () => void;
}

const FALLBACK_MAX_CTX = 32768;

function sanitizeModelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

export function SettingsPanel({
  baseUrl,
  model,
  onModelChange,
  modelListRefreshKey,
  systemPrompt,
  onSystemPromptChange,
  params,
  onParamsChange,
  onModelCreated,
}: SettingsPanelProps) {
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [modelInfoError, setModelInfoError] = useState<string | null>(null);
  const [newModelName, setNewModelName] = useState('');
  const [createStatus, setCreateStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    setModelInfo(null);
    setModelInfoError(null);

    showModel(baseUrl, model)
      .then((info) => {
        if (cancelled) return;
        setModelInfo(info);
        // Clamp the saved context length down if it exceeds what this
        // model actually supports (e.g. switching from a long-context
        // model to a short one) — an invalid slider value looks broken.
        if (info.contextLength && params.numCtx > info.contextLength) {
          onParamsChange({ ...params, numCtx: info.contextLength });
        }
      })
      .catch((err) => {
        if (!cancelled) setModelInfoError(String(err));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, model]);

  const maxCtx = modelInfo?.contextLength ?? FALLBACK_MAX_CTX;

  const handleSaveAsModel = async () => {
    const name = sanitizeModelName(newModelName);
    if (!name || !model) return;
    setCreateStatus('saving');
    setCreateError(null);
    try {
      await createModel(baseUrl, name, model, systemPrompt);
      setCreateStatus('saved');
      setNewModelName('');
      onModelCreated?.();
    } catch (err) {
      setCreateStatus('error');
      setCreateError(String(err));
    }
  };

  return (
    <div className="settings-panel">
      <label className="settings-panel__field">
        <span>Model</span>
        <ModelPicker baseUrl={baseUrl} value={model} onChange={onModelChange} refreshKey={modelListRefreshKey} />
      </label>

      {modelInfoError ? (
        <p className="settings-panel__model-info settings-panel__model-info--error">
          Couldn't load model info: {modelInfoError}
        </p>
      ) : modelInfo ? (
        <div className="settings-panel__model-info">
          <span>
            {modelInfo.parameterSize} · {modelInfo.quantization}
            {modelInfo.contextLength ? ` · max ${modelInfo.contextLength.toLocaleString()} ctx` : ''}
          </span>
          {modelInfo.capabilities.length > 0 && (
            <div className="settings-panel__capabilities">
              {modelInfo.capabilities.map((cap) => (
                <span key={cap} className="settings-panel__capability-badge">
                  {cap}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {modelInfo?.system && (
        <details className="settings-panel__model-system">
          <summary>This model's built-in system prompt ({modelInfo.system.length.toLocaleString()} chars)</summary>
          <p className="settings-panel__hint">
            Baked into <code>{model}</code> via "Save as custom model" — always sent, in addition to whatever you add
            below. To change it, save over this model name again with new text below.
          </p>
          <pre className="settings-panel__model-system-text">{modelInfo.system}</pre>
        </details>
      )}

      <label className="settings-panel__field">
        <span>{modelInfo?.system ? 'Additional system prompt (this conversation)' : 'System prompt'}</span>
        <textarea
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          placeholder="You are a helpful assistant…"
          rows={4}
        />
      </label>

      <div className="settings-panel__field">
        <span>Save as custom model</span>
        <div className="settings-panel__save-model-row">
          <input
            type="text"
            value={newModelName}
            onChange={(e) => {
              setNewModelName(e.target.value);
              setCreateStatus('idle');
            }}
            placeholder="my-custom-name"
            disabled={!model || !systemPrompt.trim()}
          />
          <button
            type="button"
            onClick={handleSaveAsModel}
            disabled={!newModelName.trim() || !model || !systemPrompt.trim() || createStatus === 'saving'}
          >
            {createStatus === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
        {!systemPrompt.trim() && (
          <span className="settings-panel__hint">Add a system prompt above first — that's what gets baked in.</span>
        )}
        {createStatus === 'saved' && (
          <span className="settings-panel__hint settings-panel__hint--success">
            Saved. It's now selectable in the model picker.
          </span>
        )}
        {createStatus === 'error' && (
          <span className="settings-panel__hint settings-panel__hint--error">Failed: {createError}</span>
        )}
      </div>

      <label className="settings-panel__field">
        <span>Temperature: {params.temperature.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={params.temperature}
          onChange={(e) => onParamsChange({ ...params, temperature: Number(e.target.value) })}
        />
      </label>

      <label className="settings-panel__field">
        <span>Top P: {params.topP.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={params.topP}
          onChange={(e) => onParamsChange({ ...params, topP: Number(e.target.value) })}
        />
      </label>

      <label className="settings-panel__field">
        <span>
          Context length: {params.numCtx.toLocaleString()}
          {modelInfo?.contextLength ? ` (model max: ${maxCtx.toLocaleString()})` : ''}
        </span>
        <input
          type="range"
          min={512}
          max={maxCtx}
          step={512}
          value={params.numCtx}
          onChange={(e) => onParamsChange({ ...params, numCtx: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}
