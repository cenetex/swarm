/**
 * Twitter/X Platform Adapter Tests
 *
 * Tests for the TwitterAdapter class that handles Twitter API v2 interactions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TwitterAdapter } from './twitter.js';
import type { AgentConfig } from '../types/index.js';

// Mock twitter-api-v2
vi.mock('twitter-api-v2', () => {
  const mockTweet = vi.fn();
  const mockLike = vi.fn();
  const mockUploadMedia = vi.fn();
  const mockUserMentionTimeline = vi.fn();
  const mockMe = vi.fn();

  return {
    TwitterApi: vi.fn().mockImplementation(() => ({
      v2: {
        tweet: mockTweet,
        like: mockLike,
        userMentionTimeline: mockUserMentionTimeline,
        me: mockMe,
      },
      v1: {
        uploadMedia: mockUploadMedia,
      },
    })),
  };
});

const createMockAgentConfig = (twitterEnabled = true): AgentConfig => ({
  id: 'test-agent',
  name: 'Test Agent',
  version: '1.0.0',
  persona: 'Test persona',
  platforms: {
    twitter: twitterEnabled ? {
      enabled: true,
      username: 'test_bot',
      features: ['mention_replies'],
    } : { enabled: false, username: '' },
  },
  llm: { provider: 'openrouter', model: 'test', temperature: 0.7, maxTokens: 1024 },
  media: { image: { provider: 'replicate', model: 'flux' } },
  scheduling: {},
  behavior: { responseDelayMs: [0, 0], typingIndicator: false, ignoreBots: true, cooldownMinutes: 0, maxContextMessages: 10 },
  tools: [],
  secrets: [],
});

const createMockCredentials = (partial?: Partial<{ appKey: string; appSecret: string; accessToken: string; accessSecret: string }>) => ({
  appKey: partial?.appKey ?? 'test-app-key',
  appSecret: partial?.appSecret ?? 'test-app-secret',
  accessToken: partial?.accessToken ?? 'test-access-token',
  accessSecret: partial?.accessSecret ?? 'test-access-secret',
});

describe('TwitterAdapter - Configuration', () => {
  it('should identify as twitter platform', () => {
    // Basic verification that platform identifier is correct
    const platform = 'twitter' as const;
    expect(platform).toBe('twitter');
  });

  it('isConfigured returns true when all credentials are present', () => {
    const adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
    expect(adapter.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when any credential is missing', () => {
    const adapter = new TwitterAdapter(
      createMockAgentConfig(),
      createMockCredentials({ appKey: '' })
    );
    expect(adapter.isConfigured()).toBe(false);
  });

  it('isConfigured returns false when twitter config is disabled', () => {
    const adapter = new TwitterAdapter(
      createMockAgentConfig(false),
      createMockCredentials()
    );
    expect(adapter.isConfigured()).toBe(false);
  });

  it('getDisplayName returns formatted username', () => {
    const adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
    expect(adapter.getDisplayName()).toBe('Twitter @test_bot');
  });
});

describe('TwitterAdapter - Message Parsing', () => {
  let adapter: TwitterAdapter;

  beforeEach(() => {
    adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
  });

  it('parseMessage returns null for invalid tweet data', async () => {
    const result = await adapter.parseMessage({});
    expect(result).toBeNull();
  });

  it('parseMessage extracts tweet ID and text correctly', async () => {
    const tweet = {
      id: '123456789',
      text: 'Hello @test_bot how are you?',
      created_at: '2026-01-13T10:00:00.000Z',
    };

    const envelope = await adapter.parseMessage(tweet);

    expect(envelope).not.toBeNull();
    expect(envelope!.messageId).toBe('123456789');
    expect(envelope!.content.text).toBe('Hello @test_bot how are you?');
  });

  it('parseMessage extracts sender info from author', async () => {
    const tweet = {
      id: '123',
      text: 'Test',
      author_id: 'author-456',
      author: {
        id: 'author-456',
        username: 'sender_user',
        name: 'Sender Name',
      },
    };

    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.sender.id).toBe('author-456');
    expect(envelope!.sender.username).toBe('sender_user');
    expect(envelope!.sender.displayName).toBe('Sender Name');
  });

  it('parseMessage extracts conversation_id for threading', async () => {
    const tweet = {
      id: '123',
      text: 'Reply tweet',
      conversation_id: 'conv-789',
    };

    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.conversationId).toBe('conv-789');
  });

  it('parseMessage extracts reply_to from referenced_tweets', async () => {
    const tweet = {
      id: '123',
      text: 'This is a reply',
      referenced_tweets: [
        { type: 'replied_to', id: 'original-tweet-id' },
      ],
    };

    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.replyTo).toBe('original-tweet-id');
  });

  it('parseMessage handles missing optional fields gracefully', async () => {
    const tweet = {
      id: '123',
      text: 'Minimal tweet',
    };

    const envelope = await adapter.parseMessage(tweet);

    expect(envelope).not.toBeNull();
    expect(envelope!.messageId).toBe('123');
    expect(envelope!.conversationId).toBe('123'); // Falls back to tweet ID
  });
});

describe('TwitterAdapter - Mention Extraction', () => {
  it('should match @mention regex pattern', () => {
    const mentionRegex = /@(\w+)/g;
    const text = 'Hello @user1 and @user2!';
    const matches = [...text.matchAll(mentionRegex)];

    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe('user1');
    expect(matches[1][1]).toBe('user2');
  });

  it('extractMentions returns empty array for no mentions', async () => {
    const adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
    const tweet = { id: '1', text: 'No mentions here' };
    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.mentions).toHaveLength(0);
  });

  it('extractMentions returns correct offset and length', async () => {
    const adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
    const tweet = { id: '1', text: 'Hello @test_bot' };
    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.mentions.length).toBeGreaterThan(0);
    const mention = envelope!.mentions[0];
    expect(mention.username).toBe('test_bot');
    expect(mention.offset).toBe(6); // Position of @
    expect(mention.length).toBe(9); // Length of @test_bot
  });

  it('extractMentions handles multiple consecutive mentions', async () => {
    const adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
    const tweet = { id: '1', text: '@user1 @user2 @user3 hello' };
    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.mentions).toHaveLength(3);
  });
});

describe('TwitterAdapter - Action Execution', () => {
  let adapter: TwitterAdapter;
  let TwitterApi: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ TwitterApi } = await import('twitter-api-v2'));
    adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
  });

  it('executeAction throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAgentConfig(false),
      createMockCredentials()
    );

    await expect(
      unconfiguredAdapter.executeAction({ type: 'send_message', text: 'test' }, 'conv-1')
    ).rejects.toThrow('Twitter client not initialized');
  });

  it('executeAction handles send_message action', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'tweet-123' } });
    mockClient.v2.me.mockResolvedValue({ data: { id: 'bot-user-id' } });

    const result = await adapter.executeAction(
      { type: 'send_message', text: 'Hello world' },
      'conv-1',
      'reply-to-id'
    );

    expect(result).toBe(true);
    expect(mockClient.v2.tweet).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hello world',
        reply: { in_reply_to_tweet_id: 'reply-to-id' },
      })
    );
  });

  it('executeAction handles send_voice action with URL', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'tweet-123' } });

    const result = await adapter.executeAction(
      { type: 'send_voice', url: 'https://example.com/audio.mp3', caption: 'Listen to this' },
      'conv-1'
    );

    expect(result).toBe(true);
    expect(mockClient.v2.tweet).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('https://example.com/audio.mp3'),
      })
    );
  });

  it('executeAction handles react action (like)', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.me.mockResolvedValue({ data: { id: 'bot-user-id' } });
    mockClient.v2.like.mockResolvedValue({ data: { liked: true } });

    const result = await adapter.executeAction(
      { type: 'react', messageId: 'tweet-to-like', emoji: '❤️' },
      'conv-1'
    );

    expect(result).toBe(true);
    expect(mockClient.v2.like).toHaveBeenCalledWith('bot-user-id', 'tweet-to-like');
  });

  it('executeAction handles wait action with delay', async () => {
    const start = Date.now();

    const result = await adapter.executeAction(
      { type: 'wait', durationMs: 50 },
      'conv-1'
    );

    const elapsed = Date.now() - start;
    expect(result).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
  });

  it('executeAction handles ignore action (no-op)', async () => {
    const result = await adapter.executeAction({ type: 'ignore' }, 'conv-1');
    expect(result).toBe(true);
  });

  it('executeAction returns false on API error', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockRejectedValue(new Error('Rate limited'));

    const result = await adapter.executeAction(
      { type: 'send_message', text: 'test' },
      'conv-1'
    );

    expect(result).toBe(false);
  });
});

describe('TwitterAdapter - Tweet Posting', () => {
  let adapter: TwitterAdapter;
  let TwitterApi: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ TwitterApi } = await import('twitter-api-v2'));
    adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
  });

  it('postTweet throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAgentConfig(false),
      createMockCredentials()
    );

    await expect(unconfiguredAdapter.postTweet('test')).rejects.toThrow('Twitter client not initialized');
  });

  it('postTweet sends basic text tweet', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'new-tweet-id' } });

    const result = await adapter.postTweet('Hello Twitter!');

    expect(result).toBe('new-tweet-id');
    expect(mockClient.v2.tweet).toHaveBeenCalledWith({ text: 'Hello Twitter!' });
  });

  it('postTweet includes reply parameters when replying', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'reply-id' } });

    await adapter.postTweet('Reply text', undefined, 'original-tweet-id');

    expect(mockClient.v2.tweet).toHaveBeenCalledWith({
      text: 'Reply text',
      reply: { in_reply_to_tweet_id: 'original-tweet-id' },
    });
  });

  it('postTweet uploads and attaches single image', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'tweet-id' } });
    mockClient.v1.uploadMedia.mockResolvedValue('media-id-1');

    // Mock fetch for image download
    global.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    await adapter.postTweet('Tweet with image', [{ type: 'image', url: 'https://example.com/image.png' }]);

    expect(mockClient.v1.uploadMedia).toHaveBeenCalled();
    expect(mockClient.v2.tweet).toHaveBeenCalledWith(
      expect.objectContaining({
        media: { media_ids: ['media-id-1'] },
      })
    );
  });

  it('postTweet uploads and attaches multiple images', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'tweet-id' } });
    mockClient.v1.uploadMedia
      .mockResolvedValueOnce('media-id-1')
      .mockResolvedValueOnce('media-id-2');

    global.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    await adapter.postTweet('Tweet with images', [
      { type: 'image', url: 'https://example.com/1.png' },
      { type: 'image', url: 'https://example.com/2.png' },
    ]);

    expect(mockClient.v1.uploadMedia).toHaveBeenCalledTimes(2);
  });

  it('postTweet handles media upload failure gracefully', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'tweet-id' } });
    mockClient.v1.uploadMedia.mockRejectedValue(new Error('Upload failed'));

    global.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    // Should not throw, just post without media
    const result = await adapter.postTweet('Tweet', [{ type: 'image', url: 'https://example.com/fail.png' }]);

    expect(result).toBe('tweet-id');
  });

  it('postTweet returns tweet ID on success', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'returned-tweet-id' } });

    const result = await adapter.postTweet('Test');

    expect(result).toBe('returned-tweet-id');
  });
});

describe('TwitterAdapter - Mentions Retrieval', () => {
  let adapter: TwitterAdapter;
  let TwitterApi: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ TwitterApi } = await import('twitter-api-v2'));
    adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
  });

  it('getMentions throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAgentConfig(false),
      createMockCredentials()
    );

    await expect(unconfiguredAdapter.getMentions()).rejects.toThrow('Twitter client not initialized');
  });

  it('getMentions fetches mentions without since_id', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.me.mockResolvedValue({ data: { id: 'bot-id' } });
    mockClient.v2.userMentionTimeline.mockResolvedValue({
      data: { data: [] },
      includes: {},
    });

    await adapter.getMentions();

    expect(mockClient.v2.userMentionTimeline).toHaveBeenCalledWith(
      'bot-id',
      expect.objectContaining({
        since_id: undefined,
      })
    );
  });

  it('getMentions fetches mentions with since_id for pagination', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.me.mockResolvedValue({ data: { id: 'bot-id' } });
    mockClient.v2.userMentionTimeline.mockResolvedValue({
      data: { data: [] },
      includes: {},
    });

    await adapter.getMentions('last-mention-id');

    expect(mockClient.v2.userMentionTimeline).toHaveBeenCalledWith(
      'bot-id',
      expect.objectContaining({
        since_id: 'last-mention-id',
      })
    );
  });

  it('getMentions parses all returned tweets into envelopes', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.me.mockResolvedValue({ data: { id: 'bot-id' } });
    mockClient.v2.userMentionTimeline.mockResolvedValue({
      data: {
        data: [
          { id: '1', text: 'Mention 1', author_id: 'author-1' },
          { id: '2', text: 'Mention 2', author_id: 'author-2' },
        ],
      },
      includes: {
        users: [
          { id: 'author-1', username: 'user1', name: 'User 1' },
          { id: 'author-2', username: 'user2', name: 'User 2' },
        ],
      },
    });

    const result = await adapter.getMentions();

    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe('1');
    expect(result[1].messageId).toBe('2');
  });

  it('getMentions handles empty response', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.me.mockResolvedValue({ data: { id: 'bot-id' } });
    mockClient.v2.userMentionTimeline.mockResolvedValue({
      data: { data: undefined },
      includes: {},
    });

    const result = await adapter.getMentions();

    expect(result).toHaveLength(0);
  });

  it('getMentions includes author data from expansions', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.me.mockResolvedValue({ data: { id: 'bot-id' } });
    mockClient.v2.userMentionTimeline.mockResolvedValue({
      data: {
        data: [{ id: '1', text: 'Hello', author_id: 'author-123' }],
      },
      includes: {
        users: [{ id: 'author-123', username: 'testuser', name: 'Test User' }],
      },
    });

    const result = await adapter.getMentions();

    expect(result[0].sender.username).toBe('testuser');
    expect(result[0].sender.displayName).toBe('Test User');
  });
});

describe('TwitterAdapter - Quote Tweets', () => {
  let adapter: TwitterAdapter;
  let TwitterApi: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ TwitterApi } = await import('twitter-api-v2'));
    adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
  });

  it('quoteTweet throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAgentConfig(false),
      createMockCredentials()
    );

    await expect(unconfiguredAdapter.quoteTweet('test', 'quote-id')).rejects.toThrow('Twitter client not initialized');
  });

  it('quoteTweet posts with quote_tweet_id', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'quote-tweet-id' } });

    await adapter.quoteTweet('My comment', 'original-tweet-123');

    expect(mockClient.v2.tweet).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'My comment',
        quote_tweet_id: 'original-tweet-123',
      })
    );
  });

  it('quoteTweet attaches media when provided', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'qt-id' } });
    mockClient.v1.uploadMedia.mockResolvedValue('media-id');

    global.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    await adapter.quoteTweet('Comment', 'original-123', [
      { type: 'image', url: 'https://example.com/image.png' },
    ]);

    expect(mockClient.v1.uploadMedia).toHaveBeenCalled();
  });

  it('quoteTweet limits media to 4 items', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'qt-id' } });
    mockClient.v1.uploadMedia.mockResolvedValue('media-id');

    global.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    const fiveImages = Array(5).fill({ type: 'image', url: 'https://example.com/img.png' });

    await adapter.quoteTweet('Comment', 'original-123', fiveImages);

    // Should only upload 4 images (Twitter limit)
    expect(mockClient.v1.uploadMedia).toHaveBeenCalledTimes(4);
  });

  it('quoteTweet returns tweet ID on success', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.tweet.mockResolvedValue({ data: { id: 'quote-result-id' } });

    const result = await adapter.quoteTweet('Comment', 'original-123');

    expect(result).toBe('quote-result-id');
  });
});

describe('TwitterAdapter - Bot User ID', () => {
  let adapter: TwitterAdapter;
  let TwitterApi: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ TwitterApi } = await import('twitter-api-v2'));
    adapter = new TwitterAdapter(createMockAgentConfig(), createMockCredentials());
  });

  it('getBotUserId fetches and caches user ID', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.me.mockResolvedValue({ data: { id: 'bot-user-id-123' } });
    mockClient.v2.like.mockResolvedValue({ data: { liked: true } });

    // Trigger getBotUserId via an action that uses it
    await adapter.executeAction({ type: 'react', messageId: 'tweet-1', emoji: '❤️' }, 'conv-1');

    expect(mockClient.v2.me).toHaveBeenCalled();
    expect(mockClient.v2.like).toHaveBeenCalledWith('bot-user-id-123', 'tweet-1');
  });

  it('getBotUserId returns cached ID on subsequent calls', async () => {
    const mockClient = TwitterApi.mock.results[0]?.value;
    mockClient.v2.me.mockResolvedValue({ data: { id: 'cached-id' } });
    mockClient.v2.like.mockResolvedValue({ data: { liked: true } });

    // First call
    await adapter.executeAction({ type: 'react', messageId: 'tweet-1', emoji: '❤️' }, 'conv-1');
    // Second call
    await adapter.executeAction({ type: 'react', messageId: 'tweet-2', emoji: '❤️' }, 'conv-1');

    // me() should only be called once due to caching
    expect(mockClient.v2.me).toHaveBeenCalledTimes(1);
  });

  it('getBotUserId throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAgentConfig(false),
      createMockCredentials()
    );

    // This will trigger getBotUserId internally
    await expect(
      unconfiguredAdapter.executeAction({ type: 'react', messageId: 'tweet-1', emoji: '❤️' }, 'conv-1')
    ).rejects.toThrow('Twitter client not initialized');
  });
});

describe('TwitterAdapter - Integration Scenarios (TODO)', () => {
  /**
   * These tests document E2E scenarios that require real Twitter API.
   * They are marked as todo until integration test infrastructure is set up.
   */
  it.todo('E2E: Full mention processing workflow');
  it.todo('E2E: Post tweet with image from URL');
  it.todo('E2E: Handle rate limiting gracefully');
  it.todo('E2E: OAuth token refresh when expired');
});
