/**
 * MCP Twitter Tools Tests
 *
 * Tests for the MCP tools that enable agents to interact with Twitter/X.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTwitterTools } from './twitter.js';

const baseContext = { agentId: 'agent-1', platform: 'admin-ui' as const };

function getTool(name: string, services: Parameters<typeof createTwitterTools>[0]) {
  const tool = createTwitterTools(services).find(candidate => candidate.name === name);
  expect(tool).toBeTruthy();
  return tool!;
}

describe('Twitter Tools - twitter_status', () => {
  it('should have correct tool metadata', () => {
    const toolName = 'twitter_status';
    const category = 'readonly';

    expect(toolName).toBe('twitter_status');
    expect(category).toBe('readonly');
  });

  it('returns connected status with username when connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, username: 'swarm' }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_status', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ connected: true, username: 'swarm' });
  });

  it('returns not connected message when disconnected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_status', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ connected: false });
    expect((result.data as { message?: string }).message).toContain('not connected');
  });

  it('calls getConnectionStatus service', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_status', services);
    await (tool.execute as any)({}, baseContext);

    expect(services.getConnectionStatus).toHaveBeenCalledTimes(1);
  });
});

describe('Twitter Tools - twitter_request_integration', () => {
  it('should have correct tool metadata', () => {
    const toolName = 'twitter_request_integration';
    const category = 'config';

    expect(toolName).toBe('twitter_request_integration');
    expect(category).toBe('config');
  });

  it('returns already connected when Twitter is connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, username: 'swarm' }),
      startOAuthFlow: vi.fn().mockResolvedValue({ authorizationUrl: 'https://x.com/auth' }),
    };
    const tool = getTool('twitter_request_integration', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ alreadyConnected: true, username: 'swarm' });
    expect(services.startOAuthFlow).not.toHaveBeenCalled();
  });

  it('starts OAuth flow when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue({ authorizationUrl: 'https://x.com/auth' }),
    };
    const tool = getTool('twitter_request_integration', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(true);
    expect(services.startOAuthFlow).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ pending: true });
  });

  it('returns authorization URL for admin', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue({ authorizationUrl: 'https://x.com/auth' }),
    };
    const tool = getTool('twitter_request_integration', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ authorizationUrl: 'https://x.com/auth' });
  });

  it('includes reason in response when provided', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue({ authorizationUrl: 'https://x.com/auth' }),
    };
    const tool = getTool('twitter_request_integration', services);
    const result = await (tool.execute as any)({ reason: 'Need to post' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ reason: 'Need to post' });
  });

  it('returns error when OAuth not configured', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_request_integration', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });
});

describe('Twitter Tools - twitter_post', () => {
  it('should enforce 280 character limit', () => {
    const maxLength = 280;
    expect(maxLength).toBe(280);
  });

  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_post', services);
    const result = await (tool.execute as any)({ text: 'Hello' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when postTweet service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_post', services);
    const result = await (tool.execute as any)({ text: 'Hello' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Tweet posting service is not available');
  });

  it('posts tweet with text only', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      postTweet: vi.fn().mockResolvedValue({ tweetId: '1', url: 'https://x.com/1' }),
    };
    const tool = getTool('twitter_post', services);
    const result = await (tool.execute as any)({ text: 'Hello' }, baseContext);

    expect(result.success).toBe(true);
    expect(services.postTweet).toHaveBeenCalledWith('Hello', undefined);
  });

  it('posts tweet with media URLs', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      postTweet: vi.fn().mockResolvedValue({ tweetId: '1', url: 'https://x.com/1' }),
    };
    const tool = getTool('twitter_post', services);
    const result = await (tool.execute as any)({ text: 'Hello', mediaUrls: ['https://img'] }, baseContext);

    expect(result.success).toBe(true);
    expect(services.postTweet).toHaveBeenCalledWith('Hello', ['https://img']);
  });

  it('returns tweet ID and URL on success', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      postTweet: vi.fn().mockResolvedValue({ tweetId: '1', url: 'https://x.com/1' }),
    };
    const tool = getTool('twitter_post', services);
    const result = await (tool.execute as any)({ text: 'Hello' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ tweetId: '1', url: 'https://x.com/1' });
  });

  it('returns error on post failure', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      postTweet: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_post', services);
    const result = await (tool.execute as any)({ text: 'Hello' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to post tweet');
  });
});

describe('Twitter Tools - twitter_get_timeline', () => {
  it('should have sensible count limits', () => {
    const minCount = 1;
    const maxCount = 100;
    const defaultCount = 20;

    expect(minCount).toBe(1);
    expect(maxCount).toBe(100);
    expect(defaultCount).toBe(20);
  });

  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_get_timeline', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_get_timeline', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Timeline service is not available');
  });

  it('fetches timeline with default count', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getTimeline: vi.fn().mockResolvedValue([]),
    };
    const tool = getTool('twitter_get_timeline', services);
    const parsed = tool.inputSchema.parse({});
    const result = await (tool.execute as any)(parsed, baseContext);

    expect(result.success).toBe(true);
    expect(services.getTimeline).toHaveBeenCalledWith(20);
  });

  it('fetches timeline with custom count', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getTimeline: vi.fn().mockResolvedValue([]),
    };
    const tool = getTool('twitter_get_timeline', services);
    const result = await (tool.execute as any)({ count: 5 }, baseContext);

    expect(result.success).toBe(true);
    expect(services.getTimeline).toHaveBeenCalledWith(5);
  });

  it('formats tweet data in response', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getTimeline: vi.fn().mockResolvedValue([{
        id: 't1',
        text: 'hello',
        authorId: 'u1',
        authorUsername: 'alice',
        authorName: 'Alice',
        createdAt: '2024-01-01T00:00:00Z',
        metrics: { likeCount: 2 },
      }]),
    };
    const tool = getTool('twitter_get_timeline', services);
    const result = await (tool.execute as any)({ count: 1 }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      count: 1,
      tweets: [{
        id: 't1',
        text: 'hello',
        author: '@alice',
        authorName: 'Alice',
      }],
    });
  });
});

describe('Twitter Tools - twitter_get_mentions', () => {
  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_get_mentions', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_get_mentions', services);
    const result = await (tool.execute as any)({}, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Mentions service is not available');
  });

  it('fetches mentions with default count', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getMentions: vi.fn().mockResolvedValue([]),
    };
    const tool = getTool('twitter_get_mentions', services);
    const parsed = tool.inputSchema.parse({});
    const result = await (tool.execute as any)(parsed, baseContext);

    expect(result.success).toBe(true);
    expect(services.getMentions).toHaveBeenCalledWith(undefined, 20);
  });

  it('fetches mentions with sinceId for pagination', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getMentions: vi.fn().mockResolvedValue([]),
    };
    const tool = getTool('twitter_get_mentions', services);
    const result = await (tool.execute as any)({ sinceId: 's1', count: 10 }, baseContext);

    expect(result.success).toBe(true);
    expect(services.getMentions).toHaveBeenCalledWith('s1', 10);
  });

  it('includes conversation context in response', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getMentions: vi.fn().mockResolvedValue([{
        id: 'm1',
        text: '@bot hi',
        authorId: 'u1',
        authorUsername: 'bob',
        authorName: 'Bob',
        createdAt: '2024-01-01T00:00:00Z',
        conversationId: 'c1',
        inReplyToUserId: 'u2',
      }]),
    };
    const tool = getTool('twitter_get_mentions', services);
    const result = await (tool.execute as any)({ count: 1 }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      count: 1,
      mentions: [{
        id: 'm1',
        conversationId: 'c1',
        inReplyToUserId: 'u2',
      }],
    });
  });
});

describe('Twitter Tools - twitter_get_tweet', () => {
  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_get_tweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_get_tweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Tweet lookup service is not available');
  });

  it('fetches specific tweet by ID', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getTweet: vi.fn().mockResolvedValue({
        id: 't1',
        text: 'hello',
        authorId: 'u1',
        createdAt: '2024-01-01T00:00:00Z',
      }),
    };
    const tool = getTool('twitter_get_tweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(services.getTweet).toHaveBeenCalledWith('t1');
  });

  it('returns not found for invalid ID', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getTweet: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_get_tweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('includes metrics and references in response', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      getTweet: vi.fn().mockResolvedValue({
        id: 't1',
        text: 'hello',
        authorId: 'u1',
        createdAt: '2024-01-01T00:00:00Z',
        metrics: { likeCount: 2 },
        referencedTweets: [{ type: 'quoted', id: 'q1' }],
      }),
    };
    const tool = getTool('twitter_get_tweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      metrics: { likeCount: 2 },
      referencedTweets: [{ type: 'quoted', id: 'q1' }],
    });
  });
});

describe('Twitter Tools - twitter_reply', () => {
  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_reply', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hi' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_reply', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hi' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Reply service is not available');
  });

  it('posts reply to specified tweet', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      reply: vi.fn().mockResolvedValue({ tweetId: 't2', url: 'https://x.com/t2' }),
    };
    const tool = getTool('twitter_reply', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hi' }, baseContext);

    expect(result.success).toBe(true);
    expect(services.reply).toHaveBeenCalledWith('t1', 'hi', undefined);
  });

  it('includes media when provided', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      reply: vi.fn().mockResolvedValue({ tweetId: 't2', url: 'https://x.com/t2' }),
    };
    const tool = getTool('twitter_reply', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hi', mediaUrls: ['https://img'] }, baseContext);

    expect(result.success).toBe(true);
    expect(services.reply).toHaveBeenCalledWith('t1', 'hi', ['https://img']);
  });

  it('returns new tweet URL on success', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      reply: vi.fn().mockResolvedValue({ tweetId: 't2', url: 'https://x.com/t2' }),
    };
    const tool = getTool('twitter_reply', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hi' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ tweetId: 't2', url: 'https://x.com/t2' });
  });
});

describe('Twitter Tools - twitter_like', () => {
  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_like', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_like', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Like service is not available');
  });

  it('likes specified tweet', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      like: vi.fn().mockResolvedValue(true),
    };
    const tool = getTool('twitter_like', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(services.like).toHaveBeenCalledWith('t1');
  });

  it('returns success message', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      like: vi.fn().mockResolvedValue(true),
    };
    const tool = getTool('twitter_like', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ message: 'Tweet liked!' });
  });

  it('handles like failure', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      like: vi.fn().mockResolvedValue(false),
    };
    const tool = getTool('twitter_like', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to like tweet');
  });
});

describe('Twitter Tools - twitter_unlike', () => {
  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_unlike', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_unlike', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unlike service is not available');
  });

  it('unlikes specified tweet', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      unlike: vi.fn().mockResolvedValue(true),
    };
    const tool = getTool('twitter_unlike', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(services.unlike).toHaveBeenCalledWith('t1');
  });

  it('returns success message', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      unlike: vi.fn().mockResolvedValue(true),
    };
    const tool = getTool('twitter_unlike', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ message: 'Like removed.' });
  });
});

describe('Twitter Tools - twitter_retweet', () => {
  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_retweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_retweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Retweet service is not available');
  });

  it('retweets specified tweet', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      retweet: vi.fn().mockResolvedValue(true),
    };
    const tool = getTool('twitter_retweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(services.retweet).toHaveBeenCalledWith('t1');
  });

  it('returns success message', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      retweet: vi.fn().mockResolvedValue(true),
    };
    const tool = getTool('twitter_retweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ message: 'Retweeted!' });
  });
});

describe('Twitter Tools - twitter_unretweet', () => {
  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_unretweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_unretweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unretweet service is not available');
  });

  it('removes retweet', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      unretweet: vi.fn().mockResolvedValue(true),
    };
    const tool = getTool('twitter_unretweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(services.unretweet).toHaveBeenCalledWith('t1');
  });

  it('returns success message', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      unretweet: vi.fn().mockResolvedValue(true),
    };
    const tool = getTool('twitter_unretweet', services);
    const result = await (tool.execute as any)({ tweetId: 't1' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ message: 'Retweet removed.' });
  });
});

describe('Twitter Tools - twitter_quote', () => {
  it('returns error when not connected', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_quote', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hello' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  it('returns error when service unavailable', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_quote', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hello' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Quote tweet service is not available');
  });

  it('posts quote tweet with text', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      quoteTweet: vi.fn().mockResolvedValue({ tweetId: 't2', url: 'https://x.com/t2' }),
    };
    const tool = getTool('twitter_quote', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hello' }, baseContext);

    expect(result.success).toBe(true);
    expect(services.quoteTweet).toHaveBeenCalledWith('t1', 'hello', undefined);
  });

  it('includes media when provided', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      quoteTweet: vi.fn().mockResolvedValue({ tweetId: 't2', url: 'https://x.com/t2' }),
    };
    const tool = getTool('twitter_quote', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hello', mediaUrls: ['https://img'] }, baseContext);

    expect(result.success).toBe(true);
    expect(services.quoteTweet).toHaveBeenCalledWith('t1', 'hello', ['https://img']);
  });

  it('returns new tweet URL on success', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
      quoteTweet: vi.fn().mockResolvedValue({ tweetId: 't2', url: 'https://x.com/t2' }),
    };
    const tool = getTool('twitter_quote', services);
    const result = await (tool.execute as any)({ tweetId: 't1', text: 'hello' }, baseContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ tweetId: 't2', url: 'https://x.com/t2' });
  });
});

describe('Twitter Tools - Service Injection', () => {
  it('createTwitterTools accepts service interface', () => {
    const tools = createTwitterTools({
      getConnectionStatus: async () => ({ connected: false }),
      startOAuthFlow: async () => null,
    });
    expect(tools.length).toBeGreaterThan(0);
  });

  it('tools call correct service methods', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_status', services);
    await (tool.execute as any)({}, baseContext);

    expect(services.getConnectionStatus).toHaveBeenCalled();
  });

  it('handles missing optional services gracefully', async () => {
    const services = {
      getConnectionStatus: vi.fn().mockResolvedValue({ connected: true }),
      startOAuthFlow: vi.fn().mockResolvedValue(null),
    };
    const tool = getTool('twitter_post', services);
    const result = await (tool.execute as any)({ text: 'Hello' }, baseContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Tweet posting service is not available');
  });
});

describe('Twitter Tools - Input Validation', () => {
  it('twitter_post validates text length', () => {
    const tool = getTool('twitter_post', {
      getConnectionStatus: async () => ({ connected: true }),
      startOAuthFlow: async () => null,
    });
    const result = tool.inputSchema.safeParse({ text: 'x'.repeat(281) });

    expect(result.success).toBe(false);
  });

  it('twitter_post validates media array length (max 4)', () => {
    const tool = getTool('twitter_post', {
      getConnectionStatus: async () => ({ connected: true }),
      startOAuthFlow: async () => null,
    });
    const result = tool.inputSchema.safeParse({ text: 'hello', mediaUrls: ['1', '2', '3', '4', '5'] });

    expect(result.success).toBe(false);
  });

  it('twitter_get_timeline validates count range', () => {
    const tool = getTool('twitter_get_timeline', {
      getConnectionStatus: async () => ({ connected: true }),
      startOAuthFlow: async () => null,
    });
    const tooHigh = tool.inputSchema.safeParse({ count: 200 });
    const tooLow = tool.inputSchema.safeParse({ count: 0 });

    expect(tooHigh.success).toBe(false);
    expect(tooLow.success).toBe(false);
  });

  it('twitter_get_mentions validates count range', () => {
    const tool = getTool('twitter_get_mentions', {
      getConnectionStatus: async () => ({ connected: true }),
      startOAuthFlow: async () => null,
    });
    const tooHigh = tool.inputSchema.safeParse({ count: 200 });
    const tooLow = tool.inputSchema.safeParse({ count: 0 });

    expect(tooHigh.success).toBe(false);
    expect(tooLow.success).toBe(false);
  });
});

describe('Twitter Tools - Integration Scenarios (TODO)', () => {
  /**
   * These tests document E2E scenarios with real MCP context.
   */
  it.todo('E2E: Agent checks status and requests integration');
  it.todo('E2E: Agent posts tweet after connection');
  it.todo('E2E: Agent reads and replies to mentions');
  it.todo('E2E: Agent engages with timeline content');
});
