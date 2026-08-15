import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './App.css';
import { Sidebar } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { LoopxDigest } from './components/LoopxDigest';
import { ThemePicker } from './components/ThemePicker';
import { SettingsMenu } from './components/SettingsMenu';
import { useConversations } from './hooks/useConversations';
import { useChat } from './hooks/useChat';
import {
  applyThemePack,
  BUILTIN_THEMES,
  getActiveThemeId,
  loadCustomThemes,
  setActiveThemeId,
} from './lib/themes';
import { getToolDefinitions, type ToolDefinition } from './lib/skills';
import { loadDisabledTools, saveDisabledTools } from './lib/toolConfig';

const DEFAULT_MODEL = 'llama3.2';
const BASE_URL_KEY = 'ollama-ui:base-url';
const SIDEBAR_COLLAPSED_KEY = 'ollama-ui:sidebar-collapsed';
const TITLE_MAX_LENGTH = 48;

function deriveTitle(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed || 'New chat';
  return `${collapsed.slice(0, TITLE_MAX_LENGTH).trimEnd()}…`;
}

interface AppInfo {
  version: string;
  tauriVersion: string;
}

function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    invoke<{ version: string; tauri_version: string }>('get_app_info')
      .then((info) => setAppInfo({ version: info.version, tauriVersion: info.tauri_version }))
      .catch((err) => console.error('get_app_info failed:', err));
  }, []);

  // Fetched independently of useChat's own (lazy, per-turn) copy so the
  // Settings → Tools list has something to render before the user has sent
  // a first message in any conversation.
  const [toolDefs, setToolDefs] = useState<ToolDefinition[]>([]);
  useEffect(() => {
    getToolDefinitions()
      .then(setToolDefs)
      .catch((err) => console.error('getToolDefinitions failed:', err));
  }, []);

  const [disabledTools, setDisabledTools] = useState<Set<string>>(loadDisabledTools);
  const toggleTool = useCallback((name: string) => {
    setDisabledTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveDisabledTools(next);
      return next;
    });
  }, []);

  const [baseUrl, setBaseUrl] = useState(
    () => localStorage.getItem(BASE_URL_KEY) || 'http://localhost:11434'
  );

  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  );

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  // Theme packs: app-level (not per-conversation), persisted like the other
  // app settings. 'auto' (the default) removes the data-theme attribute so
  // index.css's prefers-color-scheme query decides; anything else injects
  // the pack's variables scoped to :root[data-theme="..."]. A saved id that
  // no longer exists (pack deleted elsewhere) falls back to auto rather
  // than stranding the app unstyled.
  const [themeId, setThemeId] = useState(getActiveThemeId);

  useEffect(() => {
    const pack =
      BUILTIN_THEMES.find((t) => t.id === themeId) ??
      loadCustomThemes().find((t) => t.id === themeId) ??
      { id: 'auto', name: 'Auto', vars: {} };
    applyThemePack(pack);
  }, [themeId]);

  const handleThemeSelect = useCallback((id: string) => {
    setThemeId(id);
    setActiveThemeId(id);
  }, []);

  type MainView = 'chat' | 'digest' | 'settings';
  const [mainView, setMainView] = useState<MainView>('chat');
  const toggleView = useCallback((view: MainView) => {
    setMainView((current) => (current === view ? 'chat' : view));
  }, []);

  const handleBaseUrlChange = useCallback((url: string) => {
    setBaseUrl(url);
    localStorage.setItem(BASE_URL_KEY, url);
  }, []);

  const {
    conversations,
    active,
    activeId,
    setActiveId,
    createConversation,
    deleteConversation,
    updateConversation,
    setMessages,
  } = useConversations(DEFAULT_MODEL);

  const {
    sendMessage,
    stop,
    isStreaming,
    error,
    pendingToolCall,
    approveToolCall,
    denyToolCall,
    activitySteps,
  } = useChat({
    baseUrl,
    conversation: active,
    onMessagesChange: setMessages,
    disabledTools,
  });

  const handleSend = useCallback(
    (content: string) => {
      if (active && active.messages.length === 0 && active.title === 'New chat') {
        updateConversation(active.id, { title: deriveTitle(content) });
      }
      sendMessage(content);
    },
    [active, updateConversation, sendMessage]
  );

  return (
    <div className="shell">
      <div className="titlebar" data-tauri-drag-region>
        <button
          type="button"
          className="titlebar__sidebar-toggle"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        >
          ☰
        </button>
        <button
          type="button"
          className="titlebar__digest-toggle"
          onClick={() => toggleView('digest')}
          aria-label={mainView === 'digest' ? 'Show chat' : 'Show tasks'}
          title={mainView === 'digest' ? 'Show chat' : 'Show tasks'}
        >
          📋
        </button>
        <ThemePicker activeId={themeId} onSelect={handleThemeSelect} />
        <button
          type="button"
          className="titlebar__settings-toggle"
          onClick={() => toggleView('settings')}
          aria-label={mainView === 'settings' ? 'Show chat' : 'Settings'}
          title={mainView === 'settings' ? 'Show chat' : 'Settings'}
        >
          ⚙
        </button>
        {appInfo && (
          <span className="titlebar__info">
            v{appInfo.version} · Tauri {appInfo.tauriVersion}
          </span>
        )}
      </div>
      <div className="app">
        {mainView === 'digest' ? (
          <LoopxDigest />
        ) : mainView === 'settings' ? (
          <SettingsMenu
            baseUrl={baseUrl}
            onBaseUrlChange={handleBaseUrlChange}
            appVersion={appInfo?.version}
            tauriVersion={appInfo?.tauriVersion}
            themeId={themeId}
            onThemeSelect={handleThemeSelect}
            tools={toolDefs}
            disabledTools={disabledTools}
            onToggleTool={toggleTool}
          />
        ) : (
          <>
            {!sidebarCollapsed && (
              <Sidebar
                conversations={conversations}
                activeId={activeId}
                onSelect={setActiveId}
                onNew={() => createConversation()}
                onDelete={deleteConversation}
                onRename={(id, title) => updateConversation(id, { title })}
              />
            )}
            {active ? (
              <ChatWindow
                conversation={active}
                baseUrl={baseUrl}
                onModelChange={(model) => updateConversation(active.id, { model })}
                onSystemPromptChange={(systemPrompt) => updateConversation(active.id, { systemPrompt })}
                onParamsChange={(params) => updateConversation(active.id, { params })}
                isStreaming={isStreaming}
                error={error}
                onSend={handleSend}
                onStop={stop}
                pendingToolCall={pendingToolCall}
                onApproveToolCall={approveToolCall}
                onDenyToolCall={denyToolCall}
                activitySteps={activitySteps}
              />
            ) : (
              <div className="app__empty">
                <p>No conversation selected.</p>
                <button onClick={() => createConversation()}>Start a new chat</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default App;
