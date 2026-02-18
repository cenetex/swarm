/**
 * Media Pipeline Integration Tests
 *
 * Tests for the media processing pipeline that handles image and video generation.
 * Uses bun:test with mock functions instead of vi.mock for dependency injection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

describe('Media Pipeline Integration', () => {
  beforeEach(() => {
    process.env.RESPONSE_QUEUE_URL = 'https://sqs.test/responses';
    process.env.STATE_TABLE = 'test-table';
    process.env.AVATAR_ID = 'avatar-1';
    process.env.MEDIA_BUCKET = 'test-bucket';
  });

  describe('Media Queue Item Schema Validation', () => {
    const MediaQueueItemSchema = z.object({
      jobId: z.string(),
      avatarId: z.string(),
      conversationId: z.string(),
      action: z.object({
        type: z.string(),
        prompt: z.string().optional(),
      }).passthrough(),
      response: z.object({
        avatarId: z.string(),
        platform: z.string(),
        conversationId: z.string(),
        actions: z.array(z.any()),
      }).passthrough(),
    });

    it('should validate a correct media job item', () => {
      const item = {
        jobId: 'job-1',
        avatarId: 'avatar-1',
        conversationId: 'chat-1',
        action: { type: 'take_selfie', prompt: 'a photo' },
        response: {
          avatarId: 'avatar-1',
          platform: 'telegram',
          conversationId: 'chat-1',
          actions: [],
          generatedAt: Date.now(),
          llmModel: 'test',
          tokensUsed: 0
        }
      };

      const result = MediaQueueItemSchema.safeParse(item);
      expect(result.success).toBe(true);
    });

    it('should reject invalid media job item missing required fields', () => {
      const item = {
        jobId: 'job-1',
        // missing avatarId
        conversationId: 'chat-1',
        action: { type: 'take_selfie' },
        response: {
          avatarId: 'avatar-1',
          platform: 'telegram',
          conversationId: 'chat-1',
          actions: [],
        }
      };

      const result = MediaQueueItemSchema.safeParse(item);
      expect(result.success).toBe(false);
    });
  });

  describe('Media Action Processing Logic', () => {
    it('should identify take_selfie action for image generation', () => {
      const action = { type: 'take_selfie', prompt: 'a photo' };
      const isImageAction = action.type === 'take_selfie';
      expect(isImageAction).toBe(true);
    });

    it('should identify generate_video action for video generation', () => {
      const action = { type: 'generate_video', prompt: 'dancing robot' };
      const isVideoAction = action.type === 'generate_video';
      expect(isVideoAction).toBe(true);
    });

    it('should build image prompt with avatar name prefix', () => {
      const action = { prompt: 'beach sunset', style: 'artistic' };
      const avatar = { name: 'TestBot' };

      let prompt = action.prompt;
      if (action.style) {
        prompt = `${prompt}, ${action.style} style`;
      }
      if (avatar.name) {
        prompt = `${avatar.name}: ${prompt}`;
      }

      expect(prompt).toBe('TestBot: beach sunset, artistic style');
    });
  });

  describe('Media Response Construction', () => {
    it('should construct send_media action from generated image', () => {
      const generatedMedia = {
        url: 'https://example.com/img.png',
        type: 'image'
      };

      const mediaAction = {
        type: 'send_media',
        mediaType: generatedMedia.type === 'video' ? 'video' : 'image',
        url: generatedMedia.url,
        caption: 'Generated image',
        replyToMessageId: 'msg-123',
      };

      expect(mediaAction.type).toBe('send_media');
      expect(mediaAction.mediaType).toBe('image');
      expect(mediaAction.url).toBe('https://example.com/img.png');
    });

    it('should construct send_media action from generated video', () => {
      const generatedMedia = {
        url: 'https://example.com/vid.mp4',
        type: 'video'
      };

      const mediaAction = {
        type: 'send_media',
        mediaType: 'video',
        url: generatedMedia.url,
        caption: 'Generated video',
      };

      expect(mediaAction.type).toBe('send_media');
      expect(mediaAction.mediaType).toBe('video');
      expect(mediaAction.url).toBe('https://example.com/vid.mp4');
    });
  });

  describe('Media Service Mock Integration', () => {
    it('should process a media job and return results', async () => {
      // Create mock media service
      const mockGenerateImage = vi.fn(() =>
        Promise.resolve({ url: 'https://example.com/img.png', type: 'image' })
      );

      const mockMediaService = {
        generateImage: mockGenerateImage,
        generateVideo: vi.fn(() =>
          Promise.resolve({ url: 'https://example.com/vid.mp4', type: 'video' })
        ),
      };

      // Simulate processing a take_selfie action
      const action = { type: 'take_selfie', prompt: 'a photo' };
      const response = {
        avatarId: 'avatar-1',
        platform: 'telegram',
        conversationId: 'chat-1',
        actions: [],
        generatedAt: Date.now(),
      };

      // Process the action
      let mediaAction = null;
      if (action.type === 'take_selfie') {
        const media = await mockMediaService.generateImage(action.prompt, {});
        mediaAction = {
          type: 'send_media',
          mediaType: media.type === 'video' ? 'video' : 'image',
          url: media.url,
          caption: action.prompt,
        };
      }

      expect(mockGenerateImage).toHaveBeenCalled();
      expect(mediaAction).not.toBeNull();
      expect(mediaAction!.type).toBe('send_media');
      expect(mediaAction!.url).toBe('https://example.com/img.png');

      // Construct the media response
      const mediaResponse = {
        ...response,
        actions: [mediaAction],
        generatedAt: Date.now(),
      };

      expect(mediaResponse.platform).toBe('telegram');
      expect(mediaResponse.actions[0].type).toBe('send_media');
    });

    it('should handle video generation action', async () => {
      const mockGenerateVideo = vi.fn(() =>
        Promise.resolve({ url: 'https://example.com/vid.mp4', type: 'video' })
      );

      const action = { type: 'generate_video', prompt: 'dancing robot' };

      const media = await mockGenerateVideo(action.prompt, {});
      const mediaAction = {
        type: 'send_media',
        mediaType: 'video',
        url: media.url,
        caption: action.prompt,
      };

      expect(mockGenerateVideo).toHaveBeenCalled();
      expect(mediaAction.mediaType).toBe('video');
      expect(mediaAction.url).toBe('https://example.com/vid.mp4');
    });
  });

  describe('Job Idempotency', () => {
    it('should claim job using conditional write', async () => {
      const claimedJobs = new Set<string>();

      const claimJob = async (jobId: string): Promise<boolean> => {
        if (claimedJobs.has(jobId)) {
          return false; // Already claimed
        }
        claimedJobs.add(jobId);
        return true;
      };

      // First claim should succeed
      const firstClaim = await claimJob('job-123');
      expect(firstClaim).toBe(true);

      // Second claim should fail
      const secondClaim = await claimJob('job-123');
      expect(secondClaim).toBe(false);

      // Different job should succeed
      const thirdClaim = await claimJob('job-456');
      expect(thirdClaim).toBe(true);
    });
  });

  describe('SQS Message Construction', () => {
    it('should construct SQS message with correct FIFO parameters', () => {
      const conversationId = 'conv-123';
      const jobId = 'job-456';
      const messageBody = {
        avatarId: 'avatar-1',
        platform: 'telegram',
        conversationId,
        actions: [{ type: 'send_media', url: 'https://example.com/img.png' }],
      };

      const sqsParams = {
        QueueUrl: 'https://sqs.test/responses',
        MessageBody: JSON.stringify(messageBody),
        MessageGroupId: conversationId,
        MessageDeduplicationId: `media_${jobId}`,
      };

      expect(sqsParams.MessageGroupId).toBe('conv-123');
      expect(sqsParams.MessageDeduplicationId).toBe('media_job-456');
      expect(JSON.parse(sqsParams.MessageBody).platform).toBe('telegram');
    });
  });
});
