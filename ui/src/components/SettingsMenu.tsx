import { useState } from 'react';
import { ThemePickerMenu } from './ThemePicker';
import { RISK_LABEL, riskOf } from '../lib/toolConfig';
import type { ToolDefinition } from '../lib/skills';

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
}

type Tab = 'theme' | 'general' | 'tools';

const TABS: { id: Tab; label: string }[] = [
  { id: 'theme', label: 'Theme' },
  { id: 'general', label: 'General' },
  { id: 'tools', label: 'Tools' },
];

// App-level settings home: titlebar ⚙ opens this in place of the chat pane
// (same pattern as the ⚙/📋 tasks-digest toggle). Distinct from the
// per-conversation SettingsPanel (model/system-prompt/params), which stays
// inline in ChatWindow since those genuinely vary per conversation.
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
            <div className="settings-menu__placeholder">
              <strong>MCP connectors</strong> — connecting external MCP servers as additional tool sources is
              planned but not wired up yet.
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
