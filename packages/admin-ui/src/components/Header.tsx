interface HeaderProps {
  onClear: () => void;
}

export function Header({ onClear }: HeaderProps) {
  return (
    <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/swarm.svg" alt="Swarm" className="w-8 h-8" />
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-text)]">Swarm Admin</h1>
            <p className="text-xs text-[var(--color-text-tertiary)]">Agent Configuration Console</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onClear}
            className="px-3 py-1.5 text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
          >
            Clear Chat
          </button>
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse-slow" title="Connected" />
        </div>
      </div>
    </header>
  );
}
