/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Media Generation Service
 * Handles image, video, and sticker generation with multiple providers
 *
 * Uses core media resolvers for model/API key resolution to avoid duplication.
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { PutCommand, QueryCommand, DeleteCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHmac } from 'crypto';
import { v4 as uuid } from 'uuid';
import {
  createModelResolver,
  createApiKeyResolver,
  createTrialCreditConsumer,
  type ResolverConfig,
} from '@swarm/core/services';
import * as mediaJobs from './media-jobs.js';
import * as gallery from './gallery.js';
import * as credits from '../billing/credits.js';
import { _getSecretValueInternal } from '../secrets.js';
import { getReplicateVersion } from '../models-registry.js';
import { validateReplicateInputWithSchema } from './replicate-schema.js';
import type { MediaJob, GalleryItem, SecretType, AICapability } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';
import { buildMediaUrl, canonicalizeMediaUrl } from '../../utils/media-url.js';

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});
const dynamoClient = getDynamoClient();

const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const MEDIA_QUEUE_URL = process.env.MEDIA_QUEUE_URL;
const CDN_URL = process.env.CDN_URL;
const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const REPLICATE_WEBHOOK_SECRET = process.env.REPLICATE_WEBHOOK_SECRET || '';

function buildReplicateWebhookUrl(baseUrl: string, jobId: string): string {
  try {
    const webhook = new URL(baseUrl);
    webhook.searchParams.set('jobId', jobId);

    if (REPLICATE_WEBHOOK_SECRET) {
      const signature = createHmac('sha256', REPLICATE_WEBHOOK_SECRET).update(jobId).digest('hex');
      webhook.searchParams.set('sig', signature);
    }

    return webhook.toString();
  } catch {
    return `${baseUrl}?jobId=${jobId}`;
  }
}

// Core resolvers - use ADMIN_TABLE for admin-api context
const resolverConfig: ResolverConfig = {
  tableName: ADMIN_TABLE,
  dynamoClient: dynamoClient,
};
// These functions always return defined resolvers, so we can use non-null assertion
const coreModelResolver = createModelResolver(resolverConfig)!;
const coreApiKeyResolver = createApiKeyResolver(resolverConfig)!;
const coreTrialCreditConsumer = createTrialCreditConsumer(resolverConfig)!;

// Log CDN configuration on cold start
if (!CDN_URL) {
  console.warn('[Media] WARNING: CDN_URL is not set! S3 bucket is private, images will not be accessible via direct S3 URLs.');
} else {
  console.log(`[Media] CDN configured: ${CDN_URL}`);
}

// Timeout for external fetch operations (10 seconds)
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch with timeout using AbortController
 * Prevents hanging on slow/unresponsive external URLs
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url.slice(0, 100)}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Convert an S3 URL to a publicly accessible URL.
 * If CDN is configured, returns CDN URL.
 * Otherwise, generates a signed S3 URL (valid for 1 hour).
 */
async function makeUrlAccessible(url: string): Promise<string> {
  // If it's already a CDN URL or external URL, return as-is
  if (!url.includes('.s3.amazonaws.com') && !url.includes('.s3.us-')) {
    return url;
  }

  // If CDN is configured, canonicalize S3 URL to CDN URL
  if (CDN_URL) {
    return canonicalizeMediaUrl(url, CDN_URL);
  }

  // No CDN - generate a signed URL for temporary public access
  console.log(`[Media] No CDN, generating signed URL for: ${url.slice(0, 50)}...`);
  const s3UrlPattern = /https:\/\/([^.]+)\.s3[^/]*\.amazonaws\.com\/(.+)/;
  const match = url.match(s3UrlPattern);
  if (match) {
    const [, bucket, key] = match;
    const command = new GetObjectCommand({ Bucket: bucket, Key: decodeURIComponent(key) });
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return signedUrl;
  }

  return url;
}

/**
 * Make multiple URLs accessible for external services like Replicate
 * Uses Promise.allSettled to handle partial failures gracefully
 */
async function makeUrlsAccessible(urls: string[]): Promise<string[]> {
  const results = await Promise.allSettled(urls.map(url => makeUrlAccessible(url)));
  const successfulUrls: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      successfulUrls.push(result.value);
    } else {
      console.warn(`[Media] Failed to make URL accessible: ${urls[i]?.slice(0, 50)}...`, result.reason);
      // Include the original URL as fallback
      successfulUrls.push(urls[i]);
    }
  }

  return successfulUrls;
}

// Provider configuration
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';

function summarizeReplicateError(errorText: string, status?: number): string {
  const raw = (errorText || '').trim();
  if (!raw) return status ? `Replicate request failed (HTTP ${status}).` : 'Replicate request failed.';

  // Try to extract a useful message from JSON error bodies.
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const detail = typeof obj.detail === 'string' ? obj.detail : undefined;
        const title = typeof obj.title === 'string' ? obj.title : undefined;
        const error = typeof obj.error === 'string' ? obj.error : undefined;
        const message = typeof obj.message === 'string' ? obj.message : undefined;
        const candidate = detail || error || message || title;
        if (candidate && candidate.trim()) return candidate.trim();
      }
    } catch {
      // fall through
    }
  }

  // Common Replicate error we see when version hashes drift.
  if (/invalid version or not permitted/i.test(raw)) {
    return 'Replicate rejected the configured model version. Please switch to a different model or remove the pinned version.';
  }

  // Prevent raw JSON blobs from leaking into chat.
  if (raw.length > 240) return `${raw.slice(0, 240)}…`;
  return raw;
}

function shouldRetryAsModelEndpoint(status: number, errorText: string, hadVersion: boolean): boolean {
  if (!hadVersion) return false;
  if (status !== 422) return false;
  return /invalid version or not permitted/i.test(errorText);
}
// Use core resolvers for API key resolution (includes trial credits) and model resolution
// These replace the duplicated getImageGenerationApiKey, getSystemReplicateKey,
// consumeImageGenerationTrial, and getConfiguredModel functions

interface ResolvedApiKeyWithSource {
  key: string;
  isTrialUsage: boolean;
  source: 'avatar' | 'system' | 'trial';
  trialCreditsAvailable?: number;
}

/**
 * Get Replicate API key for image generation using core resolver
 * Handles avatar key -> system key -> trial credits fallback
 * Note: For trial usage, credits are checked but NOT consumed here.
 * Caller must call consumeTrialCreditAfterSuccess() after successful operation.
 */
async function getImageGenerationApiKey(avatarId: string): Promise<ResolvedApiKeyWithSource> {
  const resolved = await coreApiKeyResolver(avatarId, 'replicate');
  const isTrialUsage = resolved.source === 'trial';
  if (resolved.source === 'trial' && resolved.trialCreditsAvailable !== undefined) {
    console.log(`[Media] Using Replicate trial key: avatar=${avatarId}, credits available=${resolved.trialCreditsAvailable}`);
  } else {
    console.log(`[Media] Using Replicate key source: avatar=${avatarId}, source=${resolved.source}`);
  }
  return {
    key: resolved.key,
    isTrialUsage,
    source: resolved.source,
    trialCreditsAvailable: resolved.trialCreditsAvailable,
  };
}

/**
 * Consume trial credit after successful image generation
 * Only call this when getImageGenerationApiKey returned isTrialUsage=true
 */
async function consumeTrialCreditAfterSuccess(avatarId: string): Promise<number> {
  const result = await coreTrialCreditConsumer(avatarId);
  return result.remaining;
}

/**
 * Get the configured model for an avatar's capability using core resolver
 */
async function getConfiguredModel(
  avatarId: string,
  capability: AICapability
): Promise<string> {
  const resolved = await coreModelResolver(avatarId, capability);
  return resolved.model;
}

interface GenerateImageOptions {
  prompt: string;
  avatarId: string;
  platform?: string;
  model?: string;
  referenceImageUrls?: string[]; // Array of reference images (profile, gallery, etc.)
  resolution?: '1K' | '2K' | '4K';
  aspectRatio?: 'match_input_image' | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9';
  chargeEnergy?: boolean;
}

interface GenerateVideoOptions {
  prompt: string;
  avatarId: string;
  platform?: string;
  conversationId: string;
  replyToMessageId?: string;
  model?: string;
  referenceImageUrl?: string;
}

interface GenerateStickerOptions {
  prompt: string;
  avatarId: string;
  platform?: string;
  sourceImageId?: string; // Convert existing image to sticker
}

/**
 * Reference image categories
 */
export type ReferenceImageCategory = 
  | 'profile'      // Avatar's profile/avatar
  | 'character'    // Character reference for consistency
  | 'style'        // Style reference images
  | 'background'   // Background/scene references
  | 'other';       // Miscellaneous references

interface ReferenceImageUploadResult {
  uploadUrl: string;
  s3Key: string;
  publicUrl: string;
  category: ReferenceImageCategory;
}

/**
 * Generate a signed URL for uploading a profile image
 */
export async function getProfileImageUploadUrl(avatarId: string): Promise<{
  uploadUrl: string;
  s3Key: string;
  publicUrl: string;
}> {
  const s3Key = `avatars/${avatarId}/profile/${uuid()}.png`;

  const command = new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    ContentType: 'image/png',
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const publicUrl = buildMediaUrl(s3Key, MEDIA_BUCKET, CDN_URL);

  return { uploadUrl, s3Key, publicUrl };
}

/**
 * Generate a signed URL for uploading a reference image
 */
export async function getReferenceImageUploadUrl(
  avatarId: string,
  category: ReferenceImageCategory,
  filename?: string,
  contentType: string = 'image/png'
): Promise<ReferenceImageUploadResult> {
  const extension = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
  const safeName = filename 
    ? filename.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 50) 
    : uuid().slice(0, 8);
  const s3Key = `avatars/${avatarId}/references/${category}/${safeName}-${uuid().slice(0, 8)}.${extension}`;

  const command = new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const publicUrl = buildMediaUrl(s3Key, MEDIA_BUCKET, CDN_URL);

  return { uploadUrl, s3Key, publicUrl, category };
}

/**
 * Get API key for a provider
 */
export async function getProviderApiKey(
  avatarId: string,
  provider: 'openrouter' | 'replicate' | 'openai'
): Promise<string | null> {
  // For replicate, use core resolver which handles avatar key -> system key -> trial credits
  if (provider === 'replicate') {
    try {
      const resolved = await coreApiKeyResolver(avatarId, 'replicate');
      return resolved.key;
    } catch {
      return null;
    }
  }

  // For other providers, use the secrets service
  const secretTypes: Record<'openrouter' | 'openai', SecretType> = {
    openrouter: 'openrouter_api_key',
    openai: 'openai_api_key',
  };

  // Try avatar-specific key first, then global
  let key = await _getSecretValueInternal(avatarId, secretTypes[provider], 'default');
  if (!key) {
    key = await _getSecretValueInternal(null, secretTypes[provider], 'default');
  }

  return key;
}

/**
 * Generate an image synchronously using Replicate
 * Supports multiple reference images for character/style consistency
 * Returns immediately with the generated image URL
 */
export async function generateImage(options: GenerateImageOptions): Promise<GalleryItem> {
  const {
    prompt,
    avatarId,
    platform,
    model,
    referenceImageUrls = [],
    resolution = '2K',
    aspectRatio = '1:1',
    chargeEnergy = true,
  } = options;

  // Unified burst pool check: entitlement-first, energy-fallback
  if (chargeEnergy) {
    const burstCheck = await credits.checkMediaWithEnergyFallback(avatarId);
    if (!burstCheck.allowed) {
      throw new Error(burstCheck.reason || 'Media generation not allowed');
    }
  } else {
    // Even when not charging energy, still check tool rate limit
    const canUse = await credits.canUseTool(avatarId, 'generate_image');
    if (!canUse.allowed) {
      throw new Error(`Rate limited: ${canUse.reason}`);
    }
  }

  // Get Replicate API key (avatar key or system trial)
  // Note: For trial usage, credits are checked but NOT consumed yet
  const { key: apiKey, isTrialUsage, source: apiKeySource } = await getImageGenerationApiKey(avatarId);

  // Build the prompt with reference context if images provided
  let finalPrompt = prompt;
  if (referenceImageUrls.length > 0) {
    finalPrompt = `${prompt}. Use the provided reference images to maintain visual consistency with the character's appearance, style, and features.`;
  }

  // Get model - use provided model, avatar's configured model, or system default
  const modelId = model || await getConfiguredModel(avatarId, 'image_generation');
  const version = getReplicateVersion(modelId);

  console.log(`[Media] Using image model: ${modelId}${version ? ` (version: ${version.slice(0, 8)}...)` : ' (using /models API)'}; keySource=${apiKeySource}`);

  // Convert reference image URLs to publicly accessible URLs
  // (CDN URLs if available, otherwise signed S3 URLs)
  const accessibleReferenceUrls = referenceImageUrls.length > 0
    ? await makeUrlsAccessible(referenceImageUrls)
    : [];

  if (accessibleReferenceUrls.length > 0) {
    console.log(`[Media] Reference images converted to accessible URLs: ${accessibleReferenceUrls.length}`);
  }

  // Build generic input — schema validation will strip unsupported params
  const hasReferenceImages = accessibleReferenceUrls.length > 0;
  const genericInput: Record<string, unknown> = {
    prompt: finalPrompt,
    aspect_ratio: hasReferenceImages ? 'match_input_image' : aspectRatio,
    output_format: 'png',
    num_outputs: 1,
    resolution,
    safety_filter_level: 'block_only_high',
  };

  // Add reference images (models that support it accept image_input or image)
  if (hasReferenceImages) {
    genericInput.image_input = accessibleReferenceUrls.slice(0, 14);
    genericInput.image = accessibleReferenceUrls[0];
  }

  // Add width/height for models that use pixel dimensions instead of aspect_ratio
  const widthMap = { '4K': 2048, '2K': 1024, '1K': 512 } as const;
  genericInput.width = widthMap[resolution as keyof typeof widthMap] ?? 1024;
  genericInput.height = widthMap[resolution as keyof typeof widthMap] ?? 1024;

  // Validate input against model's schema — strips unsupported params automatically
  let validatedInput = genericInput;
  try {
    const { cleanedInput, adjustments } = await validateReplicateInputWithSchema(
      modelId, genericInput, apiKey, dynamoClient, ADMIN_TABLE,
    );
    validatedInput = cleanedInput;
    if (adjustments.length > 0) {
      console.log(`[Media] Schema validation adjusted input for ${modelId}:`, adjustments);
    }
  } catch (err) {
    console.warn(`[Media] Schema validation failed for ${modelId}, sending generic input:`, err);
  }

  console.log(`Generating image with ${modelId}, refs: ${referenceImageUrls.length}, prompt: ${prompt.slice(0, 50)}...`);

  // Start Replicate prediction - use version-based or model-based API
  const endpoint = version
    ? REPLICATE_ENDPOINT
    : `https://api.replicate.com/v1/models/${modelId}/predictions`;

  const requestBody: Record<string, unknown> = {
    input: validatedInput,
  };
  if (version) {
    requestBody.version = version;
  }

  let response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Replicate expects Token auth for both endpoints
      'Authorization': `Token ${apiKey}`,
      'Prefer': 'wait', // Wait for completion (up to 60s for fast models)
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const status = response.status;
    console.error(`Replicate API error: ${status}`, errorText);

    // If version-based run fails due to stale/invalid version, retry via /models endpoint.
    if (shouldRetryAsModelEndpoint(status, errorText, Boolean(version))) {
      const fallbackEndpoint = `https://api.replicate.com/v1/models/${modelId}/predictions`;
      const fallbackBody = { input: requestBody.input };
      console.warn(`[Media] Retrying image generation via model endpoint: ${fallbackEndpoint}`);
      response = await fetch(fallbackEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token ${apiKey}`,
          'Prefer': 'wait',
        },
        body: JSON.stringify(fallbackBody),
      });

      if (!response.ok) {
        const fallbackErrorText = await response.text();
        const fallbackStatus = response.status;
        console.error(`Replicate API error (fallback): ${fallbackStatus}`, fallbackErrorText);
        throw new Error(`Image generation failed: ${summarizeReplicateError(fallbackErrorText, fallbackStatus)}`);
      }
    } else {
      throw new Error(`Image generation failed: ${summarizeReplicateError(errorText, status)}`);
    }
  }

  // Parse initial response
  let prediction = await response.json() as {
    id: string;
    status: string;
    output?: string | string[] | { uri?: string };
    error?: string;
  };

  console.log(`Prediction started: ${prediction.id}, status: ${prediction.status}`);

  // Poll for completion
  const maxAttempts = 120; // 120 seconds max for slower models
  let attempts = 0;

  while (prediction.status === 'starting' || prediction.status === 'processing') {
    if (attempts++ >= maxAttempts) {
      console.error(`Prediction ${prediction.id} timed out after ${attempts} seconds`);
      throw new Error('Image generation timed out');
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const pollResponse = await fetch(`${REPLICATE_ENDPOINT}/${prediction.id}`, {
      headers: { 'Authorization': `Token ${apiKey}` },
    });
    prediction = await pollResponse.json() as typeof prediction;

    if (attempts % 10 === 0) {
      console.log(`Prediction ${prediction.id} still ${prediction.status} after ${attempts}s`);
    }
  }

  console.log(`Prediction ${prediction.id} completed with status: ${prediction.status}`);

  if (prediction.status === 'failed') {
    console.error(`Prediction failed:`, prediction.error);
    throw new Error(`Image generation failed: ${prediction.error || 'Unknown error'}`);
  }

  if (prediction.status !== 'succeeded') {
    throw new Error(`Unexpected prediction status: ${prediction.status}`);
  }

  // Get output URL - handle different output formats
  let outputUrl: string | undefined;
  if (Array.isArray(prediction.output)) {
    outputUrl = prediction.output[0];
  } else if (typeof prediction.output === 'string') {
    outputUrl = prediction.output;
  } else if (prediction.output && typeof prediction.output === 'object' && 'uri' in prediction.output) {
    outputUrl = prediction.output.uri;
  }

  if (!outputUrl) {
    console.error('No output URL in prediction:', JSON.stringify(prediction));
    throw new Error('No image returned from Replicate');
  }

  console.log(`Image generated by Replicate: ${outputUrl}`);

  // Download from Replicate
  console.log(`Downloading image from Replicate...`);
  const imageResponse = await fetch(outputUrl);
  if (!imageResponse.ok) {
    console.error(`Failed to download from Replicate: ${imageResponse.status} ${imageResponse.statusText}`);
    throw new Error(`Failed to download generated image: ${imageResponse.status}`);
  }

  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  console.log(`Downloaded image: ${imageBuffer.length} bytes`);

  // Upload to S3
  const imageId = gallery.generateGalleryId();
  const s3Key = `avatars/${avatarId}/images/${imageId}.png`;

  console.log(`Uploading to S3: bucket=${MEDIA_BUCKET}, key=${s3Key}`);
  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: imageBuffer,
    ContentType: 'image/png',
  }));
  console.log(`S3 upload successful`);

  // Consume trial credit AFTER successful generation (only for trial users)
  if (isTrialUsage) {
    const remaining = await consumeTrialCreditAfterSuccess(avatarId);
    console.log(`[Media] Trial credit consumed after success: avatar=${avatarId}, remaining=${remaining}`);
  }

  // Consume rate-limit credit (for non-trial users only to avoid double-charging)
  if (!isTrialUsage) {
    await credits.consumeCredit(avatarId, 'generate_image');
  }

  // Energy was already consumed in burst fallback (if applicable) during the
  // unified checkMediaWithEnergyFallback call. No separate consumption needed.

  // Construct public URL
  // IMPORTANT: CDN_URL should be set to your CloudFront distribution URL
  // If not set, falls back to direct S3 URL (which requires public bucket)
  const publicUrl = buildMediaUrl(s3Key, MEDIA_BUCKET, CDN_URL);
  console.log(`Public URL: ${publicUrl} (CDN_URL=${CDN_URL || 'NOT SET'})`);

  const galleryItem = await gallery.addToGallery(avatarId, {
    id: imageId,
    type: 'image',
    url: publicUrl,
    s3Key,
    prompt,
    model: modelId,
    platform,
  });

  console.log(`Gallery item created: ${galleryItem.id}`);
  return galleryItem;
}

/**
 * Options for async image generation
 */
interface GenerateImageAsyncOptions extends GenerateImageOptions {
  conversationId: string;
  replyToMessageId?: string;
  apiKey?: string;
}

/**
 * Generate an image asynchronously
 * Returns a job ID - image will be delivered via callback when complete
 * Use this for long-running operations to avoid HTTP timeouts
 */
export async function generateImageAsync(options: GenerateImageAsyncOptions): Promise<MediaJob> {
  const {
    prompt,
    avatarId,
    platform,
    model,
    referenceImageUrls = [],
    resolution = '2K',
    aspectRatio = '1:1',
    conversationId,
    replyToMessageId,
    chargeEnergy = true,
    apiKey: apiKeyOverride,
  } = options;

  // Unified burst pool check: entitlement-first, energy-fallback
  if (chargeEnergy) {
    const burstCheck = await credits.checkMediaWithEnergyFallback(avatarId);
    if (!burstCheck.allowed) {
      throw new Error(burstCheck.reason || 'Media generation not allowed');
    }
  } else {
    const canUse = await credits.canUseTool(avatarId, 'generate_image');
    if (!canUse.allowed) {
      throw new Error(`Rate limited: ${canUse.reason}`);
    }
  }

  // Get Replicate API key
  // Note: For async jobs, we consume trial credits at job start (not ideal, but webhook
  // handler would need significant changes to consume on completion)
  let apiKey: string;
  let isTrialUsage = false;
  if (apiKeyOverride) {
    apiKey = apiKeyOverride;
  } else {
    const resolved = await getImageGenerationApiKey(avatarId);
    apiKey = resolved.key;
    isTrialUsage = resolved.isTrialUsage;
  }

  // Build the prompt with reference context if images provided
  let finalPrompt = prompt;
  if (referenceImageUrls.length > 0) {
    finalPrompt = `${prompt}. Use the provided reference images to maintain visual consistency with the character's appearance, style, and features.`;
  }

  // Get model - use provided model, avatar's configured model, or system default
  const modelId = model || await getConfiguredModel(avatarId, 'image_generation');
  const version = getReplicateVersion(modelId);

  console.log(`[Media] Async image gen using model: ${modelId}${version ? ` (version: ${version.slice(0, 8)}...)` : ' (using /models API)'}`);

  // Convert reference image URLs to publicly accessible URLs
  const accessibleReferenceUrls = referenceImageUrls.length > 0
    ? await makeUrlsAccessible(referenceImageUrls)
    : [];

  if (accessibleReferenceUrls.length > 0) {
    console.log(`[Media] Reference images converted to accessible URLs: ${accessibleReferenceUrls.length}`);
  }

  // Build generic input — schema validation will strip unsupported params
  const hasReferenceImages = accessibleReferenceUrls.length > 0;
  const asyncGenericInput: Record<string, unknown> = {
    prompt: finalPrompt,
    aspect_ratio: hasReferenceImages ? 'match_input_image' : aspectRatio,
    output_format: 'png',
    num_outputs: 1,
    resolution,
    safety_filter_level: 'block_only_high',
  };

  if (hasReferenceImages) {
    asyncGenericInput.image_input = accessibleReferenceUrls.slice(0, 14);
    asyncGenericInput.image = accessibleReferenceUrls[0];
  }

  const asyncWidthMap = { '4K': 2048, '2K': 1024, '1K': 512 } as const;
  asyncGenericInput.width = asyncWidthMap[resolution as keyof typeof asyncWidthMap] ?? 1024;
  asyncGenericInput.height = asyncWidthMap[resolution as keyof typeof asyncWidthMap] ?? 1024;

  // Validate input against model's schema
  let asyncValidatedInput = asyncGenericInput;
  try {
    const { cleanedInput, adjustments } = await validateReplicateInputWithSchema(
      modelId, asyncGenericInput, apiKey, dynamoClient, ADMIN_TABLE,
    );
    asyncValidatedInput = cleanedInput;
    if (adjustments.length > 0) {
      console.log(`[Media] Async schema validation adjusted input for ${modelId}:`, adjustments);
    }
  } catch (err) {
    console.warn(`[Media] Async schema validation failed for ${modelId}, sending generic input:`, err);
  }

  // Create job record
  const jobId = uuid();
  const job = await mediaJobs.createJob({
    jobId,
    avatarId,
    type: 'image',
    prompt,
    conversationId,
    platform: platform || 'unknown',
    replyToMessageId,
    provider: 'replicate',
  });

  console.log(`[Media] Starting async image generation: job=${jobId}, model=${modelId}, refs=${referenceImageUrls.length}`);

  // Start Replicate prediction with webhook (async - don't wait)
  const webhookUrl = process.env.REPLICATE_WEBHOOK_URL;

  // Choose endpoint based on whether model has a version hash
  const asyncEndpoint = version
    ? REPLICATE_ENDPOINT
    : `https://api.replicate.com/v1/models/${modelId}/predictions`;

  // Build request body - only include webhook config when URL is configured
  const requestBody: Record<string, unknown> = {
    input: asyncValidatedInput,
  };
  if (version) {
    requestBody.version = version;
  }

  if (webhookUrl) {
    requestBody.webhook = buildReplicateWebhookUrl(webhookUrl, jobId);
    requestBody.webhook_events_filter = ['completed'];
  }

  let response = await fetch(asyncEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Replicate expects Token auth for both endpoints
      'Authorization': `Token ${apiKey}`,
      // Note: NOT using 'Prefer: wait' - we want async processing
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const status = response.status;

    if (shouldRetryAsModelEndpoint(status, errorText, Boolean(version))) {
      const fallbackEndpoint = `https://api.replicate.com/v1/models/${modelId}/predictions`;
      const fallbackBody: Record<string, unknown> = { input: requestBody.input };
      if (webhookUrl) {
        fallbackBody.webhook = requestBody.webhook;
        fallbackBody.webhook_events_filter = requestBody.webhook_events_filter;
      }

      console.warn(`[Media] Retrying async image generation via model endpoint: ${fallbackEndpoint}`);
      response = await fetch(fallbackEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token ${apiKey}`,
        },
        body: JSON.stringify(fallbackBody),
      });

      if (!response.ok) {
        const fallbackErrorText = await response.text();
        const fallbackStatus = response.status;
        await mediaJobs.updateJobStatus(jobId, 'failed', { error: summarizeReplicateError(fallbackErrorText, fallbackStatus) });
        throw new Error(`Image generation failed to start: ${summarizeReplicateError(fallbackErrorText, fallbackStatus)}`);
      }
    } else {
      await mediaJobs.updateJobStatus(jobId, 'failed', { error: summarizeReplicateError(errorText, status) });
      throw new Error(`Image generation failed to start: ${summarizeReplicateError(errorText, status)}`);
    }
  }

  const prediction = await response.json() as { id: string };

  // Update job with external ID
  await mediaJobs.updateJobStatus(jobId, 'processing', { externalId: prediction.id });

  // Consume credits - trial users consume trial credits, non-trial users consume rate-limit credits
  // Note: For async jobs, we consume at job submission (not ideal, but webhook handler
  // would need significant changes to consume on completion)
  if (isTrialUsage) {
    const remaining = await consumeTrialCreditAfterSuccess(avatarId);
    console.log(`[Media] Trial credit consumed for async job: avatar=${avatarId}, remaining=${remaining}`);
  } else {
    await credits.consumeCredit(avatarId, 'generate_image');
  }

  // Energy was already consumed in burst fallback (if applicable) during the
  // unified checkMediaWithEnergyFallback call. No separate consumption needed.

  console.log(`[Media] Async image job started: job=${jobId}, prediction=${prediction.id}`);

  return job;
}

/**
 * Generate a video asynchronously
 * Returns a job ID - video will be delivered via callback
 */
export async function generateVideo(options: GenerateVideoOptions): Promise<MediaJob> {
  const {
    prompt, avatarId, platform, conversationId, replyToMessageId,
    model, referenceImageUrl
  } = options;

  // Unified burst pool check: entitlement-first, energy-fallback
  const videoBurstCheck = await credits.checkVideoWithEnergyFallback(avatarId);
  if (!videoBurstCheck.allowed) {
    throw new Error(videoBurstCheck.reason || 'Video generation not allowed');
  }

  // Get Replicate API key
  const apiKey = await getProviderApiKey(avatarId, 'replicate');
  if (!apiKey) {
    throw new Error('No Replicate API key configured. Please set up an API key first.');
  }

  // Create job record
  const jobId = uuid();
  const job = await mediaJobs.createJob({
    jobId,
    avatarId,
    type: 'video',
    prompt,
    conversationId,
    platform: platform || 'unknown',
    replyToMessageId,
    provider: 'replicate',
  });

  // Start Replicate prediction with webhook
  const webhookUrl = process.env.REPLICATE_WEBHOOK_URL;

  // Get model - use provided model, avatar's configured model, or system default
  const videoModel = model || await getConfiguredModel(avatarId, 'video_generation');
  console.log(`[Media] Using video model: ${videoModel}`);

  // Use the models API endpoint (video models typically don't use version hashes)
  // Format: https://api.replicate.com/v1/models/{owner}/{name}/predictions
  const modelEndpoint = `https://api.replicate.com/v1/models/${videoModel}/predictions`;

  const requestBody: Record<string, unknown> = {
    input: {
      prompt,
      ...(referenceImageUrl && { first_frame_image: referenceImageUrl }),
    },
  };

  // Only include webhook config when webhook URL is configured
  if (webhookUrl) {
    requestBody.webhook = buildReplicateWebhookUrl(webhookUrl, jobId);
    requestBody.webhook_events_filter = ['completed'];
  }

  const response = await fetch(modelEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Replicate expects Token auth for model predictions API
      'Authorization': `Token ${apiKey}`,
      'Prefer': 'wait=5',  // Short wait to get initial status
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const status = response.status;
    await mediaJobs.updateJobStatus(jobId, 'failed', { error: summarizeReplicateError(errorText, status) });
    throw new Error(`Video generation failed to start: ${summarizeReplicateError(errorText, status)}`);
  }

  const prediction = await response.json() as { id: string };

  // Update job with external ID
  await mediaJobs.updateJobStatus(jobId, 'processing', { externalId: prediction.id });

  // Consume rate-limit credit (energy was already handled in burst check)
  await credits.consumeCredit(avatarId, 'generate_video');

  return job;
}

/**
 * Generate a sticker (image with background removal)
 */
export async function generateSticker(options: GenerateStickerOptions): Promise<GalleryItem> {
  const { prompt, avatarId, platform, sourceImageId } = options;

  // Unified burst pool check: entitlement-first, energy-fallback
  const stickerBurstCheck = await credits.checkMediaWithEnergyFallback(avatarId);
  if (!stickerBurstCheck.allowed) {
    throw new Error(stickerBurstCheck.reason || 'Sticker generation not allowed');
  }

  let imageUrl: string;
  let originalS3Key: string | undefined;

  if (sourceImageId) {
    // Convert existing image to sticker
    const sourceItem = await gallery.getGalleryItem(avatarId, sourceImageId);
    if (!sourceItem) {
      throw new Error(`Source image not found: ${sourceImageId}`);
    }
    imageUrl = sourceItem.url;
    originalS3Key = sourceItem.s3Key;
  } else {
    // Generate new image first
    const image = await generateImage({
      prompt: `${prompt}, simple clean design suitable for sticker, transparent background style`,
      avatarId,
      platform,
      resolution: '1K',
      aspectRatio: '1:1',
      chargeEnergy: false,
    });
    imageUrl = image.url;
    originalS3Key = image.s3Key;
  }

  // Get Replicate API key for background removal
  const apiKey = await getProviderApiKey(avatarId, 'replicate');
  if (!apiKey) {
    throw new Error('No Replicate API key configured for background removal.');
  }

  // Run background removal model
  const response = await fetch(REPLICATE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${apiKey}`,
    },
    body: JSON.stringify({
      // Using rembg model for background removal
      version: 'fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003',
      input: {
        image: imageUrl,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Background removal failed: ${error}`);
  }

  // Poll for completion (rembg is usually fast)
  const prediction = await response.json() as { id: string; status: string; output?: string };
  let result = prediction;

  while (result.status === 'starting' || result.status === 'processing') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const pollResponse = await fetch(`${REPLICATE_ENDPOINT}/${result.id}`, {
      headers: { 'Authorization': `Token ${apiKey}` },
    });
    result = await pollResponse.json() as typeof prediction;
  }

  if (result.status !== 'succeeded' || !result.output) {
    throw new Error('Background removal failed');
  }

  // Download result and convert to WebP for Telegram
  const stickerResponse = await fetch(result.output);
  const stickerBuffer = Buffer.from(await stickerResponse.arrayBuffer());

  // Store as sticker
  const stickerId = gallery.generateGalleryId();
  const s3Key = `avatars/${avatarId}/stickers/${stickerId}.webp`;

  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: stickerBuffer,
    ContentType: 'image/webp',
  }));

  // Consume rate-limit credit (energy was already handled in burst check)
  await credits.consumeCredit(avatarId, 'generate_sticker');

  // Mark original as converted if it was from gallery
  if (sourceImageId && originalS3Key) {
    const sourceItem = await gallery.getGalleryItem(avatarId, sourceImageId);
    if (sourceItem) {
      await gallery.markConvertedToSticker(avatarId, sourceImageId, sourceItem.sk);
    }
  }

  // Add to gallery
  const publicUrl = buildMediaUrl(s3Key, MEDIA_BUCKET, CDN_URL);

  const galleryItem = await gallery.addToGallery(avatarId, {
    id: stickerId,
    type: 'sticker',
    url: publicUrl,
    s3Key,
    prompt,
    model: 'rembg',
    platform,
    metadata: { sourceImageId },
  });

  return galleryItem;
}

export async function generateProfileImageAsync(
  avatarId: string,
  prompt: string
): Promise<MediaJob> {
  const canUse = await credits.canUseTool(avatarId, 'set_profile_image');
  if (!canUse.allowed) {
    throw new Error(`Rate limited: ${canUse.reason}`);
  }

  const profilePrompt = `${prompt}, professional profile picture, centered subject, clean background`;
  const job = await generateImageAsync({
    prompt: profilePrompt,
    avatarId,
    platform: 'profile',
    resolution: '1K',
    aspectRatio: '1:1',
    conversationId: '',
  });

  const consumed = await credits.consumeCredit(avatarId, 'set_profile_image');
  if (!consumed) {
    console.warn(`[Credits] Failed to consume credit for set_profile_image: avatar=${avatarId}`);
  }

  return job;
}

/**
 * Set avatar profile image from URL or generated image
 */
export async function setProfileImage(
  avatarId: string,
  source: { type: 'url'; url: string } | { type: 'generate'; prompt: string } | { type: 'gallery'; imageId: string }
): Promise<{ url: string; s3Key: string }> {
  // Check credits for set_profile_image
  const canUse = await credits.canUseTool(avatarId, 'set_profile_image');
  if (!canUse.allowed) {
    throw new Error(`Rate limited: ${canUse.reason}`);
  }

  let imageBuffer: Buffer;

  if (source.type === 'url') {
    // Download from URL
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else if (source.type === 'generate') {
    // Generate a new profile image
    const image = await generateImage({
      prompt: `${source.prompt}, professional profile picture, centered subject, clean background`,
      avatarId,
      platform: 'profile',
      resolution: '1K',
      aspectRatio: '1:1',
    });

    // Download from our storage
    const response = await fetch(image.url);
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else if (source.type === 'gallery') {
    // Use existing gallery image
    const item = await gallery.getGalleryItem(avatarId, source.imageId);
    if (!item) {
      throw new Error(`Image not found in gallery: ${source.imageId}`);
    }

    const response = await fetch(item.url);
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error('Invalid source type');
  }

  // Store as profile image
  const s3Key = `avatars/${avatarId}/profile/${uuid()}.png`;

  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: imageBuffer,
    ContentType: 'image/png',
  }));

  // Consume credit
  await credits.consumeCredit(avatarId, 'set_profile_image');

  const publicUrl = buildMediaUrl(s3Key, MEDIA_BUCKET, CDN_URL);

  return { url: publicUrl, s3Key };
}

/**
 * Generate a signed URL for uploading a character reference image
 */
export async function getCharacterReferenceUploadUrl(avatarId: string): Promise<{
  uploadUrl: string;
  s3Key: string;
  publicUrl: string;
}> {
  const s3Key = `avatars/${avatarId}/character-reference/${uuid()}.png`;

  const command = new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    ContentType: 'image/png',
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const publicUrl = buildMediaUrl(s3Key, MEDIA_BUCKET, CDN_URL);

  return { uploadUrl, s3Key, publicUrl };
}

/**
 * Set avatar character reference from URL, upload, or gallery
 * Character reference is used for full-body consistency in image/video generation
 */
export async function setCharacterReference(
  avatarId: string,
  source: { type: 'url'; url: string } | { type: 'generate'; prompt: string } | { type: 'gallery'; imageId: string },
  description?: string
): Promise<{ url: string; s3Key: string }> {
  // Check credits - use dedicated character reference bucket
  const canUse = await credits.canUseTool(avatarId, 'set_character_reference');
  if (!canUse.allowed) {
    throw new Error(`Rate limited: ${canUse.reason}`);
  }

  let imageBuffer: Buffer;
  let generatedPrompt: string | undefined;

  if (source.type === 'url') {
    // Download from URL with timeout protection
    const response = await fetchWithTimeout(source.url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else if (source.type === 'generate') {
    generatedPrompt = source.prompt;
    // Generate a character sheet image
    const image = await generateImage({
      prompt: `${source.prompt}, character reference sheet, turnaround view, full body, multiple angles, white background, concept art`,
      avatarId,
      platform: 'character-reference',
      resolution: '2K',
      aspectRatio: '16:9', // Wide for turnaround
    });

    // Download from our storage with timeout protection
    const response = await fetchWithTimeout(image.url);
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else if (source.type === 'gallery') {
    // Use existing gallery image
    const item = await gallery.getGalleryItem(avatarId, source.imageId);
    if (!item) {
      throw new Error(`Image not found in gallery: ${source.imageId}`);
    }

    // Download with timeout protection
    const response = await fetchWithTimeout(item.url);
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error('Invalid source type');
  }

  // Store as character reference
  const s3Key = `avatars/${avatarId}/character-reference/${uuid()}.png`;

  // Upload to S3
  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: imageBuffer,
    ContentType: 'image/png',
  }));

  const publicUrl = buildMediaUrl(s3Key, MEDIA_BUCKET, CDN_URL);

  // Update avatar record with character reference
  // If this fails, rollback by deleting the S3 file to prevent orphaned files
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: 'SET characterReference = :ref, updatedAt = :now',
      ExpressionAttributeValues: {
        ':ref': {
          url: publicUrl,
          s3Key,
          generatedPrompt,
          description,
          updatedAt: Date.now(),
        },
        ':now': Date.now(),
      },
    }));
  } catch (dbError) {
    // Rollback: delete the orphaned S3 file
    console.error(`[Media] DynamoDB update failed for character reference, rolling back S3 upload: ${s3Key}`, dbError);
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: s3Key,
      }));
      console.log(`[Media] Rollback successful: deleted ${s3Key}`);
    } catch (rollbackError) {
      console.error(`[Media] Rollback failed: could not delete ${s3Key}`, rollbackError);
    }
    throw new Error('Failed to save character reference. Please try again.');
  }

  // Consume credit only after successful save
  await credits.consumeCredit(avatarId, 'set_character_reference');

  return { url: publicUrl, s3Key };
}

/**
 * Get the best reference image for generation
 * Prefers character reference (full body) over profile image (headshot)
 */
export async function getBestReferenceImageUrl(avatarId: string): Promise<string | undefined> {
  // First check for character reference in avatar config
  const avatarResult = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
  }));

  const avatar = avatarResult.Item;
  if (!avatar) return undefined;

  // Prefer character reference for full-body consistency
  if (avatar.characterReference?.url) {
    return avatar.characterReference.url;
  }

  // Fall back to profile image
  if (avatar.profileImage?.url) {
    return avatar.profileImage.url;
  }

  // Fall back to any 'character' category reference image
  const characterRefs = await listReferenceImages(avatarId, 'character');
  if (characterRefs.length > 0) {
    return characterRefs[0].url;
  }

  return undefined;
}

/**
 * Get tool status for the avatar (for AI prompt injection)
 */
export async function getMediaToolStatus(avatarId: string): Promise<string> {
  return credits.getToolStatus(avatarId);
}

/**
 * Queue a media job for async processing (used by handlers)
 */
export async function queueMediaJob(job: {
  type: 'image' | 'video' | 'sticker';
  prompt: string;
  avatarId: string;
  platform: string;
  conversationId: string;
  replyToMessageId?: string;
}): Promise<string> {
  if (!MEDIA_QUEUE_URL) {
    throw new Error('MEDIA_QUEUE_URL not configured');
  }

  const jobId = uuid();

  const messageGroupId = job.conversationId || job.avatarId;
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: MEDIA_QUEUE_URL,
    MessageBody: JSON.stringify({
      jobId,
      ...job,
    }),
    MessageGroupId: messageGroupId,
    MessageDeduplicationId: `media_${jobId}`,
  }));

  return jobId;
}

// ============================================================================
// Reference Images Management
// ============================================================================

export interface ReferenceImage {
  id: string;
  avatarId: string;
  category: ReferenceImageCategory;
  name: string;
  description?: string;
  url: string;
  s3Key: string;
  createdAt: number;
}

/**
 * Save reference image metadata after upload
 */
export async function saveReferenceImage(
  avatarId: string,
  category: ReferenceImageCategory,
  s3Key: string,
  publicUrl: string,
  name: string,
  description?: string
): Promise<ReferenceImage> {
  const id = uuid();
  const now = Date.now();

  const image: ReferenceImage = {
    id,
    avatarId,
    category,
    name,
    description,
    url: publicUrl,
    s3Key,
    createdAt: now,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: `AVATAR#${avatarId}`,
      sk: `REFERENCE#${category}#${id}`,
      ...image,
    },
  }));

  return image;
}

/**
 * List reference images for an avatar
 */
export async function listReferenceImages(
  avatarId: string,
  category?: ReferenceImageCategory
): Promise<ReferenceImage[]> {
  const skPrefix = category ? `REFERENCE#${category}#` : 'REFERENCE#';

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: {
      ':pk': `AVATAR#${avatarId}`,
      ':sk': skPrefix,
    },
  }));

  return (result.Items || []).map(item => ({
    id: item.id,
    avatarId: item.avatarId,
    category: item.category,
    name: item.name,
    description: item.description,
    url: item.url,
    s3Key: item.s3Key,
    createdAt: item.createdAt,
  }));
}

/**
 * Delete a reference image
 */
export async function deleteReferenceImage(
  avatarId: string,
  imageId: string
): Promise<void> {
  // First find the image to get its category and s3Key
  const images = await listReferenceImages(avatarId);
  const image = images.find(img => img.id === imageId);

  if (!image) {
    throw new Error('Reference image not found');
  }

  // Delete from S3
  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: image.s3Key,
    }));
  } catch (err) {
    console.warn('Failed to delete S3 object:', err instanceof Error ? err.message : String(err));
  }

  // Delete from DynamoDB
  await dynamoClient.send(new DeleteCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `REFERENCE#${image.category}#${imageId}`,
    },
  }));
}
