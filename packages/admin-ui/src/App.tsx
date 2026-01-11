import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentStore } from './store';
import { AgentSidebar, AgentLogsPanel, ChatPanel } from './components';

function getLogsAgentId(pathname: string): string | null {
  const match = pathname.match(/^\/agents\/([^/]+)\/logs\/?$/);
  return match?.[1] || null;
}

function App() {
  const { fetchAgents, activeAgentId, syncChatHistory } = useAgentStore();
  const [initialized, setInitialized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [logsAgentId, setLogsAgentId] = useState<string | null>(
    () => getLogsAgentId(window.location.pathname)
  );

  const isLogsRoute = useMemo(() => Boolean(logsAgentId), [logsAgentId]);

  // Fetch agents from backend on mount
  useEffect(() => {
    if (!initialized) {
      fetchAgents()
        .catch(console.error)
        .finally(() => setInitialized(true));
    }
  }, [initialized, fetchAgents]);

  // Sync chat history from backend when agent is selected
  // ALWAYS sync on agent change to ensure cross-device consistency
  useEffect(() => {
    if (activeAgentId && initialized && !isLogsRoute) {
      // Always sync from backend - it's the source of truth for cross-device
      syncChatHistory(activeAgentId).catch(console.error);
    }
  }, [activeAgentId, initialized, isLogsRoute, syncChatHistory]);

  // Close sidebar when agent is selected on mobile
  useEffect(() => {
    if (activeAgentId) {
      setSidebarOpen(false);
    }
  }, [activeAgentId]);

  useEffect(() => {
    const handlePopState = () => {
      setLogsAgentId(getLogsAgentId(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const openLogs = useCallback((agentId: string) => {
    const nextPath = `/agents/${agentId}/logs`;
    window.history.pushState({}, '', nextPath);
    setLogsAgentId(agentId);
  }, []);

  const openChat = useCallback(() => {
    window.history.pushState({}, '', '/');
    setLogsAgentId(null);
  }, []);

  return (
    <div className="h-screen flex bg-[var(--color-bg)] relative">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - hidden on mobile unless toggled */}
      <div className={`
        fixed lg:relative inset-y-0 left-0 z-30 
        transform transition-transform duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <AgentSidebar onClose={() => setSidebarOpen(false)} />
      </div>

      {/* Main Chat Area */}
      {isLogsRoute && logsAgentId ? (
        <AgentLogsPanel
          agentId={logsAgentId}
          onMenuClick={() => setSidebarOpen(true)}
          onBack={openChat}
        />
      ) : (
        <ChatPanel
          onMenuClick={() => setSidebarOpen(true)}
          onOpenLogs={openLogs}
        />
      )}
    </div>
  );
}

export default App;
