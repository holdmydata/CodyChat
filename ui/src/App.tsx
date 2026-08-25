import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Bird, ListTodo, Maximize2, Minimize2, Network, PanelLeftClose, PanelLeftOpen, Settings, X } from 'lucide-react';
import './App.css';
import { Sidebar } from './components/Sidebar';
import { ChatWindow } from './components/ChatWindow';
import { DuckPanel } from './components/DuckPanel';
import { TaskDigest } from './components/TaskDigest';
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
import { getPresentationMode, setPresentationMode, type PresentationMode } from './lib/presentation';
import { getToolDefinitions, type ToolDefinition } from './lib/skills';
import {
  loadDisabledTools,
  saveDisabledTools,
  loadAutoApproveReadOnly,
  saveAutoApproveReadOnly,
  loadAutoApproveWrites,
  saveAutoApproveWrites,
  loadAutoApproveSafeCommands,
  saveAutoApproveSafeCommands,
  loadSafeCommands,
  saveSafeCommands,
} from './lib/toolConfig';
import { loadAgentHints, saveAgentHints, type AgentHintSettings } from './lib/agentHints';
import { generateSubject, summarizeForClear } from './lib/subject';
import { indexMessage, updateConversationSubject } from './lib/memory';
import { DEFAULT_PARAMS, type Conversation, type Message } from './types';
import type { ChatBackend } from './hooks/useChat';

// Only used for the very first conversation ever created, before any model
// has been picked — left empty rather than a hardcoded model name (was
// 'llama3.2', which most users never have pulled locally and showed up as
// "⚠ llama3.2 (not found)" on every new chat). ModelPicker shows "loading…"
// until its fetch resolves and only flags a "not found" state for a
// non-empty value, so an empty default degrades cleanly.
const DEFAULT_MODEL = '';
const BASE_URL_KEY = 'ollama-ui:base-url';
const BACKEND_KEY = 'ollama-ui:backend';
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

  const [autoApproveWrites, setAutoApproveWrites] = useState<boolean>(loadAutoApproveWrites);
  const toggleAutoApproveWrites = useCallback(() => {
    setAutoApproveWrites((prev) => {
      const next = !prev;
      saveAutoApproveWrites(next);
      return next;
    });
  }, []);

  const [autoApproveSafeCommands, setAutoApproveSafeCommands] = useState<boolean>(loadAutoApproveSafeCommands);
  const toggleAutoApproveSafeCommands = useCallback(() => {
    setAutoApproveSafeCommands((prev) => {
      const next = !prev;
      saveAutoApproveSafeCommands(next);
      return next;
    });
  }, []);
  const [safeCommands, setSafeCommands] = useState<string[]>(loadSafeCommands);
  const updateSafeCommands = useCallback((next: string[]) => {
    setSafeCommands(next);
    saveSafeCommands(next);
  }, []);

  const [agentHints, setAgentHints] = useState<AgentHintSettings>(loadAgentHints);
  const handleAgentHintsChange = useCallback((next: AgentHintSettings) => {
    setAgentHints(next);
    saveAgentHints(next);
  }, []);

  const [baseUrl, setBaseUrl] = useState(
    () => localStorage.getItem(BASE_URL_KEY) || 'http://localhost:11434'
  );

  // Which wire protocol baseUrl speaks — Ollama's native API, or the
  // OpenAI-compatible one shared by llama-server/LM Studio/vLLM (see
  // lib/openaiCompat.ts). Model management (create/save-as, /api/show's
  // baked system prompt), embeddings, and the duck/auto-title/clear-context
  // helper calls in lib/subject.ts and lib/memory.ts stay hard-wired to
  // Ollama's endpoints regardless of this toggle — llama-server has no
  // equivalent for the first, and switching the rest over wasn't worth the
  // scope for what's meant to be a minimal second backend.
  const [backend, setBackend] = useState<ChatBackend>(
    () => (localStorage.getItem(BACKEND_KEY) as ChatBackend | null) || 'ollama'
  );
  const handleBackendChange = useCallback((next: ChatBackend) => {
    setBackend(next);
    localStorage.setItem(BACKEND_KEY, next);
  }, []);

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

  // Same relationship theme packs have to color/font, one level up: which
  // paradigm renders the message history (today: only 'flat' vs 'spatial').
  // App-level like themeId, not per-conversation — see lib/presentation.ts.
  const [presentationMode, setPresentationModeState] = useState(getPresentationMode);

  const handlePresentationModeSelect = useCallback((mode: PresentationMode) => {
    setPresentationModeState(mode);
    setPresentationMode(mode);
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

  // Companion duck panel — session-only, not persisted (unlike sidebarCollapsed/
  // themeId), since there's no strong reason it should default open on next launch.
  const [isDuckOpen, setIsDuckOpen] = useState(false);
  const toggleDuck = useCallback(() => setIsDuckOpen((v) => !v), []);

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

  // On-demand only (a Sidebar button click, or the memory graph's bulk
  // Classify action below), never automatic — reuses whichever model that
  // conversation is already set to rather than a separate always-loaded
  // "labeling model", so it costs a real generation call only when
  // actually asked for. Also backfills the subject into every already-
  // indexed memory_item for this conversation (memory.ts's
  // updateConversationSubject) so search_memory's own results can show it
  // to the model — fire-and-forget, a failure here shouldn't undo the
  // title update that already succeeded.
  const handleGenerateSubject = useCallback(
    async (id: string) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv || !conv.model) return;
      const subject = await generateSubject(baseUrl, conv.model, conv.messages);
      updateConversation(id, { title: subject });
      void updateConversationSubject(id, subject).catch((err: unknown) =>
        console.error('updateConversationSubject failed (non-fatal):', err)
      );
    },
    [conversations, baseUrl, updateConversation]
  );

  // "Classify" (MemoryGraphView's control bar) — the bulk version of the
  // Sidebar button above: generates a subject for every conversation that
  // still has an unlabeled/mechanical title, one at a time. Sequential, not
  // Promise.all — this is real local-model generation load, and the
  // per-conversation button already proved ~1s/call is fine one at a time;
  // running them concurrently would just have them contend for the same
  // GPU with no real benefit. A per-conversation failure logs and moves on
  // rather than aborting the whole batch, same non-fatal posture used
  // throughout this app's other best-effort background calls.
  const [classifyProgress, setClassifyProgress] = useState<{ done: number; total: number } | null>(null);
  const classifyStopRef = useRef(false);

  const isUnlabeledTitle = useCallback((conv: Conversation) => {
    const first = conv.messages[0]?.content ?? '';
    return conv.title === 'New chat' || conv.title === deriveTitle(first);
  }, []);

  const handleClassifyAll = useCallback(async () => {
    const targets = conversations.filter((c) => c.messages.length > 0 && isUnlabeledTitle(c));
    if (targets.length === 0 || classifyProgress) return;

    classifyStopRef.current = false;
    setClassifyProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (classifyStopRef.current) break;
      try {
        await handleGenerateSubject(targets[i].id);
      } catch (err) {
        console.error('Classify: failed on conversation', targets[i].id, err);
      }
      setClassifyProgress({ done: i + 1, total: targets.length });
    }
    setClassifyProgress(null);
  }, [conversations, isUnlabeledTitle, handleGenerateSubject, classifyProgress]);

  const handleStopClassify = useCallback(() => {
    classifyStopRef.current = true;
  }, []);

  // "Clear context" (ContextMeter.tsx) — replaces history with a short real
  // recap instead of wiping to nothing, per direct feedback that a hard
  // wipe felt too destructive. The original messages need no separate
  // preservation step: useChat.ts already indexes every message into
  // vector memory as it's sent, regardless of what happens to this
  // conversation's own message list later, so they're still genuinely
  // findable via search_memory after this replaces the visible history.
  // Falls back to a plain wipe if the summarization call itself fails
  // (e.g. the model's unreachable) — clearing shouldn't become impossible
  // just because the one-shot summary call had a bad day.
  const handleClearContext = useCallback(
    async (id: string) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv || conv.messages.length === 0) return;
      try {
        const summary = await summarizeForClear(baseUrl, conv.model, conv.messages);
        const note: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            `*(Earlier conversation compacted to save context space. Recap: ${summary} ` +
            'The original messages are still indexed in memory and can be found via search_memory if needed.)*',
          createdAt: Date.now(),
        };
        setMessages(id, [note]);
        if (!conv.memoryDisabled) {
          void indexMessage(baseUrl, id, note.id, 'assistant', note.content, note.createdAt);
        }
      } catch (err) {
        console.error('Context compaction failed, falling back to a plain clear:', err);
        setMessages(id, []);
      }
    },
    [conversations, baseUrl, setMessages]
  );

  // Feeds the memory graph's detail panel (MemoryGraphView) — memory_items
  // only carry a bare conversation_id from the Rust backend, which knows
  // nothing about conversation titles (those live client-side in
  // localStorage, see useConversations.ts). A plain id->title lookup avoids
  // passing full Conversation objects (with their message arrays) into a
  // component that only needs the title.
  const conversationTitles = useMemo(
    () => Object.fromEntries(conversations.map((c) => [c.id, c.title])),
    [conversations]
  );

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
    backend,
    conversation: active,
    onMessagesChange: setMessages,
    disabledTools,
    mcpTools: mcp.mcpToolDefs,
    autoApproveReadOnly,
    autoApproveWrites,
    autoApproveSafeCommands,
    safeCommands,
    agentHints,
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
  const [pendingAutoStart, setPendingAutoStart] = useState<{ projectId: string; maxTasks: number } | null>(null);
  const startAutonomousLoop = useCallback(
    (projectId: string, maxTasks: number) => {
      if (!active) {
        createConversation();
        setPendingAutoStart({ projectId, maxTasks });
      } else {
        autonomousLoop.start(projectId, maxTasks);
      }
    },
    [active, createConversation, autonomousLoop]
  );

  useEffect(() => {
    if (pendingAutoStart && active) {
      const { projectId, maxTasks } = pendingAutoStart;
      setPendingAutoStart(null);
      autonomousLoop.start(projectId, maxTasks);
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
    (content: string, images?: string[]) => {
      if (active && active.messages.length === 0 && active.title === 'New chat') {
        updateConversation(active.id, { title: deriveTitle(content) });
      }
      sendMessage(content, images);
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
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        <button
          type="button"
          className={`titlebar__digest-toggle${mainView === 'digest' ? ' titlebar__icon-btn--active' : ''}`}
          onClick={() => toggleView('digest')}
          aria-label={mainView === 'digest' ? 'Show chat' : 'Show tasks'}
          title={mainView === 'digest' ? 'Show chat' : 'Show tasks'}
        >
          <ListTodo size={16} />
        </button>
        <button
          type="button"
          className={`titlebar__memory-graph-toggle${mainView === 'memory-graph' ? ' titlebar__icon-btn--active' : ''}`}
          onClick={() => toggleView('memory-graph')}
          aria-label={mainView === 'memory-graph' ? 'Show chat' : 'Show memory graph'}
          title={mainView === 'memory-graph' ? 'Show chat' : 'Show memory graph'}
        >
          <Network size={16} />
        </button>
        <ThemePicker activeId={themeId} onSelect={handleThemeSelect} />
        <button
          type="button"
          className={`titlebar__settings-toggle${mainView === 'settings' ? ' titlebar__icon-btn--active' : ''}`}
          onClick={() => toggleView('settings')}
          aria-label={mainView === 'settings' ? 'Show chat' : 'Settings'}
          title={mainView === 'settings' ? 'Show chat' : 'Settings'}
        >
          <Settings size={16} />
        </button>
        <button
          type="button"
          className={`titlebar__duck-toggle${isDuckOpen ? ' titlebar__icon-btn--active' : ''}`}
          onClick={toggleDuck}
          aria-label={isDuckOpen ? 'Close companion duck' : 'Open companion duck'}
          title={isDuckOpen ? 'Close companion duck' : 'Open companion duck'}
        >
          <Bird size={16} />
        </button>
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
          {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          className="titlebar__close"
          onClick={closeToTray}
          aria-label="Close to tray"
          title="Close to tray"
        >
          <X size={16} />
        </button>
      </div>
      <div className="app">
        {mainView === 'digest' ? (
          <TaskDigest
            loopState={autonomousLoop.state}
            stopReason={autonomousLoop.stopReason}
            todosCompleted={autonomousLoop.todosCompleted}
            currentProjectId={autonomousLoop.currentProjectId}
            onStart={startAutonomousLoop}
            onStop={autonomousLoop.stop}
            pendingToolCall={pendingToolCall}
            onApproveToolCall={approveToolCall}
            onDenyToolCall={denyToolCall}
          />
        ) : mainView === 'memory-graph' ? (
          <MemoryGraphView
            conversationTitles={conversationTitles}
            onClassifyAll={handleClassifyAll}
            classifyProgress={classifyProgress}
            onStopClassify={handleStopClassify}
          />
        ) : mainView === 'settings' ? (
          <SettingsMenu
            baseUrl={baseUrl}
            onBaseUrlChange={handleBaseUrlChange}
            backend={backend}
            onBackendChange={handleBackendChange}
            appVersion={appInfo?.version}
            tauriVersion={appInfo?.tauriVersion}
            themeId={themeId}
            onThemeSelect={handleThemeSelect}
            presentationMode={presentationMode}
            onPresentationModeSelect={handlePresentationModeSelect}
            tools={toolDefs}
            disabledTools={disabledTools}
            onToggleTool={toggleTool}
            autoApproveReadOnly={autoApproveReadOnly}
            onToggleAutoApproveReadOnly={toggleAutoApproveReadOnly}
            autoApproveWrites={autoApproveWrites}
            onToggleAutoApproveWrites={toggleAutoApproveWrites}
            autoApproveSafeCommands={autoApproveSafeCommands}
            onToggleAutoApproveSafeCommands={toggleAutoApproveSafeCommands}
            safeCommands={safeCommands}
            onSafeCommandsChange={updateSafeCommands}
            mcpServers={mcp.servers}
            mcpStatusById={mcp.statusById}
            onAddMcpServer={mcp.addServer}
            onRemoveMcpServer={mcp.removeServer}
            onConnectMcpServer={mcp.connect}
            onDisconnectMcpServer={mcp.disconnect}
            activeModel={active?.model ?? ''}
            onModelChange={(model) => active && updateConversation(active.id, { model })}
            hasActiveConversation={!!active}
            onStartNewChat={() => createConversation()}
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
            agentHints={agentHints}
            onAgentHintsChange={handleAgentHintsChange}
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
                onGenerateSubject={handleGenerateSubject}
              />
            )}
            {active ? (
              <ChatWindow
                conversation={active}
                baseUrl={baseUrl}
                backend={backend}
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
                presentationMode={presentationMode}
                onClearContext={() => handleClearContext(active.id)}
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
      <DuckPanel open={isDuckOpen} onClose={() => setIsDuckOpen(false)} baseUrl={baseUrl} defaultModel={active?.model ?? ''} />
    </div>
  );
}

export default App;
