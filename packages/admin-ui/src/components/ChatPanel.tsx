/**
 * Chat Panel - Main chat area for active agent
 */
import { useEffect, useRef, useCallback } from 'react';
import { useAgentStore, useActiveAgent, useActiveChat } from '../store/agents';
import { sendChatMessage, saveAgentSecret } from '../api';
import { ChatMessage as ChatMessageComponent } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { AgentAvatar } from './AgentSidebar';

interface ChatPanelProps {
  onMenuClick?: () => void;
}

export function ChatPanel({ onMenuClick }: ChatPanelProps) {
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

        // Send to API with agent context
        const response = await sendChatMessage(content, history, {
          id: activeAgent.id,
          name: activeAgent.name,
          description: activeAgent.description,
          persona: activeAgent.persona,
        });

        // Update the loading message with the response
        const currentMessages = useAgentStore.getState().chats[activeAgent.id] || [];
        const loadingMessage = currentMessages.find((m) => m.isLoading);
        if (loadingMessage) {
          // Check if there's a pending tool call that needs user input
          const pendingToolCall = response.pendingToolCall;
          updateMessage(activeAgent.id, loadingMessage.id, {
            content: response.response,
            isLoading: false,
            // Add tool call for rendering if there's a pending one
            toolCalls: pendingToolCall ? [{
              id: pendingToolCall.id,
              name: pendingToolCall.name,
              arguments: pendingToolCall.arguments,
              status: 'pending' as const,
            }] : undefined,
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
      <div className="flex-1 flex items-center justify-center bg-dark-950 p-4">
        <div className="text-center">
          {/* Mobile menu button */}
          <button
            onClick={onMenuClick}
            className="mb-6 w-12 h-12 mx-auto flex items-center justify-center rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors lg:hidden"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
              <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
            </svg>
          </button>
          <div className="w-20 h-20 lg:w-24 lg:h-24 mx-auto mb-4 lg:mb-6 rounded-full bg-dark-800 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 lg:w-12 lg:h-12 text-dark-600">
              <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clipRule="evenodd" />
            </svg>
          </div>
          <h3 className="text-lg lg:text-xl font-semibold text-dark-300 mb-2">No Agent Selected</h3>
          <p className="text-sm lg:text-base text-dark-500 mb-4">Create or select an agent to start chatting</p>
          <button
            onClick={() => useAgentStore.getState().createAgent()}
            className="px-4 lg:px-6 py-2.5 lg:py-3 bg-primary-600 hover:bg-primary-500 text-white rounded-xl font-medium transition-colors text-sm lg:text-base"
          >
            Create Your First Agent
          </button>
        </div>
      </div>
    );
  }

  // Handle tool submissions (secrets, confirmations, uploads, etc.)
  const handleToolSubmit = useCallback(
    async (toolCallId: string, result: unknown) => {
      if (!activeAgent) return;

      const resultObj = result as Record<string, unknown>;
      
      // Update the tool call status in the message
      const updateToolCallStatus = () => {
        const currentMessages = useAgentStore.getState().chats[activeAgent.id] || [];
        for (const msg of currentMessages) {
          const toolCall = msg.toolCalls?.find(tc => tc.id === toolCallId);
          if (toolCall) {
            updateMessage(activeAgent.id, msg.id, {
              toolCalls: msg.toolCalls?.map(tc => 
                tc.id === toolCallId 
                  ? { ...tc, status: 'completed' as const, result }
                  : tc
              ),
            });
            break;
          }
        }
      };

      // Handle secret submission
      if (resultObj.secretKey && resultObj.value) {
        try {
          await saveAgentSecret(activeAgent.id, resultObj.secretKey as string, resultObj.value as string);
          updateToolCallStatus();
          
          // Send a follow-up message to let the agent know the secret was stored
          const followUpContent = `I've entered my ${(resultObj.secretKey as string).replace(/_/g, ' ')}.`;
          await handleSendMessage(followUpContent);
          
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to save secret';
          setError(errorMsg);
        }
        return;
      }

      // Handle image upload completion
      if (resultObj.success && resultObj.s3Key && resultObj.publicUrl) {
        try {
          updateToolCallStatus();
          
          // Send a follow-up message to let the agent know the upload completed
          const category = resultObj.category ? ` ${resultObj.category}` : '';
          const filename = resultObj.filename ? ` (${resultObj.filename})` : '';
          const followUpContent = `I've uploaded the${category} image${filename}. The s3Key is "${resultObj.s3Key}" and publicUrl is "${resultObj.publicUrl}". Please save it to my reference images.`;
          await handleSendMessage(followUpContent);
          
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to process upload';
          setError(errorMsg);
        }
        return;
      }

      // Handle confirmation response
      if ('confirmed' in resultObj) {
        updateToolCallStatus();
        const followUpContent = resultObj.confirmed ? 'Yes, proceed.' : 'No, cancel that.';
        await handleSendMessage(followUpContent);
        return;
      }

      // Generic tool result - just update status
      updateToolCallStatus();
    },
    [activeAgent, updateMessage, setError, handleSendMessage]
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-dark-950">
      {/* Agent Header */}
      <header className="bg-dark-900/80 backdrop-blur-sm border-b border-dark-700 px-4 lg:px-6 py-3 lg:py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 lg:gap-4">
            {/* Hamburger menu - mobile only */}
            <button
              onClick={onMenuClick}
              className="w-10 h-10 flex items-center justify-center rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 hover:text-white transition-colors lg:hidden"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
              </svg>
            </button>
            <AgentAvatar agent={activeAgent} size="md" />
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-dark-100 truncate">{activeAgent.name}</h1>
              <p className="text-xs text-dark-400 truncate hidden sm:block">
                {activeAgent.status === 'shell' && 'Shell agent - configure to unlock full capabilities'}
                {activeAgent.status === 'configured' && `${activeAgent.secrets.filter(s => s.isSet).length} secrets configured`}
                {activeAgent.status === 'active' && 'Active and ready'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => clearChat(activeAgent.id)}
              className="px-2 lg:px-3 py-1.5 text-xs lg:text-sm text-dark-400 hover:text-dark-200 hover:bg-dark-800 rounded-lg transition-colors"
            >
              <span className="hidden sm:inline">Clear Chat</span>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 sm:hidden">
                <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 lg:px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((message) => (
            <ChatMessageComponent 
              key={message.id} 
              message={message} 
              onToolSubmit={handleToolSubmit}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-dark-700 bg-dark-900/80 backdrop-blur-sm px-3 lg:px-6 py-3 lg:py-4">
        <div className="max-w-3xl mx-auto">
          <ChatInput onSend={handleSendMessage} disabled={isLoading} />
        </div>
      </div>
    </div>
  );
}
