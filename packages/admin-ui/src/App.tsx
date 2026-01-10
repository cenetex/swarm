import { useEffect, useState } from 'react';
import { useAgentStore } from './store';
import { AgentSidebar, ChatPanel } from './components';

function App() {
  const { agents, fetchAgents } = useAgentStore();
  const [initialized, setInitialized] = useState(false);

  // Fetch agents from backend on mount
  useEffect(() => {
    if (!initialized) {
      fetchAgents()
        .catch(console.error)
        .finally(() => setInitialized(true));
    }
  }, [initialized, fetchAgents]);

  return (
    <div className="h-screen flex bg-dark-950">
      {/* Sidebar */}
      <AgentSidebar />

      {/* Main Chat Area */}
      <ChatPanel />
    </div>
  );
}

export default App;

