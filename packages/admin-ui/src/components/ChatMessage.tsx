import ReactMarkdown from 'react-markdown';
import type { ChatMessage as ChatMessageType } from '../types';
import { ToolPrompt } from './ToolPrompts';

interface ChatMessageProps {
  message: ChatMessageType;
  onToolSubmit?: (toolCallId: string, result: unknown) => void;
}

export function ChatMessage({ message, onToolSubmit }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const hasPendingTools = message.toolCalls?.some(tc => tc.status === 'pending');

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
          <>
            {message.content && (
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            )}
            
            {/* Render tool prompts inline */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className={`space-y-3 ${message.content ? 'mt-3' : ''}`}>
                {message.toolCalls.map((toolCall) => (
                  <ToolPrompt
                    key={toolCall.id}
                    toolCall={toolCall}
                    onSubmit={onToolSubmit || (() => {})}
                    disabled={!onToolSubmit || toolCall.status !== 'pending'}
                  />
                ))}
              </div>
            )}
          </>
        )}
        
        {!message.isLoading && (
          <div
            className={`text-xs mt-2 ${
              isUser ? 'text-primary-200' : 'text-dark-500'
            }`}
          >
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {hasPendingTools && (
              <span className="ml-2 text-yellow-400">• Waiting for input</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
