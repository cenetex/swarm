import ReactMarkdown from 'react-markdown';
import type { ChatMessage as ChatMessageType } from '../types';
import { ToolPrompt } from './ToolPrompts';

interface ChatMessageProps {
  message: ChatMessageType;
  onToolSubmit?: (toolCallId: string, result: unknown) => void;
}

/**
 * Extract image URLs from tool call results
 */
function extractImagesFromToolCalls(toolCalls?: ChatMessageType['toolCalls']): string[] {
  if (!toolCalls) return [];

  const images: string[] = [];

  for (const tc of toolCalls) {
    if (tc.result && typeof tc.result === 'object') {
      const result = tc.result as Record<string, unknown>;
      // Check for image URL in result - any URL from successful generation
      if (result.url && typeof result.url === 'string') {
        // Include URLs that are images (by extension or by being from our CDN/S3)
        const url = result.url as string;
        const isImage = url.includes('.png') || url.includes('.jpg') ||
                        url.includes('.webp') || url.includes('.jpeg') ||
                        url.includes('/images/') || url.includes('cloudfront.net') ||
                        url.includes('s3.amazonaws.com');
        if (isImage) {
          images.push(url);
        }
      }
      // Check for gallery items
      if (Array.isArray(result.items)) {
        for (const item of result.items) {
          if (item && typeof item === 'object' && 'url' in item && typeof item.url === 'string') {
            images.push(item.url);
          }
        }
      }
    }
  }

  return images;
}

export function ChatMessage({ message, onToolSubmit }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const hasPendingTools = message.toolCalls?.some(tc => tc.status === 'pending');
  const images = extractImagesFromToolCalls(message.toolCalls);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 lg:mb-4`}>
      <div
        className={`max-w-[90%] sm:max-w-[85%] lg:max-w-[80%] rounded-2xl px-3 lg:px-4 py-2.5 lg:py-3 ${
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
            
            {/* Render generated images inline */}
            {images.length > 0 && (
              <div className={`grid gap-2 ${message.content ? 'mt-3' : ''} ${
                images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
              }`}>
                {images.slice(0, 4).map((url, idx) => (
                  <a 
                    key={idx} 
                    href={url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="block rounded-lg overflow-hidden hover:opacity-90 transition-opacity"
                  >
                    <img 
                      src={url} 
                      alt={`Generated image ${idx + 1}`}
                      className="w-full h-auto max-h-64 object-cover"
                      loading="lazy"
                    />
                  </a>
                ))}
              </div>
            )}
            
            {/* Render tool prompts inline */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className={`space-y-3 ${message.content || images.length > 0 ? 'mt-3' : ''}`}>
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
