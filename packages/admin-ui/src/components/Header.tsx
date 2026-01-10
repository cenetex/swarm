interface HeaderProps {
  onClear: () => void;
}

export function Header({ onClear }: HeaderProps) {
  return (
    <header className="bg-dark-800/80 backdrop-blur-sm border-b border-dark-700 px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/swarm.svg" alt="Swarm" className="w-8 h-8" />
          <div>
            <h1 className="text-lg font-semibold text-dark-100">Swarm Admin</h1>
            <p className="text-xs text-dark-400">Agent Configuration Console</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onClear}
            className="px-3 py-1.5 text-sm text-dark-400 hover:text-dark-200 hover:bg-dark-700 rounded-lg transition-colors"
          >
            Clear Chat
          </button>
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse-slow" title="Connected" />
        </div>
      </div>
    </header>
  );
}
