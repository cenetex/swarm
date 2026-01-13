/**
 * Shared Zod schemas for admin tools
 */
import { z } from 'zod/v4';

// Secret types that can be stored/requested
export const SecretTypeSchema = z.enum([
  'telegram_bot_token',
  'discord_bot_token',
  'twitter_api_key',
  'twitter_api_secret',
  'twitter_access_token',
  'twitter_access_secret',
  'twitter_bearer_token',
  'helius_api_key',
  'replicate_api_key',
  'openrouter_api_key',
  'anthropic_api_key',
  'openai_api_key',
]);

export type SecretType = z.infer<typeof SecretTypeSchema>;

// Media types
export const MediaTypeSchema = z.enum(['image', 'video', 'sticker']);
export type MediaType = z.infer<typeof MediaTypeSchema>;

// Image source for profile images
export const ImageSourceSchema = z.enum(['generate', 'url', 'gallery', 'upload']);
export type ImageSource = z.infer<typeof ImageSourceSchema>;

// Image resolution
export const ResolutionSchema = z.enum(['1K', '2K', '4K']);
export type Resolution = z.infer<typeof ResolutionSchema>;

// Image aspect ratios
export const AspectRatioSchema = z.enum([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

// Reference image categories
export const ReferenceImageCategorySchema = z.enum([
  'profile', 'character', 'style', 'background', 'other',
]);
export type ReferenceImageCategory = z.infer<typeof ReferenceImageCategorySchema>;

// Common output schemas for tool results
export const SuccessResultSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const ErrorResultSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

export const JobResultSchema = z.object({
  jobId: z.string(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  message: z.string(),
  url: z.string().optional(),
});

// UI action types for pause-for-input tools
export const UIActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('secret_request'),
    secretType: SecretTypeSchema,
    label: z.string(),
    instructions: z.string().optional(),
  }),
  z.object({
    type: z.literal('model_selection'),
    models: z.array(z.object({
      id: z.string(),
      name: z.string(),
      pricing: z.object({
        prompt: z.number(),
        completion: z.number(),
      }).optional(),
    })),
    currentModel: z.string().optional(),
  }),
  z.object({
    type: z.literal('upload_widget'),
    uploadUrl: z.string(),
    s3Key: z.string(),
    publicUrl: z.string(),
    purpose: z.enum(['profile', 'reference']),
    category: ReferenceImageCategorySchema.optional(),
    name: z.string().optional(),
    description: z.string().optional(),
  }),
]);

export type UIAction = z.infer<typeof UIActionSchema>;
