import { useCallback, useRef, useState } from 'react';
import { streamChat, type WireMessage } from '../lib/ollama';
import { executeSkill, getToolDefinitions } from '../lib/skills';
import { getEnvironmentInfo, formatEnvironmentContext } from '../lib/environment';
import { summarizeArgs, summarizeValue } from '../lib/format';
import type { ActivityStep, Conversation, Message, ToolCall } from '../types';
export type { ActivityStatus, ActivityStep } from '../types';

const makeId = () => crypto.randomUUID();

// Guards against a runaway model calling tools forever without ever
// producing a final answer.
const MAX_TOOL_ITERATIONS = 6;

interface UseChatArgs {
  baseUrl: string;
  conversation: Conversation | null;
  onMessagesChange: (id: string, messages: Message[]) => void;
}

function toWireMessages(messages: Pick<Message, 'role' | 'content' | 'toolCalls'>[]): WireMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls?.length
      ? { tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } })) }
      : {}),
  }));
}

export function useChat({ baseUrl, conversation, onMessagesChange }: UseChatArgs) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingToolCall, setPendingToolCall] = useState<ToolCall | null>(null);
  const [activitySteps, setActivitySteps] = useState<ActivityStep[]>([]);
  // Mirrors activitySteps synchronously so the final snapshot stamped onto
  // a message doesn't read stale state from a closure.
  const activityStepsRef = useRef<ActivityStep[]>([]);
  const updateActivitySteps = useCallback((updater: (prev: ActivityStep[]) => ActivityStep[]) => {
    activityStepsRef.current = updater(activityStepsRef.current);
    setActivitySteps(activityStepsRef.current);
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);
  // Tool schemas rarely change within a session — fetched once, lazily.
  const toolsRef = useRef<unknown[] | null>(null);
  // Real OS/home/Documents paths, fetched once and folded into every
  // turn's system prompt so the model doesn't have to guess at paths.
  const envContextRef = useRef<string | null>(null);

  const requestApproval = useCallback((call: ToolCall): Promise<boolean> => {
    setPendingToolCall(call);
    return new Promise((resolve) => {
      approvalResolverRef.current = (approved) => {
        setPendingToolCall(null);
        approvalResolverRef.current = null;
        resolve(approved);
      };
    });
  }, []);

  const approveToolCall = useCallback(() => approvalResolverRef.current?.(true), []);
  const denyToolCall = useCallback(() => approvalResolverRef.current?.(false), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // Unblocks an in-flight approval wait rather than leaving it hanging
    // forever if the user hits Stop while a prompt is showing.
    approvalResolverRef.current?.(false);
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!conversation || !content.trim()) return;
      setError(null);

      const userMessage: Message = {
        id: makeId(),
        role: 'user',
        content,
        createdAt: Date.now(),
      };
      const messages = [...conversation.messages, userMessage];
      onMessagesChange(conversation.id, messages);

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      activityStepsRef.current = [];
      setActivitySteps([]);

      const runTurn = async (msgs: Message[], depth: number): Promise<void> => {
        if (depth > MAX_TOOL_ITERATIONS) {
          const notice: Message = {
            id: makeId(),
            role: 'assistant',
            content: '(Stopped: too many tool calls in a row without a final answer.)',
            createdAt: Date.now(),
            activitySteps: activityStepsRef.current.length ? activityStepsRef.current : undefined,
          };
          onMessagesChange(conversation.id, [...msgs, notice]);
          return;
        }

        const assistantMessage: Message = {
          id: makeId(),
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
        };
        let current = [...msgs, assistantMessage];
        onMessagesChange(conversation.id, current);

        const historyBase = toWireMessages(msgs);
        const systemParts = [envContextRef.current, conversation.systemPrompt].filter(
          (s): s is string => Boolean(s && s.trim())
        );
        const history: WireMessage[] = systemParts.length
          ? [{ role: 'system', content: systemParts.join('\n\n') }, ...historyBase]
          : historyBase;

        let assembled = '';
        let assembledThinking = '';
        let toolCalls: ToolCall[] | null = null;

        await streamChat({
          baseUrl,
          model: conversation.model,
          messages: history,
          params: conversation.params,
          signal: controller.signal,
          tools: toolsRef.current ?? undefined,
          onToken: (token) => {
            assembled += token;
            current = current.map((m) => (m.id === assistantMessage.id ? { ...m, content: assembled } : m));
            onMessagesChange(conversation.id, current);
          },
          onThinking: (token) => {
            assembledThinking += token;
            current = current.map((m) => (m.id === assistantMessage.id ? { ...m, thinking: assembledThinking } : m));
            onMessagesChange(conversation.id, current);
          },
          onToolCalls: (calls) => {
            toolCalls = calls;
            current = current.map((m) => (m.id === assistantMessage.id ? { ...m, toolCalls: calls } : m));
            onMessagesChange(conversation.id, current);
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
        });

        if (!toolCalls) {
          if (activityStepsRef.current.length) {
            current = current.map((m) =>
              m.id === assistantMessage.id ? { ...m, activitySteps: activityStepsRef.current } : m
            );
            onMessagesChange(conversation.id, current);
          }
          return;
        }

        for (const call of toolCalls as ToolCall[]) {
          const approved = await requestApproval(call);
          updateActivitySteps((prev) =>
            prev.map((s) => (s.id === call.id ? { ...s, status: approved ? 'running' : 'denied' } : s))
          );
          let result: string;
          if (approved) {
            try {
              result = await executeSkill(call);
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
            result = `User declined to run skill '${call.name}'.`;
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

        await runTurn(current, depth + 1);
      };

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
        await runTurn(messages, 0);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [baseUrl, conversation, onMessagesChange, requestApproval]
  );

  return {
    sendMessage,
    stop,
    isStreaming,
    error,
    pendingToolCall,
    approveToolCall,
    denyToolCall,
    activitySteps,
  };
}
