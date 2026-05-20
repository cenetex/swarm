/**
 * Thinking Tags Utility
 * 
 * Extracts hidden thought tags from bot responses.
 * - Hidden thought content should go into bot memory (internal reasoning)
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
 * Extract hidden thought tags from a response and return clean content.
 * 
 * Supports multiple thinking blocks and handles edge cases:
 * - Nested content (not supported - uses non-greedy match)
 * - Multiple blocks
 * - Multiline content
 * - Case-insensitive tags
 * - Both <thinking> and <thought> tag names
 * - Malformed leading tags like "<thought internal note\nUser reply"
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
  
  // Match hidden-thought tags (case-insensitive, multiline, non-greedy).
  const thinkingRegex = /<\s*(thinking|thought)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
  const malformedLeadingThoughtRegex = /^\s*<\s*(thinking|thought)\b(?!\s*\/?\s*>)([^\r\n]*)(?:\r?\n|$)/i;
  const thinkingOrphanOpenRegex = /\s*<\s*(?:thinking|thought)\s*>\s*/gi;
  const thinkingOrphanCloseRegex = /\s*<\s*\/\s*(?:thinking|thought)\s*>\s*/gi;
  const thinkingSelfClosingRegex = /\s*<\s*(?:thinking|thought)\s*\/\s*>\s*/gi;
  
  let match;
  while ((match = thinkingRegex.exec(content)) !== null) {
    const thinkingContent = match[2].trim();
    if (thinkingContent) {
      thinkingBlocks.push(thinkingContent);
    }
  }

  // Remove all thinking blocks from the content
  let cleanContent = content.replace(thinkingRegex, '').trim();

  const malformedLeadingThought = cleanContent.match(malformedLeadingThoughtRegex);
  if (malformedLeadingThought) {
    const thinkingContent = malformedLeadingThought[2].trim();
    if (thinkingContent) {
      thinkingBlocks.push(thinkingContent);
    }
    cleanContent = cleanContent.replace(malformedLeadingThoughtRegex, '').trim();
  }

  // Remove any remaining orphan/self-closing tags
  cleanContent = cleanContent
    .replace(thinkingSelfClosingRegex, ' ')
    .replace(thinkingOrphanOpenRegex, ' ')
    .replace(thinkingOrphanCloseRegex, ' ')
    .trim();
  
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
  return (
    /<\s*(thinking|thought)\s*>[\s\S]*?<\s*\/\s*\1\s*>/i.test(content) ||
    /^\s*<\s*(thinking|thought)\b(?!\s*\/?\s*>)/i.test(content)
  );
}
