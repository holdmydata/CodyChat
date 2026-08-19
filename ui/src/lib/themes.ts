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
   * Overrides --sans (the app's UI font stack) for this pack. The one
   * non-color value a pack is allowed to set — deliberately not part of
   * `vars` below, since it isn't a color and needs its own validation.
   * These are Google Fonts names — three of the ones the built-in packs
   * actually request (Quicksand, Fredoka, Nunito Sans) are now bundled
   * locally (see index.css's @font-face rules + public/fonts/, all
   * confirmed OFL-licensed before vendoring), so those are guaranteed to
   * render regardless of what's installed on the machine. Anything else —
   * M PLUS Rounded 1c included, skipped as a bundle candidate purely on
   * file-size grounds (3.4MB for one static weight, no variable-font
   * option) — still only renders if actually installed locally, otherwise
   * the rest of the stack's fallbacks apply. Still fully offline (no
   * runtime webfont fetch either way). Should be a full font-family value
   * including fallbacks, e.g. `"'Quicksand', system-ui, sans-serif"`.
   */
  font?: string;
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
    description: "CodyChat's default light look.",
    scheme: 'light',
    font: "'M PLUS Rounded 1c', 'Quicksand', 'Nunito Sans', system-ui, sans-serif",
    vars: {
      text: '#50627A',
      'text-h': '#0B2A5B',
      'root-bg': '#F5F8FC',
      bg: '#FFFFFF',
      'bg-alt': '#FFF8E6',
      border: '#DCE5F0',
      'border-strong': '#B7C7DB',
      accent: '#2F8CFF',
      'accent-bg': 'rgba(47, 140, 255, 0.12)',
      'accent-border': 'rgba(47, 140, 255, 0.45)',
      danger: '#E35D6A',
      success: '#43A778',
      warning: '#F59E0B',
      'user-bubble': '#FFF1B8',
      'assistant-bubble': '#F2F7FF',
      'code-bg': '#EFF4FA',
      'titlebar-bg': '#FFFFFF',
      'sidebar-bg': '#F7FAFE',
      'input-bg': '#FFFFFF',
      'hover-bg': '#EDF5FF',
      'selected-bg': '#DDEEFF',
      'focus-ring': '#60A5FA',
      yellow: '#FFD54A',
      orange: '#FF9F1C',
      navy: '#0B2A5B',
      blue: '#2F8CFF',
      cream: '#FFF3D6',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    description: "CodyChat's default dark look — same duck, after dark.",
    scheme: 'dark',
    // A real dark *companion* to Light, not just "some dark palette" —
    // same accent hue (blue, brightened for dark-bg contrast), same
    // brand constants, same semantic tokens. Yellow stays reserved for
    // mascot/highlight moments rather than becoming the primary accent,
    // matching the original design brief this pack is built from.
    //
    // user-bubble is deliberately a near-white fill (not the warm-gold
    // glow this started as) so it reads clearly apart from the dark
    // assistant-bubble — which is exactly why user-bubble-text needs its
    // own dark value here rather than the shared --text-h: text-h is a
    // pale near-white tuned for reading on *dark* surfaces, and would go
    // nearly illegible against this now-light one. See index.css for the
    // --user-bubble-text/--assistant-bubble-text split this motivated.
    font: "'M PLUS Rounded 1c', 'Quicksand', 'Nunito Sans', system-ui, sans-serif",
    vars: {
      text: '#8FA3C4',
      'text-h': '#EAF2FF',
      'root-bg': '#0B1830',
      bg: '#122544',
      'bg-alt': '#182A4E',
      border: 'rgba(96, 165, 250, 0.25)',
      'border-strong': 'rgba(96, 165, 250, 0.4)',
      accent: '#5AA9FF',
      'accent-bg': 'rgba(90, 169, 255, 0.16)',
      'accent-border': 'rgba(90, 169, 255, 0.5)',
      danger: '#FF7A87',
      success: '#5BC79A',
      warning: '#FFC24D',
      'user-bubble': 'rgba(254, 254, 249, 0.86)',
      'user-bubble-text': '#0a3272',
      'assistant-bubble': '#16294B',
      'code-bg': '#0E1E3A',
      'titlebar-bg': '#0E1E3A',
      'sidebar-bg': '#132542',
      'input-bg': '#142744',
      'hover-bg': '#1A2E56',
      'selected-bg': 'rgba(90, 169, 255, 0.22)',
      'focus-ring': '#5AA9FF',
      yellow: '#FFD54A',
      orange: '#FF9F1C',
      navy: '#0B2A5B',
      blue: '#2F8CFF',
      cream: '#FFF3D6',
    },
  },
  {
    id: 'psycho-duck',
    name: 'Psycho Duck',
    author: 'MeanSquares',
    description: "Confused about its own colors. Do not ask.",
    scheme: 'light',
    // Extra-mascot-y and a little unhinged, matching the joke framing —
    // the chaotic counterpart to Cody Duck's polished version below.
    font: "'Fredoka', 'Quicksand', system-ui, sans-serif",
    // Panel fills bumped to near-opaque (was ~0.78-0.85, matching the
    // "translucent so packs pick up Mica" plan). Real Mica/Acrylic still
    // doesn't render (see Kanban backlog) — the window falls back to a
    // raw black surface with no compositing, so those low-alpha yellows
    // were blending against black instead of glass, reading as muddy and
    // dark rather than the intended bright pastel. Not a hypothetical:
    // user-confirmed live, "dark colors and bad backgrounds". Kept a
    // sliver of translucency (0.96-0.97, not 1) so this still picks up
    // real glass the moment that investigation resolves; accent-bg/
    // accent-border are unaffected on purpose — those render as tinted
    // overlays on top of an already-opaque panel, not against raw window
    // background, so they were never part of this problem.
    vars: {
      text: '#5d5533',
      'text-h': '#241d05',
      bg: 'rgba(255, 246, 199, 0.96)',
      'bg-alt': 'rgba(250, 238, 176, 0.97)',
      border: 'rgba(199, 173, 84, 0.9)',
      'code-bg': 'rgba(247, 236, 158, 0.96)',
      accent: '#a87c00',
      'accent-bg': 'rgba(255, 196, 0, 0.22)',
      'accent-border': 'rgba(168, 124, 0, 0.6)',
      danger: '#c2452e',
      'user-bubble': 'rgba(255, 214, 71, 0.96)',
      'assistant-bubble': 'rgba(250, 238, 176, 0.96)',
      'root-bg': '#faeeb0',
    },
  },
  {
    id: 'hextech',
    name: 'League Hextech',
    author: 'MeanSquares',
    description: 'Hextech gold on the dark-navy League of Legends client blue.',
    scheme: 'dark',
    // Rebuilt from the actual LoL client palette (deep navy #0A1428 +
    // Hextech gold #C8AA6E, with the signature teal #0AC8B9 as a
    // secondary highlight) — the previous version used an off-brand
    // purple/orange combo that wasn't really Hextech at all. Also
    // explicitly sets every semantic surface token (sidebar-bg,
    // titlebar-bg, hover-bg, selected-bg, focus-ring) instead of relying
    // on the generic bg-alt/accent-bg fallback chain — the sidebar in
    // particular gets its own distinct navy shade so it reads as a
    // separated panel rather than blending into the main pane, matching
    // the "sidebar as a game menu panel" chrome direction from the Cody
    // Duck pass.
    vars: {
      text: '#A09B8C',
      'text-h': '#F0E6D2',
      'root-bg': '#0A1428',
      bg: '#0A1428',
      'bg-alt': '#091428',
      border: 'rgba(200, 170, 110, 0.35)',
      'border-strong': 'rgba(200, 170, 110, 0.55)',
      'code-bg': '#060E1C',
      accent: '#C8AA6E',
      'accent-bg': 'rgba(200, 170, 110, 0.16)',
      'accent-border': 'rgba(200, 170, 110, 0.5)',
      danger: '#E84057',
      success: '#0AC8B9',
      warning: '#F0B232',
      'user-bubble': 'rgba(200, 170, 110, 0.22)',
      'assistant-bubble': '#0F2440',
      'titlebar-bg': '#091428',
      'sidebar-bg': '#0A1F3D',
      'input-bg': '#0A1F3D',
      'hover-bg': '#132A4D',
      'selected-bg': 'rgba(200, 170, 110, 0.22)',
      'focus-ring': '#C8AA6E',
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
// A font-family value: quoted/unquoted names, commas, spaces, hyphens.
// Same untrusted-input posture as COLOR_RE — this gets injected into a
// <style> block, so anything with { } ; < > or backslashes is rejected
// outright rather than sanitized, and length is capped against a pack
// that tries to smuggle something absurd in.
const FONT_RE = /^[a-zA-Z0-9 ,'"()-]{1,200}$/;

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
  if (typeof obj.font === 'string' && FONT_RE.test(obj.font.trim())) pack.font = obj.font.trim();
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

const FONT_OVERRIDE_KEY = 'ollama-ui:font-override';

// A user-set font always wins over whatever the active pack specifies —
// separate from theme packs entirely (survives switching packs) since the
// actual problem this solves is "the fonts packs ask for aren't installed
// on this machine," which isn't a per-pack concern. Applied as an inline
// style on <html> in applyFontOverride below, which beats any stylesheet
// rule (including a pack's injected :root[data-theme] one) regardless of
// specificity math, guaranteeing it always wins without needing to touch
// the theme-pack injection logic at all.
// Tolerates a trailing ';' since that's a completely natural thing to type
// after a CSS font-family value (copy-pasted from a stylesheet, muscle
// memory) — without this, FONT_RE rejects it outright and the override
// silently no-ops with zero feedback to the user.
export function normalizeFontValue(font: string): string {
  return font.trim().replace(/;+\s*$/, '');
}

export function loadFontOverride(): string | null {
  return localStorage.getItem(FONT_OVERRIDE_KEY);
}

export function saveFontOverride(font: string | null): void {
  const normalized = font ? normalizeFontValue(font) : '';
  if (normalized) {
    localStorage.setItem(FONT_OVERRIDE_KEY, normalized);
  } else {
    localStorage.removeItem(FONT_OVERRIDE_KEY);
  }
}

export function applyFontOverride(font: string | null): void {
  const normalized = font ? normalizeFontValue(font) : '';
  if (normalized && FONT_RE.test(normalized)) {
    document.documentElement.style.setProperty('--sans', normalized);
  } else {
    document.documentElement.style.removeProperty('--sans');
  }
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
  const font = pack.font ? `\n  --sans: ${pack.font};` : '';
  getThemeStyleElement().textContent = `:root[data-theme="${pack.id}"] {\n${decls}${scheme}${font}\n}`;
}

/**
 * Reads a pack file from disk through the Rust shell (commands.rs) rather
 * than a webview file input — the frontend doesn't touch the disk itself,
 * consistent with the skills layer.
 */
export async function readThemePackFile(path: string): Promise<string> {
  return invoke<string>('read_theme_pack', { path });
}
