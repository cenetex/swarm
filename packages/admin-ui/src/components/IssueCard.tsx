/**
 * IssueCard - Expandable issue display component for the logs panel
 */
import { useMemo } from 'react';
import type { AgentIssue } from '../api/issues';

interface IssueCardProps {
  issue: AgentIssue;
  isExpanded: boolean;
  onToggle: () => void;
  isActive?: boolean;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function getSeverityColor(severity: AgentIssue['severity']): string {
  switch (severity) {
    case 'critical': return 'text-red-400 bg-red-500/20 border-red-500/40';
    case 'high': return 'text-orange-400 bg-orange-500/20 border-orange-500/40';
    case 'medium': return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/40';
    case 'low': return 'text-blue-400 bg-blue-500/20 border-blue-500/40';
    default: return 'text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] border-[var(--color-border)]';
  }
}

function getSeverityBadgeColor(severity: AgentIssue['severity']): string {
  switch (severity) {
    case 'critical': return 'bg-red-500/30 text-red-300';
    case 'high': return 'bg-orange-500/30 text-orange-300';
    case 'medium': return 'bg-yellow-500/30 text-yellow-300';
    case 'low': return 'bg-blue-500/30 text-blue-300';
    default: return 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]';
  }
}

export function IssueCard({ issue, isExpanded, onToggle, isActive }: IssueCardProps) {
  const severityColor = useMemo(() => getSeverityColor(issue.severity), [issue.severity]);
  const badgeColor = useMemo(() => getSeverityBadgeColor(issue.severity), [issue.severity]);

  return (
    <div 
      className={`border-2 rounded-lg overflow-hidden transition-all ${severityColor} ${isActive ? 'ring-2 ring-brand-500' : ''}`}
      data-issue-id={issue.id}
    >
      {/* Header - always visible */}
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-start gap-3 text-left hover:bg-white/5 transition-colors"
      >
        {/* Expand indicator */}
        <svg 
          className={`w-4 h-4 mt-0.5 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none" 
          viewBox="0 0 24 24" 
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>

        {/* Issue icon */}
        <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium uppercase ${badgeColor}`}>
              {issue.severity}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
              {issue.category}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]">
              {issue.platform}
            </span>
          </div>
          <h4 className="font-medium mt-1 text-sm">{issue.title}</h4>
          {!isExpanded && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
              {issue.description}
            </p>
          )}
        </div>

        <span className="text-xs text-[var(--color-text-muted)] flex-shrink-0 whitespace-nowrap">
          {formatTimestamp(issue.timestamp)}
        </span>
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="border-t border-current/20 px-4 py-3 space-y-3 bg-black/20">
          {/* Description */}
          <div>
            <h5 className="text-xs font-medium text-[var(--color-text-tertiary)] uppercase mb-1">Description</h5>
            <p className="text-sm text-[var(--color-text)]">{issue.description}</p>
          </div>

          {/* User message that triggered the issue */}
          {issue.userMessage && (
            <div>
              <h5 className="text-xs font-medium text-[var(--color-text-tertiary)] uppercase mb-1">User Message</h5>
              <p className="text-sm text-[var(--color-text)] bg-[var(--color-bg-tertiary)] rounded px-2 py-1.5 font-mono">
                "{issue.userMessage}"
              </p>
            </div>
          )}

          {/* Context details */}
          {issue.context && Object.keys(issue.context).length > 0 && (
            <div>
              <h5 className="text-xs font-medium text-[var(--color-text-tertiary)] uppercase mb-1">Context</h5>
              <pre className="text-xs text-[var(--color-text)] bg-[var(--color-bg)] rounded p-2 overflow-x-auto max-h-[200px] overflow-y-auto">
                {JSON.stringify(issue.context, null, 2)}
              </pre>
            </div>
          )}

          {/* Metadata */}
          <div className="flex flex-wrap gap-4 text-xs text-[var(--color-text-muted)]">
            <span>ID: <code className="text-[var(--color-text-secondary)]">{issue.id}</code></span>
            {issue.logStream && (
              <span className="truncate max-w-[300px]" title={issue.logStream}>
                Stream: <code className="text-[var(--color-text-secondary)]">{issue.logStream.split('/').pop()}</code>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface IssueNavigationProps {
  issues: AgentIssue[];
  currentIndex: number;
  onNavigate: (index: number) => void;
}

export function IssueNavigation({ issues, currentIndex, onNavigate }: IssueNavigationProps) {
  if (issues.length === 0) return null;

  const currentIssue = issues[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < issues.length - 1;

  return (
    <div className="flex items-center gap-2 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded-lg px-3 py-2">
      <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      
      <span className="text-xs text-[var(--color-text-secondary)]">
        Issue {currentIndex + 1} of {issues.length}
      </span>

      {currentIssue && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium uppercase ${getSeverityBadgeColor(currentIssue.severity)}`}>
          {currentIssue.severity}
        </span>
      )}

      <div className="flex-1" />

      <button
        onClick={() => onNavigate(currentIndex - 1)}
        disabled={!hasPrev}
        className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Previous issue"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <button
        onClick={() => onNavigate(currentIndex + 1)}
        disabled={!hasNext}
        className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Next issue"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
