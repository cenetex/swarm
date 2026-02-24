/**
 * Media Service - Image and video generation via multiple providers
 *
 * This service can be used standalone with basic functionality, or enhanced
 * with injected dependencies for model resolution, credits, and gallery.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { MediaService, MediaConfig, GeneratedMedia } from '../../types/index.js';
import type {
  MediaServiceDependencies,
  GenerateImageOptions,
  GalleryItemOutput,
} from './types.js';

// Re-export types and resolvers
export * from './types.js';
export * from './resolvers.js';

/**
 * Extended result that includes gallery info
 */
export interface GeneratedMediaExtended extends GeneratedMedia {
  galleryItem?: GalleryItemOutput;
  trialCreditsRemaining?: number;
}

export class SwarmMediaService implements MediaService {
  private s3Client: S3Client;
  private bucketName: string;
  private cdnUrl?: string;
  private deps?: MediaServiceDependencies;

  constructor(
    private readonly secrets: Record<string, string>,
    bucketName: string,
    cdnUrl?: string,
    region: string = 'us-east-1',
    deps?: MediaServiceDependencies
  ) {
    this.s3Client = new S3Client({ region });
    this.bucketName = bucketName;
    this.cdnUrl = normalizeCdnUrl(cdnUrl);
    this.deps = deps;
  }

  /**
   * Set dependencies after construction (for lazy initialization)
   */
  setDependencies(deps: MediaServiceDependencies): void {
    this.deps = deps;
  }

  /**
   * Generate image with optional enhanced features
   */
  async generateImage(
    prompt: string,
    config: MediaConfig['image'],
    options?: GenerateImageOptions
  ): Promise<GeneratedMediaExtended> {
    const avatarId = options?.avatarId;

    // Check rate-limit credits if enabled and dependencies available
    if (options?.checkCredits !== false && avatarId && this.deps?.checkCredits) {
      const creditCheck = await this.deps.checkCredits(avatarId, 'generate_image');
      if (!creditCheck.allowed) {
        throw new Error(creditCheck.reason || 'Credit check failed');
      }
    }

    // Resolve model if dependencies available and avatarId provided
    let resolvedConfig = config;

    if (avatarId && this.deps?.resolveModel) {
      const resolved = await this.deps.resolveModel(avatarId, 'image_generation');
      resolvedConfig = {
        ...config,
        provider: resolved.provider as 'replicate' | 'openrouter' | 'dalle',
        model: resolved.model,
      };
    }

    // Resolve API key if dependencies available
    // Note: For trial usage, this only checks credits, doesn't consume yet
    let apiKeyOverride: string | undefined;
    let isTrialUsage = false;
    if (avatarId && this.deps?.resolveApiKey && resolvedConfig.provider === 'replicate') {
      try {
        const resolved = await this.deps.resolveApiKey(avatarId, 'replicate');
        apiKeyOverride = resolved.key;
        isTrialUsage = resolved.source === 'trial';
      } catch (err) {
        // Fall back to secrets if resolver fails
        console.warn('[MediaService] API key resolver failed, using secrets:', err);
      }
    }

    // Generate the image
    let result: GeneratedMedia;
    switch (resolvedConfig.provider) {
      case 'openrouter':
        result = await this.generateImageOpenRouter(prompt, resolvedConfig.model);
        break;

      case 'replicate':
        result = await this.generateImageReplicate(
          prompt,
          resolvedConfig.model,
          options?.aspectRatio || resolvedConfig.aspectRatio,
          avatarId,
          apiKeyOverride,
          options?.referenceImageUrls
        );
        break;

      case 'dalle':
        result = await this.generateImageDalle(prompt, resolvedConfig.model);
        break;

      default:
        throw new Error(`Unknown image provider: ${resolvedConfig.provider}`);
    }

    // === POST-SUCCESS CREDIT CONSUMPTION ===
    // Consume trial credit if this was a trial usage (only after success)
    let trialCreditsRemaining: number | undefined;
    if (isTrialUsage && avatarId && this.deps?.consumeTrialCredit) {
      const consumed = await this.deps.consumeTrialCredit(avatarId);
      trialCreditsRemaining = consumed.remaining;
    }

    // Consume rate-limit credits for non-trial users only
    // (trial users are already limited by trial credits)
    if (!isTrialUsage && options?.checkCredits !== false && avatarId && this.deps?.consumeCredits) {
      await this.deps.consumeCredits(avatarId, 'generate_image');
    }

    // Save to gallery if enabled
    let galleryItem: GalleryItemOutput | undefined;
    if (options?.saveToGallery !== false && avatarId && this.deps?.saveToGallery && result.s3Key) {
      galleryItem = await this.deps.saveToGallery(avatarId, {
        id: result.s3Key.split('/').pop()?.split('.')[0] || `img_${Date.now()}`,
        type: 'image',
        url: result.url,
        s3Key: result.s3Key,
        prompt,
        model: resolvedConfig.model,
        platform: options?.platform,
      });
    }

    return {
      ...result,
      galleryItem,
      trialCreditsRemaining,
    };
  }

  async generateVideo(prompt: string, config: NonNullable<MediaConfig['video']>): Promise<GeneratedMedia> {
    if (config.provider !== 'replicate') {
      throw new Error(`Unknown video provider: ${config.provider}`);
    }

    return this.generateVideoReplicate(prompt, config.model);
  }

  async uploadToS3(buffer: Buffer, key: string, contentType: string): Promise<string> {
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'max-age=31536000',
    }));

    if (this.cdnUrl) {
      return `${this.cdnUrl}/${key}`;
    }

    return `https://${this.bucketName}.s3.amazonaws.com/${key}`;
  }

  /**
   * Generate image using OpenRouter's image models
   */
  private async generateImageOpenRouter(prompt: string, model: string): Promise<GeneratedMedia> {
    const apiKey = this.secrets['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not found');
    }

    const response = await fetch('https://openrouter.ai/api/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: '1024x1024',
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter image generation failed: ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{ url: string }>;
    };

    const imageUrl = data.data[0].url;

    // Download and upload to S3 for persistence
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      const errorText = await imageResponse.text();
      throw new Error(`Failed to download generated image: ${imageResponse.status} - ${errorText}`);
    }
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    const s3Key = `generated/${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
    const s3Url = await this.uploadToS3(imageBuffer, s3Key, 'image/png');

    return {
      type: 'image',
      url: s3Url,
      s3Key,
      prompt,
      model,
    };
  }

  /**
   * Generate image using Replicate
   */
  private async generateImageReplicate(
    prompt: string,
    model: string,
    aspectRatio?: string,
    avatarId?: string,
    apiKeyOverride?: string,
    referenceImageUrls?: string[]
  ): Promise<GeneratedMedia> {
    // Use override or check for various key names
    const apiKey = apiKeyOverride
      || this.secrets['REPLICATE_API_TOKEN']
      || this.secrets['REPLICATE_API_KEY']
      || this.secrets['replicate_api_key'];

    if (!apiKey) {
      throw new Error('REPLICATE_API_TOKEN or REPLICATE_API_KEY not found in secrets');
    }

    // Use models endpoint for flexibility (handles both versioned and unversioned models)
    const endpoint = `https://api.replicate.com/v1/models/${model}/predictions`;

    // Build input with optional image_input for reference images
    const input: Record<string, unknown> = {
      prompt,
      num_outputs: 1,
      output_format: 'png',
      aspect_ratio: aspectRatio || '1:1',
    };

    // Add image_input if reference images provided (for nano-banana-pro and similar models)
    if (referenceImageUrls && referenceImageUrls.length > 0) {
      input.image_input = referenceImageUrls.slice(0, 14); // Max 14 reference images
      console.log(`[MediaService] Using ${referenceImageUrls.length} reference image(s) for generation`);
    }

    let createResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Prefer': 'wait',
      },
      body: JSON.stringify({ input }),
    });

    // If the model rejects the aspect_ratio (422), retry with 1:1 as a safe fallback
    if (createResponse.status === 422 && input.aspect_ratio !== '1:1') {
      console.warn(`[MediaService] Replicate rejected aspect_ratio "${input.aspect_ratio}", retrying with 1:1`);
      input.aspect_ratio = '1:1';
      createResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Prefer': 'wait',
        },
        body: JSON.stringify({ input }),
      });
    }

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`Replicate prediction failed: ${createResponse.status} - ${errorText}`);
    }

    const prediction = await createResponse.json() as {
      id: string;
      status: string;
      output?: string | string[];
      error?: string;
    };

    // Poll for completion if not using Prefer: wait or if still processing
    let result = prediction;
    let attempts = 0;
    const pollIntervalMs = 1000;
    const maxAttempts = 120; // 2 minutes max

    while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      attempts++;

      const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${result.id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!pollResponse.ok) {
        const errorText = await pollResponse.text();
        throw new Error(`Replicate poll failed: ${pollResponse.status} - ${errorText}`);
      }

      result = await pollResponse.json() as typeof prediction;
    }

    if (result.status !== 'succeeded') {
      const timeoutSeconds = Math.round((maxAttempts * pollIntervalMs) / 1000);
      const reason = result.status === 'failed'
        ? result.error || 'Unknown error'
        : `timed out after ${timeoutSeconds}s`;
      throw new Error(`Replicate prediction ${result.status === 'failed' ? 'failed' : 'timed out'}: ${reason}`);
    }

    // Handle output as string or array
    const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    if (!imageUrl) {
      throw new Error('No output from Replicate');
    }

    // Upload to S3 with avatar-specific path if available
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      const errorText = await imageResponse.text();
      throw new Error(`Failed to download generated image: ${imageResponse.status} - ${errorText}`);
    }
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    const imageId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const s3Key = avatarId
      ? `avatars/${avatarId}/images/${imageId}.png`
      : `generated/${imageId}.png`;
    const s3Url = await this.uploadToS3(imageBuffer, s3Key, 'image/png');

    return {
      type: 'image',
      url: s3Url,
      s3Key,
      prompt,
      model,
    };
  }

  /**
   * Generate image using DALL-E via OpenAI API
   */
  private async generateImageDalle(prompt: string, model: string): Promise<GeneratedMedia> {
    const apiKey = this.secrets['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not found');
    }

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      }),
    });

    if (!response.ok) {
      throw new Error(`DALL-E generation failed: ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{ url: string }>;
    };

    const imageUrl = data.data[0].url;

    // Upload to S3
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      const errorText = await imageResponse.text();
      throw new Error(`Failed to download generated image: ${imageResponse.status} - ${errorText}`);
    }
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    const s3Key = `generated/${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
    const s3Url = await this.uploadToS3(imageBuffer, s3Key, 'image/png');

    return {
      type: 'image',
      url: s3Url,
      s3Key,
      prompt,
      model,
    };
  }

  /**
   * Generate video using Replicate (async with webhook callback)
   */
  private async generateVideoReplicate(prompt: string, model: string): Promise<GeneratedMedia> {
    const apiKey = this.secrets['REPLICATE_API_TOKEN'] || this.secrets['REPLICATE_API_KEY'] || this.secrets['replicate_api_key'];
    if (!apiKey) {
      throw new Error('REPLICATE_API_TOKEN or REPLICATE_API_KEY not found in secrets');
    }

    // Use models endpoint
    const endpoint = `https://api.replicate.com/v1/models/${model}/predictions`;

    const createResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${apiKey}`,
      },
      body: JSON.stringify({
        input: { prompt },
      }),
    });

    if (!createResponse.ok) {
      throw new Error(`Replicate prediction failed: ${createResponse.status}`);
    }

    const prediction = await createResponse.json() as {
      id: string;
      status: string;
      output?: string;
    };

    // Poll for completion (video takes longer)
    let result = prediction;
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes max

    while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;

      const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${result.id}`, {
        headers: { 'Authorization': `Token ${apiKey}` },
      });

      result = await pollResponse.json() as typeof prediction;
    }

    if (result.status !== 'succeeded') {
      throw new Error(`Video generation ${result.status === 'failed' ? 'failed' : 'timed out'}`);
    }

    const videoUrl = result.output;
    if (!videoUrl) {
      throw new Error('No output from Replicate');
    }

    // Upload to S3
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      const errorText = await videoResponse.text();
      throw new Error(`Failed to download generated video: ${videoResponse.status} - ${errorText}`);
    }
    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

    const s3Key = `generated/${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`;
    const s3Url = await this.uploadToS3(videoBuffer, s3Key, 'video/mp4');

    return {
      type: 'video',
      url: s3Url,
      s3Key,
      prompt,
      model,
    };
  }
}

/**
 * Factory function - basic version without dependencies
 */
export function createMediaService(
  secrets: Record<string, string>,
  bucketName: string,
  cdnUrl?: string
): SwarmMediaService {
  return new SwarmMediaService(secrets, bucketName, cdnUrl);
}

/**
 * Factory function - enhanced version with all dependencies
 */
export function createMediaServiceWithDeps(
  secrets: Record<string, string>,
  bucketName: string,
  cdnUrl: string | undefined,
  deps: MediaServiceDependencies
): SwarmMediaService {
  return new SwarmMediaService(secrets, bucketName, cdnUrl, 'us-east-1', deps);
}

function normalizeCdnUrl(cdnUrl?: string): string | undefined {
  if (!cdnUrl) return undefined;
  const trimmed = cdnUrl.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}
