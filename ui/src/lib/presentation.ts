// App-level chat-history presentation setting — same relationship to
// ChatWindow's message-history region that theme packs (see lib/themes.ts)
// have to color/font: a swappable paradigm, not a per-conversation property.
// String-typed rather than a boolean specifically so a third mode can be
// added later without a storage/type redesign, even though only one
// alternative to 'flat' ships today.
export type PresentationMode = 'flat' | 'spatial';

const PRESENTATION_MODE_KEY = 'ollama-ui:presentation-mode';

export function getPresentationMode(): PresentationMode {
  return localStorage.getItem(PRESENTATION_MODE_KEY) === 'spatial' ? 'spatial' : 'flat';
}

export function setPresentationMode(mode: PresentationMode): void {
  localStorage.setItem(PRESENTATION_MODE_KEY, mode);
}
