import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  BUILTIN_THEMES,
  loadCustomThemes,
  readThemePackFile,
  sanitizeThemePack,
  saveCustomThemes,
  type ThemePack,
} from '../lib/themes';

interface ThemePickerProps {
  activeId: string;
  onSelect: (id: string) => void;
}

function swatchStyle(pack: ThemePack): CSSProperties | undefined {
  if (pack.id === 'auto') return undefined; // the --auto class draws the split swatch
  const accent = pack.vars.accent ?? pack.vars['accent-bg'] ?? '#888888';
  const bg = pack.vars.bg ?? 'transparent';
  // Pack colors are translucent by design (they sit over the app's glass
  // backdrop), but the swatch itself sits inside the *currently active*
  // theme's menu background — previewing another pack's translucent bg
  // raw picks up whatever's active right now instead of that pack's own
  // color (e.g. Light's swatch reads muddy gray while Dark is active).
  // Give every swatch a fixed, scheme-matched backdrop so it always shows
  // its own true color.
  const backdrop = pack.scheme === 'dark' ? '#1c1d24' : '#f5f4f7';
  return {
    backgroundColor: backdrop,
    backgroundImage: `linear-gradient(135deg, ${accent} 50%, ${bg} 50%)`,
  };
}

function ThemeRow({
  pack,
  active,
  onSelect,
  onDelete,
}: {
  pack: ThemePack;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const title = [pack.description, pack.author ? `by ${pack.author}` : null]
    .filter(Boolean)
    .join(' — ');
  return (
    <div className="theme-picker__row">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={active}
        title={title || undefined}
        className={`theme-picker__select${active ? ' theme-picker__select--active' : ''}`}
        onClick={() => onSelect(pack.id)}
      >
        <span
          className={`theme-picker__swatch${pack.id === 'auto' ? ' theme-picker__swatch--auto' : ''}`}
          style={swatchStyle(pack)}
        />
        <span className="theme-picker__name">{pack.name}</span>
        {active && <span className="theme-picker__check">✓</span>}
      </button>
      {onDelete && (
        <button
          type="button"
          className="theme-picker__delete"
          title="Remove this pack"
          onClick={() => onDelete(pack.id)}
        >
          ×
        </button>
      )}
    </div>
  );
}

interface ThemePickerMenuProps extends ThemePickerProps {
  /** True when rendered inline in the Settings menu rather than as a popover. */
  embedded?: boolean;
}

// The picker's actual content (built-ins, imported packs, import controls) —
// factored out so it can be rendered two ways: as a popover from the
// titlebar 🎨 button (quick access, see ThemePicker below) and inline as a
// full section of the Settings menu (a proper home for it, not just a
// dropdown). Both read/write the same localStorage-backed custom-theme list.
export function ThemePickerMenu({ activeId, onSelect, embedded = false }: ThemePickerMenuProps) {
  const [customThemes, setCustomThemes] = useState<ThemePack[]>(loadCustomThemes);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importFromText = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setImportError(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const { pack, error } = sanitizeThemePack(parsed);
    if (!pack || error) {
      setImportError(error ?? "Couldn't import that pack.");
      return;
    }
    const next = [...customThemes];
    const i = next.findIndex((t) => t.id === pack.id);
    if (i >= 0) next[i] = pack;
    else next.push(pack);
    saveCustomThemes(next);
    setCustomThemes(next);
    setImportError(null);
    setPasteOpen(false);
    setPasteText('');
    // Apply immediately so the import shows its result (menu stays open so
    // the new row is visible right next to the built-ins).
    onSelect(pack.id);
  };

  const handleImportFile = async () => {
    const path = fileInputRef.current?.value;
    if (fileInputRef.current) fileInputRef.current.value = ''; // allow re-picking the same file
    if (!path) return;
    setImportError(null);
    try {
      importFromText(await readThemePackFile(path));
    } catch (err) {
      setImportError(String(err));
    }
  };

  const handleDelete = (id: string) => {
    const next = customThemes.filter((t) => t.id !== id);
    saveCustomThemes(next);
    setCustomThemes(next);
    if (id === activeId) onSelect('auto'); // don't strand the app on a deleted pack
  };

  return (
    <div
      className={`theme-picker__menu${embedded ? ' theme-picker__menu--embedded' : ''}`}
      role={embedded ? undefined : 'menu'}
      aria-label={embedded ? undefined : 'Theme packs'}
    >
      <div className="theme-picker__section-label">Theme</div>
      {BUILTIN_THEMES.map((pack) => (
        <ThemeRow key={pack.id} pack={pack} active={pack.id === activeId} onSelect={onSelect} />
      ))}
      {customThemes.length > 0 && (
        <>
          <div className="theme-picker__section-label">Imported packs</div>
          {customThemes.map((pack) => (
            <ThemeRow
              key={pack.id}
              pack={pack}
              active={pack.id === activeId}
              onSelect={onSelect}
              onDelete={handleDelete}
            />
          ))}
        </>
      )}
      <div className="theme-picker__divider" />
      <button type="button" className="theme-picker__action" onClick={() => setPasteOpen((v) => !v)}>
        {pasteOpen ? 'Hide paste import' : 'Paste pack JSON'}
      </button>
      <button type="button" className="theme-picker__action" onClick={handleImportFile}>
        Import pack file…
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={handleImportFile}
      />
      {importError && <div className="theme-picker__error">{importError}</div>}
      {pasteOpen && (
        <div className="theme-picker__paste">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={4}
            placeholder='{"id":"my-pack","name":"My Pack","author":"…","vars":{"accent":"#00aaff"}}'
          />
          <div className="theme-picker__paste-actions">
            <button type="button" onClick={() => importFromText(pasteText)} disabled={!pasteText.trim()}>
              Import
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Titlebar quick-access popover — a thin wrapper around ThemePickerMenu that
// adds the 🎨 toggle button and open/close (outside-click, Escape) behavior.
export function ThemePicker({ activeId, onSelect }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="theme-picker" ref={menuRef}>
      <button
        type="button"
        className="titlebar__theme-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme"
      >
        🎨
      </button>
      {open && <ThemePickerMenu activeId={activeId} onSelect={onSelect} />}
    </div>
  );
}
