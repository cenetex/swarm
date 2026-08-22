import { TwitterAdapter } from '@swarm/core';
/**
 * Twitter Threaded Replies and Media Attachment Tests
 *
 * Validates that:
 * - Mention replies set in_reply_to_tweet_id correctly
 * - Generated images are uploaded and attached to tweets
 * - Media upload failures are handled gracefully
 * - Existing mention polling behavior is preserved
 *
 * Closes #1108
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { TwitterApi } from 'twitter-api-v2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockAvatarConfig = (): AvatarConfig => ({
  id: 'test-avatar',
  name: 'Test Avatar',
  version: '1.0.0',
  persona: 'Test persona',
  platforms: {
    twitter: {
      enabled: true,
      username: 'test_bot',
      features: ['mention_replies'],
    },
  },
  llm: { provider: 'openrouter', model: 'test', temperature: 0.7, maxTokens: 1024 },
  media: { image: { provider: 'replicate', model: 'flux' } },
  scheduling: {},
  behavior: {
    responseDelayMs: [0, 0],
    typingIndicator: false,
    ignoreBots: true,
    cooldownMinutes: 0,
    maxContextMessages: 10,
  },
  tools: [],
  secrets: [],
});

const createMockCredentials = () => ({
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  accessToken: 'test-access-token',
  accessSecret: 'test-access-secret',
});

function createMockTwitterClient() {
  return {
    v2: {
      tweet: mock(() => Promise.resolve({ data: { id: 'reply-tweet-123' } })),
      like: mock(() => Promise.resolve({ data: { liked: true } })),
      userMentionTimeline: mock(() =>
        Promise.resolve({ data: { data: [] }, includes: {} })
      ),
      singleTweet: mock(() => Promise.resolve({ data: null, includes: {} })),
      me: mock(() => Promise.resolve({ data: { id: 'bot-user-id' } })),
    },
    v1: {
      uploadMedia: mock(() => Promise.resolve('media-id-1')),
    },
  } as unknown as TwitterApi;
}

// ---------------------------------------------------------------------------
// Threaded Replies
// ---------------------------------------------------------------------------

describe('Twitter Threaded Replies', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(
      createMockAvatarConfig(),
      createMockCredentials(),
      mockClient
    );
  });

  it('should set in_reply_to_tweet_id when replying to a mention', async () => {
    const replyToTweetId = 'original-mention-tweet-999';
    await adapter.postTweet('Thanks for the mention!', undefined, replyToTweetId);

    const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
    const tweetParams = tweetCall[0] as { text: string; reply?: { in_reply_to_tweet_id: string } };

    expect(tweetParams.reply).toBeDefined();
    expect(tweetParams.reply!.in_reply_to_tweet_id).toBe(replyToTweetId);
    expect(tweetParams.text).toBe('Thanks for the mention!');
  });

  it('should not set reply params when no replyToTweetId is provided', async () => {
    await adapter.postTweet('Just a regular tweet');

    const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
    const tweetParams = tweetCall[0] as { text: string; reply?: unknown };

    expect(tweetParams.reply).toBeUndefined();
  });

  it('should return the posted tweet ID for threaded replies', async () => {
    const tweetId = await adapter.postTweet('Reply text', undefined, 'parent-tweet-id');
    expect(tweetId).toBe('reply-tweet-123');
  });

  it('should thread via executeAction with send_message and replyToMessageId', async () => {
    const replyToId = 'mention-tweet-42';

    await adapter.executeAction(
      { type: 'send_message', text: 'Threaded reply via executeAction' },
      'conv-123',
      replyToId
    );

    const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
    const tweetParams = tweetCall[0] as { text: string; reply?: { in_reply_to_tweet_id: string } };

    expect(tweetParams.reply).toBeDefined();
    expect(tweetParams.reply!.in_reply_to_tweet_id).toBe(replyToId);
  });

  it('should thread via executeAction with send_media and replyToMessageId', async () => {
    const replyToId = 'mention-tweet-77';

    // Mock global fetch for media download
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(Buffer.from('fake-image-data'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      )
    ) as typeof fetch;

    try {
      await adapter.executeAction(
        { type: 'send_media', mediaType: 'image', url: 'https://example.com/image.png', caption: 'Check this out' },
        'conv-456',
        replyToId
      );

      const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
      const tweetParams = tweetCall[0] as {
        text: string;
        reply?: { in_reply_to_tweet_id: string };
        media?: { media_ids: string[] };
      };

      expect(tweetParams.reply).toBeDefined();
      expect(tweetParams.reply!.in_reply_to_tweet_id).toBe(replyToId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Media Attachment Delivery
// ---------------------------------------------------------------------------

describe('Twitter Media Attachment Delivery', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(
      createMockAvatarConfig(),
      createMockCredentials(),
      mockClient
    );
  });

  it('should upload media and attach media_ids to tweet', async () => {
    // Mock fetch for media download
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(Buffer.from('fake-image-bytes'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      )
    ) as typeof fetch;

    try {
      const tweetId = await adapter.postTweet(
        'Tweet with image',
        [{ type: 'image', url: 'https://example.com/photo.png' }],
        'parent-tweet-55'
      );

      expect(tweetId).toBe('reply-tweet-123');

      // Verify media was uploaded
      const uploadCalls = (mockClient.v1.uploadMedia as ReturnType<typeof mock>).mock.calls;
      expect(uploadCalls.length).toBe(1);

      // Verify tweet includes media_ids and reply
      const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
      const tweetParams = tweetCall[0] as {
        text: string;
        reply?: { in_reply_to_tweet_id: string };
        media?: { media_ids: string[] };
      };

      expect(tweetParams.media).toBeDefined();
      expect(tweetParams.media!.media_ids).toContain('media-id-1');
      expect(tweetParams.reply!.in_reply_to_tweet_id).toBe('parent-tweet-55');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should upload multiple media items (up to 4)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(Buffer.from('fake'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      )
    ) as typeof fetch;

    try {
      const mediaItems = [
        { type: 'image', url: 'https://example.com/1.jpg' },
        { type: 'image', url: 'https://example.com/2.jpg' },
        { type: 'image', url: 'https://example.com/3.jpg' },
        { type: 'image', url: 'https://example.com/4.jpg' },
        { type: 'image', url: 'https://example.com/5.jpg' }, // should be dropped
      ];

      const mediaIds = await adapter.uploadMedia(mediaItems);

      // Twitter max is 4 media items
      const uploadCalls = (mockClient.v1.uploadMedia as ReturnType<typeof mock>).mock.calls;
      expect(uploadCalls.length).toBe(4);
      expect(mediaIds.length).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should handle media upload failure gracefully and still post tweet', async () => {
    // Make upload fail
    (mockClient.v1.uploadMedia as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error('Upload failed: 503'))
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(Buffer.from('fake'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      )
    ) as typeof fetch;

    try {
      // postTweet should still succeed -- media upload failure is non-fatal
      const tweetId = await adapter.postTweet(
        'Tweet with failed media',
        [{ type: 'image', url: 'https://example.com/broken.png' }],
        'parent-42'
      );

      expect(tweetId).toBe('reply-tweet-123');

      // Verify tweet was posted without media_ids (since upload failed)
      const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
      const tweetParams = tweetCall[0] as {
        text: string;
        media?: { media_ids: string[] };
        reply?: { in_reply_to_tweet_id: string };
      };

      expect(tweetParams.media).toBeUndefined();
      // Reply should still be set
      expect(tweetParams.reply!.in_reply_to_tweet_id).toBe('parent-42');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should handle partial media upload failure', async () => {
    let callCount = 0;
    (mockClient.v1.uploadMedia as ReturnType<typeof mock>).mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return Promise.reject(new Error('Upload failed for item 2'));
      }
      return Promise.resolve(`media-id-${callCount}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(Buffer.from('fake'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      )
    ) as typeof fetch;

    try {
      const mediaIds = await adapter.uploadMedia([
        { type: 'image', url: 'https://example.com/1.png' },
        { type: 'image', url: 'https://example.com/2.png' },
        { type: 'image', url: 'https://example.com/3.png' },
      ]);

      // Only 2 out of 3 should succeed
      expect(mediaIds.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should handle media download failure gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('Not Found', { status: 404, statusText: 'Not Found' })
      )
    ) as typeof fetch;

    try {
      // uploadMedia should handle the download failure and return empty array
      const mediaIds = await adapter.uploadMedia([
        { type: 'image', url: 'https://example.com/missing.png' },
      ]);

      expect(mediaIds.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Mention Parsing Preserves Threading Context
// ---------------------------------------------------------------------------

describe('Twitter Mention Parsing Threading Context', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(
      createMockAvatarConfig(),
      createMockCredentials(),
      mockClient
    );
  });

  it('should parse mention with replyTo field from referenced_tweets', async () => {
    const mentionTweet = {
      id: 'mention-tweet-100',
      text: '@test_bot what do you think?',
      conversation_id: 'conv-root-1',
      referenced_tweets: [{ type: 'replied_to', id: 'original-tweet-50' }],
      in_reply_to_user_id: 'bot-user-id',
      author_id: 'user-xyz',
      author: { id: 'user-xyz', username: 'asker', name: 'Asker' },
    };

    const envelope = await adapter.parseMessage(mentionTweet);

    expect(envelope).not.toBeNull();
    expect(envelope!.messageId).toBe('mention-tweet-100');
    expect(envelope!.replyTo).toBe('original-tweet-50');
    expect(envelope!.conversationId).toBe('conv-root-1');
  });

  it('should detect isMention flag when bot username appears in text', async () => {
    const tweet = {
      id: 'tweet-200',
      text: 'Hey @test_bot check this out',
      author_id: 'user-abc',
    };

    const envelope = await adapter.parseMessage(tweet);
    expect(envelope!.metadata.isMention).toBe(true);
  });

  it('should detect isReplyToBot flag when in_reply_to_user_id matches bot', async () => {
    // First, set up botUserId
    await adapter.getBotUserId();

    const tweet = {
      id: 'tweet-300',
      text: 'Replying to bot tweet',
      in_reply_to_user_id: 'bot-user-id',
      author_id: 'user-def',
    };

    const envelope = await adapter.parseMessage(tweet);
    expect(envelope!.metadata.isReplyToBot).toBe(true);
  });

  it('should set high priority for direct engagement mentions', async () => {
    const tweet = {
      id: 'tweet-400',
      text: '@test_bot hello!',
      author_id: 'user-ghi',
    };

    const envelope = await adapter.parseMessage(tweet);
    expect(envelope!.metadata.priority).toBe('high');
  });

  it('should preserve messageId for use as in_reply_to_tweet_id in response', async () => {
    const mentionTweetId = 'mention-tweet-500';
    const tweet = {
      id: mentionTweetId,
      text: '@test_bot generate me something',
      author_id: 'user-jkl',
    };

    const envelope = await adapter.parseMessage(tweet);
    expect(envelope!.messageId).toBe(mentionTweetId);

    // When message-processor creates a response, it sets:
    // replyToMessageId = envelope.messageId
    // which then flows to postTweet(text, media, replyToTweetId)
    // This verifies the ID is preserved correctly
    await adapter.postTweet('Here you go!', undefined, envelope!.messageId);

    const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
    const tweetParams = tweetCall[0] as { reply?: { in_reply_to_tweet_id: string } };
    expect(tweetParams.reply!.in_reply_to_tweet_id).toBe(mentionTweetId);
  });
});

// ---------------------------------------------------------------------------
// End-to-End: Outbound Sender Integration (via executeAction)
// ---------------------------------------------------------------------------

describe('Twitter executeAction Threading + Media Integration', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(
      createMockAvatarConfig(),
      createMockCredentials(),
      mockClient
    );
  });

  it('should handle send_message with text-only threaded reply', async () => {
    const result = await adapter.executeAction(
      { type: 'send_message', text: 'Text-only reply' },
      'conv-1',
      'parent-tweet-1'
    );

    expect(result).toBe(true);

    const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
    const params = tweetCall[0] as { text: string; reply?: { in_reply_to_tweet_id: string } };
    expect(params.text).toBe('Text-only reply');
    expect(params.reply!.in_reply_to_tweet_id).toBe('parent-tweet-1');
  });

  it('should handle send_media with threaded reply', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(Buffer.from('img-data'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      )
    ) as typeof fetch;

    try {
      const result = await adapter.executeAction(
        {
          type: 'send_media',
          mediaType: 'image',
          url: 'https://cdn.example.com/gen-image.png',
          caption: 'Generated art',
        },
        'conv-2',
        'parent-tweet-2'
      );

      expect(result).toBe(true);

      // Verify media uploaded
      expect((mockClient.v1.uploadMedia as ReturnType<typeof mock>).mock.calls.length).toBe(1);

      // Verify tweet sent with media and reply
      const tweetCall = (mockClient.v2.tweet as ReturnType<typeof mock>).mock.calls[0];
      const params = tweetCall[0] as {
        text: string;
        reply?: { in_reply_to_tweet_id: string };
        media?: { media_ids: string[] };
      };
      expect(params.reply!.in_reply_to_tweet_id).toBe('parent-tweet-2');
      expect(params.media!.media_ids).toContain('media-id-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should handle react action (like) without threading', async () => {
    // Set up bot user ID
    await adapter.getBotUserId();

    const result = await adapter.executeAction(
      { type: 'react', emoji: 'like', messageId: 'tweet-to-like-1' },
      'conv-3',
      'parent-tweet-3'
    );

    expect(result).toBe(true);
    const likeCalls = (mockClient.v2.like as ReturnType<typeof mock>).mock.calls;
    expect(likeCalls.length).toBe(1);
    expect(likeCalls[0][0]).toBe('bot-user-id');
    expect(likeCalls[0][1]).toBe('tweet-to-like-1');
  });

  it('should propagate API errors as PlatformError with retryability', async () => {
    const apiError = new Error('429 Too Many Requests');
    (apiError as Record<string, unknown>).code = 429;
    (mockClient.v2.tweet as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(apiError)
    );

    try {
      await adapter.executeAction(
        { type: 'send_message', text: 'Will fail' },
        'conv-4',
        'parent-tweet-4'
      );
      // Should not reach here
      expect(true).toBe(false);
    } catch (error: unknown) {
      const err = error as { retryable?: boolean; statusCode?: number };
      expect(err.retryable).toBe(true);
      expect(err.statusCode).toBe(429);
    }
  });
});
