import ReactMarkdown from 'react-markdown';
import { useMemo } from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { ToolPrompt } from './ToolPrompts';

interface ChatMessageProps {
  message: ChatMessageType;
  onToolSubmit?: (toolCallId: string, result: unknown) => void;
}

/**
 * Clean message content by removing raw JSON and extracting embedded images
 * LLMs sometimes include tool results as raw JSON in their responses
 */
function processMessageContent(content: string): { 
  cleanedContent: string; 
  embeddedImages: string[];
  embeddedData: Array<{ type: 'gallery' | 'jobs' | 'unknown'; items: unknown[] }>;
} {
  const embeddedImages: string[] = [];
  const embeddedData: Array<{ type: 'gallery' | 'jobs' | 'unknown'; items: unknown[] }> = [];
  
  // Match JSON arrays or objects in the content
  // This regex finds standalone JSON that looks like tool output
  let cleanedContent = content;
  
  // Pattern 1: JSON arrays (like gallery results or job lists)
  const jsonArrayPattern = /\n?\s*\[\s*\{[\s\S]*?\}\s*\]\s*\n?/g;
  const arrayMatches = content.match(jsonArrayPattern) || [];
  
  for (const match of arrayMatches) {
    try {
      const parsed = JSON.parse(match.trim());
      if (Array.isArray(parsed)) {
        // Check if it's a gallery (has url field)
        const hasUrls = parsed.some(item => item && typeof item === 'object' && 'url' in item);
        if (hasUrls) {
          embeddedData.push({ type: 'gallery', items: parsed });
          for (const item of parsed) {
            if (item?.url && typeof item.url === 'string') {
              embeddedImages.push(item.url);
            }
          }
        } else if (parsed.length === 0) {
          // Empty array, likely "no pending jobs" - just remove it
          embeddedData.push({ type: 'jobs', items: [] });
        } else {
          embeddedData.push({ type: 'unknown', items: parsed });
        }
        cleanedContent = cleanedContent.replace(match, '');
      }
    } catch {
      // Not valid JSON, leave it
    }
  }
  
  // Pattern 2: Single JSON objects (like image generation results)
  const jsonObjectPattern = /\n?\s*\{\s*"[^"]+"\s*:[\s\S]*?\}\s*\n?/g;
  const objectMatches = cleanedContent.match(jsonObjectPattern) || [];
  
  for (const match of objectMatches) {
    try {
      const parsed = JSON.parse(match.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Check if it has an image URL
        if (parsed.url && typeof parsed.url === 'string' && 
            (parsed.url.includes('.png') || parsed.url.includes('.jpg') || 
             parsed.url.includes('rati.chat') || parsed.url.includes('/images/'))) {
          embeddedImages.push(parsed.url);
          cleanedContent = cleanedContent.replace(match, '');
        }
      }
    } catch {
      // Not valid JSON, leave it
    }
  }
  
  // Clean up multiple newlines left after removal
  cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n').trim();
  
  return { cleanedContent, embeddedImages, embeddedData };
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
      // Support both 'url' and 'resultUrl' fields (from get_job_status)
      const url = (result.url || result.resultUrl) as string | undefined;
      if (url && typeof url === 'string') {
        // Include URLs that are images (by extension or by being from our CDN/S3)
        const isImage = url.includes('.png') || url.includes('.jpg') ||
                        url.includes('.webp') || url.includes('.jpeg') ||
                        url.includes('/images/') || url.includes('cloudfront.net') ||
                        url.includes('s3.amazonaws.com') || url.includes('rati.chat');
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

/**
 * Extract images from completed pending jobs
 */
function extractImagesFromPendingJobs(pendingJobs?: ChatMessageType['pendingJobs']): string[] {
  if (!pendingJobs) return [];
  return pendingJobs
    .filter(job => job.status === 'completed' && job.resultUrl)
    .map(job => job.resultUrl!)
    .filter(url => url.includes('.png') || url.includes('.jpg') || 
                   url.includes('.webp') || url.includes('.jpeg') ||
                   url.includes('/images/') || url.includes('rati.chat'));
}

/**
 * Get pending/processing jobs that should show status indicator
 */
function getActiveJobs(pendingJobs?: ChatMessageType['pendingJobs']) {
  if (!pendingJobs) return [];
  return pendingJobs.filter(job => job.status === 'pending' || job.status === 'processing');
}

/**
 * Get failed jobs that should show error
 */
function getFailedJobs(pendingJobs?: ChatMessageType['pendingJobs']) {
  if (!pendingJobs) return [];
  return pendingJobs.filter(job => job.status === 'failed');
}

export function ChatMessage({ message, onToolSubmit }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const hasPendingTools = message.toolCalls?.some(tc => tc.status === 'pending');
  
  // Process message content to extract embedded JSON and images
  const { cleanedContent, embeddedImages } = useMemo(
    () => message.content ? processMessageContent(message.content) : { cleanedContent: '', embeddedImages: [], embeddedData: [] },
    [message.content]
  );
  
  const imagesFromTools = extractImagesFromToolCalls(message.toolCalls);
  const imagesFromJobs = extractImagesFromPendingJobs(message.pendingJobs);
  // Combine all image sources, deduplicate
  const allImages = [...imagesFromTools, ...imagesFromJobs, ...embeddedImages];
  const images = [...new Set(allImages)];
  
  const activeJobs = getActiveJobs(message.pendingJobs);
  const failedJobs = getFailedJobs(message.pendingJobs);

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
            {cleanedContent && (
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown>{cleanedContent}</ReactMarkdown>
              </div>
            )}
            
            {/* Render generated images inline */}
            {images.length > 0 && (
              <div className={`grid gap-2 ${cleanedContent ? 'mt-3' : ''} ${
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
            
            {/* Render tool prompts inline - only for tools that need user input */}
            {message.toolCalls && message.toolCalls.length > 0 && (() => {
              // Filter out media generation tools - those are displayed as images, not prompts
              const mediaToolNames = ['generate_image', 'generate_video', 'generate_sticker', 'get_my_gallery'];
              const interactiveToolCalls = message.toolCalls.filter(tc => !mediaToolNames.includes(tc.name));
              
              if (interactiveToolCalls.length === 0) return null;
              
              return (
                <div className={`space-y-3 ${message.content || images.length > 0 ? 'mt-3' : ''}`}>
                  {interactiveToolCalls.map((toolCall) => (
                    <ToolPrompt
                      key={toolCall.id}
                      toolCall={toolCall}
                      onSubmit={onToolSubmit || (() => {})}
                      disabled={!onToolSubmit || toolCall.status !== 'pending'}
                    />
                  ))}
                </div>
              );
            })()}

            {/* Render pending job indicators */}
            {activeJobs.length > 0 && (
              <div className={`${message.content || images.length > 0 ? 'mt-3' : ''}`}>
                {activeJobs.map((job) => (
                  <div key={job.jobId} className="flex items-center gap-2 text-sm text-dark-300 bg-dark-900 rounded-lg px-3 py-2">
                    <div className="animate-spin w-4 h-4 border-2 border-primary-400 border-t-transparent rounded-full" />
                    <span>
                      {job.status === 'processing' ? 'Generating' : 'Starting'} {job.type}...
                      {job.prompt && <span className="text-dark-500 ml-1">"{job.prompt.slice(0, 50)}{job.prompt.length > 50 ? '...' : ''}"</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Render failed job errors */}
            {failedJobs.length > 0 && (
              <div className={`${message.content || images.length > 0 || activeJobs.length > 0 ? 'mt-3' : ''}`}>
                {failedJobs.map((job) => (
                  <div key={job.jobId} className="flex items-center gap-2 text-sm text-red-400 bg-red-900/20 rounded-lg px-3 py-2">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                    <span>
                      {job.type} generation failed{job.error && `: ${job.error}`}
                    </span>
                  </div>
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
            {activeJobs.length > 0 && (
              <span className="ml-2 text-primary-400">• Generating {activeJobs.length} {activeJobs.length === 1 ? 'image' : 'images'}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
