/**
 * Split text into Discord-safe chunks.
 *
 * Discord caps text messages at 2000 chars.
 * Sending anything over the limit returns a non-retryable 400, so long LLM
 * replies would disappear entirely.
 *
 * Strategy: prefer sentence breaks, then word breaks, then hard-cut.
 * Each chunk is returned as raw text, preserving whitespace from the input.
 */

/** Discord's hard cap for message content. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Split `text` into pieces each no longer than `maxLen`. If nonblank input
 * fits, returns `[text]` unchanged. Blank input returns no chunks so callers do
 * not attempt to send invalid empty Discord messages.
 */
export function splitForDiscord(text: string, maxLen = DISCORD_MESSAGE_LIMIT): string[] {
  if (maxLen <= 0) throw new Error('maxLen must be positive');
  if (text.trim().length === 0) return [];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const cut = findCut(slice);
    const chunk = remaining.slice(0, cut);
    if (chunk.trim().length > 0) chunks.push(chunk);
    remaining = remaining.slice(cut);
  }

  if (remaining.trim().length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Return an index in [1, slice.length] indicating where to cut. Prefers
 * sentence > word boundaries; falls back to the whole slice when
 * none exist inside it.
 */
function findCut(slice: string): number {
  const sentence = lastSentenceBreak(slice);
  if (sentence > slice.length / 2) return sentence;

  const newline = slice.lastIndexOf('\n');
  if (newline > slice.length / 2) return newline + 1;

  const space = slice.lastIndexOf(' ');
  if (space > slice.length / 2) return space + 1;

  // No good boundary in the second half — hard-cut.
  return slice.length;
}

/** Find the last `. `, `? `, or `! ` sequence and return the index after it. */
function lastSentenceBreak(slice: string): number {
  let best = -1;
  for (const marker of ['. ', '? ', '! ', '.\n', '?\n', '!\n']) {
    const idx = slice.lastIndexOf(marker);
    if (idx > best) best = idx + marker.length;
  }
  return best;
}
