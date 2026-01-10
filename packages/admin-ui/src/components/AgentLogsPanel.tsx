/**
 * Agent Logs Panel - Consolidated log view for a single agent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchAgentLogs, type AgentLogEvent } from '../api/logs';
import { useActiveAgent, useAgentStore } from '../store/agents';
import { AgentAvatar } from './AgentSidebar';

interface AgentLogsPanelProps {
  agentId: string;
  onMenuClick?: () => void;
  onBack?: () => void;
}

const DEFAULT_SINCE = '30m';

function formatTimestamp(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function AgentLogsPanel({ agentId, onMenuClick, onBack }: AgentLogsPanelProps) {
  const activeAgent = useActiveAgent();
  const { setActiveAgent } = useAgentStore();

  const [since, setSince] = useState(DEFAULT_SINCE);
  const [level, setLevel] = useState('');
  const [subsystem, setSubsystem] = useState('');
  const [query, setQuery] = useState('');
  const [logs, setLogs] = useState<AgentLogEvent[]>([]);
  const [logGroups, setLogGroups] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agentId) {
      setActiveAgent(agentId);
    }
  }, [agentId, setActiveAgent]);

  const filters = useMemo(() => ({
    since,
    level: level || undefined,
    subsystem: subsystem || undefined,
    query: query || undefined,
  }), [since, level, subsystem, query]);

  const loadLogs = useCallback(async () => {
    if (!agentId) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchAgentLogs(agentId, filters);
      setLogs(response.events || []);
      setLogGroups(response.logGroups || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setIsLoading(false);
    }
  }, [agentId, filters]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  return (
    <div className="flex-1 flex flex-col h-full bg-dark-950">
      <header className="bg-dark-900/80 backdrop-blur-sm border-b border-dark-700 px-4 lg:px-6 py-3 lg:py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 lg:gap-4 min-w-0">
            <button
              onClick={onMenuClick}
              className="w-10 h-10 flex items-center justify-center rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors lg:hidden"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
              </svg>
            </button>
            {activeAgent && <AgentAvatar agent={activeAgent} size="md" />}
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-dark-100 truncate">
                {activeAgent?.name || agentId} logs
              </h1>
              <p className="text-xs text-dark-400 truncate">
                {logGroups.length} log group{logGroups.length === 1 ? '' : 's'} queried
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                onClick={onBack}
                className="px-3 py-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-200 text-xs font-medium transition-colors"
              >
                Back to chat
              </button>
            )}
            <button
              onClick={loadLogs}
              className="px-3 py-2 rounded-lg bg-primary-600 hover:bg-primary-500 text-white text-xs font-medium transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <div className="border-b border-dark-800 px-4 lg:px-6 py-3 bg-dark-900">
        <div className="flex flex-wrap items-center gap-3 text-xs text-dark-300">
          <label className="flex items-center gap-2">
            <span className="text-dark-400">Since</span>
            <select
              value={since}
              onChange={(event) => setSince(event.target.value)}
              className="bg-dark-800 border border-dark-700 rounded-md px-2 py-1 text-dark-100"
            >
              <option value="15m">15m</option>
              <option value="30m">30m</option>
              <option value="1h">1h</option>
              <option value="6h">6h</option>
              <option value="24h">24h</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-dark-400">Level</span>
            <input
              value={level}
              onChange={(event) => setLevel(event.target.value)}
              placeholder="error, warn"
              className="bg-dark-800 border border-dark-700 rounded-md px-2 py-1 text-dark-100 placeholder:text-dark-500"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-dark-400">Subsystem</span>
            <input
              value={subsystem}
              onChange={(event) => setSubsystem(event.target.value)}
              placeholder="telegram-webhook"
              className="bg-dark-800 border border-dark-700 rounded-md px-2 py-1 text-dark-100 placeholder:text-dark-500"
            />
          </label>
          <label className="flex items-center gap-2 flex-1 min-w-[200px]">
            <span className="text-dark-400">Query</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="text search"
              className="w-full bg-dark-800 border border-dark-700 rounded-md px-2 py-1 text-dark-100 placeholder:text-dark-500"
            />
          </label>
          <button
            onClick={loadLogs}
            className="px-3 py-1.5 rounded-md bg-dark-700 hover:bg-dark-600 text-dark-100 transition-colors"
          >
            Apply
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 lg:px-6 py-4 space-y-3">
        {isLoading && (
          <div className="text-dark-400 text-sm">Loading logs…</div>
        )}
        {error && (
          <div className="text-sm text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        {!isLoading && !error && logs.length === 0 && (
          <div className="text-dark-400 text-sm">No log events found.</div>
        )}
        {logs.map((event, index) => (
          <div key={`${event.logStream || 'stream'}-${index}`} className="border border-dark-800 rounded-lg bg-dark-900/70">
            <div className="px-3 py-2 border-b border-dark-800 text-xs text-dark-400 flex flex-wrap gap-3">
              <span>{formatTimestamp(event.timestamp)}</span>
              {event.logGroup && <span className="text-dark-500">{event.logGroup}</span>}
              {event.logStream && <span className="text-dark-600">{event.logStream}</span>}
            </div>
            <pre className="text-xs text-dark-100 whitespace-pre-wrap px-3 py-2">
              {event.message || ''}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
