import { useState, type KeyboardEvent } from 'react';

interface MessageInputProps {
  disabled: boolean;
  isStreaming: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}

export function MessageInput({ disabled, isStreaming, onSend, onStop }: MessageInputProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    // The Send button already hides itself while streaming, but Enter in
    // the textarea bypassed that — letting a new message fire a second,
    // concurrent sendMessage() while the first was still suspended
    // awaiting tool approval, orphaning the pending prompt on screen.
    if (!value.trim() || isStreaming) return;
    onSend(value);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="message-input">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message the model… (Enter to send, Shift+Enter for newline)"
        disabled={disabled}
        rows={3}
      />
      {isStreaming ? (
        <button className="message-input__stop" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="message-input__send" onClick={submit} disabled={disabled || !value.trim()}>
          Send
        </button>
      )}
    </div>
  );
}
