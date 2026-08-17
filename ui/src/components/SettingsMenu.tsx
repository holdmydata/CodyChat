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

interface SettingsMenuProps {
  baseUrl: string;
  onBaseUrlChange: (url: string) => void;
  appVersion?: string;
  tauriVersion?: string;
  themeId: string;
  onThemeSelect: (id: string) => void;
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

            <h4 className="settings-menu__subheading">Font</h4>
            <p className="settings-menu__hint">
              Theme packs can request a font (Google Fonts names like "Quicksand" or "M PLUS Rounded 1c"), but
              nothing is bundled with the app — a requested font only renders if it's actually installed on this
              machine, otherwise it silently falls back. Type a font-family value below to override whatever the
              active pack asks for; the preview uses it directly so you can see immediately whether it's really
              available here.
            </p>
            <label className="settings-panel__field">
              <span>Font override</span>
              <input
                type="text"
                value={fontOverride}
                onChange={(e) => onFontOverrideChange(e.target.value)}
                placeholder="'Quicksand', system-ui, sans-serif"
              />
            </label>
            <p
              className="settings-menu__font-preview"
              style={fontOverride ? { fontFamily: normalizeFontValue(fontOverride) } : undefined}
            >
              The quick brown fox jumps over the lazy duck — Aa Bb Cc 123
            </p>
            {fontOverride && (
              <button type="button" className="settings-menu__font-reset" onClick={() => onFontOverrideChange('')}>
                Reset to theme default
              </button>
            )}

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
