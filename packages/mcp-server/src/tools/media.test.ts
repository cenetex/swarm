/**
 * Media Tools Tests
 *
 * Tests for image, video, and sticker generation tools.
 */
import { describe, it, expect } from 'vitest';
import { createMediaTools, type MediaServices, type CreditServices } from './media.js';

const mockMediaServices: MediaServices = {
  generateImage: async (params) => {
    if (params.prompt === 'sync') {
      return {
        url: 'https://example.com/image.jpg',
        id: 'img-123',
      };
    }
    return {
      jobId: 'job-456',
      status: 'pending',
    };
  },

  generateVideo: async () => ({
    jobId: 'video-789',
    status: 'pending',
  }),

  generateSticker: async () => ({
    url: 'https://example.com/sticker.webp',
    id: 'sticker-123',
  }),

  getProfileImageUrl: async () => 'https://example.com/profile.jpg',
  getReferenceImageUrl: async () => 'https://example.com/reference.jpg',
  getBestReferenceImageUrl: async () => 'https://example.com/best-ref.jpg',
};

const mockCreditServices: CreditServices = {
  canUseTool: async () => ({ allowed: true }),
  consumeCredit: async () => true,
};

const mockLimitedCreditServices: CreditServices = {
  canUseTool: async () => ({ allowed: false, reason: 'Rate limit exceeded' }),
  consumeCredit: async () => false,
};

describe('Media Tools - generate_image', () => {
  it('generates image with valid prompt', async () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)(
      { prompt: 'sync', aspectRatio: '1:1', resolution: '2K' },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('url');
    expect(result.media).toBeDefined();
    expect(result.media?.type).toBe('image');
  });

  it('returns pending job for async generation', async () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');

    const result = await (tool!.execute as any)(
      { prompt: 'async image', aspectRatio: '16:9' },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(true);
    expect(result.pendingJob).toBeDefined();
    expect(result.pendingJob?.type).toBe('image');
  });

  it('validates required prompt field', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');

    const valid = tool!.inputSchema.safeParse({ prompt: 'test' });
    const missing = tool!.inputSchema.safeParse({});

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it('validates aspectRatio enum values', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');

    const valid = tool!.inputSchema.safeParse({
      prompt: 'test',
      aspectRatio: '16:9',
    });
    const invalid = tool!.inputSchema.safeParse({
      prompt: 'test',
      aspectRatio: '21:9',
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it('validates resolution enum values', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');

    const valid = tool!.inputSchema.safeParse({
      prompt: 'test',
      resolution: '4K',
    });
    const invalid = tool!.inputSchema.safeParse({
      prompt: 'test',
      resolution: '8K',
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it('checks credits before generation', async () => {
    const tools = createMediaTools(mockMediaServices, mockLimitedCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');

    const result = await (tool!.execute as any)(
      { prompt: 'test' },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit');
  });

  it('uses profile as reference by default', async () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');

    const parsed = tool!.inputSchema.parse({ prompt: 'test' });
    expect(parsed.useProfileAsReference).toBe(true);
  });

  it('has media category', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');

    expect(tool?.category).toBe('media');
  });
});

describe('Media Tools - generate_video', () => {
  it('generates video with valid prompt', async () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_video');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)(
      { prompt: 'a dancing robot' },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(true);
    expect(result.pendingJob).toBeDefined();
    expect(result.pendingJob?.type).toBe('video');
  });

  it('validates required prompt field', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_video');

    const valid = tool!.inputSchema.safeParse({ prompt: 'test' });
    const missing = tool!.inputSchema.safeParse({});

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it('accepts optional referenceImageId', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_video');

    const withRef = tool!.inputSchema.safeParse({
      prompt: 'test',
      referenceImageId: 'img-123',
    });

    expect(withRef.success).toBe(true);
  });

  it('checks credits before generation', async () => {
    const tools = createMediaTools(mockMediaServices, mockLimitedCreditServices);
    const tool = tools.find(t => t.name === 'generate_video');

    const result = await (tool!.execute as any)(
      { prompt: 'test' },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit');
  });

  it('has media category', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_video');

    expect(tool?.category).toBe('media');
  });
});

describe('Media Tools - generate_sticker', () => {
  it('generates sticker from prompt', async () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_sticker');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)(
      { prompt: 'happy face' },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(true);
    expect(result.media).toBeDefined();
    expect(result.media?.type).toBe('sticker');
  });

  it('allows prompt to be optional', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_sticker');

    const withPrompt = tool!.inputSchema.safeParse({ prompt: 'test' });
    const withoutPrompt = tool!.inputSchema.safeParse({});

    expect(withPrompt.success).toBe(true);
    expect(withoutPrompt.success).toBe(true);
  });

  it('accepts sourceImageId for sticker from image', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_sticker');

    const withSource = tool!.inputSchema.safeParse({
      sourceImageId: 'img-123',
    });

    expect(withSource.success).toBe(true);
  });

  it('checks credits before generation', async () => {
    const tools = createMediaTools(mockMediaServices, mockLimitedCreditServices);
    const tool = tools.find(t => t.name === 'generate_sticker');

    const result = await (tool!.execute as any)(
      { prompt: 'test' },
      { avatarId: 'test', platform: 'admin-ui' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit');
  });

  it('has media category', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_sticker');

    expect(tool?.category).toBe('media');
  });
});

describe('Media Tools - Service Interface', () => {
  it('creates tools with valid service interface', () => {
    const tools = createMediaTools(mockMediaServices, mockCreditServices);

    expect(tools.length).toBeGreaterThan(0);
    tools.forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.category).toBe('media');
    });
  });

  it('all media tools check credits', async () => {
    const tools = createMediaTools(mockMediaServices, mockLimitedCreditServices);

    for (const tool of tools) {
      if (tool.execute && tool.execute !== false) {
        const result = await tool.execute({} as any, {
          avatarId: 'test',
          platform: 'admin-ui',
        });

        if (result.success === false) {
          expect(result.error).toBeTruthy();
        }
      }
    }
  });
});

describe('Media Tools - Context and Conversation', () => {
  it('passes conversation context to image generation', async () => {
    let capturedParams: any;
    const services: MediaServices = {
      ...mockMediaServices,
      generateImage: async (params) => {
        capturedParams = params;
        return { url: 'test', id: 'test' };
      },
    };

    const tools = createMediaTools(services, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_image');

    await (tool!.execute as any)(
      { prompt: 'test' },
      {
        avatarId: 'test',
        platform: 'telegram',
        conversationId: 'chat123',
        replyToMessageId: 'msg456',
      }
    );

    expect(capturedParams.conversationId).toBe('chat123');
    expect(capturedParams.replyToMessageId).toBe('msg456');
    expect(capturedParams.deliveryIntent).toEqual({
      platform: 'telegram',
      conversationId: 'chat123',
      replyToMessageId: 'msg456',
      expectedAction: 'send_media',
    });
  });

  it('passes conversation context to video generation', async () => {
    let capturedParams: any;
    const services: MediaServices = {
      ...mockMediaServices,
      generateVideo: async (params) => {
        capturedParams = params;
        return { jobId: 'test', status: 'pending' };
      },
    };

    const tools = createMediaTools(services, mockCreditServices);
    const tool = tools.find(t => t.name === 'generate_video');

    await (tool!.execute as any)(
      { prompt: 'test' },
      {
        avatarId: 'test',
        platform: 'telegram',
        conversationId: 'chat789',
        replyToMessageId: 'msg012',
      }
    );

    expect(capturedParams.conversationId).toBe('chat789');
    expect(capturedParams.replyToMessageId).toBe('msg012');
    expect(capturedParams.deliveryIntent).toEqual({
      platform: 'telegram',
      conversationId: 'chat789',
      replyToMessageId: 'msg012',
      expectedAction: 'send_media',
    });
  });

  it('captures an explicit supported cross-platform destination', async () => {
    let capturedParams: any;
    const services: MediaServices = {
      ...mockMediaServices,
      generateImage: async (params) => {
        capturedParams = params;
        return { jobId: 'job-cross-platform', status: 'pending' };
      },
    };

    const tool = createMediaTools(services, mockCreditServices)
      .find(t => t.name === 'generate_image');

    await (tool!.execute as any)(
      {
        prompt: 'post this in Discord',
        destination: {
          platform: 'discord',
          conversationId: 'discord-channel-42',
          replyToMessageId: 'discord-message-7',
        },
      },
      {
        avatarId: 'test',
        platform: 'admin-ui',
        conversationId: 'admin-session-1',
      },
    );

    expect(capturedParams.platform).toBe('admin-ui');
    expect(capturedParams.conversationId).toBe('admin-session-1');
    expect(capturedParams.deliveryIntent).toEqual({
      platform: 'discord',
      conversationId: 'discord-channel-42',
      replyToMessageId: 'discord-message-7',
      expectedAction: 'discord_send_media_to_channel',
    });
  });

  it('does not duplicate a synchronous cross-platform result into the origin', async () => {
    const tool = createMediaTools(mockMediaServices, mockCreditServices)
      .find(t => t.name === 'generate_image');

    const result = await (tool!.execute as any)(
      {
        prompt: 'sync',
        destination: {
          platform: 'discord',
          conversationId: 'discord-channel-42',
        },
      },
      {
        avatarId: 'test',
        platform: 'admin-ui',
        conversationId: 'admin-session-1',
      },
    );

    expect(result.success).toBe(true);
    expect(result.data.url).toBe('https://example.com/image.jpg');
    expect(result.media).toBeUndefined();
  });

  it('does not copy an origin reply ID into a different destination', async () => {
    let capturedParams: any;
    const services: MediaServices = {
      ...mockMediaServices,
      generateVideo: async (params) => {
        capturedParams = params;
        return { jobId: 'video-cross-platform', status: 'pending' };
      },
    };

    const tool = createMediaTools(services, mockCreditServices)
      .find(t => t.name === 'generate_video');

    await (tool!.execute as any)(
      {
        prompt: 'send this elsewhere',
        destination: {
          platform: 'discord',
          conversationId: 'discord-channel-42',
        },
      },
      {
        avatarId: 'test',
        platform: 'telegram',
        conversationId: '-1001',
        replyToMessageId: 'telegram-message-9',
      },
    );

    expect(capturedParams.deliveryIntent).toEqual({
      platform: 'discord',
      conversationId: 'discord-channel-42',
      replyToMessageId: undefined,
      expectedAction: 'discord_send_media_to_channel',
    });
  });
});
