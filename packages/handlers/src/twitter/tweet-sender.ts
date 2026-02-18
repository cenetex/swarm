/**
 * Tweet Sender Handler
 *
 * Consumes messages from POST_QUEUE and sends tweets to Twitter
 * with rate limiting, backoff, and content store integration.
 *
 * Flow:
 * 1. Check rate limit -> BLOCKED -> re-queue with delay
 * 2. Check scheduled time -> not yet -> re-queue
 * 3. Call TwitterAdapter.postTweet()
 * 4. 429? -> record, re-queue with backoff
 * 5. Success? -> update content store, record success
 */
import type { SQSHandler, SQSBatchResponse } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createContentStoreService,
  logger,
  type PostQueueMessage,
  type ContentStoreService,
} from '@swarm/core';
import {
  createRateLimitService,
  type RateLimitService,
} from '../services/twitter-rate-limit.js';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';

const STATE_TABLE = process.env.STATE_TABLE;
const POST_QUEUE_URL = process.env.POST_QUEUE_URL;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const TWITTER_API_TIER = (process.env.TWITTER_API_TIER || 'basic') as 'free' | 'basic';
const TWITTER_DAILY_RESERVE_PCT = parseInt(process.env.TWITTER_DAILY_RESERVE_PCT || '20', 10);
const TWITTER_MONTHLY_BUDGET = process.env.TWITTER_MONTHLY_BUDGET
  ? parseInt(process.env.TWITTER_MONTHLY_BUDGET, 10)
  : undefined;

// Feature flag
const ENABLE_DECOUPLED_POSTING = process.env.ENABLE_DECOUPLED_POSTING === 'true';

// Maximum retry attempts before giving up
const MAX_RETRY_ATTEMPTS = 5;

// Services
let stateService: ReturnType<typeof createStateService>;
let secretsService: ReturnType<typeof createSecretsService>;
let contentStoreService: ContentStoreService;
let rateLimitService: RateLimitService;
let sqsClient: SQSClient;

async function initialize(): Promise<void> {
  if (stateService) return;

  if (!STATE_TABLE) {
    throw new Error('STATE_TABLE is required for tweet-sender');
  }
  if (!POST_QUEUE_URL) {
    throw new Error('POST_QUEUE_URL is required for tweet-sender');
  }

  stateService = createStateService(STATE_TABLE);
  secretsService = createSecretsService();
  contentStoreService = createContentStoreService(STATE_TABLE);
  rateLimitService = createRateLimitService(STATE_TABLE, {
    tier: TWITTER_API_TIER,
    dailyReservePct: TWITTER_DAILY_RESERVE_PCT,
    monthlyBudget: TWITTER_MONTHLY_BUDGET,
  });
  sqsClient = new SQSClient({});
}

/**
 * Re-queue a message with a delay
 */
async function requeue(
  message: PostQueueMessage,
  delaySeconds: number
): Promise<void> {
  // SQS FIFO max delay is 15 minutes
  const effectiveDelay = Math.min(delaySeconds, 900);

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: POST_QUEUE_URL!,
    MessageBody: JSON.stringify({
      ...message,
      attempts: message.attempts + 1,
    }),
    MessageGroupId: message.avatarId,
    MessageDeduplicationId: `${message.postId}-${message.attempts + 1}-${Date.now()}`,
    DelaySeconds: effectiveDelay,
  }));

  logger.info('Message re-queued', {
    event: 'message_requeued',
    postId: message.postId,
    avatarId: message.avatarId,
    attempts: message.attempts + 1,
    delaySeconds: effectiveDelay,
  });
}

/**
 * Process a single queue message
 */
async function processMessage(message: PostQueueMessage): Promise<{ success: boolean; error?: string }> {
  const { postId, avatarId, scheduledAt, attempts } = message;

  // Check if we've exceeded max retries
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    logger.error('Max retry attempts exceeded', undefined, {
      postId,
      avatarId,
      attempts,
    });
    await contentStoreService.markFailed(avatarId, postId, 'Max retry attempts exceeded');
    return { success: false, error: 'Max retry attempts exceeded' };
  }

  // Check if scheduled for later
  const now = Date.now();
  if (scheduledAt && scheduledAt > now) {
    const delaySeconds = Math.ceil((scheduledAt - now) / 1000);
    await requeue(message, delaySeconds);
    return { success: true }; // Successfully re-queued
  }

  // Check rate limit
  const rateLimitCheck = await rateLimitService.canPost(avatarId);
  if (!rateLimitCheck.allowed) {
    logger.warn('Rate limited, re-queuing', {
      postId,
      avatarId,
      reason: rateLimitCheck.reason,
      retryAfter: rateLimitCheck.retryAfter,
    });

    const delaySeconds = rateLimitCheck.retryAfter || 60;
    await requeue(message, delaySeconds);

    // Update content store with rate limit info
    if (rateLimitCheck.retryAfter) {
      await contentStoreService.markRateLimited(avatarId, postId, rateLimitCheck.retryAfter * 1000);
    }

    return { success: true }; // Successfully re-queued
  }

  // Get the post from content store
  const post = await contentStoreService.getPost(avatarId, postId);
  if (!post) {
    logger.error('Post not found in content store', undefined, { postId, avatarId });
    return { success: false, error: 'Post not found' };
  }

  // Check post status - should be 'approved' or 'queued'
  if (post.status !== 'approved' && post.status !== 'queued') {
    logger.warn('Post not in sendable status', {
      postId,
      avatarId,
      status: post.status,
    });
    return { success: false, error: `Invalid post status: ${post.status}` };
  }

  // Get avatar config and secrets
  const avatarConfig = await stateService.getAvatarConfig(avatarId);
  if (!avatarConfig) {
    logger.error('Avatar config not found', undefined, { avatarId });
    await contentStoreService.markFailed(avatarId, postId, 'Avatar config not found');
    return { success: false, error: 'Avatar config not found' };
  }

  const secrets = await loadAvatarSecrets(secretsService, avatarId, SECRET_PREFIX);

  // Initialize Twitter adapter
  const twitterAdapter = new TwitterAdapter(avatarConfig, {
    appKey: secrets.TWITTER_API_KEY,
    appSecret: secrets.TWITTER_API_SECRET,
    accessToken: secrets.TWITTER_ACCESS_TOKEN,
    accessSecret: secrets.TWITTER_ACCESS_SECRET,
  });

  if (!twitterAdapter.isConfigured()) {
    logger.error('Twitter adapter not configured', undefined, { avatarId });
    await contentStoreService.markFailed(avatarId, postId, 'Twitter not configured');
    return { success: false, error: 'Twitter not configured' };
  }

  // Post to Twitter
  try {
    let tweetId: string;

    const mediaForPost = post.media?.map(m => ({ type: m.type as 'image' | 'video' | 'gif', url: m.url }));

    if (post.communityId) {
      tweetId = await twitterAdapter.postToCommunity(
        post.communityId,
        post.text,
        mediaForPost
      );
    } else {
      // postTweet handles replies via the optional third parameter
      tweetId = await twitterAdapter.postTweet(
        post.text,
        mediaForPost,
        post.inReplyToId
      );
    }

    // Record success
    await rateLimitService.recordSuccess(avatarId);
    await contentStoreService.markPosted(avatarId, postId, tweetId);

    logger.info('Tweet posted successfully', {
      event: 'tweet_posted',
      postId,
      avatarId,
      tweetId,
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const is429 = errorMessage.includes('429') || errorMessage.toLowerCase().includes('rate limit');

    if (is429) {
      // Parse retry-after if available
      const retryAfterMatch = errorMessage.match(/retry.?after[:\s]+(\d+)/i);
      const retryAfterSeconds = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : undefined;

      await rateLimitService.record429(avatarId, retryAfterSeconds);

      logger.warn('Twitter 429 error, re-queuing with backoff', {
        postId,
        avatarId,
        retryAfterSeconds,
      });

      // Re-queue with backoff
      const delaySeconds = retryAfterSeconds || 60;
      await requeue(message, delaySeconds);
      await contentStoreService.markRateLimited(avatarId, postId, delaySeconds * 1000);

      return { success: true }; // Successfully re-queued
    }

    // Non-429 error
    await rateLimitService.recordFailure(avatarId, errorMessage);
    await contentStoreService.markFailed(avatarId, postId, errorMessage);

    logger.error('Tweet posting failed', error, {
      postId,
      avatarId,
    });

    return { success: false, error: errorMessage };
  }
}

/**
 * SQS Handler for POST_QUEUE
 */
export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  if (!ENABLE_DECOUPLED_POSTING) {
    logger.warn('Decoupled posting not enabled; keeping messages in queue');
    return {
      batchItemFailures: event.Records.map(record => ({ itemIdentifier: record.messageId })),
    };
  }

  await initialize();

  logger.info('Tweet sender started', {
    event: 'handler_started',
    messageCount: event.Records.length,
  });

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message: PostQueueMessage = JSON.parse(record.body);

      logger.setContext({
        postId: message.postId,
        avatarId: message.avatarId,
      });

      const result = await processMessage(message);

      if (!result.success) {
        // Only report as failure if it's a permanent error
        // Re-queued messages are considered successful
        if (result.error && !result.error.includes('re-queue')) {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
    } catch (error) {
      logger.error('Failed to process message', error, {
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  logger.info('Tweet sender complete', {
    event: 'handler_complete',
    processed: event.Records.length,
    failures: batchItemFailures.length,
  });

  return { batchItemFailures };
};
