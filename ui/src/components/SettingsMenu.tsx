import { useState } from 'react';
import { ThemePickerMenu } from './ThemePicker';
import { normalizeFontValue } from '../lib/themes';
import { McpServers } from './McpServers';
import { SettingsPanel } from './SettingsPanel';
import { RISK_LABEL, riskOf } from '../lib/toolConfig';
import type { ToolDefinition } from '../lib/skills';
import type { McpServerConfig } from '../lib/mcp';
import type { McpServerStatus } from '../hooks/useMcpServers';
import type { ChatParams } from '../types';
import type { PresentationMode } from '../lib/presentation';
import { AGENT_HINTS, type AgentHintSettings } from '../lib/agentHints';
import type { ChatBackend } from '../hooks/useChat';

interface SettingsMenuProps {
  baseUrl: string;
  onBaseUrlChange: (url: string) => void;
  /** Which wire protocol baseUrl speaks — see ChatBackend in hooks/useChat.ts. */
  backend: ChatBackend;
  onBackendChange: (backend: ChatBackend) => void;
  appVersion?: string;
  tauriVersion?: string;
  themeId: string;
  onThemeSelect: (id: string) => void;
  /** Flat vs. spatial (3D) chat history rendering — moved here from a titlebar toggle (2026-08-19) since it's a display preference, same category as theme/font, not something reached for every session. */
  presentationMode: PresentationMode;
  onPresentationModeSelect: (mode: PresentationMode) => void;
  tools: ToolDefinition[];
  disabledTools: Set<string>;
  onToggleTool: (name: string) => void;
  autoApproveReadOnly: boolean;
  onToggleAutoApproveReadOnly: () => void;
  autoApproveWrites: boolean;
  onToggleAutoApproveWrites: () => void;
  autoApproveSafeCommands: boolean;
  onToggleAutoApproveSafeCommands: () => void;
  safeCommands: string[];
  onSafeCommandsChange: (next: string[]) => void;
  mcpServers: McpServerConfig[];
  mcpStatusById: Record<string, McpServerStatus>;
  onAddMcpServer: (config: Omit<McpServerConfig, 'id'>) => void;
  onRemoveMcpServer: (id: string) => void;
  onConnectMcpServer: (id: string) => void;
  onDisconnectMcpServer: (id: string) => void;
  /** The active conversation's model/system-prompt/params — moved here from a per-conversation toggle in the chat header so persona/modelfile editing has one clear home. */
  activeModel: string;
  onModelChange: (model: string) => void;
  /** False right after a fresh launch with zero conversations (or all of them deleted) — SettingsPanel's fields are conversation-scoped and would otherwise silently show DEFAULT_PARAMS/an empty model with no working onChange, since there's no conversation for edits to write into. */
  hasActiveConversation: boolean;
  onStartNewChat: () => void;
  modelListRefreshKey?: number;
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  params: ChatParams;
  onParamsChange: (params: ChatParams) => void;
  onModelCreated: () => void;
  memoryDisabled: boolean;
  onMemoryDisabledChange: (disabled: boolean) => void;
  /** Manual font override — wins over whatever the active pack requests, since packs' fonts (Google Fonts names) aren't bundled and only render if installed locally. Empty string means no override. */
  fontOverride: string;
  onFontOverrideChange: (font: string) => void;
  /** Standing behavior hints folded into every turn's system prompt — see lib/agentHints.ts. */
  agentHints: AgentHintSettings;
  onAgentHintsChange: (next: AgentHintSettings) => void;
}

// Curated, not free-typed — real bug this replaces: the free-text input
// wouldn't accept spaces while typing (root cause never pinned down, not
// FONT_RE, which does allow them — a webview/IME quirk), which broke
// typing any multi-word font name at all. User explicitly didn't want
// free-typing as the long-term UX anyway ("don't really want users to
// type"). Two tiers below: Windows-shipped system fonts (always render
// regardless of what's bundled) and the three Google Fonts actually
// vendored with the app (index.css's @font-face rules + public/fonts/,
// confirmed OFL-licensed before bundling) — both are guaranteed to
// actually render on selection, unlike a typed arbitrary name.
const FONT_PRESETS: { label: string; value: string }[] = [
  { label: 'Theme default', value: '' },
  { label: 'Segoe UI (Windows default)', value: "'Segoe UI', system-ui, sans-serif" },
  { label: 'Georgia (serif)', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Trebuchet MS', value: "'Trebuchet MS', sans-serif" },
  { label: 'Comic Sans MS (rounded/fun)', value: "'Comic Sans MS', 'Comic Sans', cursive" },
  { label: 'Consolas (monospace)', value: "Consolas, 'Courier New', monospace" },
  { label: 'Quicksand (bundled, rounded)', value: "'Quicksand', system-ui, sans-serif" },
  { label: 'Fredoka (bundled, rounded)', value: "'Fredoka', system-ui, sans-serif" },
  { label: 'Nunito Sans (bundled)', value: "'Nunito Sans', system-ui, sans-serif" },
];

type Tab = 'theme' | 'general' | 'tools';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'theme', label: 'Theme' },
  { id: 'tools', label: 'Tools' },
];

// App-level settings home: titlebar ⚙ opens this in place of the chat pane
// (same pattern as the ⚙/📋 tasks-digest toggle). General also embeds the
// per-conversation SettingsPanel (model info, system prompt, sampling
// params, save-as-custom-model) — moved here from a toggle in the chat
// header so persona/modelfile editing (system prompt + save-as-model) has
// one clear home instead of being buried in a collapsible panel. The
// values themselves are still genuinely per-conversation (operate on
// whichever conversation is currently active); only the editing UI's
// location changed.
export function SettingsMenu({
  baseUrl,
  onBaseUrlChange,
  backend,
  onBackendChange,
  appVersion,
  tauriVersion,
  themeId,
  onThemeSelect,
  presentationMode,
  onPresentationModeSelect,
  tools,
  disabledTools,
  onToggleTool,
  autoApproveReadOnly,
  onToggleAutoApproveReadOnly,
  autoApproveWrites,
  onToggleAutoApproveWrites,
  autoApproveSafeCommands,
  onToggleAutoApproveSafeCommands,
  safeCommands,
  onSafeCommandsChange,
  mcpServers,
  mcpStatusById,
  onAddMcpServer,
  onRemoveMcpServer,
  onConnectMcpServer,
  onDisconnectMcpServer,
  activeModel,
  onModelChange,
  hasActiveConversation,
  onStartNewChat,
  modelListRefreshKey,
  systemPrompt,
  onSystemPromptChange,
  params,
  onParamsChange,
  onModelCreated,
  memoryDisabled,
  onMemoryDisabledChange,
  fontOverride,
  onFontOverrideChange,
  agentHints,
  onAgentHintsChange,
}: SettingsMenuProps) {
  const [tab, setTab] = useState<Tab>('general');
  // Local text buffer so typing doesn't fight the parent's parsed array on
  // every keystroke — parsed into safeCommands (blank lines dropped) only
  // on blur, same commit-on-blur pattern as the rest of Settings' text
  // fields.
  const [safeCommandsText, setSafeCommandsText] = useState(() => safeCommands.join('\n'));

  return (
    <div className="settings-menu">
      <nav className="settings-menu__tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`settings-menu__tab${tab === t.id ? ' settings-menu__tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="settings-menu__content">
        {tab === 'theme' && (
          <section className="settings-menu__section">
            <h3 className="settings-menu__heading">Theme</h3>
            <ThemePickerMenu activeId={themeId} onSelect={onThemeSelect} embedded />

            <h4 className="settings-menu__subheading">Chat view</h4>
            <div className="settings-menu__tool-row">
              <div className="settings-menu__tool-info">
                <div className="settings-menu__tool-name">
                  <span>Spatial (3D) chat view</span>
                </div>
                <p className="settings-menu__tool-desc">
                  Renders conversation history with WebGL glow/animation polish instead of plain flat scrollback.
                  Flat chat stays available as a fallback, not going away — just no longer the default focus.
                </p>
              </div>
              <label className="settings-menu__toggle">
                <input
                  type="checkbox"
                  checked={presentationMode === 'spatial'}
                  onChange={() => onPresentationModeSelect(presentationMode === 'spatial' ? 'flat' : 'spatial')}
                  aria-label={presentationMode === 'spatial' ? 'Switch to flat chat view' : 'Switch to spatial chat view'}
                />
                <span className="settings-menu__toggle-track" aria-hidden="true" />
              </label>
            </div>

            <h4 className="settings-menu__subheading">Font</h4>
            <p className="settings-menu__hint">
              Theme packs can request a font (Google Fonts names like "Quicksand" or "M PLUS Rounded 1c") — three of
              the most-requested ones (Quicksand, Fredoka, Nunito Sans) are now bundled with the app and always
              render; anything else only renders if it happens to be installed on this machine, otherwise it
              silently falls back. Pick a font below to override whatever the active pack asks for — every option
              here (Windows-shipped fonts plus the three bundled ones) is guaranteed to actually render.
            </p>
            <label className="settings-panel__field">
              <span>Select font</span>
              <select value={fontOverride} onChange={(e) => onFontOverrideChange(e.target.value)}>
                {FONT_PRESETS.map((f) => (
                  <option key={f.label} value={f.value}>
                    {f.label}
                  </option>
                ))}
                {/* Covers a value from before this became a dropdown, or a theme pack's own `font` field — a
                    <select> whose value matches no <option> silently falls back to showing the first option
                    instead, the same phantom-selection illusion already root-caused once on the model picker
                    this session. This makes what's actually active honest instead of repeating that bug. */}
                {fontOverride && !FONT_PRESETS.some((f) => f.value === fontOverride) && (
                  <option value={fontOverride}>Custom: {fontOverride}</option>
                )}
              </select>
            </label>
            <p
              className="settings-menu__font-preview"
              style={fontOverride ? { fontFamily: normalizeFontValue(fontOverride) } : undefined}
            >
              The quick brown fox jumps over the lazy duck — Aa Bb Cc 123
            </p>
            <div className="settings-menu__placeholder">
              <strong>Pack builder</strong> — a form to design your own theme pack (color pickers, name/author
              fields, export to file) is planned but not built yet. For now, import a pack via pasted JSON or a
              file above.
            </div>
          </section>
        )}

        {tab === 'general' && (
          <section className="settings-menu__section">
            <h3 className="settings-menu__heading">General</h3>
            <label className="settings-panel__field">
              <span>Backend</span>
              <select value={backend} onChange={(e) => onBackendChange(e.target.value as ChatBackend)}>
                <option value="ollama">Ollama</option>
                <option value="openai">OpenAI-compatible (llama.cpp / LM Studio / vLLM)</option>
              </select>
            </label>
            <label className="settings-panel__field">
              <span>{backend === 'openai' ? 'Server base URL' : 'Ollama base URL'}</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => onBaseUrlChange(e.target.value)}
                placeholder={backend === 'openai' ? 'http://localhost:8080' : 'http://localhost:11434'}
              />
            </label>
            {backend === 'openai' && (
              <p className="settings-menu__hint">
                Points at one already-running OpenAI-compatible server (llama-server, LM Studio, vLLM, …) —
                whichever model it was launched with is the only one available; there's no pull/switch-model list
                the way Ollama has. Tool calling needs the server started with function-calling support enabled
                (llama-server: <code>--jinja</code>).
              </p>
            )}

            <h4 className="settings-menu__subheading">Agent behavior</h4>
            <p className="settings-menu__hint">
              Standing instructions folded into every turn's system prompt, ahead of any per-conversation prompt
              below. Turn one off or edit its wording to tune how the model behaves — e.g. loosen or drop the
              thinking-efficiency hint if a particular model already writes content directly without drafting it
              twice in its thinking first.
            </p>
            {AGENT_HINTS.map((hint) => {
              const state = agentHints[hint.id];
              return (
                <div key={hint.id} className="settings-menu__hint-item">
                  <div className="settings-menu__hint-header">
                    <div className="settings-menu__tool-info">
                      <div className="settings-menu__tool-name">
                        <span>{hint.title}</span>
                      </div>
                      <p className="settings-menu__tool-desc">{hint.description}</p>
                    </div>
                    <label className="settings-menu__toggle">
                      <input
                        type="checkbox"
                        checked={state.enabled}
                        onChange={() =>
                          onAgentHintsChange({
                            ...agentHints,
                            [hint.id]: { ...state, enabled: !state.enabled },
                          })
                        }
                        aria-label={state.enabled ? `Disable ${hint.title}` : `Enable ${hint.title}`}
                      />
                      <span className="settings-menu__toggle-track" aria-hidden="true" />
                    </label>
                  </div>
                  <label className="settings-panel__field">
                    <textarea
                      value={state.text}
                      disabled={!state.enabled}
                      onChange={(e) =>
                        onAgentHintsChange({
                          ...agentHints,
                          [hint.id]: { ...state, text: e.target.value },
                        })
                      }
                      rows={3}
                    />
                  </label>
                  {state.text !== hint.defaultText && (
                    <button
                      type="button"
                      className="settings-menu__link-button"
                      onClick={() =>
                        onAgentHintsChange({
                          ...agentHints,
                          [hint.id]: { ...state, text: hint.defaultText },
                        })
                      }
                    >
                      Reset to default
                    </button>
                  )}
                </div>
              );
            })}

            <h4 className="settings-menu__subheading">Active conversation</h4>
            {hasActiveConversation ? (
              <SettingsPanel
                baseUrl={baseUrl}
                backend={backend}
                model={activeModel}
                onModelChange={onModelChange}
                modelListRefreshKey={modelListRefreshKey}
                systemPrompt={systemPrompt}
                onSystemPromptChange={onSystemPromptChange}
                params={params}
                onParamsChange={onParamsChange}
                onModelCreated={onModelCreated}
                memoryDisabled={memoryDisabled}
                onMemoryDisabledChange={onMemoryDisabledChange}
              />
            ) : (
              <div className="app__empty app__empty--inline">
                <p>No conversation selected — these settings (model, prompt, sampling) belong to a conversation.</p>
                <button type="button" onClick={onStartNewChat}>
                  Start a new chat
                </button>
              </div>
            )}

            {appVersion && (
              <p className="settings-menu__about">
                CodyShell v{appVersion}
                {tauriVersion ? ` · Tauri ${tauriVersion}` : ''}
              </p>
            )}
          </section>
        )}

        {tab === 'tools' && (
          <section className="settings-menu__section">
            <h3 className="settings-menu__heading">Tools</h3>
            <p className="settings-menu__hint">
              Every call still needs your explicit approval when the model requests it — turning a tool off here
              goes further, removing it from what the model can even see or request.
            </p>

            <div className="settings-menu__tool-row">
              <div className="settings-menu__tool-info">
                <div className="settings-menu__tool-name">
                  <span>Auto-approve read-only tools</span>
                  <span className="settings-menu__risk-badge settings-menu__risk-badge--read">Read-only</span>
                </div>
                <p className="settings-menu__tool-desc">
                  Skip the approval prompt for tools that only read data (e.g. search_memory, read_file). Write and
                  execute calls always still ask, regardless of this setting.
                </p>
              </div>
              <label className="settings-menu__toggle">
                <input
                  type="checkbox"
                  checked={autoApproveReadOnly}
                  onChange={onToggleAutoApproveReadOnly}
                  aria-label={`${autoApproveReadOnly ? 'Disable' : 'Enable'} auto-approve for read-only tools`}
                />
                <span className="settings-menu__toggle-track" aria-hidden="true" />
              </label>
            </div>

            <div className="settings-menu__tool-row">
              <div className="settings-menu__tool-info">
                <div className="settings-menu__tool-name">
                  <span>Auto-approve write tools</span>
                  <span className="settings-menu__risk-badge settings-menu__risk-badge--write">Write</span>
                </div>
                <p className="settings-menu__tool-desc">
                  Skip the approval prompt for write_file and edit_file too. execute_command (arbitrary shell
                  commands — where an actual delete would happen) always still asks, regardless of this setting. So
                  does every write call made by an unattended autonomous run — this only covers chat you're actively
                  driving.
                </p>
              </div>
              <label className="settings-menu__toggle">
                <input
                  type="checkbox"
                  checked={autoApproveWrites}
                  onChange={onToggleAutoApproveWrites}
                  aria-label={`${autoApproveWrites ? 'Disable' : 'Enable'} auto-approve for write tools`}
                />
                <span className="settings-menu__toggle-track" aria-hidden="true" />
              </label>
            </div>

            <div className="settings-menu__tool-row">
              <div className="settings-menu__tool-info">
                <div className="settings-menu__tool-name">
                  <span>Auto-approve safe commands</span>
                  <span className="settings-menu__risk-badge settings-menu__risk-badge--execute">Execute</span>
                </div>
                <p className="settings-menu__tool-desc">
                  Skip the approval prompt for execute_command, but only when the exact command text matches one of
                  the allowlist entries below (one per line, e.g. "git status") with no shell operators like{' '}
                  <code>&amp; | &gt; &lt; `</code> anywhere in it — those always require the click regardless of a
                  match, since they could chain on a second, unlisted command. Anything else still asks. Interactive
                  chat only; an unattended autonomous run always still asks for these too.
                </p>
                <label className="settings-panel__field">
                  <textarea
                    value={safeCommandsText}
                    onChange={(e) => setSafeCommandsText(e.target.value)}
                    onBlur={() =>
                      onSafeCommandsChange(
                        safeCommandsText
                          .split('\n')
                          .map((line) => line.trim())
                          .filter((line) => line.length > 0)
                      )
                    }
                    rows={4}
                    spellCheck={false}
                  />
                </label>
              </div>
              <label className="settings-menu__toggle">
                <input
                  type="checkbox"
                  checked={autoApproveSafeCommands}
                  onChange={onToggleAutoApproveSafeCommands}
                  aria-label={`${autoApproveSafeCommands ? 'Disable' : 'Enable'} auto-approve for safe commands`}
                />
                <span className="settings-menu__toggle-track" aria-hidden="true" />
              </label>
            </div>

            {tools.length === 0 ? (
              <p className="settings-menu__hint">Loading tool list…</p>
            ) : (
              <div className="settings-menu__tool-list">
                {tools.map((t) => {
                  const name = t.function.name;
                  const risk = riskOf(name);
                  const enabled = !disabledTools.has(name);
                  return (
                    <div key={name} className="settings-menu__tool-row">
                      <div className="settings-menu__tool-info">
                        <div className="settings-menu__tool-name">
                          <code>{name}</code>
                          <span className={`settings-menu__risk-badge settings-menu__risk-badge--${risk}`}>
                            {RISK_LABEL[risk]}
                          </span>
                        </div>
                        {t.function.description && (
                          <p className="settings-menu__tool-desc">{t.function.description}</p>
                        )}
                      </div>
                      <label className="settings-menu__toggle">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => onToggleTool(name)}
                          aria-label={`${enabled ? 'Disable' : 'Enable'} ${name}`}
                        />
                        <span className="settings-menu__toggle-track" aria-hidden="true" />
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
            <McpServers
              servers={mcpServers}
              statusById={mcpStatusById}
              onAdd={onAddMcpServer}
              onRemove={onRemoveMcpServer}
              onConnect={onConnectMcpServer}
              onDisconnect={onDisconnectMcpServer}
            />
          </section>
        )}
      </div>
    </div>
  );
}
