/**
 * Autonomous Tweet Poster - Shared Multi-Tenant Handler
 *
 * Runs hourly (handler manages per-avatar timing internally)
 * Posts memory-integrated content to Twitter and Communities
 *
 * Features:
 * - 4-6 hour randomized posting intervals per avatar
 * - Memory-integrated content generation
 * - Optional image generation (configurable probability)
 * - Community posting support (when available)
 * - Content store integration for simulation mode and post review
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  createLLMService,
  createMediaServiceWithDeps,
  createMediaDependencies,
  createGallerySaver,
  createContentStoreService,
  enqueuePost,
  logger,
  type AvatarConfig,
  type ContentStoreService,
  type PostMedia,
} from '@swarm/core';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { checkMediaWithEnergyFallback } from '../services/entitlement-enforcement.js';
import { createRuntimeBrainService } from '../services/brain.js';
import {
  generateAutonomousContent,
  generateImagePrompt,
  type AutonomousContentTargetType,
  type CommunityContext,
} from '../services/autonomous-content.js';

const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const POST_QUEUE_URL = process.env.POST_QUEUE_URL || '';

// Feature flags
const ENABLE_CONTENT_STORE = process.env.ENABLE_CONTENT_STORE === 'true';
const ENABLE_DECOUPLED_POSTING = process.env.ENABLE_DECOUPLED_POSTING === 'true';

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let contentStoreService: ContentStoreService | null = null;

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
  if (ENABLE_CONTENT_STORE) {
    contentStoreService = createContentStoreService(STATE_TABLE);
  }
}

/**
 * Check if an avatar is ready for an autonomous post based on timing configuration
 */
function shouldPostNow(
  lastPostTime: number,
  minIntervalHours: number,
  maxIntervalHours: number
): boolean {
  const now = Date.now();
  const minIntervalMs = minIntervalHours * 60 * 60 * 1000;
  const maxIntervalMs = maxIntervalHours * 60 * 60 * 1000;

  // Calculate a randomized interval for this check
  // Using a deterministic random based on lastPostTime for consistency
  const seed = lastPostTime || now;
  const randomFactor = (seed % 1000) / 1000; // 0-1 based on seed
  const requiredInterval = minIntervalMs + randomFactor * (maxIntervalMs - minIntervalMs);

  return now - lastPostTime >= requiredInterval;
}

/**
 * Process a single avatar for autonomous posting
 */
async function processAvatar(
  avatarId: string,
  avatarConfig: AvatarConfig,
  secrets: Record<string, string>
): Promise<{ posted: boolean; tweetId?: string; postId?: string; error?: string }> {
  const twitterConfig = avatarConfig.platforms.twitter;
  if (!twitterConfig?.enabled) {
    return { posted: false };
  }

  // Check if autonomous posts feature is enabled
  if (!twitterConfig.features?.includes('autonomous_posts')) {
    return { posted: false };
  }

  const autoConfig = twitterConfig.autonomousPosts;
  if (!autoConfig?.enabled) {
    return { posted: false };
  }

  // Check timing
  const lastPostTime = await stateService.getLastAutonomousPostTime(avatarId);
  const minInterval = autoConfig.minIntervalHours || 4;
  const maxInterval = autoConfig.maxIntervalHours || 6;

  if (!shouldPostNow(lastPostTime, minInterval, maxInterval)) {
    logger.debug('Skipping avatar, not enough time elapsed', {
      avatarId,
      lastPostTime,
      minInterval,
      maxInterval,
    });
    return { posted: false };
  }

  // Check simulation mode
  const simulationConfig = twitterConfig.simulation;
  let isSimulationMode = simulationConfig?.enabled === true;

  // Initialize Twitter adapter (skip if in simulation mode)
  let twitterAdapter: TwitterAdapter | null = null;
  if (!isSimulationMode) {
    twitterAdapter = new TwitterAdapter(avatarConfig, {
      appKey: secrets.TWITTER_API_KEY,
      appSecret: secrets.TWITTER_API_SECRET,
      accessToken: secrets.TWITTER_ACCESS_TOKEN,
      accessSecret: secrets.TWITTER_ACCESS_SECRET,
    });

    if (!twitterAdapter.isConfigured()) {
      // If Twitter not configured, fall back to simulation mode if content store enabled
      if (ENABLE_CONTENT_STORE) {
        logger.info('Twitter not configured, falling back to simulation mode', { avatarId });
        twitterAdapter = null;
        isSimulationMode = true; // Enable simulation mode for this run
      } else {
        return { posted: false, error: 'Twitter adapter not configured' };
      }
    }
  }

  // Initialize LLM service
  const llmService = createLLMService(avatarConfig.llm, secrets);
  const brainService = createRuntimeBrainService(stateService, avatarConfig.brain);

  // Decide: regular tweet or community post
  const communities = twitterConfig.communities || [];
  const hasCommunityFeature = twitterConfig.features?.includes('community_posts');
  const shouldPostToCommunity = hasCommunityFeature && communities.length > 0 && Math.random() < 0.3;

  let targetType: AutonomousContentTargetType = 'tweet';
  let communityContext: CommunityContext | undefined;

  if (shouldPostToCommunity) {
    const community = communities[Math.floor(Math.random() * communities.length)];
    targetType = 'community_post';
    communityContext = { id: community.id, name: community.name };
  }

  // Generate content with memory integration
  const content = await generateAutonomousContent(
    {
      avatarId,
      avatarConfig,
      targetType,
      communityContext,
    },
    brainService,
    llmService
  );

  // Check for duplicate content (if content store enabled)
  if (ENABLE_CONTENT_STORE && contentStoreService) {
    const isDuplicate = await contentStoreService.isDuplicateContent(avatarId, content.text);
    if (isDuplicate) {
      logger.info('Duplicate content detected, skipping post', {
        event: 'duplicate_content_skipped',
        avatarId,
        textPreview: content.text.slice(0, 50),
      });
      return { posted: false, error: 'Duplicate content' };
    }
  }

  // Optionally generate image
  let mediaUrl: string | undefined;
  let media: PostMedia[] | undefined;
  const imageChance = autoConfig.imageChance ?? 0.3;

  if (Math.random() < imageChance) {
    try {
      // Unified burst pool: entitlement-first, energy-fallback
      const usageCheck = await checkMediaWithEnergyFallback(avatarId);
      if (!usageCheck.allowed) {
        logger.info('Skipping autonomous image generation due to limits', {
          avatarId,
          reason: usageCheck.reason,
          limit: usageCheck.limit,
          current: usageCheck.current,
        });
        throw new Error(usageCheck.reason || 'Daily media generation limit reached');
      }

      const mediaDeps = createMediaDependencies({ tableName: STATE_TABLE });
      const adminTable = process.env.ADMIN_TABLE;
      if (adminTable) {
        mediaDeps.saveToGallery = createGallerySaver({ tableName: adminTable });
      }
      const mediaService = createMediaServiceWithDeps(secrets, MEDIA_BUCKET, CDN_URL, mediaDeps);

      const imagePrompt = await generateImagePrompt(content.text, avatarConfig, llmService);

      const generatedMedia = await mediaService.generateImage(
        imagePrompt,
        avatarConfig.media.image,
        { avatarId, platform: 'twitter', saveToGallery: true, checkCredits: false }
      );
      mediaUrl = generatedMedia.url;
      media = [{ type: 'image', url: generatedMedia.url, s3Key: generatedMedia.s3Key }];

      logger.info('Generated image for autonomous post', {
        event: 'image_generated',
        avatarId,
        imagePrompt: imagePrompt.slice(0, 50),
      });
    } catch (error) {
      logger.warn('Image generation failed for autonomous post', { error, avatarId });
      // Continue without image
    }
  }

  // Store post in content store if enabled
  let postId: string | undefined;
  if (ENABLE_CONTENT_STORE && contentStoreService) {
    // Check moderation config to determine initial status
    const moderationConfig = await contentStoreService.getModerationConfig(avatarId);

    // Pre-moderation only applies BEFORE graduation. Once graduated, user has earned trust.
    // The mode setting ('pre'/'post'/'none') only controls post-hoc review after graduation.
    const requiresPreReview = moderationConfig.mode === 'pre' && !moderationConfig.hasGraduated;
    const autoApprove = isSimulationMode && simulationConfig?.autoApprove;

    // Determine initial status:
    // - autoApprove: approved immediately (simulation mode)
    // - requiresPreReview: pending_review (pre-graduation mandatory review)
    // - graduated: queued/approved (earned trust, auto-post)
    let initialStatus: 'pending_review' | 'approved' | 'queued' = 'pending_review';
    if (autoApprove) {
      initialStatus = 'approved';
    } else if (!requiresPreReview) {
      // Graduated users - posts go directly to queue (or approved for simulation)
      initialStatus = isSimulationMode ? 'approved' : 'queued';
    }
    // else: requiresPreReview=true → stays pending_review (default)

    // Get next available scheduled slot (30 min gap between tweets)
    const scheduledAt = await contentStoreService.getNextScheduledSlot(avatarId, 30);

    const post = await contentStoreService.createPost({
      avatarId,
      text: content.text,
      media,
      source: isSimulationMode ? 'simulation' : 'generated',
      communityId: communityContext?.id,
      communityName: communityContext?.name,
      status: initialStatus,
      scheduledAt,
    });
    postId = post.postId;

    logger.info('Post stored in content store', {
      event: 'post_stored',
      avatarId,
      postId,
      status: initialStatus,
      scheduledAt: new Date(scheduledAt).toISOString(),
      isSimulationMode,
    });

    // If in simulation mode or requires review, don't post to Twitter
    if (isSimulationMode || initialStatus === 'pending_review') {
      await stateService.setLastAutonomousPostTime(avatarId, Date.now());

      await activityService.log({
        avatarId,
        timestamp: Date.now(),
        eventType: 'response_sent',
        platform: 'twitter',
        summary: `${isSimulationMode ? 'Simulated' : 'Pending review'} ${targetType}: ${content.text.slice(0, 50)}...`,
        details: {
          postId,
          hasImage: !!mediaUrl,
          targetType,
          communityId: communityContext?.id,
          communityName: communityContext?.name,
          isSimulationMode,
          status: initialStatus,
        },
      });

      return { posted: true, postId };
    }

    // If decoupled posting is enabled, enqueue for tweet-sender instead of posting directly
    if (ENABLE_DECOUPLED_POSTING && POST_QUEUE_URL && initialStatus === 'queued') {
      try {
        await enqueuePost(POST_QUEUE_URL, avatarId, postId!, scheduledAt);
        logger.info('Post enqueued for decoupled Twitter posting', {
          event: 'post_enqueued',
          avatarId,
          postId,
          scheduledAt: new Date(scheduledAt).toISOString(),
        });

        await stateService.setLastAutonomousPostTime(avatarId, Date.now());

        await activityService.log({
          avatarId,
          timestamp: Date.now(),
          eventType: 'response_sent',
          platform: 'twitter',
          summary: `Queued ${targetType}: ${content.text.slice(0, 50)}...`,
          details: {
            postId,
            hasImage: !!mediaUrl,
            targetType,
            communityId: communityContext?.id,
            communityName: communityContext?.name,
            status: 'queued',
          },
        });

        return { posted: true, postId };
      } catch (error) {
        logger.error('Failed to enqueue post', { event: 'post_enqueue_failed', avatarId, postId, error });
        // Fall through to direct posting as fallback
      }
    }
  }

  // Post the tweet (only if not in simulation mode and has configured adapter)
  if (!twitterAdapter) {
    return { posted: false, error: 'Twitter adapter not available' };
  }

  let tweetId: string;
  try {
    if (targetType === 'community_post' && communityContext) {
      tweetId = await twitterAdapter.postToCommunity(
        communityContext.id,
        content.text,
        mediaUrl ? [{ type: 'image', url: mediaUrl }] : undefined
      );
    } else {
      tweetId = await twitterAdapter.postTweet(
        content.text,
        mediaUrl ? [{ type: 'image', url: mediaUrl }] : undefined
      );
    }

    // Update content store with Twitter ID
    if (ENABLE_CONTENT_STORE && contentStoreService && postId) {
      await contentStoreService.markPosted(avatarId, postId, tweetId);
    }
  } catch (error) {
    // Update content store with failure
    if (ENABLE_CONTENT_STORE && contentStoreService && postId) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await contentStoreService.markFailed(avatarId, postId, errorMessage);
    }
    throw error;
  }

  // Record the post time
  await stateService.setLastAutonomousPostTime(avatarId, Date.now());

  // Log activity
  await activityService.log({
    avatarId,
    timestamp: Date.now(),
    eventType: 'response_sent',
    platform: 'twitter',
    summary: `Autonomous ${targetType}: ${content.text.slice(0, 50)}...`,
    details: {
      tweetId,
      postId,
      hasImage: !!mediaUrl,
      targetType,
      communityId: communityContext?.id,
      communityName: communityContext?.name,
    },
  });

  return { posted: true, tweetId, postId };
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  const startTime = Date.now();
  logger.setContext({
    requestId: context.awsRequestId,
    handler: 'autonomous-tweet-poster',
  });

  await initialize();

  logger.info('Autonomous tweet poster started', {
    event: 'handler_started',
    subsystem: 'twitter',
  });

  // Get all avatars
  const avatarIds = await stateService.listAvatars();
  let postsCreated = 0;
  let avatarsProcessed = 0;
  let avatarsSkipped = 0;
  const errors: Array<{ avatarId: string; error: string }> = [];

  for (const avatarId of avatarIds) {
    try {
      logger.setContext({ avatarId, requestId: context.awsRequestId });

      // Check avatar status - only active avatars should post
      const configWithStatus = await stateService.getAvatarConfigWithStatus(avatarId);
      if (!configWithStatus) {
        logger.debug('Avatar config not found', { avatarId });
        continue;
      }

      if (configWithStatus.status !== 'active') {
        logger.info('Avatar not active, skipping autonomous posting', {
          event: 'avatar_inactive',
          avatarId,
          status: configWithStatus.status,
        });
        avatarsSkipped++;
        continue;
      }

      const avatarConfig = configWithStatus.config;

      // Quick check for autonomous posts feature before loading secrets
      const twitterConfig = avatarConfig.platforms?.twitter;
      if (!twitterConfig?.enabled || !twitterConfig.features?.includes('autonomous_posts')) {
        avatarsSkipped++;
        continue;
      }

      if (!twitterConfig.autonomousPosts?.enabled) {
        avatarsSkipped++;
        continue;
      }

      const secrets = await loadAvatarSecrets(secretsService, avatarId, SECRET_PREFIX);

      const result = await processAvatar(avatarId, avatarConfig, secrets);
      avatarsProcessed++;

      if (result.posted) {
        postsCreated++;
        logger.info('Autonomous post created', {
          event: 'autonomous_post_created',
          tweetId: result.tweetId,
        });
      }

      if (result.error) {
        errors.push({ avatarId, error: result.error });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to process avatar for autonomous posting', error, { avatarId });
      errors.push({ avatarId, error: errorMessage });
    }
  }

  logger.info('Autonomous tweet poster complete', {
    event: 'handler_complete',
    postsCreated,
    avatarsProcessed,
    avatarsSkipped,
    errorCount: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: Date.now() - startTime,
  });
};
