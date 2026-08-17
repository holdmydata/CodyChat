import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './App.css';
import { Sidebar } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { LoopxDigest } from './components/LoopxDigest';
import { MemoryGraphView } from './components/MemoryGraphView';
import { ThemePicker } from './components/ThemePicker';
import { SettingsMenu } from './components/SettingsMenu';
import { useConversations } from './hooks/useConversations';
import { useChat } from './hooks/useChat';
import { useAutonomousLoop } from './hooks/useAutonomousLoop';
import { useMcpServers } from './hooks/useMcpServers';
import {
  applyFontOverride,
  applyThemePack,
  BUILTIN_THEMES,
  getActiveThemeId,
  loadCustomThemes,
  loadFontOverride,
  saveFontOverride,
  setActiveThemeId,
} from './lib/themes';
import { getToolDefinitions, type ToolDefinition } from './lib/skills';
import { loadDisabledTools, saveDisabledTools, loadAutoApproveReadOnly, saveAutoApproveReadOnly } from './lib/toolConfig';
import { DEFAULT_PARAMS } from './types';

// Only used for the very first conversation ever created, before any model
// has been picked — left empty rather than a hardcoded model name (was
// 'llama3.2', which most users never have pulled locally and showed up as
// "⚠ llama3.2 (not found)" on every new chat). ModelPicker shows "loading…"
// until its fetch resolves and only flags a "not found" state for a
// non-empty value, so an empty default degrades cleanly.
const DEFAULT_MODEL = '';
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

  const mcp = useMcpServers();

  // Bumped by Settings → General's "Save as custom model" so ChatWindow's
  // ModelPicker refreshes its list — lifted here since the save action and
  // the picker that needs to react to it now live in separate components.
  const [modelListRefreshKey, setModelListRefreshKey] = useState(0);

  // Widget vs. full-window mode — Rust (lib.rs) owns the real state
  // (window size/position, and whether focus-loss should auto-hide); this
  // is just enough for the UI to show the right control ("Expand" vs.
  // "Collapse") and stay optimistic on click rather than round-tripping a
  // query. Reset to false whenever the window reopens from the tray,
  // since that always resets to widget mode on the Rust side regardless
  // of whatever mode it was in before — the "window-shown-as-widget"
  // event keeps this in sync with that.
  const [isExpanded, setIsExpanded] = useState(false);
  useEffect(() => {
    const unlisten = listen('window-shown-as-widget', () => setIsExpanded(false));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const closeToTray = useCallback(() => {
    invoke('close_to_tray').catch((err) => console.error('close_to_tray failed:', err));
  }, []);

  const toggleExpanded = useCallback(() => {
    const next = !isExpanded;
    setIsExpanded(next);
    invoke(next ? 'expand_window' : 'collapse_window').catch((err) =>
      console.error(`${next ? 'expand_window' : 'collapse_window'} failed:`, err)
    );
  }, [isExpanded]);

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

  const [autoApproveReadOnly, setAutoApproveReadOnly] = useState<boolean>(loadAutoApproveReadOnly);
  const toggleAutoApproveReadOnly = useCallback(() => {
    setAutoApproveReadOnly((prev) => {
      const next = !prev;
      saveAutoApproveReadOnly(next);
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

  // A manual font override always wins over whatever the active pack asks
  // for — separate from theme packs entirely (survives switching packs)
  // since "the fonts packs ask for (Google Fonts) aren't installed on this
  // machine" isn't a per-pack problem. Applied as an inline style on
  // <html>, which beats any stylesheet rule regardless of specificity, so
  // it keeps winning even as applyThemePack above swaps the pack's own
  // injected <style> tag on theme switches.
  const [fontOverride, setFontOverride] = useState(loadFontOverride);

  useEffect(() => {
    applyFontOverride(fontOverride);
  }, [fontOverride]);

  const handleFontOverrideChange = useCallback((font: string) => {
    const trimmed = font.trim();
    setFontOverride(trimmed || null);
    saveFontOverride(trimmed || null);
  }, []);

  type MainView = 'chat' | 'digest' | 'settings' | 'memory-graph';
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
    continueTurn,
    canContinue,
    invalidateModelSystemCache,
    runAutonomousTurn,
  } = useChat({
    baseUrl,
    conversation: active,
    onMessagesChange: setMessages,
    disabledTools,
    mcpTools: mcp.mcpToolDefs,
    autoApproveReadOnly,
  });

  const autonomousLoop = useAutonomousLoop({ runAutonomousTurn, baseUrl });
  // Starting a run needs a real conversation for runAutonomousTurn to drive
  // turns in — reuses the active one if there is one, otherwise creates a
  // fresh one first, same as how a normal first message would. The loop's
  // own state (fetching/running/reporting/stopped) is then visible directly
  // in that conversation's ChatWindow, not a separate hidden panel — an
  // autonomous run is meant to look like a normal chat happening on its own.
  //
  // Real timing gap this handles: createConversation() updates state
  // asynchronously, but runAutonomousTurn's closure only picks up the new
  // `active` conversation after the next render — calling
  // autonomousLoop.start() synchronously right after createConversation()
  // would still capture the *old* (null) conversation and fail immediately.
  // pendingAutoStart bridges that gap: recorded when a fresh conversation
  // was needed, consumed by the effect below once `active` actually
  // reflects it.
  const [pendingAutoStart, setPendingAutoStart] = useState<{ goalId: string; maxTodos: number } | null>(null);
  const startAutonomousLoop = useCallback(
    (goalId: string, maxTodos: number) => {
      if (!active) {
        createConversation();
        setPendingAutoStart({ goalId, maxTodos });
      } else {
        autonomousLoop.start(goalId, maxTodos);
      }
    },
    [active, createConversation, autonomousLoop]
  );

  useEffect(() => {
    if (pendingAutoStart && active) {
      const { goalId, maxTodos } = pendingAutoStart;
      setPendingAutoStart(null);
      autonomousLoop.start(goalId, maxTodos);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoStart, active]);

  // The Approve/Deny buttons on the real OS toast (notify_pending_approval
  // in lib.rs) fire this event rather than calling back through invoke() —
  // there's no "return value" from a notification action, so Rust emits
  // and the frontend listens, same shape as window-shown-as-widget above.
  // Routes to the exact same resolver functions the in-app buttons use, so
  // there's no special-casing between "approved via notification" and
  // "approved via the widget" — both just resolve whatever's pending.
  useEffect(() => {
    const unlisten = listen<string>('tool-approval-action', (event) => {
      if (event.payload === 'approve') approveToolCall();
      else if (event.payload === 'deny') denyToolCall();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [approveToolCall, denyToolCall]);

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
        <button
          type="button"
          className="titlebar__memory-graph-toggle"
          onClick={() => toggleView('memory-graph')}
          aria-label={mainView === 'memory-graph' ? 'Show chat' : 'Show memory graph'}
          title={mainView === 'memory-graph' ? 'Show chat' : 'Show memory graph'}
        >
          🕸️
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
        {/* TODO: Add roaming duck on the titlebar, no need to have Tauri version but can keep appInfo version */}
        {appInfo && (
          <span className="titlebar__info">
            CodyChat - v{appInfo.version} · Tauri {appInfo.tauriVersion}
          </span>
        )}
        <button
          type="button"
          className="titlebar__expand-toggle"
          onClick={toggleExpanded}
          aria-label={isExpanded ? 'Collapse to widget' : 'Expand to full window'}
          title={isExpanded ? 'Collapse to widget' : 'Expand to full window'}
        >
          {isExpanded ? '⤡' : '⤢'}
        </button>
        <button
          type="button"
          className="titlebar__close"
          onClick={closeToTray}
          aria-label="Close to tray"
          title="Close to tray"
        >
          ✕
        </button>
      </div>
      <div className="app">
        {mainView === 'digest' ? (
          <LoopxDigest
            loopState={autonomousLoop.state}
            stopReason={autonomousLoop.stopReason}
            todosCompleted={autonomousLoop.todosCompleted}
            currentGoalId={autonomousLoop.currentGoalId}
            onStart={startAutonomousLoop}
            onStop={autonomousLoop.stop}
          />
        ) : mainView === 'memory-graph' ? (
          <MemoryGraphView />
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
            autoApproveReadOnly={autoApproveReadOnly}
            onToggleAutoApproveReadOnly={toggleAutoApproveReadOnly}
            mcpServers={mcp.servers}
            mcpStatusById={mcp.statusById}
            onAddMcpServer={mcp.addServer}
            onRemoveMcpServer={mcp.removeServer}
            onConnectMcpServer={mcp.connect}
            onDisconnectMcpServer={mcp.disconnect}
            activeModel={active?.model ?? ''}
            onModelChange={(model) => active && updateConversation(active.id, { model })}
            modelListRefreshKey={modelListRefreshKey}
            systemPrompt={active?.systemPrompt ?? ''}
            onSystemPromptChange={(systemPrompt) => active && updateConversation(active.id, { systemPrompt })}
            params={active?.params ?? DEFAULT_PARAMS}
            onParamsChange={(params) => active && updateConversation(active.id, { params })}
            memoryDisabled={active?.memoryDisabled ?? false}
            onMemoryDisabledChange={(memoryDisabled) => active && updateConversation(active.id, { memoryDisabled })}
            onModelCreated={() => {
              setModelListRefreshKey((k) => k + 1);
              invalidateModelSystemCache();
            }}
            fontOverride={fontOverride ?? ''}
            onFontOverrideChange={handleFontOverrideChange}
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
                isStreaming={isStreaming}
                error={error}
                onSend={handleSend}
                onStop={stop}
                pendingToolCall={pendingToolCall}
                onApproveToolCall={approveToolCall}
                onDenyToolCall={denyToolCall}
                activitySteps={activitySteps}
                canContinue={canContinue}
                onContinue={continueTurn}
                compact={!isExpanded}
                modelListRefreshKey={modelListRefreshKey}
                loopState={autonomousLoop.state}
                loopStopReason={autonomousLoop.stopReason}
                loopTodosCompleted={autonomousLoop.todosCompleted}
                onStopLoop={autonomousLoop.stop}
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
