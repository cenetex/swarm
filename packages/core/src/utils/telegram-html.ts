/**
 * Telegram HTML Formatting Utilities
 *
 * Converts standard Markdown (as produced by LLMs) to Telegram-compatible HTML.
 * Uses HTML parse_mode because it is more forgiving than MarkdownV2 with
 * malformed input from non-deterministic model outputs.
 *
 * Supported conversions:
 *   **bold** / __bold__  -> <b>bold</b>
 *   *italic* / _italic_  -> <i>italic</i>
 *   ~~strikethrough~~    -> <s>strikethrough</s>
 *   `inline code`        -> <code>inline code</code>
 *   ```code block```     -> <pre>code block</pre>
 *   [text](url)          -> <a href="url">text</a>
 *
 * HTML special characters (&, <, >) in non-formatting text are escaped
 * before formatting tags are applied.
 */

/**
 * Escape HTML special characters in raw text.
 * Must be applied BEFORE markdown-to-HTML conversion so that user-supplied
 * angle brackets and ampersands don't break the parse_mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert standard Markdown to Telegram HTML.
 *
 * The function first escapes HTML entities, then applies formatting
 * conversions in a specific order to avoid conflicts between overlapping
 * patterns (e.g. `*` for italic vs `**` for bold).
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return markdown;

  // Step 1: Escape HTML special characters in the raw input
  let html = escapeHtml(markdown);

  // Step 2: Convert fenced code blocks (```...```) FIRST — content inside
  // should not have further formatting applied.
  // Handle both ```lang\ncode``` and ```code```
  const codeBlocks: string[] = [];
  html = html.replace(/```(?:[a-zA-Z]*\n)?([\s\S]*?)```/g, (_match, code: string) => {
    const placeholder = `\x00CB${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre>${code.trim()}</pre>`);
    return placeholder;
  });

  // Step 3: Convert inline code (`...`) — protect from further formatting
  const inlineCode: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const placeholder = `\x00IC${inlineCode.length}\x00`;
    inlineCode.push(`<code>${code}</code>`);
    return placeholder;
  });

  // Step 4: Convert links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Step 5: Convert bold — **text** or __text__
  // Use negative lookbehind/ahead to avoid matching inside words for __
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/(?<!\w)__(.+?)__(?!\w)/g, '<b>$1</b>');

  // Step 6: Convert italic — *text* or _text_
  // Avoid matching already-converted <b> tags or mid-word underscores
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  html = html.replace(/(?<!\w)_(?!_)(.+?)(?<!_)_(?!\w)/g, '<i>$1</i>');

  // Step 7: Convert strikethrough ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Step 8: Restore inline code placeholders
  for (let i = 0; i < inlineCode.length; i++) {
    html = html.replace(`\x00IC${i}\x00`, inlineCode[i]);
  }

  // Step 9: Restore code block placeholders
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CB${i}\x00`, codeBlocks[i]);
  }

  return html;
}

/**
 * Strip all Markdown formatting to produce plain text.
 * Used as a fallback when HTML parse_mode fails.
 */
export function stripMarkdown(markdown: string): string {
  if (!markdown) return markdown;

  let text = markdown;

  // Remove fenced code block markers
  text = text.replace(/```(?:[a-zA-Z]*\n)?([\s\S]*?)```/g, (_match, code: string) => code.trim());

  // Remove inline code markers
  text = text.replace(/`([^`\n]+)`/g, '$1');

  // Convert links to "text (url)"
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Remove bold markers
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/(?<!\w)__(.+?)__(?!\w)/g, '$1');

  // Remove italic markers
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1');
  text = text.replace(/(?<!\w)_(?!_)(.+?)(?<!_)_(?!\w)/g, '$1');

  // Remove strikethrough markers
  text = text.replace(/~~(.+?)~~/g, '$1');

  return text;
}
