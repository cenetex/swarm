/**
 * Thinking Tags Utility
 * 
 * Extracts <thinking>...</thinking> tags from bot responses.
 * - Thinking content should go into bot memory (internal reasoning)
 * - Clean content should be sent to chat (user-facing message)
 * 
 * This enables bots to have internal monologue/reasoning that persists
 * in their memory but doesn't pollute the chat.
 */

export interface ThinkingExtractionResult {
  /** The cleaned content with thinking tags removed */
  cleanContent: string;
  /** Array of thinking content extracted from the response */
  thinkingBlocks: string[];
  /** Whether any thinking tags were found */
  hasThinking: boolean;
}

/**
 * Extract thinking tags from a response and return clean content.
 * 
 * Supports multiple thinking blocks and handles edge cases:
 * - Nested content (not supported - uses non-greedy match)
 * - Multiple blocks
 * - Multiline content
 * - Case-insensitive tags
 * 
 * @example
 * ```ts
 * const result = extractThinking(
 *   '<thinking>I should be careful here</thinking>Hello!'
 * );
 * // result.cleanContent = 'Hello!'
 * // result.thinkingBlocks = ['I should be careful here']
 * ```
 */
export function extractThinking(content: string): ThinkingExtractionResult {
  if (!content) {
    return {
      cleanContent: '',
      thinkingBlocks: [],
      hasThinking: false,
    };
  }

  const thinkingBlocks: string[] = [];
  
  // Match <thinking>...</thinking> tags (case-insensitive, multiline, non-greedy)
  const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
  
  let match;
  while ((match = thinkingRegex.exec(content)) !== null) {
    const thinkingContent = match[1].trim();
    if (thinkingContent) {
      thinkingBlocks.push(thinkingContent);
    }
  }

  // Remove all thinking blocks from the content
  let cleanContent = content.replace(thinkingRegex, '').trim();
  
  // Clean up any double whitespace or newlines left behind
  cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, '\n\n').trim();

  return {
    cleanContent,
    thinkingBlocks,
    hasThinking: thinkingBlocks.length > 0,
  };
}

/**
 * Format thinking blocks for memory storage.
 * Combines multiple thinking blocks into a single memory-friendly format.
 * 
 * @param thinkingBlocks Array of thinking content
 * @param contextHint Optional context (e.g., channel, topic) for the memory
 */
export function formatThinkingForMemory(
  thinkingBlocks: string[],
  contextHint?: string
): string {
  if (thinkingBlocks.length === 0) {
    return '';
  }

  const timestamp = new Date().toISOString();
  const context = contextHint ? ` (context: ${contextHint})` : '';
  
  if (thinkingBlocks.length === 1) {
    return `[Internal thought${context} at ${timestamp}]: ${thinkingBlocks[0]}`;
  }

  const combined = thinkingBlocks
    .map((block, i) => `${i + 1}. ${block}`)
    .join('\n');
  
  return `[Internal thoughts${context} at ${timestamp}]:\n${combined}`;
}

/**
 * Check if content contains thinking tags without extracting them.
 * Useful for quick checks before doing full extraction.
 */
export function hasThinkingTags(content: string): boolean {
  if (!content) return false;
  return /<thinking>[\s\S]*?<\/thinking>/i.test(content);
}
