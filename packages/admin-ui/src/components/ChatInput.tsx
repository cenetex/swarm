import { useState, useRef, FormEvent, KeyboardEvent } from 'react';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      setMessage('');
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleInput = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 lg:gap-3 items-end">
      <div className="flex-1 relative">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Type a message..."
          disabled={disabled}
          rows={1}
          className="w-full px-3 lg:px-4 py-2.5 lg:py-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl text-[var(--color-text)] placeholder-[var(--color-text-muted)] resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed max-h-36 text-sm lg:text-base"
        />
      </div>
      <button
        type="submit"
        disabled={disabled || !message.trim()}
        className="p-2.5 lg:px-6 lg:py-3 bg-brand-600 text-white rounded-xl font-medium hover:bg-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-[var(--color-bg)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="w-5 h-5"
        >
          <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
        </svg>
      </button>
    </form>
  );
}
