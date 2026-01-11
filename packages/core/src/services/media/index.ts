/**
 * Media Service - Image and video generation via multiple providers
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { MediaService, MediaConfig, GeneratedMedia } from '../../types/index.js';

export class SwarmMediaService implements MediaService {
  private s3Client: S3Client;
  private bucketName: string;
  private cdnDomain?: string;

  constructor(
    private readonly secrets: Record<string, string>,
    bucketName: string,
    cdnDomain?: string,
    region: string = 'us-east-1'
  ) {
    this.s3Client = new S3Client({ region });
    this.bucketName = bucketName;
    this.cdnDomain = cdnDomain;
  }

  async generateImage(prompt: string, config: MediaConfig['image']): Promise<GeneratedMedia> {
    switch (config.provider) {
      case 'openrouter':
        return this.generateImageOpenRouter(prompt, config.model);
      
      case 'replicate':
        return this.generateImageReplicate(prompt, config.model);
      
      case 'dalle':
        return this.generateImageDalle(prompt, config.model);
      
      default:
        throw new Error(`Unknown image provider: ${config.provider}`);
    }
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

    if (this.cdnDomain) {
      return `https://${this.cdnDomain}/${key}`;
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
  private async generateImageReplicate(prompt: string, model: string): Promise<GeneratedMedia> {
    // Check for various key names
    const apiKey = this.secrets['REPLICATE_API_TOKEN'] || this.secrets['REPLICATE_API_KEY'] || this.secrets['replicate_api_key'];
    if (!apiKey) {
      throw new Error('REPLICATE_API_TOKEN or REPLICATE_API_KEY not found in secrets');
    }

    // Start prediction
    const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Prefer': 'wait',
      },
      body: JSON.stringify({
        version: model,
        input: { 
          prompt,
          num_outputs: 1,
          output_format: 'png',
        },
      }),
    });

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

    // Start prediction
    const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${apiKey}`,
      },
      body: JSON.stringify({
        version: model,
        input: { prompt },
        // webhook: webhookUrl, // For async processing
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
 * Factory function
 */
export function createMediaService(
  secrets: Record<string, string>,
  bucketName: string,
  cdnDomain?: string
): MediaService {
  return new SwarmMediaService(secrets, bucketName, cdnDomain);
}
