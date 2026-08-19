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

interface SettingsMenuProps {
  baseUrl: string;
  onBaseUrlChange: (url: string) => void;
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
  { id: 'theme', label: 'Theme' },
  { id: 'general', label: 'General' },
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
}: SettingsMenuProps) {
  const [tab, setTab] = useState<Tab>('theme');

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
              <span>Ollama base URL</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => onBaseUrlChange(e.target.value)}
                placeholder="http://localhost:11434"
              />
            </label>

            <h4 className="settings-menu__subheading">Active conversation</h4>
            {hasActiveConversation ? (
              <SettingsPanel
                baseUrl={baseUrl}
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
