/**
 * Tests for the Media Extractor module.
 *
 * Uses bun:test. Mocks fetch for Telegram API and OpenAI Whisper calls.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  extractMediaContext,
  buildUserMessageContent,
  resolveTelegramFileUrl,
  type MediaExtractionConfig,
  type MediaExtractionResult,
} from './media-extractor.js';
import type { SwarmEnvelope, MediaAttachment } from '@swarm/core';

// ============================================================================
// Helpers
// ============================================================================

function makeEnvelope(overrides: Partial<SwarmEnvelope> = {}): SwarmEnvelope {
  return {
    avatarId: 'test-avatar',
    platform: 'telegram',
    messageId: '123',
    conversationId: '-100123456',
    timestamp: Date.now(),
    sender: {
      id: '42',
      username: 'testuser',
      displayName: 'Test User',
      isBot: false,
      platform: 'telegram',
      platformUserId: '42',
    },
    content: {
      text: '',
      media: [],
    },
    mentions: [],
    raw: {},
    metadata: {
      receivedAt: Date.now(),
      priority: 'normal',
      idempotencyKey: 'test-key',
    },
    ...overrides,
  };
}

function makePhotoAttachment(): MediaAttachment {
  return { type: 'photo', fileId: 'photo-file-id-123', size: 50000 };
}

function makeAudioAttachment(): MediaAttachment {
  return {
    type: 'audio',
    fileId: 'voice-file-id-456',
    mimeType: 'audio/ogg',
    size: 30000,
  };
}

function makeVideoAttachment(): MediaAttachment {
  return {
    type: 'video',
    fileId: 'video-file-id-789',
    mimeType: 'video/mp4',
    size: 500000,
  };
}

function makeDocImageAttachment(): MediaAttachment {
  return {
    type: 'document',
    fileId: 'doc-img-file-id',
    mimeType: 'image/png',
    size: 100000,
  };
}

// ============================================================================
// Tests: resolveTelegramFileUrl
// ============================================================================

describe('resolveTelegramFileUrl', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it('resolves a file_id to a Telegram CDN URL', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: 'photos/file_1.jpg' },
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const url = await resolveTelegramFileUrl('bot-token-abc', 'file-id-123');
    expect(url).toBe(
      'https://api.telegram.org/file/botbot-token-abc/photos/file_1.jpg',
    );

    // Verify the fetch was called with the right URL
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const callArgs = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs[0]).toBe(
      'https://api.telegram.org/botbot-token-abc/getFile',
    );

    globalThis.fetch = originalFetch;
  });

  it('throws when Telegram API returns an error', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          description: 'Bad Request: file not found',
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    await expect(
      resolveTelegramFileUrl('bot-token-abc', 'bad-file-id'),
    ).rejects.toThrow('Bad Request: file not found');

    globalThis.fetch = originalFetch;
  });
});

// ============================================================================
// Tests: extractMediaContext
// ============================================================================

describe('extractMediaContext', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it('returns empty result for envelopes with no media', async () => {
    const envelope = makeEnvelope({ content: { text: 'hello' } });
    const result = await extractMediaContext(envelope, {});

    expect(result.imageUrls).toHaveLength(0);
    expect(result.mediaDescriptions).toHaveLength(0);
    expect(result.annotation).toBe('');

    globalThis.fetch = originalFetch;
  });

  it('resolves photo attachments to image URLs', async () => {
    // Mock the Telegram getFile API call
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: 'photos/file_1.jpg' },
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const envelope = makeEnvelope({
      content: { text: 'Look at this', media: [makePhotoAttachment()] },
    });

    const config: MediaExtractionConfig = {
      telegramBotToken: 'test-bot-token',
    };

    const result = await extractMediaContext(envelope, config);

    expect(result.imageUrls).toHaveLength(1);
    expect(result.imageUrls[0]).toBe(
      'https://api.telegram.org/file/bottest-bot-token/photos/file_1.jpg',
    );
    expect(result.mediaDescriptions).toHaveLength(0);

    globalThis.fetch = originalFetch;
  });

  it('falls back to description when bot token is missing', async () => {
    const envelope = makeEnvelope({
      content: { text: '', media: [makePhotoAttachment()] },
    });

    const result = await extractMediaContext(envelope, {});

    expect(result.imageUrls).toHaveLength(0);
    expect(result.mediaDescriptions).toHaveLength(1);
    expect(result.mediaDescriptions[0]).toContain('photo');

    globalThis.fetch = originalFetch;
  });

  it('adds video description as placeholder', async () => {
    const envelope = makeEnvelope({
      content: { text: '', media: [makeVideoAttachment()] },
    });

    const result = await extractMediaContext(envelope, {
      telegramBotToken: 'test-bot-token',
    });

    expect(result.imageUrls).toHaveLength(0);
    expect(result.mediaDescriptions).toHaveLength(1);
    expect(result.mediaDescriptions[0]).toContain('video');
    expect(result.annotation).toContain('video');

    globalThis.fetch = originalFetch;
  });

  it('resolves document images to image URLs', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: 'documents/image.png' },
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const envelope = makeEnvelope({
      content: { text: '', media: [makeDocImageAttachment()] },
    });

    const result = await extractMediaContext(envelope, {
      telegramBotToken: 'test-bot-token',
    });

    expect(result.imageUrls).toHaveLength(1);
    expect(result.imageUrls[0]).toContain('documents/image.png');

    globalThis.fetch = originalFetch;
  });

  it('transcribes audio when OpenAI key is available', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      // First call: Telegram getFile
      if (urlStr.includes('api.telegram.org') && urlStr.includes('getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: 'voice/file_1.oga' },
          }),
          { status: 200 },
        );
      }

      // Second call: Download the audio file
      if (urlStr.includes('api.telegram.org/file/')) {
        return new Response(Buffer.from('fake-audio-data'), { status: 200 });
      }

      // Third call: OpenAI Whisper transcription
      if (urlStr.includes('openai.com')) {
        return new Response(
          JSON.stringify({ text: 'Hello, this is a voice message.' }),
          { status: 200 },
        );
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof globalThis.fetch;

    const envelope = makeEnvelope({
      content: { text: '', media: [makeAudioAttachment()] },
    });

    const config: MediaExtractionConfig = {
      telegramBotToken: 'test-bot-token',
      openaiApiKey: 'test-openai-key',
    };

    const result = await extractMediaContext(envelope, config);

    expect(result.mediaDescriptions).toHaveLength(1);
    expect(result.mediaDescriptions[0]).toContain(
      'Hello, this is a voice message.',
    );
    expect(result.annotation).toContain('Voice message transcript');

    globalThis.fetch = originalFetch;
  });

  it('falls back to description when audio transcription fails', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: 'voice/file_1.oga' },
          }),
          { status: 200 },
        );
      }

      if (urlStr.includes('api.telegram.org/file/')) {
        return new Response(Buffer.from('fake-audio'), { status: 200 });
      }

      if (urlStr.includes('openai.com')) {
        return new Response('Internal Server Error', { status: 500 });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof globalThis.fetch;

    const envelope = makeEnvelope({
      content: { text: '', media: [makeAudioAttachment()] },
    });

    const config: MediaExtractionConfig = {
      telegramBotToken: 'test-bot-token',
      openaiApiKey: 'test-openai-key',
    };

    const result = await extractMediaContext(envelope, config);

    // Should fall back to description
    expect(result.mediaDescriptions).toHaveLength(1);
    expect(result.mediaDescriptions[0]).toContain('voice/audio');

    globalThis.fetch = originalFetch;
  });

  it('skips audio transcription when text already exists (prior transcription)', async () => {
    const envelope = makeEnvelope({
      content: {
        text: 'Previously transcribed text',
        media: [makeAudioAttachment()],
      },
    });

    // Should not attempt to transcribe since text already exists
    const result = await extractMediaContext(envelope, {
      telegramBotToken: 'test-bot-token',
      openaiApiKey: 'test-openai-key',
    });

    // Audio should get a fallback description since we skip transcription
    expect(result.mediaDescriptions).toHaveLength(1);
    expect(result.mediaDescriptions[0]).toContain('voice/audio');

    globalThis.fetch = originalFetch;
  });

  it('handles multiple media attachments in one message', async () => {
    let callCount = 0;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      callCount++;
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes('getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: `photos/file_${callCount}.jpg` },
          }),
          { status: 200 },
        );
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof globalThis.fetch;

    const envelope = makeEnvelope({
      content: {
        text: 'Multiple images',
        media: [makePhotoAttachment(), makeVideoAttachment()],
      },
    });

    const result = await extractMediaContext(envelope, {
      telegramBotToken: 'test-bot-token',
    });

    // Photo should be resolved as image URL
    expect(result.imageUrls).toHaveLength(1);
    // Video should be a description
    expect(result.mediaDescriptions).toHaveLength(1);
    expect(result.mediaDescriptions[0]).toContain('video');

    globalThis.fetch = originalFetch;
  });

  it('uses existing URL on attachment when available', async () => {
    const attachment: MediaAttachment = {
      type: 'photo',
      url: 'https://example.com/image.jpg',
      size: 50000,
    };

    const envelope = makeEnvelope({
      content: { text: '', media: [attachment] },
    });

    // No fetch should be needed
    const result = await extractMediaContext(envelope, {});

    expect(result.imageUrls).toHaveLength(1);
    expect(result.imageUrls[0]).toBe('https://example.com/image.jpg');
  });
});

// ============================================================================
// Tests: buildUserMessageContent
// ============================================================================

describe('buildUserMessageContent', () => {
  it('returns plain text when no images', () => {
    const extraction: MediaExtractionResult = {
      imageUrls: [],
      mediaDescriptions: ['[The user sent a video]'],
      annotation: '[The user sent a video]',
    };

    const content = buildUserMessageContent('[User]: Hello', extraction);
    expect(typeof content).toBe('string');
    expect(content).toContain('[User]: Hello');
    expect(content).toContain('[The user sent a video]');
  });

  it('returns multimodal content parts when images are present', () => {
    const extraction: MediaExtractionResult = {
      imageUrls: ['https://example.com/image.jpg'],
      mediaDescriptions: [],
      annotation: '',
    };

    const content = buildUserMessageContent('[User]: Look at this', extraction);
    expect(Array.isArray(content)).toBe(true);

    const parts = content as Array<{ type: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      type: 'text',
      text: '[User]: Look at this',
    });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/image.jpg' },
    });
  });

  it('combines text annotation and image URLs for mixed media', () => {
    const extraction: MediaExtractionResult = {
      imageUrls: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'],
      mediaDescriptions: ['[Voice message transcript]: Hello world'],
      annotation: '[Voice message transcript]: Hello world',
    };

    const content = buildUserMessageContent('[User]: ', extraction);
    expect(Array.isArray(content)).toBe(true);

    const parts = content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(3); // 1 text + 2 images
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('Voice message transcript');
    expect(parts[1].type).toBe('image_url');
    expect(parts[2].type).toBe('image_url');
  });

  it('returns plain text with no annotation when no media', () => {
    const extraction: MediaExtractionResult = {
      imageUrls: [],
      mediaDescriptions: [],
      annotation: '',
    };

    const content = buildUserMessageContent('[User]: Just text', extraction);
    expect(content).toBe('[User]: Just text');
  });
});
