import { useState, useEffect } from 'react';
import { useAgentStore } from './store';
import { AgentSidebar, AgentConfigModal, ChatPanel } from './components';
import type { Agent } from './types';

function App() {
  const { agents, createAgent } = useAgentStore();
  const [configAgent, setConfigAgent] = useState<Agent | null>(null);

  // Create initial agent if none exist
  useEffect(() => {
    if (agents.length === 0) {
      createAgent('Swarm Assistant');
    }
  }, [agents.length, createAgent]);

  return (
    <div className="h-screen flex bg-dark-950">
      {/* Sidebar */}
      <AgentSidebar onConfigureAgent={setConfigAgent} />

      {/* Main Chat Area */}
      <ChatPanel onConfigureAgent={setConfigAgent} />

      {/* Config Modal */}
      {configAgent && (
        <AgentConfigModal
          agent={configAgent}
          isOpen={!!configAgent}
          onClose={() => setConfigAgent(null)}
        />
      )}
    </div>
  );
}

export default App;

