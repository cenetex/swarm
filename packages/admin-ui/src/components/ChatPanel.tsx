/**
 * Chat Panel - Main chat area for active agent
 */
import { useEffect, useRef, useCallback } from 'react';
import { useAgentStore, useActiveAgent, useActiveChat } from '../store/agents';
import { sendChatMessage } from '../api';
import { ChatMessage as ChatMessageComponent } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { AgentAvatar } from './AgentSidebar';
import type { Agent } from '../types';

interface ChatPanelProps {
  onConfigureAgent?: (agent: Agent) => void;
}

export function ChatPanel({ onConfigureAgent }: ChatPanelProps) {
  const activeAgent = useActiveAgent();
  const messages = useActiveChat();
  const { addMessage, updateMessage, removeMessage, clearChat, isLoading, setLoading, setError } = useAgentStore();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!activeAgent) return;

      // Add user message
      addMessage(activeAgent.id, { role: 'user', content });

      // Add loading message
      addMessage(activeAgent.id, {
        role: 'assistant',
        content: '',
        isLoading: true,
      });

      setLoading(true);
      setError(null);

      try {
        // Build history for API
        const history = messages
          .filter((m) => m.id !== 'welcome' && !m.isLoading)
          .map((m) => ({
            role: m.role,
            content: m.content,
          }));

        history.push({ role: 'user', content });

        // Send to API
        const response = await sendChatMessage(content, history);

        // Update the loading message with the response
        const currentMessages = useAgentStore.getState().chats[activeAgent.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          updateMessage(activeAgent.id, loadingMessage.id, {
            content: response.response,
            isLoading: false,
          });
        }
      } catch (error) {
        const currentMessages = useAgentStore.getState().chats[activeAgent.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          removeMessage(activeAgent.id, loadingMessage.id);
        }

        const errorMsg = error instanceof Error ? error.message : 'Failed to send message';
        setError(errorMsg);
        addMessage(activeAgent.id, {
          role: 'assistant',
          content: `❌ **Error:** ${errorMsg}\n\nPlease try again or check the agent configuration.`,
        });
      } finally {
        setLoading(false);
      }
    },
    [activeAgent, messages, addMessage, updateMessage, removeMessage, setLoading, setError]
  );

  if (!activeAgent) {
    return (
      <div className="flex-1 flex items-center justify-center bg-dark-950">
        <div className="text-center">
          <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-dark-800 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-12 h-12 text-dark-600">
              <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clipRule="evenodd" />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-dark-300 mb-2">No Agent Selected</h3>
          <p className="text-dark-500 mb-4">Create or select an agent to start chatting</p>
          <button
            onClick={() => useAgentStore.getState().createAgent()}
            className="px-6 py-3 bg-primary-600 hover:bg-primary-500 text-white rounded-xl font-medium transition-colors"
          >
            Create Your First Agent
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-dark-950">
      {/* Agent Header */}
      <header className="bg-dark-900/80 backdrop-blur-sm border-b border-dark-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <AgentAvatar agent={activeAgent} size="md" />
            <div>
              <h1 className="text-lg font-semibold text-dark-100">{activeAgent.name}</h1>
              <p className="text-xs text-dark-400">
                {activeAgent.status === 'shell' && 'Shell agent - configure to unlock full capabilities'}
                {activeAgent.status === 'configured' && `${activeAgent.secrets.filter(s => s.isSet).length} secrets configured`}
                {activeAgent.status === 'active' && 'Active and ready'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => clearChat(activeAgent.id)}
              className="px-3 py-1.5 text-sm text-dark-400 hover:text-dark-200 hover:bg-dark-800 rounded-lg transition-colors"
            >
              Clear Chat
            </button>
            <button
              onClick={() => onConfigureAgent?.(activeAgent)}
              className="px-3 py-1.5 text-sm text-primary-400 hover:text-primary-300 hover:bg-dark-800 rounded-lg transition-colors flex items-center gap-1"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              Configure
            </button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((message) => (
            <ChatMessageComponent key={message.id} message={message} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-dark-700 bg-dark-900/80 backdrop-blur-sm px-6 py-4">
        <div className="max-w-3xl mx-auto">
          <ChatInput onSend={handleSendMessage} disabled={isLoading} />
        </div>
      </div>
    </div>
  );
}
