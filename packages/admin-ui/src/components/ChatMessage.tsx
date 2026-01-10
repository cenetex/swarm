import ReactMarkdown from 'react-markdown';
import type { ChatMessage as ChatMessageType } from '../types';

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-primary-600 text-white rounded-br-md'
            : 'bg-dark-800 text-dark-100 rounded-bl-md'
        }`}
      >
        {message.isLoading ? (
          <div className="typing-indicator flex gap-1 py-2">
            <span className="w-2 h-2 bg-dark-400 rounded-full"></span>
            <span className="w-2 h-2 bg-dark-400 rounded-full"></span>
            <span className="w-2 h-2 bg-dark-400 rounded-full"></span>
          </div>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
        <div
          className={`text-xs mt-2 ${
            isUser ? 'text-primary-200' : 'text-dark-500'
          }`}
        >
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      </div>
    </div>
  );
}
