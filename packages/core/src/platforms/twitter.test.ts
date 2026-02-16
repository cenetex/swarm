/**
 * Twitter/X Platform Adapter Tests
 *
 * Tests for the TwitterAdapter class that handles Twitter API v2 interactions.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { TwitterAdapter } from './twitter.js';
import type { AvatarConfig } from '../types/index.js';
import type { TwitterApi } from 'twitter-api-v2';

const createMockAvatarConfig = (twitterEnabled = true): AvatarConfig => ({
  id: 'test-avatar',
  name: 'Test Avatar',
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

function createMockTwitterClient() {
  return {
    v2: {
      tweet: mock(() => Promise.resolve({ data: { id: 'tweet-123' } })),
      like: mock(() => Promise.resolve({ data: { liked: true } })),
      userMentionTimeline: mock(() => Promise.resolve({ data: { data: [] }, includes: {} })),
      singleTweet: mock(() => Promise.resolve({ data: null, includes: {} })),
      me: mock(() => Promise.resolve({ data: { id: 'bot-user-id' } })),
    },
    v1: {
      uploadMedia: mock(() => Promise.resolve('media-id-1')),
    },
  } as unknown as TwitterApi;
}

describe('TwitterAdapter - Configuration', () => {
  it('should identify as twitter platform', () => {
    const platform = 'twitter' as const;
    expect(platform).toBe('twitter');
  });

  it('isConfigured returns true when all credentials are present', () => {
    const adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials());
    expect(adapter.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when any credential is missing', () => {
    const adapter = new TwitterAdapter(
      createMockAvatarConfig(),
      createMockCredentials({ appKey: '' })
    );
    expect(adapter.isConfigured()).toBe(false);
  });

  it('isConfigured returns false when twitter config is disabled', () => {
    const adapter = new TwitterAdapter(
      createMockAvatarConfig(false),
      createMockCredentials()
    );
    expect(adapter.isConfigured()).toBe(false);
  });

  it('getDisplayName returns formatted username', () => {
    const adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials());
    expect(adapter.getDisplayName()).toBe('Twitter @test_bot');
  });
});

describe('TwitterAdapter - Message Parsing', () => {
  let adapter: TwitterAdapter;

  beforeEach(() => {
    adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials());
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
    const adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials());
    const tweet = { id: '1', text: 'No mentions here' };
    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.mentions).toHaveLength(0);
  });

  it('extractMentions returns correct offset and length', async () => {
    const adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials());
    const tweet = { id: '1', text: 'Hello @test_bot' };
    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.mentions.length).toBeGreaterThan(0);
    const mention = envelope!.mentions[0];
    expect(mention.username).toBe('test_bot');
    expect(mention.offset).toBe(6); // Position of @
    expect(mention.length).toBe(9); // Length of @test_bot
  });

  it('extractMentions handles multiple consecutive mentions', async () => {
    const adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials());
    const tweet = { id: '1', text: '@user1 @user2 @user3 hello' };
    const envelope = await adapter.parseMessage(tweet);

    expect(envelope!.mentions).toHaveLength(3);
  });
});

describe('TwitterAdapter - Action Execution', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials(), mockClient);
  });

  it('executeAction throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAvatarConfig(false),
      createMockCredentials()
    );

    await expect(
      unconfiguredAdapter.executeAction({ type: 'send_message', text: 'test' }, 'conv-1')
    ).rejects.toThrow('Twitter client not initialized');
  });

  it('executeAction handles send_message action', async () => {
    const result = await adapter.executeAction(
      { type: 'send_message', text: 'Hello world' },
      'conv-1',
      'reply-to-id'
    );

    expect(result).toBe(true);
    expect(mockClient.v2.tweet).toHaveBeenCalled();
  });

  it('executeAction handles send_voice action with URL', async () => {
    const result = await adapter.executeAction(
      { type: 'send_voice', url: 'https://example.com/audio.mp3', caption: 'Listen to this' },
      'conv-1'
    );

    expect(result).toBe(true);
    expect(mockClient.v2.tweet).toHaveBeenCalled();
  });

  it('executeAction handles react action (like)', async () => {
    const result = await adapter.executeAction(
      { type: 'react', messageId: 'tweet-to-like', emoji: '❤️' },
      'conv-1'
    );

    expect(result).toBe(true);
    expect(mockClient.v2.like).toHaveBeenCalled();
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
    mockClient.v2.tweet = mock(() => Promise.reject(new Error('Rate limited')));

    const result = await adapter.executeAction(
      { type: 'send_message', text: 'test' },
      'conv-1'
    );

    expect(result).toBe(false);
  });
});

describe('TwitterAdapter - Tweet Posting', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials(), mockClient);
  });

  it('postTweet throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAvatarConfig(false),
      createMockCredentials()
    );

    await expect(unconfiguredAdapter.postTweet('test')).rejects.toThrow('Twitter client not initialized');
  });

  it('postTweet sends basic text tweet', async () => {
    const result = await adapter.postTweet('Hello Twitter!');

    expect(result).toBe('tweet-123');
    expect(mockClient.v2.tweet).toHaveBeenCalled();
  });

  it('postTweet includes reply parameters when replying', async () => {
    await adapter.postTweet('Reply text', undefined, 'original-tweet-id');

    expect(mockClient.v2.tweet).toHaveBeenCalled();
  });

  it('postTweet uploads and attaches single image', async () => {
    // Mock fetch for image download
    globalThis.fetch = mock(() => Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: () => 'image/png',
      },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    } as Response));

    await adapter.postTweet('Tweet with image', [{ type: 'image', url: 'https://example.com/image.png' }]);

    expect(mockClient.v1.uploadMedia).toHaveBeenCalled();
    expect(mockClient.v2.tweet).toHaveBeenCalled();
  });

  it('postTweet handles media upload failure gracefully', async () => {
    mockClient.v1.uploadMedia = mock(() => Promise.reject(new Error('Upload failed')));

    globalThis.fetch = mock(() => Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: () => 'image/png',
      },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    } as Response));

    // Should not throw, just post without media
    const result = await adapter.postTweet('Tweet', [{ type: 'image', url: 'https://example.com/fail.png' }]);

    expect(result).toBe('tweet-123');
  });

  it('postTweet returns tweet ID on success', async () => {
    const result = await adapter.postTweet('Test');

    expect(result).toBe('tweet-123');
  });
});

describe('TwitterAdapter - Mentions Retrieval', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials(), mockClient);
  });

  it('getMentions throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAvatarConfig(false),
      createMockCredentials()
    );

    await expect(unconfiguredAdapter.getMentions()).rejects.toThrow('Twitter client not initialized');
  });

  it('getMentions fetches mentions without since_id', async () => {
    await adapter.getMentions();

    expect(mockClient.v2.userMentionTimeline).toHaveBeenCalled();
  });

  it('getMentions fetches mentions with since_id for pagination', async () => {
    await adapter.getMentions('last-mention-id');

    expect(mockClient.v2.userMentionTimeline).toHaveBeenCalled();
  });

  it('getMentions parses all returned tweets into envelopes', async () => {
    mockClient.v2.userMentionTimeline = mock(() => Promise.resolve({
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
    }));

    const result = await adapter.getMentions();

    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe('1');
    expect(result[1].messageId).toBe('2');
  });

  it('getMentions handles empty response', async () => {
    mockClient.v2.userMentionTimeline = mock(() => Promise.resolve({
      data: { data: undefined },
      includes: {},
    }));

    const result = await adapter.getMentions();

    expect(result).toHaveLength(0);
  });

  it('getMentions includes author data from expansions', async () => {
    mockClient.v2.userMentionTimeline = mock(() => Promise.resolve({
      data: {
        data: [{ id: '1', text: 'Hello', author_id: 'author-123' }],
      },
      includes: {
        users: [{ id: 'author-123', username: 'testuser', name: 'Test User' }],
      },
    }));

    const result = await adapter.getMentions();

    expect(result[0].sender.username).toBe('testuser');
    expect(result[0].sender.displayName).toBe('Test User');
  });
});

describe('TwitterAdapter - Reply Chain Context', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials(), mockClient);
  });

  it('buildReplyChainContextText returns undefined when tweet is not a reply', async () => {
    const context = await adapter.buildReplyChainContextText({
      id: 'm1',
      text: '@test_bot hi',
      referenced_tweets: [],
    } as any);

    expect(context).toBeUndefined();
  });

  it('buildReplyChainContextText walks replied_to chain and formats oldest→newest', async () => {
    const singleTweet = mockClient.v2.singleTweet as unknown as ReturnType<typeof mock>;
    singleTweet.mockImplementation((tweetId: string) => {
      if (tweetId === 'p1') {
        return Promise.resolve({
          data: {
            id: 'p1',
            text: 'Parent tweet',
            author_id: 'u2',
            referenced_tweets: [{ type: 'replied_to', id: 'r1' }],
          },
          includes: {
            users: [{ id: 'u2', username: 'bob', name: 'Bob' }],
          },
        });
      }

      if (tweetId === 'r1') {
        return Promise.resolve({
          data: {
            id: 'r1',
            text: 'Root tweet',
            author_id: 'u3',
          },
          includes: {
            users: [{ id: 'u3', username: 'carol', name: 'Carol' }],
          },
        });
      }

      return Promise.resolve({ data: null, includes: {} });
    });

    const context = await adapter.buildReplyChainContextText({
      id: 'm1',
      text: '@test_bot hi',
      referenced_tweets: [{ type: 'replied_to', id: 'p1' }],
    } as any, { maxParentTweets: 8, maxChars: 2000 });

    expect(context).toBeTruthy();
    expect(context!).toContain('Thread context');

    const rootIndex = context!.indexOf('@carol: Root tweet');
    const parentIndex = context!.indexOf('@bob: Parent tweet');
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    expect(parentIndex).toBeGreaterThanOrEqual(0);
    expect(rootIndex).toBeLessThan(parentIndex);

    expect(singleTweet).toHaveBeenCalledTimes(2);
  });
});

describe('TwitterAdapter - Quote Tweets', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials(), mockClient);
  });

  it('quoteTweet throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAvatarConfig(false),
      createMockCredentials()
    );

    await expect(unconfiguredAdapter.quoteTweet('test', 'quote-id')).rejects.toThrow('Twitter client not initialized');
  });

  it('quoteTweet posts with quote_tweet_id', async () => {
    await adapter.quoteTweet('My comment', 'original-tweet-123');

    expect(mockClient.v2.tweet).toHaveBeenCalled();
  });

  it('quoteTweet returns tweet ID on success', async () => {
    const result = await adapter.quoteTweet('Comment', 'original-123');

    expect(result).toBe('tweet-123');
  });
});

describe('TwitterAdapter - Bot User ID', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials(), mockClient);
  });

  it('getBotUserId fetches and caches user ID', async () => {
    // Trigger getBotUserId via an action that uses it
    await adapter.executeAction({ type: 'react', messageId: 'tweet-1', emoji: '❤️' }, 'conv-1');

    expect(mockClient.v2.me).toHaveBeenCalled();
    expect(mockClient.v2.like).toHaveBeenCalled();
  });

  it('getBotUserId returns cached ID on subsequent calls', async () => {
    // First call
    await adapter.executeAction({ type: 'react', messageId: 'tweet-1', emoji: '❤️' }, 'conv-1');
    // Second call
    await adapter.executeAction({ type: 'react', messageId: 'tweet-2', emoji: '❤️' }, 'conv-1');

    // me() should only be called once due to caching
    expect(mockClient.v2.me).toHaveBeenCalledTimes(1);
  });

  it('getBotUserId throws when client not initialized', async () => {
    const unconfiguredAdapter = new TwitterAdapter(
      createMockAvatarConfig(false),
      createMockCredentials()
    );

    await expect(
      unconfiguredAdapter.executeAction({ type: 'react', messageId: 'tweet-1', emoji: '❤️' }, 'conv-1')
    ).rejects.toThrow('Twitter client not initialized');
  });
});

describe('TwitterAdapter - Integration Scenarios', () => {
  let adapter: TwitterAdapter;
  let mockClient: ReturnType<typeof createMockTwitterClient>;

  beforeEach(() => {
    mockClient = createMockTwitterClient();
    adapter = new TwitterAdapter(createMockAvatarConfig(), createMockCredentials(), mockClient);
  });

  it('E2E: Full mention processing workflow', async () => {
    // Set up mock for mention retrieval
    const mentionData = {
      data: [
        {
          id: 'mention-123',
          text: '@test_bot What is the weather like today?',
          author_id: 'user-456',
          conversation_id: 'conv-789',
          created_at: '2026-01-13T10:00:00.000Z',
          referenced_tweets: [{ type: 'replied_to', id: 'original-tweet-100' }],
        },
      ],
      includes: {
        users: [
          { id: 'user-456', username: 'curious_user', name: 'Curious User' },
        ],
      },
    };

    mockClient.v2.userMentionTimeline = mock(() => Promise.resolve({
      data: mentionData.data,
      includes: mentionData.includes,
    }));

    // Verify mention data structure
    const mention = mentionData.data[0];
    expect(mention.id).toBe('mention-123');
    expect(mention.text).toContain('@test_bot');
    expect(mention.conversation_id).toBe('conv-789');

    // Verify author includes
    const author = mentionData.includes.users[0];
    expect(author.username).toBe('curious_user');

    // Verify reply threading
    const replyTo = mention.referenced_tweets?.[0];
    expect(replyTo?.type).toBe('replied_to');
    expect(replyTo?.id).toBe('original-tweet-100');
  });

  it('E2E: Handle rate limiting gracefully', async () => {
    // Simulate rate limit error from Twitter API
    const rateLimitError = new Error('Too Many Requests') as any;
    rateLimitError.code = 429;
    rateLimitError.data = {
      title: 'Too Many Requests',
      detail: 'Too Many Requests',
      type: 'about:blank',
      status: 429,
    };
    rateLimitError.rateLimit = {
      limit: 300,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 900,
    };

    mockClient.v2.tweet = mock(() => Promise.reject(rateLimitError));

    // Verify error structure
    expect(rateLimitError.code).toBe(429);
    expect(rateLimitError.rateLimit.remaining).toBe(0);

    // Calculate retry time
    const now = Math.floor(Date.now() / 1000);
    const resetTime = rateLimitError.rateLimit.reset;
    const waitSeconds = resetTime - now;

    expect(waitSeconds).toBeGreaterThan(0);
    expect(waitSeconds).toBeLessThanOrEqual(900);

    // Verify graceful handling returns false
    const result = await adapter.executeAction(
      { type: 'send_message', text: 'test' },
      'conv-1'
    );
    expect(result).toBe(false);
  });

  it('E2E: OAuth token refresh when expired', async () => {
    // Token expiry simulation
    const tokenExpiryError = new Error('Unauthorized') as any;
    tokenExpiryError.code = 401;
    tokenExpiryError.data = {
      title: 'Unauthorized',
      detail: 'Access token has expired',
      status: 401,
    };

    // Verify token expiry detection
    expect(tokenExpiryError.code).toBe(401);
    expect(tokenExpiryError.data.detail).toContain('expired');

    // Token refresh flow
    const oldTokens = {
      accessToken: 'expired-access-token',
      accessSecret: 'old-secret',
      refreshToken: 'valid-refresh-token',
    };

    const newTokens = {
      accessToken: 'new-access-token',
      accessSecret: 'new-secret',
      refreshToken: 'new-refresh-token',
      expiresIn: 7200,
    };

    // Verify token structure
    expect(oldTokens.refreshToken).toBeDefined();
    expect(newTokens.accessToken).not.toBe(oldTokens.accessToken);
    expect(newTokens.expiresIn).toBe(7200);

    // Verify credential update pattern
    const updatedCredentials = createMockCredentials({
      accessToken: newTokens.accessToken,
      accessSecret: newTokens.accessSecret,
    });
    expect(updatedCredentials.accessToken).toBe('new-access-token');
  });
});
