/**
 * Agent Sidebar - Discord-like agent list
 */
import { useAgentStore } from '../store/agents';
import type { Agent } from '../types';

interface AgentAvatarProps {
  agent: Agent;
  size?: 'sm' | 'md' | 'lg';
  showStatus?: boolean;
}

function AgentAvatar({ agent, size = 'md', showStatus = true }: AgentAvatarProps) {
  const sizeClasses = {
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
  };

  const statusColors = {
    shell: 'bg-dark-500',
    configured: 'bg-yellow-500',
    active: 'bg-green-500',
    error: 'bg-red-500',
  };

  return (
    <div className="relative">
      <div
        className={`${sizeClasses[size]} rounded-full overflow-hidden ring-2 ring-dark-700`}
        style={{ backgroundColor: agent.color }}
      >
        {agent.avatar ? (
          <img
            src={agent.avatar}
            alt={agent.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white font-bold">
            {agent.name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      {showStatus && (
        <div
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-dark-900 ${statusColors[agent.status]}`}
          title={agent.status}
        />
      )}
    </div>
  );
}

interface AgentListItemProps {
  agent: Agent;
  isActive: boolean;
  onClick: () => void;
}

function AgentListItem({ agent, isActive, onClick }: AgentListItemProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left ${
        isActive
          ? 'bg-dark-700 text-white'
          : 'text-dark-300 hover:bg-dark-800 hover:text-dark-100'
      }`}
    >
      <AgentAvatar agent={agent} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{agent.name}</div>
        <div className="text-xs text-dark-500 truncate">
          {agent.status === 'shell' && 'Unconfigured'}
          {agent.status === 'configured' && `${agent.secrets.filter(s => s.isSet).length} secrets`}
          {agent.status === 'active' && 'Active'}
          {agent.status === 'error' && 'Error'}
        </div>
      </div>
    </button>
  );
}

interface AgentSidebarProps {
  className?: string;
  onClose?: () => void;
}

export function AgentSidebar({ className, onClose }: AgentSidebarProps) {
  const { agents, activeAgentId, createAgent, setActiveAgent, isLoading, error } = useAgentStore();

  const handleCreateAgent = async () => {
    try {
      await createAgent();
    } catch (e) {
      // Error is already set in store
      console.error('Failed to create agent:', e);
    }
  };

  const handleSelectAgent = (agentId: string) => {
    setActiveAgent(agentId);
    onClose?.();
  };

  return (
    <div className={`w-72 lg:w-64 bg-dark-900 border-r border-dark-700 flex flex-col h-full ${className || ''}`}>
      {/* Header */}
      <div className="p-4 border-b border-dark-700">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-dark-100">Agents</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreateAgent}
              disabled={isLoading}
              className={`w-8 h-8 flex items-center justify-center rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors ${
                isLoading ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              title="Create new agent"
            >
              {isLoading ? (
                <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="w-5 h-5"
                >
                  <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                </svg>
              )}
            </button>
            {/* Close button - only on mobile */}
            {onClose && (
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors lg:hidden"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {error && (
          <div className="mt-2 text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">
            {error}
          </div>
        )}
      </div>

      {/* Agent List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {isLoading && agents.length === 0 ? (
          <div className="text-center py-8 text-dark-500">
            <svg className="w-6 h-6 animate-spin mx-auto mb-2" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-sm">Loading agents...</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-8 text-dark-500">
            <p className="text-sm">No agents yet</p>
            <button
              onClick={handleCreateAgent}
              disabled={isLoading}
              className="mt-2 text-primary-400 hover:text-primary-300 text-sm disabled:opacity-50"
            >
              Create your first agent
            </button>
          </div>
        ) : (
          agents.map((agent) => (
            <AgentListItem
              key={agent.id}
              agent={agent}
              isActive={agent.id === activeAgentId}
              onClick={() => handleSelectAgent(agent.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export { AgentAvatar };
