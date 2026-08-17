import { useEffect, useState, type KeyboardEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';

interface MessageInputProps {
  disabled: boolean;
  isStreaming: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// Folds attached paths into the actual outgoing message text — the model
// still needs the real absolute path to call read_file on it, this just
// keeps that path out of the visible/editable textarea, shown instead as a
// removable chip above it.
function withAttachments(text: string, attachments: string[]): string {
  if (attachments.length === 0) return text;
  const pathLines = attachments.join('\n');
  return text.trim() ? `${text}\n\n${pathLines}` : pathLines;
}

export function MessageInput({ disabled, isStreaming, onSend, onStop }: MessageInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  // Tauri's drag-drop event is window-scoped, not a per-element DOM drop
  // target — it fires wherever a file is dropped anywhere in the window,
  // with real absolute filesystem paths (something a browser's sandboxed
  // File API can't give you, but a native desktop webview can). The
  // message input is the only sensible place in this app to route a
  // dropped file's path into, so the listener lives here rather than at
  // some higher app-level component.
  useEffect(() => {
    // onDragDropEvent registers asynchronously (returns a Promise) — under
    // StrictMode's dev-mode double-effect-invocation, the first run's
    // cleanup can fire before that promise resolves, so `unlisten` is still
    // undefined when it runs and the first listener never actually gets
    // torn down. Real bug hit live: one file dropped, path inserted twice,
    // from two simultaneously-active listeners. Fixed with a `cancelled`
    // flag — if the promise resolves after cleanup already ran, unlisten
    // immediately instead of stashing a handle nothing will ever call.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'over') {
          setIsDragOver(true);
        } else if (event.payload.type === 'drop') {
          setIsDragOver(false);
          const paths = event.payload.paths;
          if (paths.length > 0) {
            setAttachments((prev) => [...prev, ...paths]);
          }
        } else {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleInsertFile = async () => {
    const selected = await open({ multiple: false });
    if (typeof selected === 'string') {
      setAttachments((prev) => [...prev, selected]);
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  };

  const submit = () => {
    // The Send button already hides itself while streaming, but Enter in
    // the textarea bypassed that — letting a new message fire a second,
    // concurrent sendMessage() while the first was still suspended
    // awaiting tool approval, orphaning the pending prompt on screen.
    if ((!value.trim() && attachments.length === 0) || isStreaming) return;
    onSend(withAttachments(value, attachments));
    setValue('');
    setAttachments([]);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={`message-input${isDragOver ? ' message-input--drag-over' : ''}`}>
      {attachments.length > 0 && (
        <div className="message-input__attachments">
          {attachments.map((path) => (
            <span key={path} className="message-input__attachment-chip" title={path}>
              📎 {basename(path)}
              <button
                type="button"
                className="message-input__attachment-remove"
                onClick={() => removeAttachment(path)}
                aria-label={`Remove ${basename(path)}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="message-input__row">
        <button
          type="button"
          className="message-input__insert-file"
          onClick={handleInsertFile}
          disabled={disabled}
          aria-label="Insert file"
          title="Insert file"
        >
          +
        </button>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the model… (drag a file in, or click + to insert one)"
          disabled={disabled}
          rows={1}
        />
        {isStreaming ? (
          <button className="message-input__stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            className="message-input__send"
            onClick={submit}
            disabled={disabled || (!value.trim() && attachments.length === 0)}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
