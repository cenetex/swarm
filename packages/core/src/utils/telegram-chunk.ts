/**
 * Split text into Telegram-safe chunks.
 *
 * Telegram caps text messages at 4096 chars and media captions at 1024 chars.
 * Sending anything over the limit returns a non-retryable 400, so long LLM
 * replies would disappear entirely.
 *
 * Strategy: prefer paragraph breaks, then sentence breaks, then word breaks,
 * then hard-cut. Each chunk is returned as raw text — HTML conversion happens
 * per-chunk downstream so we never split across an HTML tag.
 */

/** Telegram's hard caps. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

/**
 * Split `text` into pieces each no longer than `maxLen`. If the input fits,
 * returns `[text]` unchanged.
 */
export function splitForTelegram(text: string, maxLen = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (maxLen <= 0) throw new Error('maxLen must be positive');
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const cut = findCut(slice);
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks.filter(c => c.length > 0);
}

/**
 * Return an index in [1, slice.length] indicating where to cut. Prefers
 * paragraph > sentence > word boundaries; falls back to the whole slice when
 * none exist inside it.
 */
function findCut(slice: string): number {
  const paragraph = slice.lastIndexOf('\n\n');
  if (paragraph > slice.length / 2) return paragraph + 2;

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
