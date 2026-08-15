import { invoke } from '@tauri-apps/api/core';

/**
 * Theme packs — the mechanism behind the titlebar theme picker.
 *
 * A pack is a named set of values for the CSS custom properties the whole
 * UI is built on (see index.css: every component reads var(--...) and never
 * hardcodes a color, so a complete reskin is just a new palette). Packs are
 * shareable by design: the file IS this JSON object, so one user's pack can
 * be handed to another (as a file or pasted) and imported through the picker.
 */
export interface ThemePack {
  id: string;
  name: string;
  /** Optional credit, shown for packs created by someone else. */
  author?: string;
  /** Short one-line blurb, shown as a tooltip. */
  description?: string;
  /** Applied as CSS color-scheme so scrollbars/controls match. Omit for "either". */
  scheme?: 'light' | 'dark';
  /**
   * The colors. Keys are the CSS variable names without the leading `--`.
   * Packs provide the base palette (text, bg, border, accent, ...); extra
   * keys are applied as-is, so a pack can introduce a variable a future
   * component uses without breaking this version of the app.
   */
  vars: Record<string, string>;
}

export const THEME_STORAGE_KEY = 'ollama-ui:themes';
export const ACTIVE_THEME_KEY = 'ollama-ui:active-theme';

/**
 * Built-in packs, defined in TS (not CSS) so the picker can render them with
 * swatches and blurbs, and so applying works identically for built-in and
 * imported packs. The values mirror the base palette and system-dark
 * override in index.css — if you restyle index.css, update these to match.
 * 'auto' is the one exception: it's not a palette, it just removes the
 * theme attribute and lets prefers-color-scheme decide (today's behavior).
 */
export const BUILTIN_THEMES: ThemePack[] = [
  {
    id: 'auto',
    name: 'Auto (system)',
    description: 'Follows the OS light/dark setting.',
    vars: {},
  },
  {
    id: 'light',
    name: 'Light',
    description: 'The original frosted-light look, forced.',
    scheme: 'light',
    vars: {
      text: '#6b6375',
      'text-h': '#08060d',
      bg: 'rgba(255, 255, 255, 0.72)',
      'bg-alt': 'rgba(247, 246, 249, 0.82)',
      border: 'rgba(229, 228, 231, 0.7)',
      'code-bg': 'rgba(244, 243, 236, 0.85)',
      accent: '#aa3bff',
      'accent-bg': 'rgba(170, 59, 255, 0.12)',
      'accent-border': 'rgba(170, 59, 255, 0.5)',
      danger: '#d1435b',
      'user-bubble': 'rgba(240, 234, 255, 0.85)',
      'assistant-bubble': 'rgba(247, 246, 249, 0.85)',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'The original dark look, forced.',
    scheme: 'dark',
    vars: {
      text: '#9ca3af',
      'text-h': '#f3f4f6',
      bg: 'rgba(22, 23, 29, 0.7)',
      'bg-alt': 'rgba(28, 29, 36, 0.8)',
      border: 'rgba(46, 48, 58, 0.75)',
      'code-bg': 'rgba(31, 32, 40, 0.85)',
      accent: '#c084fc',
      'accent-bg': 'rgba(192, 132, 252, 0.18)',
      'accent-border': 'rgba(192, 132, 252, 0.5)',
      danger: '#f0708a',
      'user-bubble': 'rgba(42, 35, 64, 0.85)',
      'assistant-bubble': 'rgba(28, 29, 36, 0.85)',
    },
  },
  {
    id: 'psyduck-yellow',
    name: 'Psyduck Yellow',
    author: 'MeanSquares',
    description: "Confused about its own colors. Do not ask.",
    scheme: 'light',
    vars: {
      text: '#5d5533',
      'text-h': '#241d05',
      bg: 'rgba(255, 246, 199, 0.78)',
      'bg-alt': 'rgba(252, 243, 188, 0.85)',
      border: 'rgba(214, 190, 96, 0.75)',
      'code-bg': 'rgba(247, 238, 168, 0.85)',
      accent: '#c07800',
      'accent-bg': 'rgba(255, 196, 0, 0.22)',
      'accent-border': 'rgba(192, 120, 0, 0.55)',
      danger: '#c2452e',
      'user-bubble': 'rgba(255, 222, 89, 0.85)',
      'assistant-bubble': 'rgba(252, 243, 188, 0.85)',
    },
  },
];

// Import validation. Pack files are untrusted input (someone else's JSON)
// and applying one means injecting CSS text, so every value is checked
// before it's allowed near the DOM: ids must be plain tokens (they end up
// in an attribute selector), var names must be CSS identifiers, and var
// values must be plain color literals. Invalid entries are skipped (with a
// readable error when nothing usable remains), never injected.
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const VAR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.,\s%]+\)|hsla?\(\s*[\d.,\s%]+\)|transparent)$/;

export function sanitizeThemePack(
  raw: unknown,
  fallbackId = 'imported-pack',
): { pack: ThemePack | null; error: string | null } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { pack: null, error: 'A pack is a single JSON object, not an array.' };
  }
  const obj = raw as Record<string, unknown>;

  const rawId = typeof obj.id === 'string' ? obj.id.trim() : '';
  const id = ID_RE.test(rawId) ? rawId : fallbackId;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : id;

  if (typeof obj.vars !== 'object' || obj.vars === null || Array.isArray(obj.vars)) {
    return { pack: null, error: 'Pack is missing its "vars" color map.' };
  }

  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj.vars as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (!VAR_NAME_RE.test(key)) continue; // unknown key — skip, don't fail (forward-compat)
    if (!COLOR_RE.test(value.trim())) continue; // untrusted value — skip, don't fail
    vars[key] = value.trim();
  }
  if (Object.keys(vars).length === 0) {
    return { pack: null, error: 'Pack has no usable colors in "vars".' };
  }

  const pack: ThemePack = { id, name, vars };
  if (typeof obj.author === 'string' && obj.author.trim()) pack.author = obj.author.trim();
  if (typeof obj.description === 'string' && obj.description.trim())
    pack.description = obj.description.trim();
  if (obj.scheme === 'light' || obj.scheme === 'dark') pack.scheme = obj.scheme;
  return { pack, error: null };
}

export function loadCustomThemes(): ThemePack[] {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const packs: ThemePack[] = [];
    for (const entry of parsed) {
      const { pack } = sanitizeThemePack(entry);
      if (pack) packs.push(pack);
    }
    return packs;
  } catch {
    return [];
  }
}

export function saveCustomThemes(packs: ThemePack[]): void {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(packs));
}

export function getActiveThemeId(): string {
  return localStorage.getItem(ACTIVE_THEME_KEY) || 'auto';
}

export function setActiveThemeId(id: string): void {
  localStorage.setItem(ACTIVE_THEME_KEY, id);
}

/**
 * Applies a pack to the document. 'auto' removes the data-theme attribute
 * (and the injected variables) so index.css's prefers-color-scheme media
 * query decides; any other pack sets data-theme and injects its variables
 * scoped to :root[data-theme="..."], which beats both the base palette and
 * the system-dark override. A single persistent <style> element is reused,
 * so re-applying is just a textContent swap.
 */
const THEME_STYLE_ID = 'theme-pack-vars';

function getThemeStyleElement(): HTMLStyleElement {
  let el = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = THEME_STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
}

export function applyThemePack(pack: ThemePack): void {
  const root = document.documentElement;
  if (pack.id === 'auto') {
    root.removeAttribute('data-theme');
    document.getElementById(THEME_STYLE_ID)?.remove();
    return;
  }
  root.setAttribute('data-theme', pack.id);
  const decls = Object.entries(pack.vars)
    .map(([name, value]) => `  --${name}: ${value};`)
    .join('\n');
  const scheme = pack.scheme ? `\n  color-scheme: ${pack.scheme};` : '';
  getThemeStyleElement().textContent = `:root[data-theme="${pack.id}"] {\n${decls}${scheme}\n}`;
}

/**
 * Reads a pack file from disk through the Rust shell (commands.rs) rather
 * than a webview file input — the frontend doesn't touch the disk itself,
 * consistent with the skills layer.
 */
export async function readThemePackFile(path: string): Promise<string> {
  return invoke<string>('read_theme_pack', { path });
}
