/**
 * Emoji Selection for Stickers
 *
 * Maps sticker prompts to appropriate emoji based on keywords
 * Merged superset from both solanafirehorse and aws-swarm implementations
 */

/**
 * Select an appropriate emoji for a sticker based on its content/prompt
 * Uses keyword matching to find the most relevant emoji
 *
 * @param prompt - Optional description/prompt for the sticker
 * @returns Single emoji character/string
 */
export function selectStickerEmoji(prompt?: string): string {
  if (!prompt) return '😀';

  const lower = prompt.toLowerCase();

  // Fire/crypto themes
  if (lower.includes('fire') || lower.includes('burn')) return '🔥';
  if (lower.includes('diamond') || lower.includes('hodl')) return '💎';
  if (lower.includes('moon') || lower.includes('pump')) return '🚀';
  if (lower.includes('dump') || lower.includes('crash')) return '📉';
  if (lower.includes('scared') || lower.includes('fear')) return '😰';
  if (lower.includes('happy') || lower.includes('joy')) return '😄';
  if (lower.includes('angry') || lower.includes('rage')) return '😡';
  if (lower.includes('sad') || lower.includes('cry')) return '😢';
  if (lower.includes('laugh') || lower.includes('lol')) return '😂';
  if (lower.includes('love') || lower.includes('heart')) return '❤️';
  if (lower.includes('money') || lower.includes('rich')) return '💰';
  if (lower.includes('dip') || lower.includes('buy')) return '🛒';
  if (lower.includes('win') || lower.includes('profit')) return '🏆';
  if (lower.includes('rekt') || lower.includes('loss')) return '💀';
  if (lower.includes('party') || lower.includes('celebrat')) return '🎉';
  if (lower.includes('cool') || lower.includes('chill')) return '😎';
  if (lower.includes('think') || lower.includes('wonder')) return '🤔';
  if (lower.includes('wave') || lower.includes('hello') || lower.includes('hi')) return '👋';
  if (lower.includes('thumb') || lower.includes('good') || lower.includes('nice')) return '👍';

  // Default
  return '😀';
}
