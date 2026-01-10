/**
 * Media Generation Service
 * Handles image, video, and sticker generation with multiple providers
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import * as mediaJobs from './media-jobs.js';
import * as gallery from './gallery.js';
import * as credits from './credits.js';
import { _getSecretValueInternal } from './secrets.js';
import type { MediaJob, GalleryItem } from '../types.js';

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const MEDIA_QUEUE_URL = process.env.MEDIA_QUEUE_URL;
const CDN_URL = process.env.CDN_URL;
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Provider configuration
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';

// Default models (Replicate model identifiers)
const DEFAULT_IMAGE_MODEL = 'google/nano-banana-pro';
const DEFAULT_VIDEO_MODEL = 'minimax/video-01';

// Replicate model versions (required for predictions API)
const REPLICATE_MODEL_VERSIONS: Record<string, string> = {
  'google/nano-banana-pro': 'eefce837d77048ccc736cd660d4f178d223b2d99aeb5ef856741eb81941c9ed2',
  'black-forest-labs/flux-schnell': 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db',
  'black-forest-labs/flux-dev': 'a8a9b47a5f6c7f2e06b5d4f0e6a5d4f0e6a5d4f0e6a5d4f0e6a5d4f0e6a5d4f0',
};

interface GenerateImageOptions {
  prompt: string;
  agentId: string;
  platform?: string;
  model?: string;
  referenceImageUrls?: string[]; // Array of reference images (profile, gallery, etc.)
  resolution?: '1K' | '2K' | '4K';
  aspectRatio?: 'match_input_image' | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9';
}

interface GenerateVideoOptions {
  prompt: string;
  agentId: string;
  platform?: string;
  conversationId: string;
  replyToMessageId?: string;
  model?: string;
  referenceImageUrl?: string;
}

interface GenerateStickerOptions {
  prompt: string;
  agentId: string;
  platform?: string;
  sourceImageId?: string; // Convert existing image to sticker
}

/**
 * Reference image categories
 */
export type ReferenceImageCategory = 
  | 'profile'      // Agent's profile/avatar
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
export async function getProfileImageUploadUrl(agentId: string): Promise<{
  uploadUrl: string;
  s3Key: string;
  publicUrl: string;
}> {
  const s3Key = `agents/${agentId}/profile/${uuid()}.png`;

  const command = new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    ContentType: 'image/png',
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

  return { uploadUrl, s3Key, publicUrl };
}

/**
 * Generate a signed URL for uploading a reference image
 */
export async function getReferenceImageUploadUrl(
  agentId: string,
  category: ReferenceImageCategory,
  filename?: string,
  contentType: string = 'image/png'
): Promise<ReferenceImageUploadResult> {
  const extension = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
  const safeName = filename 
    ? filename.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 50) 
    : uuid().slice(0, 8);
  const s3Key = `agents/${agentId}/references/${category}/${safeName}-${uuid().slice(0, 8)}.${extension}`;

  const command = new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

  return { uploadUrl, s3Key, publicUrl, category };
}

/**
 * Get API key for a provider
 */
async function getProviderApiKey(
  agentId: string,
  provider: 'openrouter' | 'replicate' | 'openai'
): Promise<string | null> {
  const secretTypes: Record<string, string> = {
    openrouter: 'openrouter_api_key',
    replicate: 'replicate_api_key',
    openai: 'openai_api_key',
  };

  // Try agent-specific key first, then global
  let key = await _getSecretValueInternal(agentId, secretTypes[provider] as any, 'default');
  if (!key) {
    key = await _getSecretValueInternal('GLOBAL', secretTypes[provider] as any, 'default');
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
    agentId,
    platform,
    model,
    referenceImageUrls = [],
    resolution = '2K',
    aspectRatio = '1:1',
  } = options;

  // Check credits
  const canUse = await credits.canUseTool(agentId, 'generate_image');
  if (!canUse.allowed) {
    throw new Error(`Rate limited: ${canUse.reason}`);
  }

  // Get Replicate API key
  const apiKey = await getProviderApiKey(agentId, 'replicate');
  if (!apiKey) {
    throw new Error('No Replicate API key configured. Please set up an API key first.');
  }

  // Build the prompt with reference context if images provided
  let finalPrompt = prompt;
  if (referenceImageUrls.length > 0) {
    finalPrompt = `${prompt}. Use the provided reference images to maintain visual consistency with the character's appearance, style, and features.`;
  }

  // Get model version for Replicate
  const modelId = model || DEFAULT_IMAGE_MODEL;
  const version = REPLICATE_MODEL_VERSIONS[modelId];

  if (!version) {
    throw new Error(`Unknown model: ${modelId}. Supported models: ${Object.keys(REPLICATE_MODEL_VERSIONS).join(', ')}`);
  }

  // Build input based on model type
  const isNanoBanana = modelId === 'google/nano-banana-pro';
  const hasReferenceImages = referenceImageUrls.length > 0;

  // Build Nano Banana Pro input
  const nanoBananaInput: Record<string, unknown> = {
    prompt: finalPrompt,
    resolution,
    output_format: 'png',
    safety_filter_level: 'block_only_high',
  };

  // Only add image_input if we have reference images
  if (hasReferenceImages) {
    nanoBananaInput.image_input = referenceImageUrls.slice(0, 14);
    nanoBananaInput.aspect_ratio = 'match_input_image';
  } else {
    nanoBananaInput.aspect_ratio = aspectRatio;
  }

  // Build Flux input (fallback)
  const fluxInput: Record<string, unknown> = {
    prompt: finalPrompt,
    width: resolution === '4K' ? 2048 : resolution === '2K' ? 1024 : 512,
    height: resolution === '4K' ? 2048 : resolution === '2K' ? 1024 : 512,
    num_outputs: 1,
    output_format: 'png',
  };
  if (referenceImageUrls[0]) {
    fluxInput.image = referenceImageUrls[0];
  }

  console.log(`Generating image with ${modelId}, refs: ${referenceImageUrls.length}, prompt: ${prompt.slice(0, 50)}...`);

  // Start Replicate prediction
  const response = await fetch(REPLICATE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${apiKey}`,
      'Prefer': 'wait', // Wait for completion (up to 60s for fast models)
    },
    body: JSON.stringify({
      version,
      input: isNanoBanana ? nanoBananaInput : fluxInput,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const status = response.status;
    console.error(`Replicate API error: ${status}`, errorText);
    throw new Error(`Image generation failed: HTTP ${status} - ${errorText || 'Empty response from Replicate'}`);
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
  const imageId = uuid();
  const s3Key = `agents/${agentId}/images/${imageId}.png`;

  console.log(`Uploading to S3: bucket=${MEDIA_BUCKET}, key=${s3Key}`);
  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: imageBuffer,
    ContentType: 'image/png',
  }));
  console.log(`S3 upload successful`);

  // Consume credit
  await credits.consumeCredit(agentId, 'generate_image');

  // Construct public URL
  // IMPORTANT: CDN_URL should be set to your CloudFront distribution URL
  // If not set, falls back to direct S3 URL (which requires public bucket)
  const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;
  console.log(`Public URL: ${publicUrl} (CDN_URL=${CDN_URL || 'NOT SET'})`);

  const galleryItem = await gallery.addToGallery(agentId, {
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
 * Generate a video asynchronously
 * Returns a job ID - video will be delivered via callback
 */
export async function generateVideo(options: GenerateVideoOptions): Promise<MediaJob> {
  const {
    prompt, agentId, platform, conversationId, replyToMessageId,
    model, referenceImageUrl
  } = options;

  // Check credits
  const canUse = await credits.canUseTool(agentId, 'generate_video');
  if (!canUse.allowed) {
    throw new Error(`Rate limited: ${canUse.reason}`);
  }

  // Get Replicate API key
  const apiKey = await getProviderApiKey(agentId, 'replicate');
  if (!apiKey) {
    throw new Error('No Replicate API key configured. Please set up an API key first.');
  }

  // Create job record
  const jobId = uuid();
  const job = await mediaJobs.createJob({
    jobId,
    agentId,
    type: 'video',
    prompt,
    conversationId,
    platform: platform || 'unknown',
    replyToMessageId,
    provider: 'replicate',
  });

  // Start Replicate prediction with webhook
  const webhookUrl = process.env.REPLICATE_WEBHOOK_URL;

  const response = await fetch(REPLICATE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_VIDEO_MODEL,
      input: {
        prompt,
        ...(referenceImageUrl && { image: referenceImageUrl }),
      },
      webhook: webhookUrl ? `${webhookUrl}?jobId=${jobId}` : undefined,
      webhook_events_filter: ['completed'],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    await mediaJobs.updateJobStatus(jobId, 'failed', { error });
    throw new Error(`Video generation failed to start: ${error}`);
  }

  const prediction = await response.json() as { id: string };

  // Update job with external ID
  await mediaJobs.updateJobStatus(jobId, 'processing', { externalId: prediction.id });

  // Consume credit
  await credits.consumeCredit(agentId, 'generate_video');

  return job;
}

/**
 * Generate a sticker (image with background removal)
 */
export async function generateSticker(options: GenerateStickerOptions): Promise<GalleryItem> {
  const { prompt, agentId, platform, sourceImageId } = options;

  // Check credits
  const canUse = await credits.canUseTool(agentId, 'generate_sticker');
  if (!canUse.allowed) {
    throw new Error(`Rate limited: ${canUse.reason}`);
  }

  let imageUrl: string;
  let originalS3Key: string | undefined;

  if (sourceImageId) {
    // Convert existing image to sticker
    const sourceItem = await gallery.getGalleryItem(agentId, sourceImageId);
    if (!sourceItem) {
      throw new Error(`Source image not found: ${sourceImageId}`);
    }
    imageUrl = sourceItem.url;
    originalS3Key = sourceItem.s3Key;
  } else {
    // Generate new image first
    const image = await generateImage({
      prompt: `${prompt}, simple clean design suitable for sticker, transparent background style`,
      agentId,
      platform,
      resolution: '1K',
      aspectRatio: '1:1',
    });
    imageUrl = image.url;
    originalS3Key = image.s3Key;
  }

  // Get Replicate API key for background removal
  const apiKey = await getProviderApiKey(agentId, 'replicate');
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
  const stickerId = uuid();
  const s3Key = `agents/${agentId}/stickers/${stickerId}.webp`;

  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: stickerBuffer,
    ContentType: 'image/webp',
  }));

  // Consume credit
  await credits.consumeCredit(agentId, 'generate_sticker');

  // Mark original as converted if it was from gallery
  if (sourceImageId && originalS3Key) {
    const sourceItem = await gallery.getGalleryItem(agentId, sourceImageId);
    if (sourceItem) {
      await gallery.markConvertedToSticker(agentId, sourceImageId, sourceItem.sk);
    }
  }

  // Add to gallery
  const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

  const galleryItem = await gallery.addToGallery(agentId, {
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

/**
 * Set agent profile image from URL or generated image
 */
export async function setProfileImage(
  agentId: string,
  source: { type: 'url'; url: string } | { type: 'generate'; prompt: string } | { type: 'gallery'; imageId: string }
): Promise<{ url: string; s3Key: string }> {
  // Check credits for set_profile_image
  const canUse = await credits.canUseTool(agentId, 'set_profile_image');
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
      agentId,
      platform: 'profile',
      resolution: '1K',
      aspectRatio: '1:1',
    });

    // Download from our storage
    const response = await fetch(image.url);
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else if (source.type === 'gallery') {
    // Use existing gallery image
    const item = await gallery.getGalleryItem(agentId, source.imageId);
    if (!item) {
      throw new Error(`Image not found in gallery: ${source.imageId}`);
    }

    const response = await fetch(item.url);
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error('Invalid source type');
  }

  // Store as profile image
  const s3Key = `agents/${agentId}/profile/${uuid()}.png`;

  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: imageBuffer,
    ContentType: 'image/png',
  }));

  // Consume credit
  await credits.consumeCredit(agentId, 'set_profile_image');

  const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

  return { url: publicUrl, s3Key };
}

/**
 * Get tool status for the agent (for AI prompt injection)
 */
export async function getMediaToolStatus(agentId: string): Promise<string> {
  return credits.getToolStatus(agentId);
}

/**
 * Queue a media job for async processing (used by handlers)
 */
export async function queueMediaJob(job: {
  type: 'image' | 'video' | 'sticker';
  prompt: string;
  agentId: string;
  platform: string;
  conversationId: string;
  replyToMessageId?: string;
}): Promise<string> {
  if (!MEDIA_QUEUE_URL) {
    throw new Error('MEDIA_QUEUE_URL not configured');
  }

  const jobId = uuid();

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: MEDIA_QUEUE_URL,
    MessageBody: JSON.stringify({
      jobId,
      ...job,
    }),
  }));

  return jobId;
}

// ============================================================================
// Reference Images Management
// ============================================================================

export interface ReferenceImage {
  id: string;
  agentId: string;
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
  agentId: string,
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
    agentId,
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
      pk: `AGENT#${agentId}`,
      sk: `REFERENCE#${category}#${id}`,
      ...image,
    },
  }));

  return image;
}

/**
 * List reference images for an agent
 */
export async function listReferenceImages(
  agentId: string,
  category?: ReferenceImageCategory
): Promise<ReferenceImage[]> {
  const skPrefix = category ? `REFERENCE#${category}#` : 'REFERENCE#';

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: {
      ':pk': `AGENT#${agentId}`,
      ':sk': skPrefix,
    },
  }));

  return (result.Items || []).map(item => ({
    id: item.id,
    agentId: item.agentId,
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
  agentId: string,
  imageId: string
): Promise<void> {
  // First find the image to get its category and s3Key
  const images = await listReferenceImages(agentId);
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
    console.warn('Failed to delete S3 object:', err);
  }

  // Delete from DynamoDB
  await dynamoClient.send(new DeleteCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: `REFERENCE#${image.category}#${imageId}`,
    },
  }));
}
