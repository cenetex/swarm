import { useEffect, useState } from 'react';
import { useAgentStore } from './store';
import { AgentSidebar, ChatPanel } from './components';

function App() {
  const { fetchAgents, activeAgentId, syncChatHistory } = useAgentStore();
  const [initialized, setInitialized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    if (activeAgentId && initialized) {
      // Always sync from backend - it's the source of truth for cross-device
      syncChatHistory(activeAgentId).catch(console.error);
    }
  }, [activeAgentId, initialized, syncChatHistory]);

  // Close sidebar when agent is selected on mobile
  useEffect(() => {
    if (activeAgentId) {
      setSidebarOpen(false);
    }
  }, [activeAgentId]);

  return (
    <div className="h-screen flex bg-dark-950 relative">
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
      <ChatPanel onMenuClick={() => setSidebarOpen(true)} />
    </div>
  );
}

export default App;

