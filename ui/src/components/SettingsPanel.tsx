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
  // The model's own baked-in system prompt, editable here — separate from
  // `systemPrompt` (the per-conversation additive field below), which is
  // never baked into a model. Reset whenever the selected model changes.
  const [builtInDraft, setBuiltInDraft] = useState('');
  // Defaults to the current model name on every model switch, so clicking
  // Save with no edits updates that model in place (see createModel's
  // name===from doc comment) — the direct fix for "I wish I could click
  // change and save to already existing models". Typing a different name
  // saves a new model instead, same as the old "Save as custom model" flow.
  const [saveName, setSaveName] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    setModelInfo(null);
    setModelInfoError(null);

    showModel(baseUrl, model)
      .then((info) => {
        if (cancelled) return;
        setModelInfo(info);
        setBuiltInDraft(info.system);
        setSaveName(model);
        setSaveStatus('idle');
        // Restore this model's own saved sampling params if it has any
        // (from a previous Update here) — otherwise every model switch
        // reset context length back to the app default regardless of what
        // was last saved for that specific model, which is what prompted
        // this whole feature. Falls back to the old clamp-down behavior
        // (don't exceed what the model actually supports) when nothing's
        // been saved yet.
        const { numCtx, temperature, topP } = info.bakedParams;
        if (numCtx !== undefined || temperature !== undefined || topP !== undefined) {
          onParamsChange({
            ...params,
            numCtx: numCtx ?? params.numCtx,
            temperature: temperature ?? params.temperature,
            topP: topP ?? params.topP,
          });
        } else if (info.contextLength && params.numCtx > info.contextLength) {
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
  // Real Ollama model names routinely contain characters sanitizeModelName
  // strips (':' for the :tag suffix, '/' for a namespaced hf.co/... name,
  // uppercase letters) — it exists to keep a brand-new, user-typed name
  // well-formed, not to round-trip an existing one. Comparing against a
  // sanitized copy of an untouched (still-equal-to-model) saveName meant
  // this was always false for any model with a tag, e.g. "assistant:latest"
  // sanitizes to "assistant-latest", which never equals "assistant:latest"
  // — so "Update <model>" never showed. Compare the raw, untouched value
  // instead, and only sanitize when actually saving a new/different name.
  const trimmedSaveName = saveName.trim();
  const isUpdate = trimmedSaveName === model && model !== '';

  const handleSave = async () => {
    const name = isUpdate ? model : sanitizeModelName(saveName);
    if (!name || !model) return;
    setSaveStatus('saving');
    setSaveError(null);
    try {
      await createModel(baseUrl, name, model, builtInDraft, {
        numCtx: params.numCtx,
        temperature: params.temperature,
        topP: params.topP,
      });
      setSaveStatus('saved');
      onModelCreated?.();
      if (isUpdate) {
        showModel(baseUrl, model)
          .then(setModelInfo)
          .catch(() => {});
      }
    } catch (err) {
      setSaveStatus('error');
      setSaveError(String(err));
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

      {modelInfo && (
        <label className="settings-panel__field">
          <span>Model's built-in system prompt</span>
          <textarea
            className="settings-panel__model-system-text"
            value={builtInDraft}
            onChange={(e) => setBuiltInDraft(e.target.value)}
            placeholder="(none baked in — type one and Save below to add it)"
            rows={5}
          />
          <span className="settings-panel__hint">
            Always sent, in addition to the per-conversation prompt below. Edit here and Save below to change it —
            editing alone doesn't save.
          </span>
        </label>
      )}

      <label className="settings-panel__field">
        <span>Additional system prompt (this conversation only)</span>
        <textarea
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          placeholder="You are a helpful assistant…"
          rows={4}
        />
      </label>

      <div className="settings-panel__field">
        <span>Save model settings</span>
        <div className="settings-panel__save-model-row">
          <input
            type="text"
            value={saveName}
            onChange={(e) => {
              setSaveName(e.target.value);
              setSaveStatus('idle');
            }}
            placeholder="model name"
            disabled={!model}
          />
          <button type="button" onClick={handleSave} disabled={!saveName.trim() || !model || saveStatus === 'saving'}>
            {saveStatus === 'saving' ? 'Saving…' : isUpdate ? `Update ${model}` : 'Save as new'}
          </button>
        </div>
        <span className="settings-panel__hint">
          {isUpdate
            ? `Bakes the prompt above and the sliders below into ${model} itself — including for other apps using it.`
            : `Creates a new model based on ${model || '…'}, with the prompt above and sliders below baked in.`}
        </span>
        {saveStatus === 'saved' && (
          <span className="settings-panel__hint settings-panel__hint--success">
            {isUpdate ? 'Updated.' : "Saved. It's now selectable in the model picker."}
          </span>
        )}
        {saveStatus === 'error' && (
          <span className="settings-panel__hint settings-panel__hint--error">Failed: {saveError}</span>
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
