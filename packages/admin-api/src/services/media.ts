/**
 * Media Generation Service
 * Handles image, video, and sticker generation with multiple providers
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuid } from 'uuid';
import * as mediaJobs from './media-jobs.js';
import * as gallery from './gallery.js';
import * as credits from './credits.js';
import { _getSecretValueInternal } from './secrets.js';
import type { MediaJob, GalleryItem } from '../types.js';

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const MEDIA_QUEUE_URL = process.env.MEDIA_QUEUE_URL;
const CDN_URL = process.env.CDN_URL;

// Provider configuration
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/images/generations';
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';

// Default models
const DEFAULT_IMAGE_MODEL = 'black-forest-labs/flux-schnell';
const DEFAULT_VIDEO_MODEL = 'minimax/video-01';

interface GenerateImageOptions {
  prompt: string;
  agentId: string;
  platform?: string;
  model?: string;
  referenceImageUrl?: string; // For character consistency
  width?: number;
  height?: number;
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
 * Generate an image synchronously
 * Returns immediately with the generated image URL
 */
export async function generateImage(options: GenerateImageOptions): Promise<GalleryItem> {
  const { prompt, agentId, platform, model, referenceImageUrl, width = 1024, height = 1024 } = options;

  // Check credits
  const canUse = await credits.canUseTool(agentId, 'generate_image');
  if (!canUse.allowed) {
    throw new Error(`Rate limited: ${canUse.reason}`);
  }

  // Get API key (OpenRouter for images by default)
  const apiKey = await getProviderApiKey(agentId, 'openrouter');
  if (!apiKey) {
    throw new Error('No OpenRouter API key configured. Please set up an API key first.');
  }

  // Build the prompt with reference if available
  let finalPrompt = prompt;
  if (referenceImageUrl) {
    finalPrompt = `${prompt}. Maintain visual consistency with the reference character.`;
  }

  // Call OpenRouter image generation
  const response = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://swarm.agent',
      'X-Title': 'Swarm Agent',
    },
    body: JSON.stringify({
      model: model || DEFAULT_IMAGE_MODEL,
      prompt: finalPrompt,
      n: 1,
      size: `${width}x${height}`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Image generation failed: ${error}`);
  }

  const data = await response.json() as { data?: Array<{ url?: string; b64_json?: string }> };
  const imageData = data.data?.[0];

  if (!imageData?.url && !imageData?.b64_json) {
    throw new Error('No image returned from provider');
  }

  // Download and store in S3
  let imageBuffer: Buffer;
  if (imageData.url) {
    const imageResponse = await fetch(imageData.url);
    imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  } else {
    imageBuffer = Buffer.from(imageData.b64_json!, 'base64');
  }

  const imageId = uuid();
  const s3Key = `agents/${agentId}/images/${imageId}.png`;

  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: imageBuffer,
    ContentType: 'image/png',
  }));

  // Consume credit
  await credits.consumeCredit(agentId, 'generate_image');

  // Add to gallery
  const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

  const galleryItem = await gallery.addToGallery(agentId, {
    id: imageId,
    type: 'image',
    url: publicUrl,
    s3Key,
    prompt,
    model: model || DEFAULT_IMAGE_MODEL,
    platform,
  });

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
      'Authorization': `Bearer ${apiKey}`,
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
      width: 512,
      height: 512,
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
      'Authorization': `Bearer ${apiKey}`,
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
      headers: { 'Authorization': `Bearer ${apiKey}` },
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
      width: 512,
      height: 512,
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
