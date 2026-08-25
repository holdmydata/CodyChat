import { useEffect, useState } from 'react';
import { createModel, listModels as listOllamaModels, showModel as ollamaShowModel, type ModelInfo } from '../lib/ollama';
import { listModels as listOpenAIModels, showModel as openaiShowModel } from '../lib/openaiCompat';
import { forecastFit, getSystemResources, type SystemResources } from '../lib/resourceForecast';
import { ModelPicker } from './ModelPicker';
import type { ChatParams } from '../types';
import type { ChatBackend } from '../hooks/useChat';

interface SettingsPanelProps {
  baseUrl: string;
  backend?: ChatBackend;
  model: string;
  onModelChange: (model: string) => void;
  /** Bumped after a custom-model save so the picker's fetched list refreshes without needing the header one to also be visible (it isn't, in compact/widget mode — see ChatWindow). */
  modelListRefreshKey?: number;
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  params: ChatParams;
  onParamsChange: (params: ChatParams) => void;
  onModelCreated?: () => void;
  memoryDisabled: boolean;
  onMemoryDisabledChange: (disabled: boolean) => void;
}

const FALLBACK_MAX_CTX = 32768;

function sanitizeModelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

export function SettingsPanel({
  baseUrl,
  backend = 'ollama',
  model,
  onModelChange,
  modelListRefreshKey,
  systemPrompt,
  onSystemPromptChange,
  params,
  onParamsChange,
  onModelCreated,
  memoryDisabled,
  onMemoryDisabledChange,
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
  const [resources, setResources] = useState<SystemResources | null>(null);
  const [modelSizeBytes, setModelSizeBytes] = useState<number | null>(null);

  // RAM/VRAM is machine state, not per-conversation — fetched once, not
  // re-fetched on every model switch (unlike modelInfo/modelSizeBytes
  // below, which really do change per model).
  useEffect(() => {
    getSystemResources()
      .then(setResources)
      .catch(() => setResources(null));
  }, []);

  // /api/show (showModel, below) doesn't return the on-disk byte size —
  // only /api/tags (listModels) does, keyed by name, so this is a second
  // fetch rather than folding it into the existing showModel effect.
  useEffect(() => {
    // Azure OpenAI deployments aren't listable without separate
    // management-plane permissions this app doesn't ask for — see
    // azureFoundry.ts's module comment.
    if (!model || backend === 'azure') {
      setModelSizeBytes(null);
      return;
    }
    let cancelled = false;
    const listModels = backend === 'openai' ? listOpenAIModels : listOllamaModels;
    listModels(baseUrl)
      .then((list) => {
        if (cancelled) return;
        setModelSizeBytes(list.find((m) => m.name === model)?.size ?? null);
      })
      .catch(() => {
        if (!cancelled) setModelSizeBytes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, backend, model]);

  useEffect(() => {
    // No Azure equivalent of /api/show — a deployment doesn't expose its
    // baked system prompt/params/context length the way Ollama/llama-server
    // do, so there's nothing to fetch here for that backend.
    if (!model || backend === 'azure') return;
    let cancelled = false;
    setModelInfo(null);
    setModelInfoError(null);

    const showModel = backend === 'openai' ? openaiShowModel : ollamaShowModel;
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
  }, [baseUrl, backend, model]);

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
  const forecast =
    modelSizeBytes != null && resources && modelInfo
      ? forecastFit(modelSizeBytes, params.numCtx, modelInfo.arch, resources)
      : null;

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
        const showModel = backend === 'openai' ? openaiShowModel : ollamaShowModel;
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
        {backend === 'azure' ? (
          <input
            type="text"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="model-router"
          />
        ) : (
          <ModelPicker baseUrl={baseUrl} value={model} onChange={onModelChange} refreshKey={modelListRefreshKey} />
        )}
      </label>
      {backend === 'azure' && (
        <p className="settings-panel__hint">
          Should match the deployment name configured above in Azure AI Foundry — Azure deployments aren't listable
          here the way Ollama/OpenAI-compatible models are.
        </p>
      )}

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

      {modelInfo && backend === 'ollama' && (
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

      <div className="settings-menu__tool-row">
        <div className="settings-menu__tool-info">
          <div className="settings-menu__tool-name">
            <span>Save this conversation to memory</span>
          </div>
          <p className="settings-menu__tool-desc">
            When on, your messages and the model's replies here are indexed for cross-conversation recall (see
            search_memory in Settings → Tools). Turn off to keep this conversation out of memory entirely — this
            only affects new messages going forward, not ones already indexed.
          </p>
        </div>
        <label className="settings-menu__toggle">
          <input
            type="checkbox"
            checked={!memoryDisabled}
            onChange={(e) => onMemoryDisabledChange(!e.target.checked)}
            aria-label={`${memoryDisabled ? 'Enable' : 'Disable'} saving this conversation to memory`}
          />
          <span className="settings-menu__toggle-track" aria-hidden="true" />
        </label>
      </div>

      {backend !== 'ollama' ? (
        <p className="settings-panel__hint">
          Saving named model variants (baked-in system prompt/params) is an Ollama-only feature —{' '}
          {backend === 'openai'
            ? 'llama-server and other OpenAI-compatible backends serve exactly one model per running instance, chosen at launch, so there\'s nothing here to save into.'
            : 'Azure deployments are managed in the Azure Portal, not from here.'}
        </p>
      ) : (
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
      )}

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

      {forecast && (
        <p className={`settings-panel__resource-forecast settings-panel__resource-forecast--${forecast.verdict}`}>
          {forecast.summary}
        </p>
      )}
    </div>
  );
}
