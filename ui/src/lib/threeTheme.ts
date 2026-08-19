import * as THREE from 'three';
import { useEffect, useState } from 'react';

// Extracted from MemoryGraphView.tsx so a second Three.js view (spatial chat
// history) can reuse the exact same theme-aware color reading instead of
// copy-pasting it a second time.

export function readCssColor(varName: string, fallback: string): THREE.Color {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  try {
    return new THREE.Color(value || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

// Real bug hit live: colors read via readCssColor were only ever computed
// once (useMemo with no real dependency on theme state), so switching
// themes (applyThemePack sets a data-theme attribute + injects a fresh
// <style> tag — see lib/themes.ts) never updated anything already rendered
// in a WebGL scene, unlike every other themed surface in this app which
// picks up CSS var changes automatically through the normal cascade. A
// MutationObserver on <html>'s attributes is the actual mechanism themes
// change through, so it's what this bumps a version off of — anything
// memoizing a readCssColor() call should depend on this number.
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return version;
}
