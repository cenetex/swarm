import { useEffect } from 'react';
import { useAgentStore } from './store';
import { AgentSidebar, ChatPanel } from './components';

function App() {
  const { agents, createAgent } = useAgentStore();

  // Create initial agent if none exist
  useEffect(() => {
    if (agents.length === 0) {
      createAgent('Swarm Assistant');
    }
  }, [agents.length, createAgent]);

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

