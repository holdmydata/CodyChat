import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Conversation } from '../types';

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  /** Generates a short topic label from the conversation's own content and applies it as the new title — see lib/subject.ts. */
  onGenerateSubject: (id: string) => Promise<void>;
}

export function Sidebar({ conversations, activeId, onSelect, onNew, onDelete, onRename, onGenerateSubject }: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Per-row in-flight tracking (a Set, not a single id) — nothing stops a
  // user from clicking generate on two different rows before the first
  // finishes, and each should show its own spinner independently.
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());

  const handleGenerateSubject = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (generatingIds.has(id)) return;
    setGeneratingIds((prev) => new Set(prev).add(id));
    try {
      await onGenerateSubject(id);
    } catch (err) {
      // Non-fatal by design, same posture as this app's other best-effort
      // background calls (e.g. notifyIfHidden in useChat.ts) — a failed
      // label generation shouldn't be able to break anything else, the
      // button just re-enables for another try.
      console.error('generateSubject failed:', err);
    } finally {
      setGeneratingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const startEditing = (c: Conversation) => {
    setEditingId(c.id);
    setDraft(c.title);
  };

  const commitEdit = () => {
    if (editingId && draft.trim()) {
      onRename(editingId, draft.trim());
    }
    setEditingId(null);
  };

  return (
    <aside className="sidebar">
      <button className="sidebar__new" onClick={onNew}>
        + New chat
      </button>
      <ul className="sidebar__list">
        {conversations.map((c) => (
          <li
            key={c.id}
            className={`sidebar__item ${c.id === activeId ? 'sidebar__item--active' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            {editingId === c.id ? (
              <input
                className="sidebar__item-title-input"
                value={draft}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit();
                  if (e.key === 'Escape') setEditingId(null);
                }}
              />
            ) : (
              <span
                className="sidebar__item-title"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startEditing(c);
                }}
                title="Double-click to rename"
              >
                {c.title}
              </span>
            )}
            <button
              className={`sidebar__item-subject${generatingIds.has(c.id) ? ' sidebar__item-subject--busy' : ''}`}
              onClick={(e) => handleGenerateSubject(e, c.id)}
              disabled={generatingIds.has(c.id) || c.messages.length === 0}
              aria-label="Generate a topic label for this conversation's title"
              title="Generate a topic label from this conversation"
            >
              <Sparkles size={13} />
            </button>
            <button
              className="sidebar__item-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
              aria-label="Delete conversation"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
