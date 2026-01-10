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
}

export function AgentSidebar({ className }: AgentSidebarProps) {
  const { agents, activeAgentId, createAgent, setActiveAgent } = useAgentStore();

  const handleCreateAgent = () => {
    createAgent();
  };

  return (
    <div className={`w-64 bg-dark-900 border-r border-dark-700 flex flex-col h-full ${className || ''}`}>
      {/* Header */}
      <div className="p-4 border-b border-dark-700">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-dark-100">Agents</h2>
          <button
            onClick={handleCreateAgent}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors"
            title="Create new agent"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-5 h-5"
            >
              <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Agent List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {agents.length === 0 ? (
          <div className="text-center py-8 text-dark-500">
            <p className="text-sm">No agents yet</p>
            <button
              onClick={handleCreateAgent}
              className="mt-2 text-primary-400 hover:text-primary-300 text-sm"
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
              onClick={() => setActiveAgent(agent.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export { AgentAvatar };
