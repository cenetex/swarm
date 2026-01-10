/**
 * Media generation tools (image, video, sticker)
 */
import { z } from 'zod';
import { defineTool } from './tool-helper.js';
import { ResolutionSchema, AspectRatioSchema } from './schemas.js';

// Job result type
interface MediaJob {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  resultUrl?: string;
}

/**
 * Generate an image (async)
 */
export const generateImage = (
  _agentId: string,
  generateFn: (params: {
    prompt: string;
    useProfileAsReference?: boolean;
    galleryImageIds?: string[];
    referenceImageId?: string;
    resolution?: string;
    aspectRatio?: string;
  }) => Promise<MediaJob>
) => defineTool({
  name: 'generate_image',
  description: 'Generate an image using Nano Banana Pro. This is async - returns a job ID immediately. The image will be saved to my gallery when complete.',
  inputSchema: z.object({
    prompt: z.string().describe('Description of the image to generate'),
    useProfileAsReference: z.boolean().default(true).describe('Use my profile image as a reference (default: true)'),
    galleryImageIds: z.array(z.string()).optional().describe('Array of gallery image IDs to use as additional references'),
    referenceImageId: z.string().optional().describe('ID of a specific reference image to use'),
    resolution: ResolutionSchema.default('2K').describe('Output resolution (default: 2K)'),
    aspectRatio: AspectRatioSchema.default('1:1').describe('Image aspect ratio (default: 1:1)'),
  }),
  execute: async (params) => {
    const job = await generateFn(params);
    return {
      jobId: job.jobId,
      status: job.status,
      message: `Image generation started! Job ID: ${job.jobId}. Check status with get_job_status.`,
    };
  },
});

/**
 * Generate a video (async)
 */
export const generateVideo = (
  _agentId: string,
  generateFn: (params: {
    prompt: string;
    useProfileAsReference?: boolean;
    referenceImageId?: string;
  }) => Promise<MediaJob>
) => defineTool({
  name: 'generate_video',
  description: 'Generate a video from a text prompt. Can use reference images. This is async - I will notify when complete.',
  inputSchema: z.object({
    prompt: z.string().describe('Description of the video to generate'),
    useProfileAsReference: z.boolean().optional().describe('Use my profile image as a reference for character consistency'),
    referenceImageId: z.string().optional().describe('ID of a specific reference image to use'),
  }),
  execute: async (params) => {
    const job = await generateFn(params);
    return {
      jobId: job.jobId,
      status: job.status,
      message: `Video generation started! Job ID: ${job.jobId}. Videos take longer - check status with get_job_status.`,
    };
  },
});

/**
 * Generate a sticker
 */
export const generateSticker = (
  _agentId: string,
  generateFn: (params: {
    prompt?: string;
    sourceImageId?: string;
  }) => Promise<MediaJob>
) => defineTool({
  name: 'generate_sticker',
  description: 'Generate a sticker (transparent background image). Can create new or convert existing.',
  inputSchema: z.object({
    prompt: z.string().optional().describe('Description of the sticker to generate (if creating new)'),
    sourceImageId: z.string().optional().describe('ID of an existing gallery image to convert to sticker'),
  }),
  execute: async (params) => {
    if (!params.prompt && !params.sourceImageId) {
      return { error: 'Please provide either a prompt or sourceImageId' };
    }
    const job = await generateFn(params);
    return {
      jobId: job.jobId,
      status: job.status,
      message: `Sticker generation started! Job ID: ${job.jobId}.`,
    };
  },
});
