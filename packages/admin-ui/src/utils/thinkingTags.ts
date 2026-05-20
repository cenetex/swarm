export interface ThinkingExtractionResult {
  cleanContent: string;
  thinkingBlocks: string[];
}

export function extractThinkingTags(content: string): ThinkingExtractionResult {
  if (!content) return { cleanContent: '', thinkingBlocks: [] };

  const thinkingBlocks: string[] = [];

  const thinkingRegex = /<\s*(thinking|thought)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
  const malformedLeadingThoughtRegex = /^\s*<\s*(thinking|thought)\b(?!\s*\/?\s*>)([^\r\n]*)(?:\r?\n|$)/i;
  const thinkingOrphanOpenRegex = /<\s*(?:thinking|thought)\s*>/gi;
  const thinkingOrphanCloseRegex = /<\s*\/\s*(?:thinking|thought)\s*>/gi;
  const thinkingSelfClosingRegex = /<\s*(?:thinking|thought)\s*\/\s*>/gi;

  let match: RegExpExecArray | null;
  while ((match = thinkingRegex.exec(content)) !== null) {
    const block = (match[2] ?? '').trim();
    if (block) thinkingBlocks.push(block);
  }

  let cleanContent = content.replace(thinkingRegex, '').trim();
  const malformedLeadingThought = cleanContent.match(malformedLeadingThoughtRegex);
  if (malformedLeadingThought) {
    const block = (malformedLeadingThought[2] ?? '').trim();
    if (block) thinkingBlocks.push(block);
    cleanContent = cleanContent.replace(malformedLeadingThoughtRegex, '').trim();
  }

  cleanContent = cleanContent
    .replace(thinkingSelfClosingRegex, '')
    .replace(thinkingOrphanOpenRegex, '')
    .replace(thinkingOrphanCloseRegex, '')
    .trim();

  cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, '\n\n').trim();

  return { cleanContent, thinkingBlocks };
}
