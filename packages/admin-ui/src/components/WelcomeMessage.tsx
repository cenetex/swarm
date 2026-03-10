/**
 * WelcomeMessage — ephemeral onboarding prompt for new avatars.
 *
 * Rendered as a fake assistant bubble with tappable action chips.
 * Disappears once the avatar has any real messages.
 */

interface WelcomeMessageProps {
  avatarName: string;
  onAction: (text: string) => void;
}

const ACTION_CHIPS = [
  'Set a personality',
  'Connect Telegram',
  'Generate a profile image',
] as const;

export function WelcomeMessage({ avatarName, onAction }: WelcomeMessageProps) {
  return (
    <div className="flex gap-3 items-start">
      {/* Bot avatar placeholder — matches ChatMessage assistant layout */}
      <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0">
        <svg
          className="w-5 h-5 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 10h.01M12 10h.01M16 10h.01M9 16h6M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </div>

      <div className="flex-1 min-w-0">
        {/* Bubble — same classes as an assistant ChatMessage */}
        <div className="rounded-2xl px-3 lg:px-4 py-2.5 lg:py-3 bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded-bl-md border border-[var(--color-border)]">
          <p className="text-sm leading-relaxed">
            Hi! I&apos;m <strong>{avatarName}</strong>, your avatar assistant.
            Here are some things to get started:
          </p>
        </div>

        {/* Action chips */}
        <div className="flex flex-wrap gap-2 mt-2">
          {ACTION_CHIPS.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => onAction(label)}
              className="text-sm px-3 py-1.5 rounded-full border border-brand-500/40 bg-brand-500/10 text-brand-400 hover:bg-brand-500/20 hover:border-brand-500/60 transition-colors cursor-pointer"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
