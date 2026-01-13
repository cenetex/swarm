/**
 * Agent Logs Panel - Consolidated log view for a single agent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchAgentLogs, type AgentLogEvent } from '../api/logs';
import { fetchAgentIssues, type AgentIssue } from '../api/issues';
import { useActiveAgent, useAgentStore } from '../store/agents';
import { AgentAvatar } from './AgentSidebar';
import { IssueCard, IssueNavigation } from './IssueCard';

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

/**
 * Parse and extract useful info from a log message
 */
function parseLogMessage(message: string): {
  level?: string;
  subsystem?: string;
  event?: string;
  json?: Record<string, unknown>;
  text: string;
  isIssue?: boolean;
  issueData?: {
    severity: string;
    title: string;
    category: string;
  };
} {
  // Lambda logs often have format: "2026-01-11T00:41:56.500Z requestId INFO {...}"
  // Try to find and extract JSON from the message
  const jsonMatch = message.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed === 'object' && parsed !== null) {
        const isIssue = parsed.event === 'agent_reported_issue';
        return {
          level: typeof parsed.level === 'string' ? parsed.level.toUpperCase() : undefined,
          subsystem: parsed.subsystem,
          event: parsed.event,
          json: parsed,
          text: message,
          isIssue,
          issueData: isIssue && parsed.issue ? {
            severity: parsed.issue.severity || 'medium',
            title: parsed.issue.title || 'Issue',
            category: parsed.issue.category || 'unknown',
          } : undefined,
        };
      }
    } catch {
      // Not valid JSON
    }
  }
  
  // Try to parse whole message as JSON
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed === 'object' && parsed !== null) {
      const isIssue = parsed.event === 'agent_reported_issue';
      return {
        level: typeof parsed.level === 'string' ? parsed.level.toUpperCase() : undefined,
        subsystem: parsed.subsystem,
        event: parsed.event,
        json: parsed,
        text: message,
        isIssue,
        issueData: isIssue && parsed.issue ? {
          severity: parsed.issue.severity || 'medium',
          title: parsed.issue.title || 'Issue',
          category: parsed.issue.category || 'unknown',
        } : undefined,
      };
    }
  } catch {
    // Not JSON
  }
  
  // Try to extract level from text like "INFO", "ERROR", etc.
  const levelMatch = message.match(/\b(ERROR|WARN|INFO|DEBUG)\b/i);
  return {
    level: levelMatch?.[1]?.toUpperCase(),
    text: message,
  };
}

/**
 * Get color classes for log level
 */
function getLevelColor(level?: string): string {
  switch (level?.toUpperCase()) {
    case 'ERROR': return 'text-red-400 bg-red-500/10';
    case 'WARN': return 'text-yellow-400 bg-yellow-500/10';
    case 'INFO': return 'text-blue-400 bg-blue-500/10';
    case 'DEBUG': return 'text-[var(--color-text-tertiary)] bg-[var(--color-bg-tertiary)]';
    default: return 'text-[var(--color-text-secondary)] bg-[var(--color-bg-elevated)]';
  }
}

/**
 * Compact JSON display - shows only subsystem and event for collapsed view
 */
function CompactJsonView({ json }: { json: Record<string, unknown> }) {
  const subsystem = typeof json.subsystem === 'string' ? json.subsystem : null;
  const event = typeof json.event === 'string' ? json.event : null;
  
  if (!subsystem && !event) {
    return <span className="text-[var(--color-text-tertiary)] text-xs">—</span>;
  }
  
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      {subsystem && (
        <span className="px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">{subsystem}</span>
      )}
      {event && (
        <span className="px-1.5 py-0.5 rounded bg-brand-900/50 text-brand-300">{event}</span>
      )}
    </div>
  );
}

/**
 * Get severity badge color
 */
function getSeverityBadgeColor(severity?: string): string {
  switch (severity) {
    case 'critical': return 'bg-red-500/30 text-red-300';
    case 'high': return 'bg-orange-500/30 text-orange-300';
    case 'medium': return 'bg-yellow-500/30 text-yellow-300';
    case 'low': return 'bg-blue-500/30 text-blue-300';
    default: return 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]';
  }
}

interface LogEntryProps {
  event: AgentLogEvent;
  linkedIssue?: AgentIssue;
  isActiveIssue?: boolean;
}

/**
 * Single log entry component with expand/collapse
 */
function LogEntry({ event, linkedIssue, isActiveIssue }: LogEntryProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const parsed = useMemo(() => parseLogMessage(event.message || ''), [event.message]);
  
  // If this is an issue log entry and we have a linked issue, show special styling
  const isIssueEntry = parsed.isIssue && linkedIssue;
  
  return (
    <div 
      className={`border rounded-lg overflow-hidden transition-all ${
        isIssueEntry 
          ? `border-2 ${isActiveIssue ? 'border-yellow-400 ring-2 ring-yellow-400/30' : 'border-yellow-500/50'} bg-yellow-500/5`
          : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]/70'
      }`}
      data-log-timestamp={event.timestamp}
      data-is-issue={isIssueEntry ? 'true' : undefined}
    >
      {/* Header row - always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-2 py-1.5 flex items-center gap-2 text-left hover:bg-[var(--color-bg-tertiary)]/50 transition-colors"
      >
        {/* Expand indicator */}
        <svg 
          className={`w-3 h-3 text-[var(--color-text-muted)] flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none" 
          viewBox="0 0 24 24" 
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        
        {/* Level badge */}
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 min-w-[45px] text-center ${getLevelColor(parsed.level)}`}>
          {parsed.level || '?'}
        </span>
        
        {/* Subsystem + Event */}
        <div className="flex-1 min-w-0">
          {isIssueEntry && parsed.issueData ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className={`px-1.5 py-0.5 rounded-full font-medium uppercase ${getSeverityBadgeColor(parsed.issueData.severity)}`}>
                {parsed.issueData.severity}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                {parsed.issueData.category}
              </span>
              <span className="text-yellow-300 font-medium truncate">
                {parsed.issueData.title}
              </span>
            </div>
          ) : parsed.json ? (
            <CompactJsonView json={parsed.json} />
          ) : (
            <span className="text-xs text-[var(--color-text-tertiary)] truncate block">
              {parsed.text.slice(0, 60)}{parsed.text.length > 60 ? '...' : ''}
            </span>
          )}
        </div>

        {/* Issue indicator icon */}
        {isIssueEntry && (
          <svg className="w-4 h-4 text-yellow-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        )}
        
        {/* Timestamp - hidden on very small screens */}
        <span className="text-[10px] text-[var(--color-text-muted)] flex-shrink-0 hidden sm:block">
          {formatTimestamp(event.timestamp)}
        </span>
      </button>

      {/* Issue card when expanded and linked to an issue */}
      {isExpanded && linkedIssue && (
        <div className="border-t border-yellow-500/30 p-3 bg-yellow-500/5">
          <IssueCard 
            issue={linkedIssue} 
            isExpanded={true}
            onToggle={() => {}}
            isActive={isActiveIssue}
          />
        </div>
      )}
      
      {/* Expanded details (for non-issue entries or to show raw log) */}
      {isExpanded && (
        <div className={`border-t px-3 py-2 space-y-2 ${linkedIssue ? 'border-yellow-500/30' : 'border-[var(--color-border)]'}`}>
          {/* Log group/stream info */}
          <div className="text-xs text-[var(--color-text-muted)] flex flex-wrap gap-3">
            {event.logGroup && (
              <span className="truncate max-w-full" title={event.logGroup}>
                <span className="text-[var(--color-text-quaternary)]">Group:</span> {event.logGroup.split('/').pop()}
              </span>
            )}
            {event.logStream && (
              <span className="truncate max-w-[200px]" title={event.logStream}>
                <span className="text-[var(--color-text-quaternary)]">Stream:</span> {event.logStream.slice(0, 20)}...
              </span>
            )}
          </div>
          
          {/* Full message */}
          <details className="group">
            <summary className="text-xs text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)]">
              {linkedIssue ? 'Show raw log' : 'Full message'}
            </summary>
            <pre className="mt-2 text-xs text-[var(--color-text)] whitespace-pre-wrap break-all overflow-x-auto max-h-[400px] overflow-y-auto bg-[var(--color-bg)] rounded p-2">
              {parsed.json ? JSON.stringify(parsed.json, null, 2) : parsed.text}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

export function AgentLogsPanel({ agentId, onMenuClick, onBack }: AgentLogsPanelProps) {
  const activeAgent = useActiveAgent();
  const { setActiveAgent } = useAgentStore();
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const [since, setSince] = useState(DEFAULT_SINCE);
  const [level, setLevel] = useState('');
  const [subsystem, setSubsystem] = useState('');
  const [query, setQuery] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({
    since: DEFAULT_SINCE,
    level: '',
    subsystem: '',
    query: '',
  });
  const [logs, setLogs] = useState<AgentLogEvent[]>([]);
  const [logGroups, setLogGroups] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Issue state
  const [issues, setIssues] = useState<AgentIssue[]>([]);
  const [currentIssueIndex, setCurrentIssueIndex] = useState(0);
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);

  useEffect(() => {
    if (agentId) {
      setActiveAgent(agentId);
    }
  }, [agentId, setActiveAgent]);

  const filters = useMemo(() => ({
    since: appliedFilters.since,
    level: appliedFilters.level || undefined,
    subsystem: appliedFilters.subsystem || undefined,
    query: appliedFilters.query || undefined,
  }), [appliedFilters]);

  // Map issues to their log timestamps for linking
  const issueByTimestamp = useMemo(() => {
    const map = new Map<string, AgentIssue>();
    for (const issue of issues) {
      // Create a key from the issue timestamp
      const isoTimestamp = new Date(issue.timestamp).toISOString();
      map.set(isoTimestamp, issue);
    }
    return map;
  }, [issues]);

  // Find linked issue for a log event
  const findLinkedIssue = useCallback((event: AgentLogEvent): AgentIssue | undefined => {
    if (!event.timestamp) return undefined;
    
    // Try exact match first
    const direct = issueByTimestamp.get(event.timestamp);
    if (direct) return direct;
    
    // Check if the log message contains agent_reported_issue
    const parsed = parseLogMessage(event.message || '');
    if (parsed.isIssue && parsed.json) {
      // Find matching issue by timestamp in the JSON
      const issueTimestamp = (parsed.json as Record<string, unknown>).timestamp as string;
      if (issueTimestamp) {
        return issueByTimestamp.get(issueTimestamp);
      }
      // Fallback: match by event timestamp
      const eventTs = new Date(event.timestamp).getTime();
      for (const issue of issues) {
        // Allow 5 second tolerance
        if (Math.abs(issue.timestamp - eventTs) < 5000) {
          return issue;
        }
      }
    }
    return undefined;
  }, [issueByTimestamp, issues]);

  const loadLogs = useCallback(async () => {
    if (!agentId) return;
    setIsLoading(true);
    setError(null);

    try {
      const [logsResponse, issuesResponse] = await Promise.all([
        fetchAgentLogs(agentId, filters),
        fetchAgentIssues(agentId, { limit: 50 }),
      ]);
      setLogs(logsResponse.events || []);
      setLogGroups(logsResponse.logGroups || []);
      setIssues(issuesResponse.issues || []);
      
      // Auto-expand the latest issue
      if (issuesResponse.issues?.length > 0) {
        setExpandedIssueId(issuesResponse.issues[0].id);
        setCurrentIssueIndex(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setIsLoading(false);
    }
  }, [agentId, filters]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // Navigate to issue and scroll to corresponding log
  const handleIssueNavigate = useCallback((index: number) => {
    if (index < 0 || index >= issues.length) return;
    
    const issue = issues[index];
    setCurrentIssueIndex(index);
    setExpandedIssueId(issue.id);
    
    // Find and scroll to the log entry with this issue
    if (logsContainerRef.current) {
      const issueTimestamp = new Date(issue.timestamp).toISOString();
      const logElement = logsContainerRef.current.querySelector(
        `[data-is-issue="true"][data-log-timestamp="${issueTimestamp}"]`
      ) || logsContainerRef.current.querySelector('[data-is-issue="true"]');
      
      if (logElement) {
        logElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [issues]);

  const applyFilters = useCallback(() => {
    setAppliedFilters({
      since,
      level,
      subsystem,
      query,
    });
  }, [level, query, since, subsystem]);

  return (
    <div className="flex-1 flex flex-col h-full bg-[var(--color-bg)]">
      <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 lg:px-6 py-3 lg:py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 lg:gap-4 min-w-0">
            <button
              onClick={onMenuClick}
              className="w-10 h-10 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
              </svg>
            </button>
            {activeAgent && <AgentAvatar agent={activeAgent} size="md" />}
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-[var(--color-text)] truncate">
                {activeAgent?.name || agentId} logs
              </h1>
              <p className="text-xs text-[var(--color-text-tertiary)] truncate">
                {logGroups.length} log group{logGroups.length === 1 ? '' : 's'} queried
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onBack && (
              <button
                onClick={onBack}
                className="px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] text-xs font-medium transition-colors"
              >
                Back to chat
              </button>
            )}
            <button
              onClick={loadLogs}
              className="px-3 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-medium transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <div className="border-b border-[var(--color-border)] px-4 lg:px-6 py-3 bg-[var(--color-bg-secondary)]">
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-secondary)]">
          <label className="flex items-center gap-2">
            <span className="text-[var(--color-text-tertiary)]">Since</span>
            <select
              value={since}
              onChange={(event) => setSince(event.target.value)}
              className="bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-md px-2 py-1 text-[var(--color-text)]"
            >
              <option value="15m">15m</option>
              <option value="30m">30m</option>
              <option value="1h">1h</option>
              <option value="6h">6h</option>
              <option value="24h">24h</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[var(--color-text-tertiary)]">Level</span>
            <input
              value={level}
              onChange={(event) => setLevel(event.target.value)}
              placeholder="error, warn"
              className="bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-md px-2 py-1 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[var(--color-text-tertiary)]">Subsystem</span>
            <input
              value={subsystem}
              onChange={(event) => setSubsystem(event.target.value)}
              placeholder="telegram-webhook"
              className="bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-md px-2 py-1 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
            />
          </label>
          <label className="flex items-center gap-2 flex-1 min-w-[200px]">
            <span className="text-[var(--color-text-tertiary)]">Query</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="text search"
              className="w-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-md px-2 py-1 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
            />
          </label>
          <button
            onClick={applyFilters}
            className="px-3 py-1.5 rounded-md bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text)] transition-colors"
          >
            Apply
          </button>
        </div>
      </div>

      {/* Issue navigation bar */}
      {issues.length > 0 && (
        <div className="border-b border-[var(--color-border)] px-4 lg:px-6 py-2 bg-yellow-500/5">
          <IssueNavigation
            issues={issues}
            currentIndex={currentIssueIndex}
            onNavigate={handleIssueNavigate}
          />
        </div>
      )}

      <div ref={logsContainerRef} className="flex-1 overflow-y-auto px-4 lg:px-6 py-4 space-y-2">
        {isLoading && (
          <div className="text-[var(--color-text-tertiary)] text-sm">Loading logs…</div>
        )}
        {error && (
          <div className="text-sm text-red-400 bg-red-900/20 border border-red-900/40 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        {!isLoading && !error && logs.length === 0 && (
          <div className="text-[var(--color-text-tertiary)] text-sm">No log events found.</div>
        )}
        {logs.map((event, index) => {
          const linkedIssue = findLinkedIssue(event);
          const isActiveIssue = linkedIssue?.id === expandedIssueId;
          return (
            <LogEntry 
              key={`${event.logStream || 'stream'}-${index}`} 
              event={event}
              linkedIssue={linkedIssue}
              isActiveIssue={isActiveIssue}
            />
          );
        })}
      </div>
    </div>
  );
}
