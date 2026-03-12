import ReactMarkdown from 'react-markdown';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { extractThinkingTags } from '../utils/thinkingTags';
import type { ChatMessage as ChatMessageType, MessageSender } from '../types';
import { useTaskCardStore } from '../store/task-cards';
import { ImageModal } from './ImageModal';

/**
 * Safely highlight occurrences of `pattern` within `text` using React elements
 * instead of dangerouslySetInnerHTML. Returns an array of ReactNodes where
 * matched segments are wrapped in a styled <span>.
 */
function highlightPattern(text: string, pattern: string): ReactNode[] {
  if (!pattern) return [text];
  // Escape regex special characters in the pattern to prevent regex injection
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let regex: RegExp;
  try {
    regex = new RegExp(`(${escaped})`, 'gi');
  } catch {
    // If regex construction still fails, return plain text
    return [text];
  }
  const parts = text.split(regex);
  return parts.map((part, i) => {
    if (regex.test(part)) {
      // Reset lastIndex since we reuse the regex with the global flag
      regex.lastIndex = 0;
      return (
        <span key={i} className="text-brand-400 font-bold">
          {part}
        </span>
      );
    }
    return part;
  });
}

interface ChatMessageProps {
  message: ChatMessageType;
  onToolSubmit?: (toolCallId: string, result: unknown) => void;
}

/**
 * Render avatar for message sender
 * - No sender or no wallet = ghost icon
 * - Has walletAddress = wallet-based display
 */
const SenderAvatar = memo(function SenderAvatar({ sender }: { sender?: MessageSender }) {
  // Ghost icon for anonymous/no wallet users
  if (!sender || !sender.walletAddress) {
    return (
      <div className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center flex-shrink-0">
        <svg className="w-5 h-5 text-gray-400" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" opacity="0.5"/>
        </svg>
      </div>
    );
  }
  
  // Avatar image if sender has one
  if (sender.avatarUrl) {
    return (
      <img 
        src={sender.avatarUrl} 
        alt={sender.displayName || 'Avatar'} 
        className="w-8 h-8 rounded-full object-cover flex-shrink-0"
      />
    );
  }
  
  // Wallet-connected user without avatar - show first 4 chars of wallet
  const shortWallet = sender.walletAddress.slice(0, 4);
  return (
    <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 text-white text-xs font-mono">
      {shortWallet}
    </div>
  );
});

/**
 * Parsed tool result from message content
 */
interface ParsedToolResult {
  type: 'image' | 'gallery' | 'audio' | 'video' | 'success' | 'error' | 'info' | 'wallet' | 'tweet' | 'twitter_status' | 'discord_status' | 'model_list' | 'unknown';
  data: unknown;
  imageUrl?: string;
  audioUrl?: string;
  videoUrl?: string;
  message?: string;
  // Wallet-specific fields
  publicKey?: string;
  walletName?: string;
  pattern?: string;
  attempts?: number;
  generationTime?: string;
  isVanity?: boolean;
  // Twitter-specific fields
  tweetId?: string;
  tweetUrl?: string;
  twitterUsername?: string;
  twitterConnected?: boolean;
  twitterError?: boolean;
  // Discord-specific fields
  discordConnected?: boolean;
  discordBotUsername?: string;
  discordMode?: string;
  discordError?: boolean;
}

/**
 * Clean message content by removing raw JSON tool results
 * Returns cleaned content plus any extracted data for rich rendering
 */
function processMessageContent(
  content: string,
  options?: { stripAllJson?: boolean }
): {
  cleanedContent: string;
  embeddedImages: string[];
  embeddedAudios: string[];
  toolResults: ParsedToolResult[];
} {
  const embeddedImages: string[] = [];
  const embeddedAudios: string[] = [];
  const toolResults: ParsedToolResult[] = [];
  let cleanedContent = content;
  const stripAllJson = options?.stripAllJson === true;
  
  // Helper to detect if URL is an audio file
  const isAudioUrl = (url: string) => {
    const lowerUrl = url.toLowerCase();
    return lowerUrl.includes('.ogg') || lowerUrl.includes('.mp3') || 
           lowerUrl.includes('.wav') || lowerUrl.includes('.opus') ||
           lowerUrl.includes('/audio/') || lowerUrl.includes('/voice/');
  };
  
  // Helper to categorize a parsed JSON object
  const categorizeResult = (parsed: Record<string, unknown>): ParsedToolResult => {
    const hasSignalKey = (
      'success' in parsed ||
      'error' in parsed ||
      'status' in parsed ||
      'jobId' in parsed ||
      'url' in parsed ||
      'resultUrl' in parsed ||
      'items' in parsed ||
      'action' in parsed
    );

    // Check for Twitter tweet result (has tweetId and url like twitter.com or x.com)
    if (parsed.tweetId && typeof parsed.tweetId === 'string') {
      const tweetUrl = typeof parsed.url === 'string' ? parsed.url : undefined;
      return {
        type: 'tweet',
        data: parsed,
        tweetId: parsed.tweetId,
        tweetUrl: tweetUrl,
        message: typeof parsed.message === 'string' ? parsed.message : 'Tweet posted!',
      };
    }

    // Check for Discord status/connection result (has mode field: webhook/bot/hybrid/none)
    // Must be checked before Twitter since both use 'connected' field
    if ('connected' in parsed && typeof parsed.mode === 'string' &&
        ['webhook', 'bot', 'hybrid', 'none'].includes(parsed.mode as string)) {
      return {
        type: 'discord_status',
        data: parsed,
        discordConnected: parsed.connected === true,
        discordError: parsed.connected === false && parsed.mode === 'none',
        discordBotUsername: typeof parsed.botUsername === 'string' ? parsed.botUsername : undefined,
        discordMode: parsed.mode as string,
        message: typeof parsed.message === 'string' ? parsed.message :
          parsed.connected ? `Discord connected in ${parsed.mode} mode` : 'Discord not connected',
      };
    }

    // Check for Twitter status/connection result (including errors)
    if ('connected' in parsed && (parsed.username || 'username' in parsed || parsed.error === true)) {
      return {
        type: 'twitter_status',
        data: parsed,
        twitterConnected: parsed.connected === true,
        twitterError: parsed.error === true,
        twitterUsername: typeof parsed.username === 'string' ? parsed.username : undefined,
        message: typeof parsed.message === 'string' ? parsed.message :
          parsed.connected ? `Connected as @${parsed.username}` : 'X not connected',
      };
    }

    // Check for Twitter integration request (pending authorization)
    if (parsed.pending === true && parsed.authorizationUrl) {
      return {
        type: 'twitter_status',
        data: parsed,
        twitterConnected: false,
        message: typeof parsed.message === 'string' ? parsed.message : 'X authorization pending',
      };
    }

    // Check for already connected Twitter
    if (parsed.alreadyConnected === true && parsed.username) {
      return {
        type: 'twitter_status',
        data: parsed,
        twitterConnected: true,
        twitterUsername: typeof parsed.username === 'string' ? parsed.username : undefined,
        message: typeof parsed.message === 'string' ? parsed.message : `Already connected as @${parsed.username}`,
      };
    }

    // Check for wallet creation result (including vanity wallets)
    if (parsed.publicKey && typeof parsed.publicKey === 'string' && parsed.publicKey.length > 30) {
      const isVanity = parsed._uiType === 'vanity_wallet_created' || 
                       typeof parsed.pattern === 'string' ||
                       typeof parsed.attempts === 'number';
      return {
        type: 'wallet',
        data: parsed,
        publicKey: parsed.publicKey as string,
        walletName: typeof parsed.message === 'string' 
          ? parsed.message.match(/wallet "([^"]+)"/)?.[1] || 'Wallet'
          : 'Wallet',
        message: typeof parsed.message === 'string' ? parsed.message : 'Wallet created!',
        pattern: typeof parsed.pattern === 'string' ? parsed.pattern : undefined,
        attempts: typeof parsed.attempts === 'number' ? parsed.attempts : undefined,
        generationTime: typeof parsed.generationTime === 'string' ? parsed.generationTime : undefined,
        isVanity,
      };
    }

    // Check for audio URL (can be at top level or inside data object from tool results)
    const audioUrlCandidate = 
      (typeof parsed.url === 'string' ? parsed.url : null) ||
      (parsed.data && typeof parsed.data === 'object' && 'url' in parsed.data && typeof (parsed.data as Record<string, unknown>).url === 'string' 
        ? (parsed.data as Record<string, unknown>).url as string 
        : null);
    
    if (audioUrlCandidate && isAudioUrl(audioUrlCandidate)) {
      embeddedAudios.push(audioUrlCandidate);
      return { type: 'audio', data: parsed, audioUrl: audioUrlCandidate };
    }
    
    // Check for media URL (video, image)
    if (parsed.url && typeof parsed.url === 'string') {
      const url = parsed.url;
      if (isAudioUrl(url)) {
        // Avoid treating voice/audio URLs as images
        return { type: 'audio', data: parsed, audioUrl: url };
      }
      // Video result
      const isVideo = url.includes('.mp4') || url.includes('.webm') || url.includes('/video');
      if (isVideo || parsed.type === 'video') {
        return { type: 'video', data: parsed, videoUrl: url };
      }
      // Image generation result
      const isImage = url.includes('.png') || url.includes('.jpg') ||
                      url.includes('.webp') || url.includes('rati.chat') ||
                      url.includes('/images/');
      if (isImage) {
        embeddedImages.push(url);
        return { type: 'image', data: parsed, imageUrl: url };
      }
    }
    
    // Success/error message (profile update, wallet created, tool failures, etc)
    if (parsed.message && typeof parsed.message === 'string' && hasSignalKey) {
      // Check for error: can be boolean true, a string error message, OR success === false
      if (parsed.error === true || typeof parsed.error === 'string' || parsed.success === false) {
        return { type: 'error', data: parsed, message: parsed.message };
      }
      return { type: 'success', data: parsed, message: parsed.message };
    }
    
    // Model list result - check before generic success
    if (parsed.success === true && Array.isArray(parsed.data) && 
        parsed.data.length > 0 && parsed.data[0]?.id && parsed.data[0]?.name) {
      // Check if it looks like a model list (has id, name, and optionally contextLength)
      const firstItem = parsed.data[0];
      if (typeof firstItem.id === 'string' && typeof firstItem.name === 'string') {
        return { type: 'model_list', data: parsed.data };
      }
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

  const isProbablyToolJson = (value: unknown): boolean => {
    if (!value) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    return (
      'success' in obj ||
      'error' in obj ||
      'status' in obj ||
      'jobId' in obj ||
      'url' in obj ||
      'resultUrl' in obj ||
      'items' in obj ||
      'action' in obj ||
      'message' in obj ||
      'publicKey' in obj ||
      'tweetId' in obj ||
      'connected' in obj
    );
  };

  const extractJsonSnippets = (text: string) => {
    const snippets: Array<{ start: number; endExclusive: number; parsed: unknown }> = [];
    const stack: Array<'{' | '['> = [];
    let startIndex: number | null = null;
    let inString = false;
    let escape = false;

    const pushSnippet = (start: number, endExclusive: number) => {
      const raw = text.slice(start, endExclusive).trim();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && (typeof parsed === 'object' || Array.isArray(parsed))) {
          snippets.push({ start, endExclusive, parsed });
        }
      } catch {
        // ignore
      }
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{' || ch === '[') {
        if (stack.length === 0) {
          startIndex = i;
        }
        stack.push(ch as '{' | '[');
        continue;
      }

      if (ch === '}' || ch === ']') {
        const expectedOpen = ch === '}' ? '{' : '[';
        if (stack.length === 0) continue;
        const open = stack[stack.length - 1];
        if (open !== expectedOpen) {
          // Mismatched; reset
          stack.length = 0;
          startIndex = null;
          continue;
        }
        stack.pop();
        if (stack.length === 0 && startIndex != null) {
          pushSnippet(startIndex, i + 1);
          startIndex = null;
        }
      }
    }

    return snippets;
  };
  
  // Extract any JSON snippets from the content (handles nested JSON and code-fenced JSON)
  const snippets = extractJsonSnippets(cleanedContent);
  if (snippets.length > 0) {
    for (const snip of snippets) {
      const parsed = snip.parsed;
      if (Array.isArray(parsed)) {
        const hasUrls = parsed.some(item => item && typeof item === 'object' && 'url' in (item as Record<string, unknown>));
        if (hasUrls) {
          for (const item of parsed) {
            if (item && typeof item === 'object' && 'url' in item && typeof (item as Record<string, unknown>).url === 'string') {
              embeddedImages.push((item as Record<string, unknown>).url as string);
            }
          }
          toolResults.push({ type: 'gallery', data: { items: parsed } });
        } else if (stripAllJson) {
          toolResults.push({ type: 'unknown', data: parsed });
        }
      } else if (parsed && typeof parsed === 'object') {
        const result = categorizeResult(parsed as Record<string, unknown>);
        if (result.type !== 'unknown') {
          toolResults.push(result);
        } else if (stripAllJson && isProbablyToolJson(parsed)) {
          toolResults.push({ type: 'unknown', data: parsed });
        }
      }
    }

    // Remove extracted snippets if we're stripping tool JSON (assistant/tool-result messages)
    if (stripAllJson) {
      // Remove from end to start so indices remain valid
      for (const snip of [...snippets].sort((a, b) => b.start - a.start)) {
        cleanedContent = cleanedContent.slice(0, snip.start) + cleanedContent.slice(snip.endExclusive);
      }
    } else {
      // Only strip recognized tool results when not in strip-all mode
      const recognizedRanges = snippets
        .filter(s => {
          const p = s.parsed;
          if (Array.isArray(p)) {
            return p.some(item => item && typeof item === 'object' && 'url' in (item as Record<string, unknown>));
          }
          if (p && typeof p === 'object') {
            return categorizeResult(p as Record<string, unknown>).type !== 'unknown';
          }
          return false;
        })
        .sort((a, b) => b.start - a.start);
      for (const snip of recognizedRanges) {
        cleanedContent = cleanedContent.slice(0, snip.start) + cleanedContent.slice(snip.endExclusive);
      }
    }
  }
  
  // Clean up artifacts
  cleanedContent = cleanedContent
    .replace(/\n{3,}/g, '\n\n')  // Multiple newlines
    .replace(/^\s*\n/, '')       // Leading newline
    .trim();
  
  return { cleanedContent, embeddedImages, embeddedAudios, toolResults };
}

/**
 * Extract audio URLs from tool call results
 */
function extractAudiosFromToolCalls(toolCalls?: ChatMessageType['toolCalls']): string[] {
  if (!toolCalls) return [];

  const audios: string[] = [];
  const isAudioUrl = (url: string) => {
    const lowerUrl = url.toLowerCase();
    return lowerUrl.includes('.ogg') || lowerUrl.includes('.mp3') || 
           lowerUrl.includes('.wav') || lowerUrl.includes('.opus') ||
           lowerUrl.includes('/audio/') || lowerUrl.includes('/voice/');
  };

  for (const tc of toolCalls) {
    if (tc.result && typeof tc.result === 'object') {
      const result = tc.result as Record<string, unknown>;
      // Check top-level url
      let url = (result.url || result.resultUrl) as string | undefined;
      // Also check inside data object (voice tool returns { success, data: { url } })
      if (!url && result.data && typeof result.data === 'object') {
        const data = result.data as Record<string, unknown>;
        url = data.url as string | undefined;
      }
      if (url && typeof url === 'string' && isAudioUrl(url)) {
        audios.push(url);
      }
    }
  }

  return audios;
}

/**
 * Extract image URLs from tool call results
 */
function extractImagesFromToolCalls(toolCalls?: ChatMessageType['toolCalls']): string[] {
  if (!toolCalls) return [];

  const images: string[] = [];

  const isAudioUrl = (url: string) => {
    const lowerUrl = url.toLowerCase();
    return lowerUrl.includes('.ogg') || lowerUrl.includes('.mp3') || 
           lowerUrl.includes('.wav') || lowerUrl.includes('.opus') ||
           lowerUrl.includes('/audio/') || lowerUrl.includes('/voice/');
  };

  for (const tc of toolCalls) {
    if (tc.result && typeof tc.result === 'object') {
      const result = tc.result as Record<string, unknown>;
      // Check for image URL in result - any URL from successful generation
      // Support both 'url' and 'resultUrl' fields (from get_job_status)
      const url = (result.url || result.resultUrl) as string | undefined;
      if (url && typeof url === 'string') {
        if (isAudioUrl(url)) {
          continue;
        }
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
 * Extract video URLs from tool call results
 */
function extractVideosFromToolCalls(toolCalls?: ChatMessageType['toolCalls']): string[] {
  if (!toolCalls) return [];
  const videoUrls: string[] = [];
  for (const tc of toolCalls) {
    if (tc.result && typeof tc.result === 'object') {
      const result = tc.result as Record<string, unknown>;
      const url = (result.url || result.resultUrl) as string | undefined;
      if (url && typeof url === 'string') {
        const isVideo = url.includes('.mp4') || url.includes('.webm') || url.includes('/video');
        if (isVideo || result.type === 'video') {
          videoUrls.push(url);
        }
      }
      // Check gallery items for videos
      const items = Array.isArray(result.items) ? result.items : Array.isArray(result.data) ? result.data : null;
      if (items) {
        for (const item of items) {
          if (item && typeof item === 'object' && item.url && item.type === 'video') {
            videoUrls.push(item.url as string);
          }
        }
      }
    }
  }
  return videoUrls;
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

/**
 * Tools that are auto-executed and don't require user interaction.
 * These are filtered out of the interactive tool prompt list.
 */
export const AUTO_EXECUTED_TOOLS = [
  'generate_image',
  'generate_video',
  'generate_sticker',
  'get_my_gallery',
  'send_gallery_image',
  'send_gallery_media',
  'search_gallery',
  'send_voice_message',
  'create_my_voice',
  'update_my_profile',
];

/**
 * Filter tool calls to those that should be visible in the chat.
 * A tool call is visible if it is NOT in the auto-executed tools list.
 * Pending calls render as interactive prompts; completed/failed render as status badges.
 */
export function getVisibleToolCalls(
  toolCalls: ChatMessageType['toolCalls'],
): NonNullable<ChatMessageType['toolCalls']> {
  return toolCalls?.filter(tc =>
    !AUTO_EXECUTED_TOOLS.includes(tc.name)
  ) ?? [];
}

/** @deprecated Use getVisibleToolCalls instead */
export const getInteractiveToolCalls = getVisibleToolCalls;



function ChatMessageInner({ message, onToolSubmit: _onToolSubmit }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const hasPendingTools = message.toolCalls?.some(tc => tc.status === 'pending');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const { contentForDisplay, thoughts } = useMemo(() => {
    const raw = message.content || '';
    const extracted = extractThinkingTags(raw);
    const fromFieldRaw = (message as unknown as { thinking?: unknown }).thinking;
    const fromField = Array.isArray(fromFieldRaw) ? fromFieldRaw : [];
    const merged = [...fromField, ...extracted.thinkingBlocks]
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0);

    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of merged) {
      if (seen.has(t)) continue;
      seen.add(t);
      deduped.push(t);
    }

    return { contentForDisplay: extracted.cleanContent, thoughts: deduped };
  }, [message]);
  
  // Process message content to extract embedded JSON, images, and audio
  const { cleanedContent, embeddedImages, embeddedAudios, toolResults } = useMemo(
    () => contentForDisplay
      ? processMessageContent(contentForDisplay, { stripAllJson: message.isToolResult })
      : { cleanedContent: '', embeddedImages: [], embeddedAudios: [], toolResults: [] },
    [contentForDisplay, message.isToolResult]
  );
  
  const imagesFromTools = extractImagesFromToolCalls(message.toolCalls);
  const imagesFromJobs = extractImagesFromPendingJobs(message.pendingJobs);
  const audiosFromTools = extractAudiosFromToolCalls(message.toolCalls);
  
  // Extract images from media array (gallery results, etc)
  const imagesFromMedia = (message.media || [])
    .filter(m => m.type === 'image' || m.type === 'sticker')
    .map(m => m.url);

  const videosFromMedia = (message.media || [])
    .filter(m => m.type === 'video')
    .map(m => m.url);

  const audiosFromMedia = (message.media || [])
    .filter(m => m.type === 'audio')
    .map(m => m.url);
  
  // Extract video URLs from tool call results
  const videosFromTools = extractVideosFromToolCalls(message.toolCalls);

  // Combine all image sources, deduplicate
  const allImages = [...imagesFromTools, ...imagesFromJobs, ...embeddedImages, ...imagesFromMedia];
  const images = [...new Set(allImages)];

  // Combine all video sources, deduplicate
  const videos = [...new Set([...videosFromTools, ...videosFromMedia])];

  // Combine all audio sources, deduplicate
  const allAudios = [...audiosFromTools, ...embeddedAudios, ...audiosFromMedia];
  const audios = [...new Set(allAudios)];
  
  const activeJobs = getActiveJobs(message.pendingJobs);
  const failedJobs = getFailedJobs(message.pendingJobs);
  
  const walletResults = toolResults.filter(r => r.type === 'wallet');
  const tweetResults = toolResults.filter(r => r.type === 'tweet');
  const twitterStatusResults = toolResults.filter(r => r.type === 'twitter_status');
  const discordStatusResults = toolResults.filter(r => r.type === 'discord_status');
  const modelListResults = toolResults.filter(r => r.type === 'model_list');
    const unknownResults = toolResults.filter(r => r.type === 'unknown');
  // Filter tool results that should be shown (not images/audio/video/wallet/twitter/discord/models - those are rendered separately)
  const visibleToolResults = toolResults.filter(
    r => r.type !== 'image' && r.type !== 'gallery' && r.type !== 'audio' && r.type !== 'video' &&
         r.type !== 'wallet' && r.type !== 'tweet' &&
      r.type !== 'twitter_status' && r.type !== 'discord_status' && r.type !== 'model_list' && r.type !== 'unknown'
  );
  
  // Filter out auto-executed tools from display
  const visibleToolCalls = getVisibleToolCalls(message.toolCalls);
  // Task cards managed by the task card store render as standalone transcript items.
  // Exclude them from the message bubble so they aren't rendered twice.
  const taskCardStoreCards = useTaskCardStore((s) => s.cards);
  const unmanagedToolCalls = visibleToolCalls.filter((tc) => !taskCardStoreCards[tc.id]);

  // Don't render empty bubbles - check if there's any visible content
  // Tool calls that have task cards render as separate transcript items, so they
  // still count as "visible content" for the purpose of keeping the message bubble.
  const hasVisibleContent =
    message.isLoading ||
    cleanedContent ||
    (!isUser && thoughts.length > 0) ||
    walletResults.length > 0 ||
    tweetResults.length > 0 ||
    twitterStatusResults.length > 0 ||
    discordStatusResults.length > 0 ||
    modelListResults.length > 0 ||
    visibleToolResults.length > 0 ||
    unknownResults.length > 0 ||
    images.length > 0 ||
    videos.length > 0 ||
    audios.length > 0 ||
    unmanagedToolCalls.length > 0 ||
    activeJobs.length > 0 ||
    failedJobs.length > 0;
  
  if (!hasVisibleContent) {
    return null;
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 lg:mb-4`}>
      <div className={`flex items-end gap-2 min-w-0 max-w-[90%] sm:max-w-[85%] lg:max-w-[80%] ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
        {/* Show avatar for user messages */}
        {isUser && <SenderAvatar sender={message.sender} />}
        
        <div
          className={`rounded-2xl px-3 lg:px-4 py-2.5 lg:py-3 overflow-hidden min-w-0 break-words ${
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
            {cleanedContent && (
              message.isToolResult ? (
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-sm font-medium text-[var(--color-text)]">
                      Tool Result
                    </div>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(cleanedContent)}
                      className="flex-shrink-0 p-1.5 rounded hover:bg-[var(--color-bg-secondary)] transition text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      title="Copy output"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                  </div>
                  <pre className="mt-2 text-xs overflow-auto rounded-md bg-[var(--color-bg-primary)] px-3 py-2 text-[var(--color-text-secondary)]">
                    {cleanedContent}
                  </pre>
                </div>
              ) : (
                <div className={`prose prose-sm max-w-none break-words ${isUser ? 'prose-invert' : 'dark:prose-invert'}`}>
                  <ReactMarkdown>{cleanedContent}</ReactMarkdown>
                </div>
              )
            )}

            {!isUser && !message.isToolResult && thoughts.length > 0 && (
              <details className={`${cleanedContent ? 'mt-2' : ''} text-xs ${isUser ? 'text-white/80' : 'text-[var(--color-text-muted)]'}`}>
                <summary className="cursor-pointer select-none hover:opacity-90">
                  Thoughts
                </summary>
                <div className={`mt-2 whitespace-pre-wrap font-mono rounded-lg border px-3 py-2 ${isUser ? 'border-white/20 bg-white/10 text-white/90' : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40 text-[var(--color-text-secondary)]'}`}>
                  {thoughts.join('\n\n')}
                </div>
              </details>
            )}

            {/* Render unknown JSON tool results as structured cards instead of raw JSON */}
            {unknownResults.length > 0 && (
              <div className={`space-y-2 ${cleanedContent ? 'mt-3' : ''}`}>
                {unknownResults.map((result, idx) => {
                  const pretty = (() => {
                    try {
                      return JSON.stringify(result.data, null, 2);
                    } catch {
                      return String(result.data);
                    }
                  })();

                  const copy = () => {
                    navigator.clipboard.writeText(pretty);
                  };

                  const keys = (result.data && typeof result.data === 'object' && !Array.isArray(result.data))
                    ? Object.keys(result.data as Record<string, unknown>).slice(0, 6)
                    : [];

                  return (
                    <div
                      key={idx}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-[var(--color-text)]">
                            Tool Result
                          </div>
                          {keys.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {keys.map(k => (
                                <span
                                  key={k}
                                  className="text-[10px] px-2 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]"
                                >
                                  {k}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={copy}
                          className="flex-shrink-0 p-1.5 rounded hover:bg-[var(--color-bg-secondary)] transition text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                          title="Copy JSON"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      </div>

                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-[var(--color-text-secondary)] select-none">
                          View details
                        </summary>
                        <pre className="mt-2 text-xs overflow-auto rounded-md bg-[var(--color-bg-primary)] px-3 py-2 text-[var(--color-text-secondary)]">
                          {pretty}
                        </pre>
                      </details>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Render wallet creation results with nice UI */}
            {walletResults.length > 0 && (
              <div className={`space-y-2 ${cleanedContent ? 'mt-3' : ''}`}>
                {walletResults.map((result, idx) => {
                  const copyToClipboard = () => {
                    if (result.publicKey) {
                      navigator.clipboard.writeText(result.publicKey);
                    }
                  };
                  
                  // Highlight pattern in address if it's a vanity wallet (safe React rendering)
                  const addressContent = result.publicKey && result.pattern
                    ? highlightPattern(result.publicKey, result.pattern)
                    : result.publicKey || '';
                  
                  return (
                    <div
                      key={idx}
                      className="rounded-lg border border-brand-500/30 bg-gradient-to-br from-brand-500/10 to-purple-500/10 px-4 py-3"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-8 h-8 rounded-full bg-brand-500/20 flex items-center justify-center">
                          <svg className="w-4 h-4 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                          </svg>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-[var(--color-text)]">
                            {result.isVanity ? '✨ Vanity Wallet Created' : '💳 Wallet Created'}
                          </div>
                          <div className="text-xs text-[var(--color-text-muted)]">
                            {result.walletName || 'Solana'}
                          </div>
                        </div>
                      </div>
                      
                      <div className="bg-[var(--color-bg-primary)] rounded-md px-3 py-2 mb-2">
                        <div className="flex items-center justify-between gap-2">
                          <code className="text-xs font-mono text-[var(--color-text-secondary)] break-all">
                            {addressContent}
                          </code>
                          <button
                            onClick={copyToClipboard}
                            className="flex-shrink-0 p-1.5 rounded hover:bg-[var(--color-bg-tertiary)] transition text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                            title="Copy address"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                      
                      {result.isVanity && (
                        <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
                          {result.pattern && (
                            <span className="bg-brand-500/20 text-brand-300 px-2 py-0.5 rounded">
                              Pattern: {result.pattern}
                            </span>
                          )}
                          {result.attempts && (
                            <span>
                              {result.attempts.toLocaleString()} attempts
                            </span>
                          )}
                          {result.generationTime && (
                            <span>
                              ⏱ {result.generationTime}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Render Twitter tweet results */}
            {tweetResults.length > 0 && (
              <div className={`space-y-2 ${cleanedContent || walletResults.length > 0 ? 'mt-3' : ''}`}>
                {tweetResults.map((result, idx) => (
                  <div
                    key={idx}
                    className="rounded-lg border border-blue-500/30 bg-gradient-to-br from-blue-500/10 to-sky-500/10 px-4 py-3"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                        <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M13.95 10.85L20.54 3h-1.56l-5.74 6.84L8.5 3H3.1l6.92 10.09L3.1 21h1.56l5.97-7.11L15.5 21h5.4l-6.95-10.15zm-2.45 2.92l-.7-1.03L5.8 4.5h2.46l4.06 5.98.7 1.02 5.24 7.71h-2.46l-4.3-6.44z" />
                        </svg>
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-[var(--color-text)]">
                          Tweet Posted! 🎉
                        </div>
                      </div>
                      {result.tweetUrl && (
                        <a
                          href={result.tweetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                        >
                          View on X
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      )}
                    </div>
                    {result.message && (
                      <div className="text-sm text-[var(--color-text-secondary)]">
                        {result.message}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Render Twitter status/connection results */}
            {twitterStatusResults.length > 0 && (
              <div className={`space-y-2 ${cleanedContent || walletResults.length > 0 || tweetResults.length > 0 ? 'mt-3' : ''}`}>
                {twitterStatusResults.map((result, idx) => {
                  // Determine styling: error (red), connected (green), or pending (yellow)
                  const isError = result.twitterError && !result.twitterConnected;
                  const borderClass = result.twitterConnected
                    ? 'border-green-500/30 bg-gradient-to-br from-green-500/10 to-emerald-500/10'
                    : isError
                    ? 'border-red-500/30 bg-gradient-to-br from-red-500/10 to-rose-500/10'
                    : 'border-yellow-500/30 bg-gradient-to-br from-yellow-500/10 to-orange-500/10';
                  const iconBgClass = result.twitterConnected
                    ? 'bg-green-500/20'
                    : isError
                    ? 'bg-red-500/20'
                    : 'bg-yellow-500/20';
                  const iconColorClass = result.twitterConnected
                    ? 'text-green-400'
                    : isError
                    ? 'text-red-400'
                    : 'text-yellow-400';

                  return (
                    <div key={idx} className={`rounded-lg border px-4 py-3 ${borderClass}`}>
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${iconBgClass}`}>
                          <svg className={`w-4 h-4 ${iconColorClass}`} fill="currentColor" viewBox="0 0 24 24">
                            <path d="M13.95 10.85L20.54 3h-1.56l-5.74 6.84L8.5 3H3.1l6.92 10.09L3.1 21h1.56l5.97-7.11L15.5 21h5.4l-6.95-10.15zm-2.45 2.92l-.7-1.03L5.8 4.5h2.46l4.06 5.98.7 1.02 5.24 7.71h-2.46l-4.3-6.44z" />
                          </svg>
                        </div>
                        <div className="flex-1">
                          <div className="text-sm font-medium text-[var(--color-text)]">
                            {result.twitterConnected ? 'Twitter Connected' : isError ? 'Twitter Connection Failed' : 'Twitter Connection'}
                            {result.twitterUsername && (
                              <span className="ml-2 text-blue-400">@{result.twitterUsername}</span>
                            )}
                          </div>
                          {result.message && (
                            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                              {result.message}
                            </div>
                          )}
                        </div>
                        {result.twitterConnected && (
                          <div className="flex items-center gap-1 text-xs text-green-400">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            Connected
                          </div>
                        )}
                        {isError && (
                          <div className="flex items-center gap-1 text-xs text-red-400">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Failed
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Render Discord status/connection results */}
            {discordStatusResults.length > 0 && (
              <div className={`space-y-2 ${cleanedContent || walletResults.length > 0 || tweetResults.length > 0 || twitterStatusResults.length > 0 ? 'mt-3' : ''}`}>
                {discordStatusResults.map((result, idx) => {
                  const isError = result.discordError && !result.discordConnected;
                  const borderClass = result.discordConnected
                    ? 'border-green-500/30 bg-gradient-to-br from-green-500/10 to-emerald-500/10'
                    : isError
                    ? 'border-red-500/30 bg-gradient-to-br from-red-500/10 to-rose-500/10'
                    : 'border-yellow-500/30 bg-gradient-to-br from-yellow-500/10 to-orange-500/10';
                  const iconBgClass = result.discordConnected
                    ? 'bg-green-500/20'
                    : isError
                    ? 'bg-red-500/20'
                    : 'bg-yellow-500/20';
                  const iconColorClass = result.discordConnected
                    ? 'text-green-400'
                    : isError
                    ? 'text-red-400'
                    : 'text-yellow-400';

                  return (
                    <div key={idx} className={`rounded-lg border px-4 py-3 ${borderClass}`}>
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${iconBgClass}`}>
                          <svg className={`w-4 h-4 ${iconColorClass}`} fill="currentColor" viewBox="0 0 24 24">
                            <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z" />
                          </svg>
                        </div>
                        <div className="flex-1">
                          <div className="text-sm font-medium text-[var(--color-text)]">
                            {result.discordConnected ? 'Discord Connected' : isError ? 'Discord Not Configured' : 'Discord Connection'}
                            {result.discordBotUsername && (
                              <span className="ml-2 text-indigo-400">{result.discordBotUsername}</span>
                            )}
                          </div>
                          {result.message && (
                            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                              {result.message}
                            </div>
                          )}
                        </div>
                        {result.discordMode && result.discordMode !== 'none' && (
                          <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                            {result.discordMode}
                          </span>
                        )}
                        {result.discordConnected && (
                          <div className="flex items-center gap-1 text-xs text-green-400">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            Connected
                          </div>
                        )}
                        {isError && (
                          <div className="flex items-center gap-1 text-xs text-red-400">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Disconnected
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Render model list results */}
            {modelListResults.length > 0 && (
              <div className={`space-y-2 ${cleanedContent || walletResults.length > 0 || tweetResults.length > 0 || twitterStatusResults.length > 0 || discordStatusResults.length > 0 ? 'mt-3' : ''}`}>
                {modelListResults.map((result, idx) => {
                  const models = result.data as Array<{ id: string; name: string; contextLength?: number }>;
                  // Group by provider
                  const grouped = models.reduce((acc, m) => {
                    const provider = m.id.split('/')[0] || 'other';
                    if (!acc[provider]) acc[provider] = [];
                    acc[provider].push(m);
                    return acc;
                  }, {} as Record<string, typeof models>);
                  const providers = Object.keys(grouped).sort();
                  
                  return (
                    <div
                      key={idx}
                      className="rounded-lg border border-brand-500/30 bg-gradient-to-br from-brand-500/10 to-purple-500/10 px-4 py-3"
                    >
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-full bg-brand-500/20 flex items-center justify-center">
                          <svg className="w-4 h-4 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                        </div>
                        <div className="flex-1">
                          <div className="text-sm font-medium text-[var(--color-text)]">
                            Available Models
                          </div>
                          <div className="text-xs text-[var(--color-text-muted)]">
                            {models.length} models from {providers.length} providers
                          </div>
                        </div>
                      </div>
                      
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {providers.map(provider => (
                          <div key={provider} className="bg-[var(--color-bg)]/50 rounded-lg p-2">
                            <div className="text-xs font-medium text-[var(--color-text-secondary)] capitalize mb-1">
                              {provider.replace(/-/g, ' ')}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {grouped[provider].map(m => (
                                <span 
                                  key={m.id}
                                  className="text-xs px-2 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
                                  title={`${m.id}${m.contextLength ? ` (${Math.round(m.contextLength/1000)}k ctx)` : ''}`}
                                >
                                  {m.name.replace(provider, '').replace(/^[\s-:]+/, '') || m.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      
                      <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
                        <p className="text-xs text-[var(--color-text-muted)]">
                          Ask me to "switch to [model name]" to change models
                        </p>
                      </div>
                    </div>
                  );
                })}
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
              <div className={`grid gap-2 max-w-full ${cleanedContent || visibleToolResults.length > 0 ? 'mt-3' : ''} ${
                images.length === 1 ? 'grid-cols-1 max-w-xs sm:max-w-sm' : 'grid-cols-2'
              }`}>
                {images.slice(0, 4).map((url, idx) => (
                  <button
                    key={idx}
                    onClick={() => setSelectedImage(url)}
                    className="block rounded-lg overflow-hidden hover:opacity-90 transition-opacity cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <img
                      src={url}
                      alt={`Generated image ${idx + 1}`}
                      className="w-full h-auto rounded-lg"
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            )}

            {/* Render videos inline */}
            {videos.length > 0 && (
              <div className={`space-y-2 ${cleanedContent || visibleToolResults.length > 0 || images.length > 0 ? 'mt-3' : ''}`}>
                {videos.map((url, idx) => (
                  <div key={idx} className="rounded-lg overflow-hidden max-w-xs sm:max-w-sm">
                    <video
                      controls
                      preload="metadata"
                      className="w-full h-auto rounded-lg"
                      playsInline
                    >
                      <source src={url} type={url.includes('.webm') ? 'video/webm' : 'video/mp4'} />
                      Your browser does not support video playback.
                    </video>
                  </div>
                ))}
              </div>
            )}

            {/* Render voice/audio messages */}
            {audios.length > 0 && (
              <div className={`space-y-2 ${cleanedContent || visibleToolResults.length > 0 || images.length > 0 ? 'mt-3' : ''}`}>
                {audios.map((url, idx) => (
                  <div 
                    key={idx}
                    className="flex items-center gap-3 bg-[var(--color-bg-tertiary)] rounded-xl px-3 py-2"
                  >
                    <div className="w-8 h-8 rounded-full bg-brand-500/20 flex items-center justify-center flex-shrink-0">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-brand-500">
                        <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 001.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06zM18.584 5.106a.75.75 0 011.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 01-1.06-1.06 8.25 8.25 0 000-11.668.75.75 0 010-1.06z" />
                        <path d="M15.932 7.757a.75.75 0 011.061 0 6 6 0 010 8.486.75.75 0 01-1.06-1.061 4.5 4.5 0 000-6.364.75.75 0 010-1.06z" />
                      </svg>
                    </div>
                    <audio 
                      controls 
                      preload="metadata"
                      className="flex-1 h-10"
                      style={{ 
                        filter: 'invert(1) hue-rotate(180deg)',
                        opacity: 0.9
                      }}
                    >
                      <source src={url} type={url.includes('.mp3') ? 'audio/mpeg' : url.includes('.wav') ? 'audio/wav' : 'audio/ogg'} />
                      Your browser does not support audio playback.
                    </audio>
                  </div>
                ))}
              </div>
            )}

            {/* Image Modal */}
            {selectedImage && (
              <ImageModal
                imageUrl={selectedImage}
                alt="Generated image"
                onClose={() => setSelectedImage(null)}
              />
            )}
            
            {/* Tool calls managed by the task card store render as standalone transcript items.
                Only render tool calls here that do NOT have a corresponding task card. */}

            {/* Render pending job indicators */}
            {activeJobs.length > 0 && (
              <div className={`${message.content || images.length > 0 ? 'mt-3' : ''}`}>
                {activeJobs.map((job) => (
                  <div key={job.jobId} className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] rounded-lg px-3 py-2 w-full max-w-full min-w-0 overflow-hidden">
                    <div className="animate-spin w-4 h-4 border-2 border-brand-400 border-t-transparent rounded-full flex-shrink-0" />
                    <div className="min-w-0 flex-1 flex items-center overflow-hidden">
                      <span className="flex-shrink-0 whitespace-nowrap">
                        {job.status === 'processing' ? 'Generating' : 'Starting'} {job.type}...
                      </span>
                      {job.prompt && (
                        job.prompt.length > 50
                          ? (
                            <span
                              className="ml-2 text-[var(--color-text-muted)] marquee min-w-0 flex-1"
                              aria-label={job.prompt}
                              style={{
                                // 0.35s per character, clamped (slower on long prompts)
                                ['--marquee-duration' as never]: `${Math.min(90, Math.max(28, Math.round(job.prompt.length * 0.35)))}s`,
                              }}
                            >
                              <span className="marquee__inner">"{job.prompt}"</span>
                            </span>
                          )
                          : (
                            <span className="ml-2 text-[var(--color-text-muted)] truncate">"{job.prompt}"</span>
                          )
                      )}
                    </div>
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
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

export const ChatMessage = memo(ChatMessageInner);
