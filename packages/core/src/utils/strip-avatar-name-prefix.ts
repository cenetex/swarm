/**
 * Strip avatar name prefix from LLM response.
 *
 * Models sometimes see `[Username]: message` in chat history and mimic the
 * pattern in their own output.  This function removes those prefixes.
 */
export function stripAvatarNamePrefix(
  content: string | undefined,
  avatarName: string | undefined,
): string {
  if (!content || !avatarName) return content || '';

  const escapedName = avatarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^\\[${escapedName}[^\\]]*\\]:\\s*`, 'i'),
    new RegExp(`^${escapedName}:\\s*`, 'i'),
  ];

  for (const pattern of patterns) {
    if (pattern.test(content)) {
      return content.replace(pattern, '').trim();
    }
  }

  return content;
}

