/**
 * Shared Twitter Mention Poller Handler
 *
 * Multi-tenant scheduled poller that:
 * - lists avatars from the state table
 * - filters to those with twitter enabled + mention_replies feature
 * - polls mentions per avatar with budget-aware limits
 * - filters to processable mentions (direct engagements, replies to bot)
 * - enqueues MessageQueueItemSchema-shaped items to a shared FIFO message queue
 *
 * Credit-efficient design:
 * - Twitter API deduplicates reads, so polling frequency is free
 * - Only NEW unique tweets cost API credits
 * - Budget tracking ensures we stay within tier limits
 */
import type { TimerHandler, ExecutionContext } from "@swarm/core";
import { sendSqsMessage } from '../services/sqs-send.js';
import { randomUUID } from 'node:crypto';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  logger,
} from '@swarm/core';
import { createTwitterUsageService, type TwitterUsageService } from '../services/twitter-usage.js';
import { maxTwitterId } from '../utils/twitter-id.js';
import { loadAvatarSecrets, type LoadedAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { isTwitterFeatureEnabled } from '../utils/twitter-feature-flags.js';
import { loadTwitterSecretsFallback, shouldProcessMention } from '../utils/twitter-mention-poller-logic.js';
import { triageMentions, isMentionTriageEnabled } from '../utils/mention-triage.js';
import { getErrorMessage, isRateLimitError, type TwitterRawTweet } from '../utils/telegram-type-guards.js';


const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let twitterUsageService: TwitterUsageService;

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
  twitterUsageService = createTwitterUsageService(STATE_TABLE);
}

/**
 * Determine if a mention should be processed and replied to.
 *
 * Only reply to:
 * 1. Direct replies to bot's tweets (highest priority)
 * 2. Explicit @mentions in tweet text (not just part of a thread)
 */
// shouldProcessMention moved to utils/twitter-mention-poller-logic.ts (unit tested)

export const handler: TimerHandler = async (_event, context: ExecutionContext) => {
  const startTime = Date.now();
  logger.setContext({
    platform: 'twitter',
    requestId: context.awsRequestId,
    handler: 'shared-mention-poller',
  });

  await initialize();

  // Global backoff used to recover from Twitter API rate limits (429).
  const globalUsage = await twitterUsageService.getGlobalUsage();
  if (globalUsage.backoffUntil && globalUsage.backoffUntil > Date.now()) {
    logger.warn('Skipping Twitter mention poll due to global backoff', {
      event: 'handler_skipped',
      subsystem: 'twitter',
      reason: 'rate_limited_backoff',
      backoffUntil: new Date(globalUsage.backoffUntil).toISOString(),
      consecutive429s: globalUsage.consecutive429s || 0,
    });
    return;
  }

  // Check global budget before proceeding
  const budget = await twitterUsageService.getRemainingBudget();
  if (budget.daily <= 0) {
    logger.info('Twitter daily budget exhausted, skipping poll', {
      event: 'budget_exhausted',
      subsystem: 'twitter',
      usedToday: budget.usedToday,
      usedThisMonth: budget.usedThisMonth,
    });
    return;
  }

  const avatarIds = await stateService.listAvatars();

  // Get Twitter-enabled avatars for budget calculation
  const twitterAvatarIds: string[] = [];
  let twitterEnabledCount = 0;
  let twitterMissingFeaturesCount = 0;
  for (const avatarId of avatarIds) {
    const avatarConfig = await stateService.getAvatarConfig(avatarId);
    const twitterConfig = avatarConfig?.platforms?.twitter as { enabled?: boolean; features?: unknown } | undefined;
    const twitterEnabled = Boolean(twitterConfig?.enabled);
    if (twitterEnabled) twitterEnabledCount++;

    const mentionRepliesEnabled = isTwitterFeatureEnabled(twitterConfig?.features, 'mention_replies');
    if (twitterEnabled && !Array.isArray(twitterConfig?.features)) {
      twitterMissingFeaturesCount++;
    }

    if (twitterEnabled && mentionRepliesEnabled) {
      twitterAvatarIds.push(avatarId);
    }
  }

  if (twitterAvatarIds.length === 0) {
    logger.info('No Twitter-enabled avatars found', {
      event: 'handler_skipped',
      subsystem: 'twitter',
      reason: 'no_enabled_avatars',
      avatarCount: avatarIds.length,
      twitterEnabledCount,
      twitterMissingFeaturesCount,
    });
    return;
  }

  // Calculate budget-aware polling parameters
  const pollConfig = twitterUsageService.getPollConfig(twitterAvatarIds.length);
  const perAvatarLimit = Math.max(5, Math.min(pollConfig.maxMentionsPerPoll, 20));

  // Enforce a minimum poll interval regardless of EventBridge schedule.
  const pollIntervalMs = pollConfig.pollIntervalMinutes * 60 * 1000;
  if (globalUsage.lastPollAt && Date.now() - globalUsage.lastPollAt < pollIntervalMs) {
    logger.info('Skipping Twitter mention poll due to poll interval throttle', {
      event: 'handler_skipped',
      subsystem: 'twitter',
      reason: 'poll_interval_throttle',
      pollIntervalMinutes: pollConfig.pollIntervalMinutes,
      lastPollAt: new Date(globalUsage.lastPollAt).toISOString(),
    });
    return;
  }

  // Mark poll attempt early so concurrent invocations don't fan out.
  await twitterUsageService.recordPollAttempt();

  logger.info('Shared Twitter mention poller started', {
    event: 'handler_started',
    subsystem: 'twitter',
    avatarCount: twitterAvatarIds.length,
    budgetRemaining: budget.daily,
    perAvatarLimit,
    tier: pollConfig.tier,
  });

  let totalQueued = 0;
  let totalPolled = 0;
  let totalMentionsRead = 0;

  for (const avatarId of twitterAvatarIds) {
    try {
      // Re-check budget to avoid overspending if previous avatars used a lot
      const currentBudget = await twitterUsageService.getRemainingBudget();
      if (currentBudget.daily <= 0) {
        logger.info('Daily budget exhausted mid-poll, stopping', {
          event: 'budget_exhausted_mid_poll',
          subsystem: 'twitter',
          avatarId,
        });
        break;
      }

      const avatarConfig = await stateService.getAvatarConfig(avatarId);
      logger.setContext({ avatarId });

      let secrets: LoadedAvatarSecrets | undefined;
      try {
        secrets = await loadAvatarSecrets(secretsService, avatarId, SECRET_PREFIX);
      } catch (error) {
        logger.error('Failed to load avatar secrets; skipping avatar', error, {
          event: 'handler_skipped',
          subsystem: 'twitter',
          avatarId,
          reason: 'secrets_load_failed',
          secretPrefix: SECRET_PREFIX,
        });
        secrets = undefined;
      }

      if (!secrets || !secrets.TWITTER_ACCESS_TOKEN || !secrets.TWITTER_ACCESS_SECRET) {
        const fallback = await loadTwitterSecretsFallback(secretsService, avatarId, SECRET_PREFIX);
        secrets = {
          ...fallback,
          ...secrets,
        };
      }

      if (!secrets?.TWITTER_ACCESS_TOKEN || !secrets?.TWITTER_ACCESS_SECRET) {
        logger.warn('Twitter access token/secret missing for avatar; skipping', {
          event: 'handler_skipped',
          subsystem: 'twitter',
          avatarId,
          reason: 'missing_twitter_access_secrets',
          secretPrefix: SECRET_PREFIX,
        });
        continue;
      }

      const twitterAdapter = new TwitterAdapter(avatarConfig!, {
        appKey: secrets.TWITTER_API_KEY,
        appSecret: secrets.TWITTER_API_SECRET,
        accessToken: secrets.TWITTER_ACCESS_TOKEN,
        accessSecret: secrets.TWITTER_ACCESS_SECRET,
      });

      if (!twitterAdapter.isConfigured()) {
        logger.warn('Twitter adapter not configured for avatar; skipping', {
          event: 'handler_skipped',
          subsystem: 'twitter',
          reason: 'not_configured',
        });
        continue;
      }

      totalPolled++;
      const sinceId = await stateService.getLastMentionId(avatarId);

      logger.info('Cursor state before poll', {
        event: 'cursor_state',
        subsystem: 'twitter',
        avatarId,
        cursorBefore: sinceId,
      });

      // Fetch with budget-aware limit
      const effectiveLimit = Math.min(perAvatarLimit, currentBudget.daily);
      const mentions = await twitterAdapter.getMentions(sinceId ?? undefined, {
        maxResults: effectiveLimit,
      });

      // Record the API usage (these are the tweets we actually read)
      if (mentions.length > 0) {
        await twitterUsageService.recordMentionsRead(mentions.length);
        totalMentionsRead += mentions.length;
      }

      if (mentions.length === 0) continue;

      // Get bot info for filtering
      const botUserId = await twitterAdapter.getBotUserId();
      const botUsername = twitterAdapter.getBotUsername();

      // Sort oldest first for processing order
      const sortedMentions = mentions.sort((a, b) => a.timestamp - b.timestamp);
      let newestMentionId = sinceId;
      let avatarQueued = 0;
      let avatarFiltered = 0;
      let avatarTriaged = 0;

      // Cache to avoid refetching the same thread context within a poll run.
      const threadContextCache = new Map<string, string | undefined>();

      // =========================================================================
      // PHASE 1: Filter and prepare mentions (before triage)
      // =========================================================================
      const processableMentions: Array<{ envelope: typeof sortedMentions[0]; traceId: string }> = [];

      for (const envelope of sortedMentions) {
        const traceId = randomUUID();
        envelope.traceId = traceId;

        // Log mention processing context
        const raw = envelope.raw as { in_reply_to_user_id?: string };
        const isReplyToBot = raw.in_reply_to_user_id === botUserId;
        const hasMentionInText = botUsername
          ? (envelope.content.text?.toLowerCase().includes(`@${botUsername.toLowerCase()}`) ?? false)
          : false;

        // Ensure the message-processor's channel state sees this as direct engagement.
        // (The response trigger logic is driven by `envelope.metadata.isMention/isReplyToBot`.)
        envelope.metadata.isReplyToBot = isReplyToBot;
        envelope.metadata.isMention = hasMentionInText;

        logger.debug('Processing mention', {
          event: 'mention_processing',
          subsystem: 'twitter',
          avatarId,
          tweetId: envelope.messageId,
          threadId: envelope.conversationId,
          senderId: envelope.sender.id,
          senderUsername: envelope.sender.username,
          isReplyToBot,
          hasMentionInText,
        });

        // Filter to only processable mentions using the new logic
        if (!shouldProcessMention(envelope, botUserId, botUsername)) {
          logger.debug('Skipping non-processable mention', {
            event: 'mention_filtered',
            subsystem: 'twitter',
            avatarId,
            tweetId: envelope.messageId,
            senderId: envelope.sender.id,
            senderUsername: envelope.sender.username,
            isReplyToBot,
            hasMentionInText,
          });
          avatarFiltered++;
          // Still update the cursor even for filtered mentions (using numeric comparison)
          newestMentionId = maxTwitterId(newestMentionId, envelope.messageId);
          continue;
        }

        // Ingest idempotency - check if we've already processed this tweet
        const idempotencyKey = `twitter:${avatarId}:${envelope.messageId}`;
        const isNewMention = await stateService.checkAndSetIdempotency(idempotencyKey, 24 * 60 * 60);
        if (!isNewMention) {
          logger.info('Duplicate mention detected at ingest, skipping', {
            event: 'ingest_dedupe_hit',
            subsystem: 'twitter',
            avatarId,
            tweetId: envelope.messageId,
            idempotencyKey,
          });
          // Still update cursor to prevent re-polling
          newestMentionId = maxTwitterId(newestMentionId, envelope.messageId);
          continue;
        }

        // Fetch reply-chain context so the model sees the whole thread, not just the mention.
        // This is best-effort: failures should not block mention processing.
        try {
          const rawTweet = envelope.raw as TwitterRawTweet;
          const replyToId = rawTweet.referenced_tweets?.find(r => r.type === 'replied_to')?.id;
          if (replyToId) {
            let threadContext = threadContextCache.get(envelope.messageId);
            if (threadContext === undefined) {
              // buildReplyChainContextText accepts the twitter-v2 Tweet type, which rawTweet conforms to
              threadContext = await twitterAdapter.buildReplyChainContextText(rawTweet as Parameters<typeof twitterAdapter.buildReplyChainContextText>[0], {
                maxParentTweets: 8,
                maxChars: 2000,
              });
              threadContextCache.set(envelope.messageId, threadContext);
            }

            if (threadContext) {
              const original = envelope.content.text || '';
              envelope.content.text = `${threadContext}\n\nMention:\n${original}`.trim();
            }
          }
        } catch (error) {
          logger.warn('Failed to fetch Twitter thread context; continuing without it', {
            event: 'thread_context_fetch_failed',
            subsystem: 'twitter',
            avatarId,
            tweetId: envelope.messageId,
            errorMessage: getErrorMessage(error),
          });
        }

        // Add to processable list
        processableMentions.push({ envelope, traceId });
        newestMentionId = maxTwitterId(newestMentionId, envelope.messageId);
      }

      // =========================================================================
      // PHASE 2: Triage mentions (if enabled)
      // =========================================================================
      const twitterConfig = avatarConfig?.platforms?.twitter as { enabled?: boolean; features?: unknown; mentionTriage?: { enabled?: boolean } } | undefined;
      const triageEnabled = isMentionTriageEnabled(twitterConfig);

      // Map of mentionId -> should queue
      const shouldQueue = new Map<string, boolean>();

      if (triageEnabled && processableMentions.length > 0) {
        logger.info('Running mention triage', {
          event: 'triage_started',
          subsystem: 'twitter',
          avatarId,
          mentionCount: processableMentions.length,
        });

        const triageResult = await triageMentions(
          processableMentions.map(p => p.envelope),
          avatarConfig!,
          secrets
        );

        for (const [mentionId, decision] of triageResult.decisions) {
          shouldQueue.set(mentionId, decision.action === 'reply');
          if (decision.action === 'ignore') {
            avatarTriaged++;
            logger.info('Mention triaged as ignore', {
              event: 'mention_triage_ignore',
              subsystem: 'twitter',
              avatarId,
              tweetId: mentionId,
              reason: decision.reason,
            });
          }
        }
      } else {
        // No triage - queue all processable mentions
        for (const { envelope } of processableMentions) {
          shouldQueue.set(envelope.messageId, true);
        }
      }

      // =========================================================================
      // PHASE 3: Queue mentions that passed triage
      // =========================================================================
      for (const { envelope, traceId } of processableMentions) {
        if (!shouldQueue.get(envelope.messageId)) {
          continue; // Triaged as ignore
        }

        await activityService.logMessageReceived(
          avatarId,
          'twitter',
          envelope.sender.displayName || envelope.sender.username || 'Unknown',
          envelope.content.text || ''
        );

        const deduplicationId = `twitter-mention-${avatarId}-${envelope.messageId}`;
        const messageGroupId = `${avatarId}#${envelope.conversationId}`;

        await sendSqsMessage({
          QueueUrl: MESSAGE_QUEUE_URL,
          MessageAttributes: {
            traceId: {
              DataType: 'String',
              StringValue: traceId,
            },
          },
          MessageGroupId: messageGroupId,
          MessageDeduplicationId: deduplicationId,
        }, {
          envelope,
          enqueuedAt: Date.now(),
          attempts: 0,
          maxAttempts: 3,
        });

        logger.debug('Message enqueued', {
          event: 'mention_enqueued',
          subsystem: 'twitter',
          avatarId,
          tweetId: envelope.messageId,
          threadId: envelope.conversationId,
          deduplicationId,
          messageGroupId,
        });

        totalQueued++;
        avatarQueued++;
      }

      if (newestMentionId && newestMentionId !== sinceId) {
        await stateService.setLastMentionId(avatarId, newestMentionId);
      }

      logger.info('Cursor state after poll', {
        event: 'cursor_updated',
        subsystem: 'twitter',
        avatarId,
        cursorBefore: sinceId,
        cursorAfter: newestMentionId,
        cursorAdvanced: newestMentionId !== sinceId,
        mentionsRead: sortedMentions.length,
        mentionsQueued: avatarQueued,
        mentionsFiltered: avatarFiltered,
        mentionsTriaged: avatarTriaged,
        triageEnabled,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const is429 = /\b429\b/.test(errorMessage) || isRateLimitError(error);

      if (is429) {
        const { backoffUntil, consecutive429s } = await twitterUsageService.recordRateLimited();
        logger.warn('Twitter API rate-limited (429). Backing off globally.', {
          event: 'rate_limited',
          subsystem: 'twitter',
          avatarId,
          backoffUntil: new Date(backoffUntil).toISOString(),
          consecutive429s,
        });
        break;
      }

      logger.error('Failed to poll Twitter mentions for avatar', error, {
        event: 'handler_error',
        subsystem: 'twitter',
        avatarId,
        errorMessage,
      });
    }
  }

  logger.info('Shared Twitter mention poller complete', {
    event: 'poll_complete',
    subsystem: 'twitter',
    polledAvatars: totalPolled,
    mentionsRead: totalMentionsRead,
    queued: totalQueued,
    durationMs: Date.now() - startTime,
  });
};
