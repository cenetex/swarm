export type OpenRouterImageModality = 'image' | 'text';

const TEXT_AND_IMAGE_OUTPUT_MODEL_PATTERNS = [
  /^google\/gemini-/,
];

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * OpenRouter image models do not all support the same output modalities.
 * FLUX/Sourceful-style image-only models must be called with ["image"], while
 * Gemini image models can return both text and images.
 */
export function openRouterImageModelSupportsTextOutput(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return TEXT_AND_IMAGE_OUTPUT_MODEL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getOpenRouterImageModalities(modelId: string): OpenRouterImageModality[] {
  return openRouterImageModelSupportsTextOutput(modelId)
    ? ['image', 'text']
    : ['image'];
}
