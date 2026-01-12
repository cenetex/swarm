import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentStore } from './store';
import { AgentSidebar, AgentLogsPanel, ChatPanel } from './components';

function getLogsAgentId(pathname: string): string | null {
  const match = pathname.match(/^\/agents\/([^/]+)\/logs\/?$/);
  return match?.[1] || null;
}

function getInhabitAgentId(pathname: string): string | null {
  const match = pathname.match(/^\/inhabit\/([^/]+)\/?$/);
  return match?.[1] || null;
}

function App() {
  const { agents, fetchAgents, activeAgentId, syncChatHistory, setActiveAgent, addMessage } = useAgentStore();
  const [initialized, setInitialized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [logsAgentId, setLogsAgentId] = useState<string | null>(
    () => getLogsAgentId(window.location.pathname)
  );
  const [inhabitAgentId, setInhabitAgentId] = useState<string | null>(
    () => getInhabitAgentId(window.location.pathname)
  );
  const [pendingInhabitPrompt, setPendingInhabitPrompt] = useState(Boolean(inhabitAgentId));

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
      const sync = async () => {
        // Always sync from backend - it's the source of truth for cross-device
        await syncChatHistory(activeAgentId).catch(console.error);

        if (pendingInhabitPrompt && inhabitAgentId === activeAgentId) {
          addMessage(activeAgentId, {
            role: 'assistant',
            content: JSON.stringify({
              action: 'inhabit_agent',
              agentId: activeAgentId,
              label: 'Inhabit this agent',
              message: 'Tap to inhabit this agent with your wallet.',
            }),
          });
          setPendingInhabitPrompt(false);
          setInhabitAgentId(null);
        }
      };

      sync();
    }
  }, [
    activeAgentId,
    initialized,
    isLogsRoute,
    syncChatHistory,
    pendingInhabitPrompt,
    inhabitAgentId,
    addMessage,
  ]);

  // Close sidebar when agent is selected on mobile
  useEffect(() => {
    if (activeAgentId) {
      setSidebarOpen(false);
    }
  }, [activeAgentId]);

  useEffect(() => {
    const handlePopState = () => {
      setLogsAgentId(getLogsAgentId(window.location.pathname));
      const nextInhabitAgentId = getInhabitAgentId(window.location.pathname);
      setInhabitAgentId(nextInhabitAgentId);
      setPendingInhabitPrompt(Boolean(nextInhabitAgentId));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!initialized || !inhabitAgentId) return;
    const hasAgent = agents.some((agent) => agent.id === inhabitAgentId);
    if (hasAgent && activeAgentId !== inhabitAgentId) {
      setActiveAgent(inhabitAgentId);
    }
  }, [agents, activeAgentId, inhabitAgentId, initialized, setActiveAgent]);

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
    <div className="h-[100dvh] flex flex-col bg-[var(--color-bg)] relative">
      {/* Safe area spacer for iOS status bar */}
      <div 
        className="flex-shrink-0 bg-[var(--color-bg-secondary)]" 
        style={{ height: 'env(safe-area-inset-top, 0px)' }} 
      />
      
      {/* Main content area */}
      <div className="flex-1 flex min-h-0 relative">
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
        `}
          style={{ top: 'env(safe-area-inset-top, 0px)' }}
        >
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
      
      {/* Safe area spacer for iOS home indicator */}
      <div 
        className="flex-shrink-0 bg-[var(--color-bg)]" 
        style={{ height: 'env(safe-area-inset-bottom, 0px)' }} 
      />
    </div>
  );
}

export default App;
