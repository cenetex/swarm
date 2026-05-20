const OPENROUTER_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;

/**
 * OpenRouter exposes some internal registry aliases with a leading "~".
 * Those IDs are not selectable runtime models for this app.
 */
export function isUsableOpenRouterModelId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.trim() !== value) return false;
  return OPENROUTER_MODEL_ID_PATTERN.test(value);
}
