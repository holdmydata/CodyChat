import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { streamChat as ollamaStreamChat, showModel as ollamaShowModel, OllamaError, type TokenUsage, type WireMessage } from '../lib/ollama';
import { streamChat as openaiStreamChat, showModel as openaiShowModel } from '../lib/openaiCompat';
import { streamChat as azureStreamChat } from '../lib/azureFoundry';
import { executeSkill, getToolDefinitions, type ToolDefinition } from '../lib/skills';
import { getEnvironmentInfo, formatEnvironmentContext } from '../lib/environment';
import { indexMessage } from '../lib/memory';
import { riskOf, isSafeCommand } from '../lib/toolConfig';
import { summarizeArgs, summarizeValue } from '../lib/format';
import { budgetTokensFor, estimateTokens, trimMessagesToBudget } from '../lib/contextBudget';
import { defaultAgentHintSettings, resolveAgentHints, type AgentHintSettings } from '../lib/agentHints';
import { loadGovernanceConfig, logGovernanceEvent } from '../lib/governance';
import type { ActivityStep, Conversation, Message, ToolCall } from '../types';
export type { ActivityStatus, ActivityStep } from '../types';

// Notifies only while the window is hidden/unfocused — no point interrupting
// with an OS notification for something already visible on screen. The
// tool-approval case gets a real toast with Approve/Deny buttons (built via
// a custom Rust command, notify_pending_approval — the official plugin's
// action-button support turned out to be mobile-only); the plain
// "response ready" case just needs a title/body, which the official plugin
// handles fine on its own.
async function notifyIfHidden(kind: 'approval', call: ToolCall): Promise<void>;
async function notifyIfHidden(kind: 'response', preview: string): Promise<void>;
async function notifyIfHidden(kind: 'approval' | 'response', arg: ToolCall | string): Promise<void> {
  try {
    const focused = await getCurrentWindow().isFocused();
    if (focused) return;

    if (kind === 'approval') {
      const call = arg as ToolCall;
      await invoke('notify_pending_approval', {
        tool_name: call.name,
        args_summary: summarizeArgs(call.arguments),
      });
      return;
    }

    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    if (!granted) return;
    await sendNotification({ title: 'CodyChat', body: arg as string });
  } catch {
    // Notifications are a courtesy, not a correctness requirement — a
    // failure here shouldn't interrupt the actual chat/approval flow.
  }
}

// 'ollama' talks Ollama's native /api/* wire format; 'openai' talks the
// OpenAI-compatible format shared by llama-server/LM Studio/vLLM (see
// lib/openaiCompat.ts); 'azure' talks Azure AI Foundry/Azure OpenAI's
// deployment-addressed, Entra-token-authed variant of that same wire
// format (see lib/azureFoundry.ts) — picks which module's streamChat/
// showModel this hook calls, everything else about the turn loop is
// identical either way.
export type ChatBackend = 'ollama' | 'openai' | 'azure';

const makeId = () => crypto.randomUUID();

// Guards against a runaway model calling tools forever without ever
// producing a final answer. Hitting this pauses the turn rather than
// dead-ending it — see pausedMessages/continueTurn below. Kept high enough
// that a normal read-heavy turn (several search_memory/read_file calls
// before composing an answer) doesn't trip it — 6 was hitting constantly.
const MAX_TOOL_ITERATIONS = 25;

const RETRY_TRIM_MESSAGE = '*(Note: earlier tool results were trimmed to fit the context window.)*\n\n';
const OVERFLOW_AFTER_RETRY_MESSAGE =
  "(The conversation is too large for this model's context window, even after trimming. Try raising context length in Settings, or start a new conversation.)";

interface UseChatArgs {
  baseUrl: string;
  /** Which wire protocol baseUrl speaks — see ChatBackend. Defaults to 'ollama'. */
  backend?: ChatBackend;
  conversation: Conversation | null;
  onMessagesChange: (id: string, messages: Message[]) => void;
  /** Tool names to strip from the `tools` list sent to Ollama — see Settings → Tools. */
  disabledTools?: Set<string>;
  /** Tool defs from currently-connected MCP servers, merged alongside the built-in skills. */
  mcpTools?: ToolDefinition[];
  /** When true, 'read' risk-tier tool calls skip the approval prompt and run immediately — see toolConfig.ts. */
  autoApproveReadOnly?: boolean;
  /** When true, 'write' risk-tier tool calls also skip the prompt — interactive turns only, see toolConfig.ts. */
  autoApproveWrites?: boolean;
  /** When true, execute_command calls matching safeCommands also skip the prompt — interactive turns only. */
  autoApproveSafeCommands?: boolean;
  /** The user-editable safe-command allowlist checked by autoApproveSafeCommands — see toolConfig.ts's isSafeCommand. */
  safeCommands?: string[];
  /** User-editable standing behavior hints (convergence/thinking-efficiency/memory-labeling) — see lib/agentHints.ts. */
  agentHints?: AgentHintSettings;
  /** Signed-in Azure UPN (from useAzureAuth), when backend is 'azure' and a session is active — used as governance's 'user' field in place of the configured fallback name. */
  azureAccount?: string | null;
}

const CHAT_BACKENDS: Record<ChatBackend, { streamChat: typeof ollamaStreamChat; showModel: typeof ollamaShowModel | null }> = {
  ollama: { streamChat: ollamaStreamChat, showModel: ollamaShowModel },
  openai: { streamChat: openaiStreamChat, showModel: openaiShowModel },
  // No showModel — Azure OpenAI deployments don't expose an equivalent
  // "show me this model's baked system prompt" call the way Ollama/
  // llama-server do; beginTurn below skips that lookup for this backend.
  azure: { streamChat: azureStreamChat, showModel: null },
};

function toWireMessages(
  messages: Pick<Message, 'role' | 'content' | 'toolCalls' | 'toolCallId' | 'images'>[]
): WireMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls?.length
      ? { tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } })) }
      : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    ...(m.images?.length ? { images: m.images } : {}),
  }));
}

// True when a streamAssistantReply attempt came back as a normal,
// successful completion (no thrown error) that nonetheless produced
// nothing usable — the model streamed thinking tokens and then just
// stopped, with no content and no tool calls. Ollama doesn't error out in
// this case (it's not a rejected request), so this has to be detected
// from the shape of the result rather than caught as an exception.
function isEmptyThinkingOnly(result: { current: Message[]; assistantId: string; toolCalls: ToolCall[] | null }): boolean {
  if (result.toolCalls) return false;
  const msg = result.current.find((m) => m.id === result.assistantId);
  return Boolean(msg && !msg.content && msg.thinking);
}

export function useChat({
  baseUrl,
  backend = 'ollama',
  conversation,
  onMessagesChange,
  disabledTools,
  mcpTools,
  autoApproveReadOnly,
  autoApproveWrites,
  autoApproveSafeCommands,
  safeCommands,
  agentHints,
  azureAccount,
}: UseChatArgs) {
  const { streamChat, showModel } = CHAT_BACKENDS[backend];
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingToolCall, setPendingToolCall] = useState<ToolCall | null>(null);
  const [activitySteps, setActivitySteps] = useState<ActivityStep[]>([]);
  // The message list a turn was paused at when MAX_TOOL_ITERATIONS was
  // hit — null when there's nothing to continue. Lets a "Continue" action
  // resume from exactly where the model left off, with a fresh iteration
  // budget, rather than the old dead-end (only recourse was a brand-new
  // message, which worked but didn't feel like resuming).
  const [pausedMessages, setPausedMessages] = useState<Message[] | null>(null);
  // Mirrors activitySteps synchronously so the final snapshot stamped onto
  // a message doesn't read stale state from a closure.
  const activityStepsRef = useRef<ActivityStep[]>([]);
  const updateActivitySteps = useCallback((updater: (prev: ActivityStep[]) => ActivityStep[]) => {
    activityStepsRef.current = updater(activityStepsRef.current);
    setActivitySteps(activityStepsRef.current);
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  // false = denied, true = approved (run executeSkill normally), a string =
  // a direct result (used by ask_user_choice — the user's clicked option
  // *is* the tool result, there's nothing further to execute).
  const approvalResolverRef = useRef<((resolution: boolean | string) => void) | null>(null);
  // Full, unfiltered schema list — fetched once, lazily (schemas rarely
  // change within a session). Filtered by disabledTools per-turn below so
  // toggling a tool off in Settings takes effect on the very next message,
  // not just for conversations started after the toggle.
  const toolsRef = useRef<ToolDefinition[] | null>(null);
  // Real OS/home/Documents paths, fetched once and folded into every
  // turn's system prompt so the model doesn't have to guess at paths.
  const envContextRef = useRef<string | null>(null);
  // A wire request always includes an explicit `system` message (see
  // systemParts below — AGENT_BEHAVIOR_HINT alone guarantees it's never
  // empty), and Ollama replaces a Modelfile's own baked-in SYSTEM prompt
  // entirely whenever the request supplies one — it does not merge them.
  // Left alone, that silently erased the system prompt of any custom model
  // saved via "Save as custom model" (/api/create) the moment a
  // conversation didn't also have its own per-conversation systemPrompt set
  // — a real, previously-unfixed bug distinct from the earlier ModelPicker
  // auto-swap fix. Fetched lazily per model (via /api/show) and folded back
  // into systemParts so the model's own persona survives regardless.
  const modelSystemCacheRef = useRef<Map<string, string>>(new Map());
  // Set at the end of every runTurn, read by runAutonomousTurn right after
  // beginTurn resolves — a ref rather than state specifically so reading it
  // immediately after the await can't race React's async state batching.
  // `completed` is the field useAutonomousLoop.ts actually gates
  // `todo complete` on — real bug fixed 2026-08-20: this used to be set
  // (implicitly "success", no such flag existed) on the max-iterations
  // stop-notice path too, and never set at all (staying null, which
  // runAutonomousTurn also treated as an empty "success") on the
  // context-overflow-notice path — so a turn that got cut short by either
  // safety limit still got reported as done to the task tracker. Only the
  // genuine final-answer path sets completed: true now.
  const lastTurnResultRef = useRef<{ content: string; toolNames: string[]; completed: boolean } | null>(null);

  const requestApproval = useCallback((call: ToolCall): Promise<boolean | string> => {
    setPendingToolCall(call);
    notifyIfHidden('approval', call);
    return new Promise((resolve) => {
      approvalResolverRef.current = (resolution) => {
        setPendingToolCall(null);
        approvalResolverRef.current = null;
        resolve(resolution);
      };
    });
  }, []);

  const approveToolCall = useCallback(() => approvalResolverRef.current?.(true), []);
  const denyToolCall = useCallback(() => approvalResolverRef.current?.(false), []);
  // ask_user_choice's UI (ChoicePrompt) calls this with the clicked option
  // text instead of approveToolCall/denyToolCall — see the tool loop below.
  const selectToolChoice = useCallback((value: string) => approvalResolverRef.current?.(value), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // Unblocks an in-flight approval wait rather than leaving it hanging
    // forever if the user hits Stop while a prompt is showing.
    approvalResolverRef.current?.(false);
  }, []);

  // One streaming attempt: builds the trimmed wire history for `historyMsgs`
  // against `budgetTokens`, appends a fresh assistant placeholder, streams
  // the reply, and returns the updated message list + any requested tool
  // calls. Factored out (rather than inlined once) so the reactive retry
  // below can cleanly redo this from scratch on a stricter budget instead
  // of trying to patch a possibly-partially-streamed message in place.
  const streamAssistantReply = useCallback(
    async (
      conv: Conversation,
      historyMsgs: Message[],
      budgetTokens: number,
      systemContent: string,
      activeTools: ToolDefinition[],
      signal: AbortSignal
    ): Promise<{ current: Message[]; assistantId: string; toolCalls: ToolCall[] | null }> => {
      const trimmed = trimMessagesToBudget(historyMsgs, budgetTokens);
      const historyBase = toWireMessages(trimmed);
      const history: WireMessage[] = systemContent
        ? [{ role: 'system', content: systemContent }, ...historyBase]
        : historyBase;

      const assistantMessage: Message = { id: makeId(), role: 'assistant', content: '', createdAt: Date.now() };
      let current = [...historyMsgs, assistantMessage];
      onMessagesChange(conv.id, current);

      let assembled = '';
      let assembledThinking = '';
      let toolCalls: ToolCall[] | null = null;
      let usage: TokenUsage | null = null;
      const startedAt = performance.now();

      await streamChat({
        baseUrl,
        model: conv.model,
        messages: history,
        params: conv.params,
        signal,
        tools: activeTools.length ? activeTools : undefined,
        onToken: (token) => {
          assembled += token;
          current = current.map((m) => (m.id === assistantMessage.id ? { ...m, content: assembled } : m));
          onMessagesChange(conv.id, current);
        },
        onThinking: (token) => {
          assembledThinking += token;
          current = current.map((m) => (m.id === assistantMessage.id ? { ...m, thinking: assembledThinking } : m));
          onMessagesChange(conv.id, current);
        },
        onToolCalls: (calls) => {
          toolCalls = calls;
          current = current.map((m) => (m.id === assistantMessage.id ? { ...m, toolCalls: calls } : m));
          onMessagesChange(conv.id, current);
          updateActivitySteps((prev) => [
            ...prev,
            ...calls.map((c) => ({
              id: c.id,
              toolName: c.name,
              argsSummary: summarizeArgs(c.arguments),
              status: 'pending_approval' as const,
            })),
          ]);
        },
        onUsage: (u) => {
          usage = u;
        },
      });

      // Logged per actual request, not once per outer turn — a tool-calling
      // turn issues several of these (one per round-trip), each a real,
      // separately-billed model call, so governance has to account for
      // each one rather than only the final one. No usage means the
      // backend/response didn't report it (see ollama.ts/openaiCompat.ts's
      // onUsage) — nothing to log in that case.
      if (usage) {
        const { promptTokens, completionTokens } = usage as TokenUsage;
        logGovernanceEvent({
          user: azureAccount || loadGovernanceConfig().fallbackUserName,
          agent: conv.title,
          model: conv.model,
          backend,
          promptTokens,
          completionTokens,
          durationMs: performance.now() - startedAt,
        });
      }

      return { current, assistantId: assistantMessage.id, toolCalls };
    },
    [baseUrl, streamChat, onMessagesChange, updateActivitySteps, backend, azureAccount]
  );

  // retryState is a single mutable object created once per top-level turn
  // (in beginTurn below) and threaded through every recursive call — one
  // retry allowed for the *whole* turn, not one per tool-call depth level,
  // so a systemic overflow can't effectively double the iteration cap.
  const runTurn = useCallback(
    async (msgs: Message[], depth: number, retryState: { used: boolean }, isAutonomous: boolean): Promise<void> => {
      if (!conversation) return;

      if (depth > MAX_TOOL_ITERATIONS) {
        const notice: Message = {
          id: makeId(),
          role: 'assistant',
          content: '(Stopped: too many tool calls in a row without a final answer.)',
          createdAt: Date.now(),
          activitySteps: activityStepsRef.current.length ? activityStepsRef.current : undefined,
        };
        lastTurnResultRef.current = {
          content: notice.content,
          toolNames: activityStepsRef.current.map((s) => s.toolName),
          completed: false,
        };
        onMessagesChange(conversation.id, [...msgs, notice]);
        setPausedMessages(msgs);
        return;
      }

      const modelSystem = modelSystemCacheRef.current.get(conversation.model) ?? '';
      const systemParts = [
        ...resolveAgentHints(agentHints ?? defaultAgentHintSettings()),
        envContextRef.current,
        modelSystem,
        conversation.systemPrompt,
      ].filter((s): s is string => Boolean(s && s.trim()));
      const systemContent = systemParts.join('\n\n');
      const systemTokens = systemContent ? estimateTokens(systemContent) : 0;
      const budgetTokens = Math.max(0, budgetTokensFor(conversation.params.numCtx) - systemTokens);

      const activeTools = [
        ...(toolsRef.current?.filter((t) => !disabledTools?.has(t.function.name)) ?? []),
        ...(mcpTools ?? []),
      ];
      const signal = abortRef.current?.signal;
      if (!signal) return;

      let attemptResult: { current: Message[]; assistantId: string; toolCalls: ToolCall[] | null } | null = null;
      let overflowError: OllamaError | null = null;
      try {
        attemptResult = await streamAssistantReply(conversation, msgs, budgetTokens, systemContent, activeTools, signal);
      } catch (err) {
        if (err instanceof OllamaError && err.likelyContextOverflow) {
          overflowError = err;
        } else {
          throw err;
        }
      }

      // Two different shapes of "ran out of room" land here: a thrown
      // overflow error (Ollama rejected the request outright), and —
      // confirmed live, this is the one the initial fix missed — a
      // *successful* 200 OK stream that contains only thinking and no
      // content/tool calls at all. The model didn't get rejected; it just
      // spent its whole remaining generation budget thinking and never
      // reached an actual answer, which is a generation-side problem, not
      // a request-size one. Trimming the input further still helps here
      // though: less input sent means more of numCtx is left over for the
      // model's own output, so both cases get the same retry, just with a
      // much harder cut for the empty-completion case since freeing
      // generation headroom is specifically the point of it.
      // Shared by both "the retry itself also failed" and "no retry budget
      // left in this turn" below — from the user's side those are the same
      // outcome (conversation too large, nothing more this turn can do
      // about it automatically), so both get the same clean message
      // instead of one showing a friendly notice and the other dumping a
      // raw Ollama error. Real gap found live: a long tool-calling turn hit
      // overflow twice — the first time the retry silently recovered it,
      // the second time (retry budget already spent) it re-threw the raw
      // JSON error straight into the `error` state instead of this notice.
      const showOverflowNotice = () => {
        const notice: Message = {
          id: makeId(),
          role: 'assistant',
          content: OVERFLOW_AFTER_RETRY_MESSAGE,
          createdAt: Date.now(),
          activitySteps: activityStepsRef.current.length ? activityStepsRef.current : undefined,
        };
        onMessagesChange(conversation.id, [...msgs, notice]);
      };

      const producedNothing = attemptResult ? isEmptyThinkingOnly(attemptResult) : false;
      if ((overflowError || producedNothing) && !retryState.used) {
        retryState.used = true;
        // Roll the visible transcript back — streamAssistantReply already
        // pushed a (possibly partially-streamed) assistant placeholder via
        // onMessagesChange, which must not survive into the retry.
        onMessagesChange(conversation.id, msgs);
        try {
          const retried = await streamAssistantReply(
            conversation,
            msgs,
            Math.floor(budgetTokens * (overflowError ? 0.5 : 0.25)),
            systemContent,
            activeTools,
            signal
          );
          if (isEmptyThinkingOnly(retried)) {
            throw new Error('retry also produced no content');
          }
          attemptResult = {
            ...retried,
            current: retried.current.map((m) =>
              m.id === retried.assistantId && m.content ? { ...m, content: RETRY_TRIM_MESSAGE + m.content } : m
            ),
          };
          onMessagesChange(conversation.id, attemptResult.current);
        } catch {
          showOverflowNotice();
          return;
        }
      } else if (overflowError) {
        // Overflow error, but the one retry this turn is already spent —
        // same clean notice as the "retry attempted and failed" case above,
        // not a raw error dump (see showOverflowNotice's comment).
        showOverflowNotice();
        return;
      }

      if (!attemptResult) return;

      const { assistantId, toolCalls } = attemptResult;
      let current = attemptResult.current;

      if (!toolCalls) {
        if (activityStepsRef.current.length) {
          current = current.map((m) => (m.id === assistantId ? { ...m, activitySteps: activityStepsRef.current } : m));
          onMessagesChange(conversation.id, current);
        }
        const finalMessage = current.find((m) => m.id === assistantId);
        lastTurnResultRef.current = {
          content: finalMessage?.content ?? '',
          toolNames: activityStepsRef.current.map((s) => s.toolName),
          completed: true,
        };
        if (finalMessage?.content) {
          notifyIfHidden('response', summarizeValue(finalMessage.content, 150));
          if (!conversation.memoryDisabled) {
            void indexMessage(
              baseUrl,
              conversation.id,
              finalMessage.id,
              'assistant',
              finalMessage.content,
              finalMessage.createdAt
            );
          }
        }
        return;
      }

      for (const call of toolCalls as ToolCall[]) {
        // Auto-approve covers 'read' always (if the setting's on), 'write'
        // only for an interactive turn with autoApproveWrites on, and
        // execute_command specifically only when it's both an interactive
        // turn and the exact command text passes isSafeCommand's allowlist
        // + metacharacter check (toolConfig.ts) — every other 'execute'
        // call is never auto-approved. isAutonomous forces write/execute
        // back to a real prompt regardless of either toggle — see
        // toolConfig.ts's loadAutoApproveWrites comment for why.
        // Short-circuits before requestApproval is ever called, so no
        // prompt/pendingToolCall state is set for an auto-approved call.
        // ask_user_choice is never auto-approved regardless of any toggle —
        // the prompt IS the interaction (there's no "safe to skip" version
        // of a question that only the user can actually answer).
        const risk = riskOf(call.name);
        const isChoice = call.name === 'ask_user_choice';
        const autoApproved =
          !isChoice &&
          ((Boolean(autoApproveReadOnly) && risk === 'read') ||
            (Boolean(autoApproveWrites) && risk === 'write' && !isAutonomous) ||
            (Boolean(autoApproveSafeCommands) &&
              !isAutonomous &&
              call.name === 'execute_command' &&
              isSafeCommand(String(call.arguments?.command ?? ''), safeCommands ?? [])));
        const resolution = autoApproved || (await requestApproval(call));
        const approved = resolution !== false;
        updateActivitySteps((prev) =>
          prev.map((s) => (s.id === call.id ? { ...s, status: approved ? 'running' : 'denied' } : s))
        );
        let result: string;
        if (typeof resolution === 'string') {
          // ChoicePrompt resolved with the clicked option text directly —
          // that *is* the result, nothing to execute.
          result = resolution;
          updateActivitySteps((prev) =>
            prev.map((s) => (s.id === call.id ? { ...s, status: 'done', resultSummary: summarizeValue(result) } : s))
          );
        } else if (approved) {
          try {
            result = await executeSkill(call, { baseUrl, conversationId: conversation.id });
            updateActivitySteps((prev) =>
              prev.map((s) => (s.id === call.id ? { ...s, status: 'done', resultSummary: summarizeValue(result) } : s))
            );
          } catch (err) {
            result = `error: ${(err as Error).message ?? String(err)}`;
            updateActivitySteps((prev) =>
              prev.map((s) => (s.id === call.id ? { ...s, status: 'error', resultSummary: summarizeValue(result) } : s))
            );
          }
        } else {
          result = isChoice ? 'The user closed the prompt without choosing an option.' : `User declined to run skill '${call.name}'.`;
        }
        const toolResultMessage: Message = {
          id: makeId(),
          role: 'tool',
          content: result,
          toolCallId: call.id,
          createdAt: Date.now(),
        };
        current = [...current, toolResultMessage];
        onMessagesChange(conversation.id, current);
      }

      await runTurn(current, depth + 1, retryState, isAutonomous);
    },
    [
      agentHints,
      autoApproveReadOnly,
      autoApproveWrites,
      autoApproveSafeCommands,
      safeCommands,
      baseUrl,
      conversation,
      disabledTools,
      mcpTools,
      onMessagesChange,
      requestApproval,
      streamAssistantReply,
      updateActivitySteps,
    ]
  );

  // Shared setup for both a brand-new message and a Continue click: fresh
  // abort controller, streaming state, activity log, and the lazy
  // tools/env-context init that used to live only in sendMessage.
  const beginTurn = useCallback(
    async (msgs: Message[], isAutonomous = false) => {
      if (!conversation) return;
      setError(null);
      setPausedMessages(null);

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      activityStepsRef.current = [];
      setActivitySteps([]);

      try {
        if (!toolsRef.current) {
          toolsRef.current = await getToolDefinitions();
        }
        if (envContextRef.current === null) {
          try {
            envContextRef.current = formatEnvironmentContext(await getEnvironmentInfo());
          } catch {
            envContextRef.current = '';
          }
        }
        if (showModel && conversation.model && !modelSystemCacheRef.current.has(conversation.model)) {
          try {
            const info = await showModel(baseUrl, conversation.model);
            modelSystemCacheRef.current.set(conversation.model, info.system);
          } catch {
            modelSystemCacheRef.current.set(conversation.model, '');
          }
        }
        await runTurn(msgs, 0, { used: false }, isAutonomous);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [baseUrl, showModel, conversation, runTurn]
  );

  const sendMessage = useCallback(
    async (content: string, images?: string[]) => {
      // Defense in depth against a second overlapping turn — the primary
      // guard lives in MessageInput (Enter used to bypass the hidden Send
      // button while streaming), but nothing should be able to start a new
      // turn while one is already in flight regardless of entry point.
      if (!conversation || (!content.trim() && !images?.length) || isStreaming) return;

      const userMessage: Message = {
        id: makeId(),
        role: 'user',
        content,
        ...(images?.length ? { images } : {}),
        createdAt: Date.now(),
      };
      const messages = [...conversation.messages, userMessage];
      onMessagesChange(conversation.id, messages);
      if (!conversation.memoryDisabled) {
        void indexMessage(baseUrl, conversation.id, userMessage.id, 'user', content, userMessage.createdAt);
      }
      await beginTurn(messages);
    },
    [baseUrl, conversation, isStreaming, onMessagesChange, beginTurn]
  );

  const continueTurn = useCallback(async () => {
    if (!conversation || isStreaming || !pausedMessages) return;
    await beginTurn(pausedMessages);
  }, [conversation, isStreaming, pausedMessages, beginTurn]);

  // Drives a real turn from a synthesized (not user-typed) prompt, for
  // useAutonomousLoop.ts — reuses the exact same beginTurn/runTurn path as
  // any other message (same streaming, same tool-approval gating, same
  // context-overflow retry), so an autonomous run behaves identically to a
  // human-driven one rather than needing parallel turn-execution logic.
  // Deliberately doesn't call indexMessage for the synthesized prompt text
  // itself — it's loop bookkeeping ("current task: ..."), not something a
  // future search_memory query should ever want back.
  const runAutonomousTurn = useCallback(
    async (promptText: string): Promise<{ content: string; toolNames: string[]; completed: boolean }> => {
      if (!conversation) throw new Error('runAutonomousTurn: no active conversation');
      const userMessage: Message = { id: makeId(), role: 'user', content: promptText, createdAt: Date.now() };
      const messages = [...conversation.messages, userMessage];
      onMessagesChange(conversation.id, messages);
      lastTurnResultRef.current = null;
      await beginTurn(messages, true);
      // The overflow-notice path in runTurn returns without ever setting
      // lastTurnResultRef (see showOverflowNotice's call sites) — null here
      // means exactly that: the turn was cut short, not a genuine empty
      // success, so completed stays false in the fallback too.
      return lastTurnResultRef.current ?? { content: '', toolNames: [], completed: false };
    },
    [conversation, onMessagesChange, beginTurn]
  );

  // Called after "Save as custom model" — re-saving over an existing custom
  // model's name (iterating on a persona) would otherwise keep serving the
  // stale cached system prompt for the rest of the session.
  const invalidateModelSystemCache = useCallback(() => {
    modelSystemCacheRef.current.clear();
  }, []);

  return {
    sendMessage,
    stop,
    isStreaming,
    error,
    pendingToolCall,
    approveToolCall,
    denyToolCall,
    selectToolChoice,
    activitySteps,
    continueTurn,
    canContinue: pausedMessages !== null,
    invalidateModelSystemCache,
    runAutonomousTurn,
  };
}
