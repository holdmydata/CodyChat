import { invoke } from '@tauri-apps/api/core';
import type { TokenUsage, WireMessage } from './ollama';
import { chatOnce } from './azureFoundry';

// Intent-based model routing for the Azure backend: classify each new user
// turn against a cheap/small deployment, then route the whole turn (every
// tool-calling round-trip included — see useChat.ts's routedModelRef) to
// whichever deployment fits. The task->role mapping is admin-managed (a
// plain JSON file the app reads from its data dir, seeded with a default on
// first run — see src-tauri/src/commands.rs's DEFAULT_ROUTER_CONFIG),
// deliberately not exposed in this app's own Settings UI.

export type RouterRole = 'small' | 'medium' | 'large';

export interface RouterConfig {
  /** Deployment used for the classification call itself — normally the same as roles.small, no dedicated deployment required. */
  classifierDeployment: string;
  /** 0-100 — a classified complexity above this always routes to the large role, regardless of task category. */
  complexityThreshold: number;
  roles: Record<RouterRole, string>;
  /** Lowercase task category -> which role handles it. Keys are also what's listed in the classifier's own prompt, so an admin can add/remove categories here without a rebuild. */
  taskRoutes: Record<string, RouterRole>;
}

export async function getRouterConfigPath(): Promise<string> {
  return invoke<string>('get_router_config_path');
}

function validateRouterConfig(parsed: unknown): RouterConfig {
  if (typeof parsed !== 'object' || !parsed) {
    throw new Error('Router config must be a JSON object.');
  }
  const p = parsed as Partial<RouterConfig>;
  if (typeof p.classifierDeployment !== 'string' || !p.classifierDeployment) {
    throw new Error('Router config is missing "classifierDeployment".');
  }
  if (typeof p.complexityThreshold !== 'number') {
    throw new Error('Router config is missing a numeric "complexityThreshold".');
  }
  const roles = p.roles;
  if (!roles || typeof roles.small !== 'string' || typeof roles.medium !== 'string' || typeof roles.large !== 'string') {
    throw new Error('Router config must define "roles": { small, medium, large } deployment names.');
  }
  if (!p.taskRoutes || typeof p.taskRoutes !== 'object') {
    throw new Error('Router config is missing "taskRoutes".');
  }
  return {
    classifierDeployment: p.classifierDeployment,
    complexityThreshold: p.complexityThreshold,
    roles: { small: roles.small, medium: roles.medium, large: roles.large },
    taskRoutes: p.taskRoutes as Record<string, RouterRole>,
  };
}

// Throws (missing/unreadable/malformed file) rather than silently falling
// back to a default — the router config being wrong is a real
// configuration error an admin needs to fix, not something to route around,
// same posture as azureFoundry.ts's "not fully configured" errors.
export async function loadRouterConfig(): Promise<RouterConfig> {
  const raw = await invoke<string>('get_router_config');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Router config file is not valid JSON: ${(err as Error).message}`);
  }
  return validateRouterConfig(parsed);
}

export interface RouteResult {
  deployment: string;
  role: RouterRole;
  task: string;
  complexity: number;
  usage: TokenUsage | null;
}

// Concrete complexity bands rather than just "0 = trivial, 100 = hard" —
// gives the classifier model real anchors instead of a vague spectrum, and
// gives whoever's tuning routing later something specific to edit if a
// class of request keeps landing on the wrong side of the threshold.
function buildClassifierSystemPrompt(taskNames: string[]): string {
  return (
    'You are a routing classifier for a chat application. Read the user\'s message and respond with ONLY a ' +
    'single-line JSON object, no prose, no markdown code fences, in exactly this shape:\n' +
    `{"task": "<one of: ${taskNames.join(', ')}, other>", "complexity": <integer 0-100>}\n\n` +
    '"task" must be the single category that best matches what the user is asking for. Use "other" if none of ' +
    'the listed categories fit.\n\n' +
    '"complexity" is your own estimate of how difficult this specific request is to handle well:\n' +
    '0-20: trivial — a single fact, a format conversion, a yes/no.\n' +
    '20-50: straightforward — a few well-defined steps, a common request.\n' +
    '50-80: moderate — multi-step reasoning, some ambiguity, real domain knowledge needed.\n' +
    '80-100: hard — deep reasoning or planning, high ambiguity, correctness genuinely matters.\n' +
    'Judge complexity independently of which task category you picked — a request tagged with an otherwise ' +
    'simple category can still be complex.\n\n' +
    'Respond with the JSON object and nothing else.'
  );
}

// Small models won't always emit clean JSON despite instructions — extract
// the first {...} blob rather than requiring the whole response to parse.
function parseClassifierResponse(raw: string): { task: string; complexity: number } | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.task !== 'string') return null;
    const complexity = Number(parsed.complexity);
    if (!Number.isFinite(complexity)) return null;
    return { task: parsed.task.trim().toLowerCase(), complexity: Math.max(0, Math.min(100, complexity)) };
  } catch {
    return null;
  }
}

// Complexity checked first and wins unconditionally — a task category is a
// typical-difficulty heuristic, not a hard ceiling; a request that happens
// to tag as "email" but is genuinely hard still escalates to the large
// tier. Falls back to 'medium' (safe middle default, not either extreme)
// when the task doesn't match a configured category.
function pickRole(task: string, complexity: number, config: RouterConfig): RouterRole {
  if (complexity > config.complexityThreshold) return 'large';
  return config.taskRoutes[task] ?? 'medium';
}

// Classifier call failure (network/auth/deployment-not-found) or an
// unparseable response both soft-fail to the medium role rather than
// blocking the turn entirely — a classifier hiccup shouldn't stop the user
// from getting an answer, just risks a less-optimal model pick for that
// one turn.
export async function classifyAndRoute(config: RouterConfig, userMessage: string): Promise<RouteResult> {
  const systemPrompt = buildClassifierSystemPrompt(Object.keys(config.taskRoutes));
  const messages: WireMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  let parsed: { task: string; complexity: number } | null = null;
  let usage: TokenUsage | null = null;
  try {
    const result = await chatOnce(config.classifierDeployment, messages);
    usage = result.usage;
    parsed = parseClassifierResponse(result.content);
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return { deployment: config.roles.medium, role: 'medium', task: 'unknown', complexity: 0, usage };
  }

  const role = pickRole(parsed.task, parsed.complexity, config);
  return { deployment: config.roles[role], role, task: parsed.task, complexity: parsed.complexity, usage };
}
