import { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from './store';
import { sendChatMessage } from './api';
import { ChatMessage, ChatInput, Header } from './components';

function App() {
  const {
    messages,
    isLoading,
    error,
    addMessage,
    updateMessage,
    removeMessage,
    setLoading,
    setError,
    clearMessages,
  } = useChatStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = useCallback(
    async (content: string) => {
      // Add user message
      addMessage({ role: 'user', content });

      // Add loading message
      addMessage({
        role: 'assistant',
        content: '',
        isLoading: true,
      });

      setLoading(true);
      setError(null);

      try {
        // Build history for API (exclude loading message)
        const history = messages
          .filter((m) => m.id !== 'welcome' && !m.isLoading)
          .map((m) => ({
            role: m.role,
            content: m.content,
          }));

        // Add the current user message
        history.push({ role: 'user', content });

        // Call API
        const response = await sendChatMessage(content, history);

        // Find and update loading message
        const loadingMessage = useChatStore.getState().messages.find(m => m.isLoading);
        if (loadingMessage) {
          updateMessage(loadingMessage.id, {
            content: response.response,
            isLoading: false,
          });
        }
      } catch (err) {
        // Remove loading message
        const loadingMessage = useChatStore.getState().messages.find(m => m.isLoading);
        if (loadingMessage) {
          removeMessage(loadingMessage.id);
        }

        const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
        setError(errorMessage);

        // Add error message as assistant response
        addMessage({
          role: 'assistant',
          content: `❌ **Error:** ${errorMessage}\n\nPlease try again or check your connection.`,
        });
      } finally {
        setLoading(false);
      }
    },
    [messages, addMessage, updateMessage, removeMessage, setLoading, setError]
  );

  return (
    <div className="h-screen flex flex-col bg-dark-950">
      <Header onClear={clearMessages} />

      {/* Chat area */}
      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto">
          {messages.map((message) => (
            <ChatMessage key={message.id} message={message} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Error banner */}
      {error && (
        <div className="bg-red-900/50 border-t border-red-700 px-4 py-2 text-center text-sm text-red-200">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 text-red-400 hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Input area */}
      <footer className="border-t border-dark-700 bg-dark-900/80 backdrop-blur-sm px-4 py-4">
        <div className="max-w-3xl mx-auto">
          <ChatInput onSend={handleSendMessage} disabled={isLoading} />
        </div>
      </footer>
    </div>
  );
}

export default App;
