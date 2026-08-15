import { useState } from 'react';
import type { Conversation } from '../types';

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

export function Sidebar({ conversations, activeId, onSelect, onNew, onDelete, onRename }: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

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
