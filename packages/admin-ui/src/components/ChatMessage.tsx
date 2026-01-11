import ReactMarkdown from 'react-markdown';
import { useMemo } from 'react';
import type { ChatMessage as ChatMessageType } from '../types';
import { ToolPrompt } from './ToolPrompts';

interface ChatMessageProps {
  message: ChatMessageType;
  onToolSubmit?: (toolCallId: string, result: unknown) => void;
}

/**
 * Parsed tool result from message content
 */
interface ParsedToolResult {
  type: 'image' | 'gallery' | 'success' | 'error' | 'info' | 'unknown';
  data: Record<string, unknown>;
  imageUrl?: string;
  message?: string;
}

/**
 * Clean message content by removing raw JSON tool results
 * Returns cleaned content plus any extracted data for rich rendering
 */
function processMessageContent(content: string): { 
  cleanedContent: string; 
  embeddedImages: string[];
  toolResults: ParsedToolResult[];
} {
  const embeddedImages: string[] = [];
  const toolResults: ParsedToolResult[] = [];
  let cleanedContent = content;
  
  // Helper to categorize a parsed JSON object
  const categorizeResult = (parsed: Record<string, unknown>): ParsedToolResult => {
    // Image generation result
    if (parsed.url && typeof parsed.url === 'string') {
      const url = parsed.url;
      const isImage = url.includes('.png') || url.includes('.jpg') || 
                      url.includes('.webp') || url.includes('rati.chat') || 
                      url.includes('/images/');
      if (isImage) {
        embeddedImages.push(url);
        return { type: 'image', data: parsed, imageUrl: url };
      }
    }
    
    // Success message (profile update, wallet created, etc)
    if (parsed.message && typeof parsed.message === 'string') {
      if (parsed.error === true) {
        return { type: 'error', data: parsed, message: parsed.message };
      }
      return { type: 'success', data: parsed, message: parsed.message };
    }
    
    // Success boolean
    if (parsed.success === true) {
      const msg = typeof parsed.result === 'string' ? parsed.result : 
                  typeof parsed.data === 'string' ? parsed.data : 'Done!';
      return { type: 'success', data: parsed, message: msg };
    }
    
    // Error result
    if (parsed.error === true || parsed.success === false) {
      const msg = typeof parsed.message === 'string' ? parsed.message :
                  typeof parsed.error === 'string' ? parsed.error : 'An error occurred';
      return { type: 'error', data: parsed, message: msg };
    }
    
    // Job status or other info
    if (parsed.status || parsed.jobId) {
      return { type: 'info', data: parsed };
    }
    
    return { type: 'unknown', data: parsed };
  };
  
  // Pattern 1: JSON arrays (gallery, job lists, etc)
  // Match arrays that contain objects
  const jsonArrayPattern = /\n?\s*\[\s*(?:\{[\s\S]*?\}\s*,?\s*)+\]\s*\n?/g;
  const emptyArrayPattern = /\n?\s*\[\s*\]\s*\n?/g;
  const emptyArrayLinePattern = /^\s*[^:\n]{1,60}:\s*\[\s*\]\s*$/gm;
  const emptyArrayFencePattern = /```(?:json)?\s*\[\s*\]\s*```/g;
  
  // Remove empty arrays (e.g., "no pending jobs")
  cleanedContent = cleanedContent.replace(emptyArrayPattern, '');
  cleanedContent = cleanedContent.replace(emptyArrayLinePattern, '');
  cleanedContent = cleanedContent.replace(emptyArrayFencePattern, '');
  
  // Process non-empty arrays
  const arrayMatches = cleanedContent.match(jsonArrayPattern) || [];
  for (const match of arrayMatches) {
    try {
      const parsed = JSON.parse(match.trim());
      if (Array.isArray(parsed)) {
        // Check if it's a gallery (items have url field)
        const hasUrls = parsed.some(item => item?.url);
        if (hasUrls) {
          for (const item of parsed) {
            if (item?.url && typeof item.url === 'string') {
              embeddedImages.push(item.url);
            }
          }
          toolResults.push({ type: 'gallery', data: { items: parsed } });
        }
        cleanedContent = cleanedContent.replace(match, '');
      }
    } catch {
      // Not valid JSON, leave it
    }
  }
  
  // Pattern 2: Single JSON objects
  // More aggressive pattern to catch tool results
  const jsonObjectPattern = /\n?\s*\{\s*"[\w]+"\s*:\s*(?:"[^"]*"|true|false|null|\d+|\{[^}]*\}|\[[^\]]*\])\s*(?:,\s*"[\w]+"\s*:\s*(?:"[^"]*"|true|false|null|\d+|\{[^}]*\}|\[[^\]]*\])\s*)*\}\s*\n?/g;
  
  const objectMatches = cleanedContent.match(jsonObjectPattern) || [];
  for (const match of objectMatches) {
    try {
      const parsed = JSON.parse(match.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const result = categorizeResult(parsed);
        toolResults.push(result);
        cleanedContent = cleanedContent.replace(match, '');
      }
    } catch {
      // Not valid JSON, leave it
    }
  }
  
  // Clean up artifacts
  cleanedContent = cleanedContent
    .replace(/\n{3,}/g, '\n\n')  // Multiple newlines
    .replace(/^\s*\n/, '')       // Leading newline
    .trim();
  
  return { cleanedContent, embeddedImages, toolResults };
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
  const { cleanedContent, embeddedImages, toolResults } = useMemo(
    () => message.content ? processMessageContent(message.content) : { cleanedContent: '', embeddedImages: [], toolResults: [] },
    [message.content]
  );
  
  const imagesFromTools = extractImagesFromToolCalls(message.toolCalls);
  const imagesFromJobs = extractImagesFromPendingJobs(message.pendingJobs);
  // Combine all image sources, deduplicate
  const allImages = [...imagesFromTools, ...imagesFromJobs, ...embeddedImages];
  const images = [...new Set(allImages)];
  
  const activeJobs = getActiveJobs(message.pendingJobs);
  const failedJobs = getFailedJobs(message.pendingJobs);
  
  // Filter tool results that should be shown (not images - those are rendered separately)
  const visibleToolResults = toolResults.filter(r => r.type !== 'image' && r.type !== 'gallery');
  
  // Filter out media generation tools for interactive display
  const mediaToolNames = ['generate_image', 'generate_video', 'generate_sticker', 'get_my_gallery'];
  const interactiveToolCalls = message.toolCalls?.filter(tc => !mediaToolNames.includes(tc.name)) ?? [];
  
  // Don't render empty bubbles - check if there's any visible content
  const hasVisibleContent = 
    message.isLoading ||
    cleanedContent ||
    visibleToolResults.length > 0 ||
    images.length > 0 ||
    interactiveToolCalls.length > 0 ||
    activeJobs.length > 0 ||
    failedJobs.length > 0;
  
  if (!hasVisibleContent) {
    return null;
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 lg:mb-4`}>
      <div
        className={`max-w-[90%] sm:max-w-[85%] lg:max-w-[80%] rounded-2xl px-3 lg:px-4 py-2.5 lg:py-3 ${
          isUser
            ? 'bg-brand-600 text-white rounded-br-md'
            : 'bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded-bl-md border border-[var(--color-border)]'
        }`}
      >
        {message.isLoading ? (
          <div className="typing-indicator flex gap-1 py-2">
            <span className="w-2 h-2 bg-[var(--color-text-muted)] rounded-full"></span>
            <span className="w-2 h-2 bg-[var(--color-text-muted)] rounded-full"></span>
            <span className="w-2 h-2 bg-[var(--color-text-muted)] rounded-full"></span>
          </div>
        ) : (
          <>
            {activeJobs.length > 0 && (
              <div className="mb-2 rounded-lg border border-brand-500/20 bg-brand-500/10 px-3 py-2 text-sm text-brand-100">
                <div className="flex items-center gap-2">
                  <div className="animate-spin w-4 h-4 border-2 border-brand-300 border-t-transparent rounded-full" />
                  <span>
                    Generating {activeJobs.length} {activeJobs.length === 1 ? activeJobs[0].type : 'items'}...
                  </span>
                </div>
              </div>
            )}

            {cleanedContent && (
              <div className={`prose prose-sm max-w-none ${isUser ? 'prose-invert' : 'dark:prose-invert'}`}>
                <ReactMarkdown>{cleanedContent}</ReactMarkdown>
              </div>
            )}
            
            {/* Render tool result badges (success/error messages) */}
            {visibleToolResults.length > 0 && (
              <div className={`space-y-1 ${cleanedContent ? 'mt-2' : ''}`}>
                {visibleToolResults.map((result, idx) => (
                  <div 
                    key={idx}
                    className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1.5 mr-2 ${
                      result.type === 'success' ? 'bg-green-500/20 text-green-600 dark:text-green-300' :
                      result.type === 'error' ? 'bg-red-500/20 text-red-600 dark:text-red-300' :
                      'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {result.type === 'success' && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {result.type === 'error' && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                    {result.message || (result.type === 'success' ? 'Done!' : 'Completed')}
                  </div>
                ))}
              </div>
            )}
            
            {/* Render generated images inline */}
            {images.length > 0 && (
              <div className={`grid gap-2 ${cleanedContent || visibleToolResults.length > 0 ? 'mt-3' : ''} ${
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
            {interactiveToolCalls.length > 0 && (
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
            )}

            {/* Render pending job indicators */}
            {activeJobs.length > 0 && (
              <div className={`${message.content || images.length > 0 ? 'mt-3' : ''}`}>
                {activeJobs.map((job) => (
                  <div key={job.jobId} className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] rounded-lg px-3 py-2">
                    <div className="animate-spin w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full" />
                    <span>
                      {job.status === 'processing' ? 'Generating' : 'Starting'} {job.type}...
                      {job.prompt && <span className="text-[var(--color-text-muted)] ml-1">"{job.prompt.slice(0, 50)}{job.prompt.length > 50 ? '...' : ''}"</span>}
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
              isUser ? 'text-brand-200' : 'text-[var(--color-text-muted)]'
            }`}
          >
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {hasPendingTools && (
              <span className="ml-2 text-yellow-500 dark:text-yellow-400">• Waiting for input</span>
            )}
            {activeJobs.length > 0 && (
              <span className="ml-2 text-brand-500">• Generating {activeJobs.length} {activeJobs.length === 1 ? 'image' : 'images'}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
