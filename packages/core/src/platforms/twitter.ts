/**
 * Twitter/X Platform Adapter
 * Handles Twitter API v2 for posting, mentions, and DMs
 */
import { TwitterApi, TweetV2, UserV2, type MediaObjectV2 } from 'twitter-api-v2';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { PlatformAdapter } from './base.js';
import { ensureTwitterImageWithinLimit, TWITTER_MAX_IMAGE_BYTES } from './twitter-media.js';
import { PlatformError } from '../errors/errors.js';
import { SwarmErrorCode } from '../errors/codes.js';
import type {
  AvatarConfig,
  SwarmEnvelope,
  ResponseAction,
  SenderInfo,
  MessageContent,
  MediaAttachment,
  TwitterConfig,
} from '../types/index.js';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import { logger } from '../utils/logger.js';

type TweetWithOptionalAuthor = TweetV2 & {
  author?: UserV2;
  author_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  in_reply_to_user_id?: string;
  includes?: { media?: MediaObjectV2[] };
};

type TwitterV2SingleTweetClient = {
  singleTweet: (
    tweetId: string,
    params: {
      expansions: string[];
      'tweet.fields': string[];
      'user.fields': string[];
    }
  ) => Promise<{ data?: TweetWithOptionalAuthor | null; includes?: { users?: UserV2[] } }>;
};

export interface TwitterCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export class TwitterAdapter extends PlatformAdapter {
  readonly platform = 'twitter' as const;
  private client: TwitterApi | null = null;
  private config: TwitterConfig;
  private botUserId: string | null = null;

  constructor(
    avatarConfig: AvatarConfig,
    private readonly credentials: TwitterCredentials,
    injectedClient?: TwitterApi
  ) {
    super(avatarConfig);
    this.config = avatarConfig.platforms.twitter!;

    if (injectedClient) {
      this.client = injectedClient;
    } else if (this.isConfigured()) {
      this.client = new TwitterApi({
        appKey: credentials.appKey,
        appSecret: credentials.appSecret,
        accessToken: credentials.accessToken,
        accessSecret: credentials.accessSecret,
      });
    }
  }

  isConfigured(): boolean {
    return !!(
      this.config?.enabled &&
      this.credentials.appKey &&
      this.credentials.appSecret &&
      this.credentials.accessToken &&
      this.credentials.accessSecret
    );
  }

  getDisplayName(): string {
    return `Twitter @${this.config.username}`;
  }

  async verifyRequest(_body: Buffer, _headers: Record<string, string>): Promise<boolean> {
    // Twitter uses CRC token verification for webhooks
    // For Account Activity API, implement CRC validation
    // For polling-based approach, this isn't used
    return true;
  }

  /**
   * Parse a tweet into SwarmEnvelope
   * Used when processing mentions or timeline tweets.
   *
   * Parity with Telegram:
   * - Extracts isMention / isReplyToBot metadata
   * - Extracts media attachments from tweet includes
   * - Sets priority to 'high' for direct engagement
   */
  async parseMessage(body: unknown): Promise<SwarmEnvelope | null> {
    const tweet = body as TweetWithOptionalAuthor;
    
    if (!tweet.id || !tweet.text) {
      return null;
    }

    const sender = await this.extractSender(tweet);
    const content = this.extractContent(tweet, tweet.includes?.media);
    const mentions = this.extractMentions(tweet);

    // Detect direct engagement (parity with Telegram adapter)
    const botUsername = this.config.username;
    const isMention = botUsername
      ? new RegExp(`@${botUsername}\\b`, 'i').test(tweet.text)
      : false;

    const botUserId = this.botUserId;
    const isReplyToBot = !!(
      botUserId &&
      tweet.in_reply_to_user_id === botUserId
    );

    const envelope = this.createBaseEnvelope({
      messageId: tweet.id,
      conversationId: tweet.conversation_id || tweet.id,
      timestamp: tweet.created_at ? new Date(tweet.created_at).getTime() : Date.now(),
      sender,
      content,
      raw: tweet,
    });

    // Enrich metadata with engagement flags (parity with Telegram)
    envelope.metadata.isMention = isMention;
    envelope.metadata.isReplyToBot = isReplyToBot;
    envelope.metadata.priority = (isMention || isReplyToBot) ? 'high' : 'normal';

    envelope.mentions = mentions;
    envelope.replyTo = tweet.referenced_tweets?.find(r => r.type === 'replied_to')?.id;

    return envelope;
  }

  async executeAction(
    action: ResponseAction,
    _conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    try {
      switch (action.type) {
        case 'send_message':
          await this.postTweet(action.text, action.media, replyToMessageId);
          break;

        case 'send_media': {
          // Parity with Telegram: handle send_media action for image/video/animation
          const media = [{ type: action.mediaType, url: action.url }];
          const caption = action.caption || '';
          await this.postTweet(caption, media, replyToMessageId);
          break;
        }

        case 'send_voice': {
          const text = action.caption ? `${action.caption} ${action.url}` : action.url;
          await this.postTweet(text, undefined, replyToMessageId);
          break;
        }

        case 'send_sticker': {
          // Twitter doesn't have stickers - post the emoji as a tweet
          await this.postTweet(action.emoji, undefined, replyToMessageId);
          break;
        }

        case 'react':
          // Twitter "reaction" is a like
          await this.client.v2.like(await this.getBotUserId(), action.messageId);
          break;

        case 'take_selfie':
          // Media generation handled by media processor
          // This action comes with pre-generated media
          break;

        case 'wait':
          await new Promise(resolve => setTimeout(resolve, action.durationMs));
          break;

        case 'ignore':
          // No action needed
          break;

        default:
          logger.warn('Twitter action ignored due to unknown type', {
            actionType: (action as ResponseAction).type,
          });
      }
      
      return true;
    } catch (error) {
      logger.warn('Twitter action execution failed', {
        actionType: action.type,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async sendTypingIndicator(_conversationId: string): Promise<void> {
    // Twitter doesn't support typing indicators for public tweets.
    // No-op by design (platform constraint).
  }

  /**
   * Upload media to Twitter and return media IDs
   * Reusable method for both regular tweets and community posts
   */
  async uploadMedia(media: Array<{ type: string; url: string }>): Promise<string[]> {
    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    const mediaIds: string[] = [];

    for (const item of media.slice(0, 4)) { // Twitter allows max 4 media items
      try {
        logger.debug('Twitter media upload: processing item', {
          url: item.url,
          type: item.type,
        });

        // Download the media (prefer S3 if URL points to our bucket) and upload to Twitter.
        const { buffer, contentType, source } = await downloadMedia(item.url);
        logger.debug('Twitter media upload: source download complete', {
          source,
          bufferSize: buffer.length,
          contentType,
        });

        // Detect MIME type from Content-Type header or URL.
        let mimeType = 'image/png';
        if (item.type === 'video') {
          mimeType = 'video/mp4';
        } else {
          if (contentType && !['application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
            mimeType = contentType.split(';')[0];
          } else {
            // Infer from URL extension
            const urlLower = item.url.toLowerCase();
            if (urlLower.includes('.webp')) mimeType = 'image/webp';
            else if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) mimeType = 'image/jpeg';
            else if (urlLower.includes('.gif')) mimeType = 'image/gif';
          }
        }

        let uploadBuffer = buffer;
        if (mimeType.startsWith('image/') && uploadBuffer.length > TWITTER_MAX_IMAGE_BYTES) {
          const resized = await ensureTwitterImageWithinLimit(uploadBuffer, mimeType);
          uploadBuffer = resized.buffer;
          mimeType = resized.mimeType;
          logger.debug('Twitter media upload: image downsized', {
            originalBytes: buffer.length,
            uploadBytes: uploadBuffer.length,
            mimeType,
          });
        }

        logger.debug('Twitter media upload: sending to Twitter API', { mimeType });
        const mediaId = await this.client.v1.uploadMedia(uploadBuffer, {
          mimeType: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'video/mp4',
        });

        logger.debug('Twitter media upload: success', { mediaId });
        mediaIds.push(mediaId);
      } catch (error) {
        logger.warn('Twitter media upload failed for item', {
          url: item.url,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (mediaIds.length < media.length) {
      logger.warn('Twitter media upload partially succeeded', {
        uploadedCount: mediaIds.length,
        requestedCount: media.length,
      });
    }

    return mediaIds;
  }

  /**
   * Post a tweet with optional media
   */
  async postTweet(
    text: string,
    media?: Array<{ type: string; url: string }>,
    replyToTweetId?: string
  ): Promise<string> {
    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    const tweetParams: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text,
    };

    // Handle reply
    if (replyToTweetId) {
      tweetParams.reply = {
        in_reply_to_tweet_id: replyToTweetId,
      };
    }

    // Handle media upload using the reusable method
    if (media && media.length > 0) {
      const mediaIds = await this.uploadMedia(media);
      if (mediaIds.length > 0) {
        tweetParams.media = { media_ids: mediaIds as [string] };
      }
    }

    const result = await this.client.v2.tweet(tweetParams);
    return result.data.id;
  }

  /**
   * Post a tweet to a Twitter Community
   * Note: Community posting requires specific API access tier.
   */
  async postToCommunity(
    communityId: string,
    text: string,
    media?: Array<{ type: string; url: string }>,
    replyToTweetId?: string
  ): Promise<string> {
    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    const tweetParams: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text,
    };

    // Community posts are supported via community_id (may require elevated access tier).
    (tweetParams as { community_id?: string }).community_id = communityId;

    // Handle reply within community
    if (replyToTweetId) {
      tweetParams.reply = {
        in_reply_to_tweet_id: replyToTweetId,
      };
    }

    // Handle media upload
    if (media && media.length > 0) {
      const mediaIds = await this.uploadMedia(media);
      if (mediaIds.length > 0) {
        tweetParams.media = { media_ids: mediaIds as [string] };
      }
    }

    const result = await this.client.v2.tweet(tweetParams);
    return result.data.id;
  }

  /**
   * Get recent tweets from a community timeline
   * Note: This is a placeholder - community timeline access varies by API tier
   */
  async getCommunityTimeline(
    _communityId: string,
    _sinceId?: string,
    _maxResults: number = 20
  ): Promise<SwarmEnvelope[]> {
    // Community timeline access requires specific API permissions
    // This is a placeholder for future implementation when API access is available
    // Possible approaches:
    // 1. Use search API with community filter (if available)
    // 2. Use community-specific endpoints (Enterprise tier)
    // 3. Scrape community page (not recommended for production)
    logger.info('Twitter community timeline is not implemented yet');
    return [];
  }

  /**
   * Get recent mentions of the bot
   */
  async getMentions(
    sinceId?: string,
    options?: { maxResults?: number }
  ): Promise<SwarmEnvelope[]> {
    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    const userId = await this.getBotUserId();
    // Twitter API allows max_results between 5 and 100
    const maxResults = Math.min(100, Math.max(5, options?.maxResults || 20));

    const mentions = await this.client.v2.userMentionTimeline(userId, {
      since_id: sinceId,
      max_results: maxResults,
      expansions: ['author_id', 'referenced_tweets.id', 'attachments.media_keys'],
      'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id', 'referenced_tweets', 'attachments'],
      'user.fields': ['username', 'name'],
      'media.fields': ['media_key', 'type', 'url', 'preview_image_url', 'width', 'height', 'alt_text'],
    });

    const envelopes: SwarmEnvelope[] = [];
    
    const mediaIncludes = (mentions.includes as { media?: MediaObjectV2[] } | undefined)?.media;

    for (const tweet of mentions.data.data || []) {
      const author = mentions.includes?.users?.find(u => u.id === tweet.author_id);
      const envelope = await this.parseMessage({
        ...tweet,
        author,
        includes: mediaIncludes ? { media: mediaIncludes } : undefined,
      });
      if (envelope) {
        envelopes.push(envelope);
      }
    }

    return envelopes;
  }

  /**
   * Build a human-readable thread context string by walking the reply chain upward.
   *
   * This is designed for mention replies where we want the bot to see what the user
   * is replying to (root tweet + intermediate parents), without doing a full
   * conversation search.
   */
  async buildReplyChainContextText(
    mentionTweet: TweetWithOptionalAuthor,
    options?: { maxParentTweets?: number; maxChars?: number }
  ): Promise<string | undefined> {
    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    const maxParentTweets = Math.max(1, Math.min(20, options?.maxParentTweets ?? 8));
    const maxChars = Math.max(200, Math.min(10_000, options?.maxChars ?? 2_000));

    const repliedToId = mentionTweet.referenced_tweets?.find(r => r.type === 'replied_to')?.id;
    if (!repliedToId) return undefined;

    const parents: TweetWithOptionalAuthor[] = [];
    const seen = new Set<string>();

    let cursor: string | undefined = repliedToId;
    while (cursor && parents.length < maxParentTweets) {
      if (seen.has(cursor)) break;
      seen.add(cursor);

      const parent = await this.fetchTweetWithAuthor(cursor);
      if (!parent) break;

      parents.push(parent);
      cursor = parent.referenced_tweets?.find(r => r.type === 'replied_to')?.id;
    }

    if (parents.length === 0) return undefined;

    // Oldest -> newest (closest parent last)
    const ordered = parents.slice().reverse();
    const lines = ordered.map((tweet) => {
      const username = tweet.author?.username;
      const who = username ? `@${username}` : (tweet.author_id ? `user:${tweet.author_id}` : 'unknown');
      const text = (tweet.text || '').replace(/\s+/g, ' ').trim();
      return `${who}: ${text}`.trim();
    }).filter(Boolean);

    if (lines.length === 0) return undefined;

    let rendered = `Thread context (oldest→newest):\n${lines.join('\n')}`;

    // Hard cap by dropping oldest lines first.
    while (rendered.length > maxChars && lines.length > 1) {
      lines.shift();
      rendered = `Thread context (oldest→newest):\n${lines.join('\n')}`;
    }

    if (rendered.length > maxChars) {
      rendered = rendered.slice(0, maxChars - 20).trimEnd() + '\n…(truncated)';
    }

    return rendered;
  }

  private async fetchTweetWithAuthor(tweetId: string): Promise<TweetWithOptionalAuthor | null> {
    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    try {
      const twitterV2Client = this.client.v2 as unknown as TwitterV2SingleTweetClient;
      const result = await twitterV2Client.singleTweet(tweetId, {
        expansions: ['author_id', 'referenced_tweets.id'],
        'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id', 'referenced_tweets'],
        'user.fields': ['username', 'name'],
      });

      const data = (result?.data ?? null) as TweetWithOptionalAuthor | null;
      if (!data?.id) return null;

      const author = (result?.includes?.users as UserV2[] | undefined)?.find((u) => u.id === (data.author_id as string | undefined));
      return { ...data, author };
    } catch {
      return null;
    }
  }

  /**
   * Quote tweet with optional image
   */
  async quoteTweet(
    text: string,
    quoteTweetId: string,
    media?: Array<{ type: string; url: string }>
  ): Promise<string> {
    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    const tweetParams: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text,
      quote_tweet_id: quoteTweetId,
    };

    // Handle media upload using the reusable method
    if (media && media.length > 0) {
      const mediaIds = await this.uploadMedia(media);
      if (mediaIds.length > 0) {
        tweetParams.media = { media_ids: mediaIds as [string] };
      }
    }

    const result = await this.client.v2.tweet(tweetParams);
    return result.data.id;
  }

  /**
   * Get the bot's Twitter user ID (cached after first call)
   */
  async getBotUserId(): Promise<string> {
    if (this.botUserId) {
      return this.botUserId;
    }

    if (!this.client) {
      throw new PlatformError('Twitter client not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'twitter',
    });
    }

    const me = await this.client.v2.me();
    this.botUserId = me.data.id;
    return this.botUserId;
  }

  /**
   * Get the bot's Twitter username from config
   */
  getBotUsername(): string | undefined {
    return this.config.username;
  }

  /**
   * Extract sender info from tweet
   */
  private async extractSender(tweet: TweetV2 & { author?: UserV2; author_id?: string }): Promise<SenderInfo> {
    const author = tweet.author;
    
    return {
      id: tweet.author_id || author?.id || 'unknown',
      username: author?.username,
      displayName: author?.name,
      isBot: false, // Twitter doesn't expose bot status easily
      platform: 'twitter',
      platformUserId: tweet.author_id || author?.id || 'unknown',
    };
  }

  /**
   * Extract content from tweet.
   * When media includes are provided (from API expansions), attaches them
   * to the content -- parity with Telegram's media extraction.
   */
  private extractContent(tweet: TweetV2, mediaIncludes?: MediaObjectV2[]): MessageContent {
    const content: MessageContent = {
      text: tweet.text,
    };

    // Extract media from tweet attachments + includes (parity with Telegram)
    if (mediaIncludes && tweet.attachments?.media_keys) {
      const mediaAttachments: MediaAttachment[] = [];
      for (const key of tweet.attachments.media_keys) {
        const media = mediaIncludes.find(m => m.media_key === key);
        if (!media) continue;

        let type: MediaAttachment['type'];
        switch (media.type) {
          case 'photo':
            type = 'photo';
            break;
          case 'video':
            type = 'video';
            break;
          case 'animated_gif':
            type = 'animation';
            break;
          default:
            type = 'document';
        }

        mediaAttachments.push({
          type,
          url: media.url || media.preview_image_url,
        });
      }

      if (mediaAttachments.length > 0) {
        content.media = mediaAttachments;
      }
    }

    return content;
  }

  /**
   * Extract mentions from tweet
   */
  private extractMentions(tweet: TweetV2): SwarmEnvelope['mentions'] {
    const mentions: SwarmEnvelope['mentions'] = [];
    
    // Extract @mentions from tweet text using regex
    const mentionRegex = /@(\w+)/g;
    let match;
    
    while ((match = mentionRegex.exec(tweet.text)) !== null) {
      mentions.push({
        userId: match[1], // We only have username, not ID
        username: match[1],
        offset: match.index,
        length: match[0].length,
      });
    }

    return mentions;
  }

  /**
   * Get the underlying TwitterApi client for advanced usage
   */
  getClient(): TwitterApi | null {
    return this.client;
  }
}

const s3Client = new S3Client({});

async function downloadMedia(url: string): Promise<{ buffer: Buffer; contentType?: string; source: 's3' | 'http' }> {
  const cdnUrlEnv = process.env.CDN_URL;
  const mediaBucketEnv = process.env.MEDIA_BUCKET;

  logger.debug('Twitter media download: start', {
    url,
    CDN_URL: cdnUrlEnv || '(not set)',
    MEDIA_BUCKET: mediaBucketEnv || '(not set)',
  });

  const s3Location = resolveS3Location(url);

  if (s3Location) {
    logger.debug('Twitter media download: resolved S3 location', s3Location);
    try {
      const response = await s3Client.send(new GetObjectCommand({
        Bucket: s3Location.bucket,
        Key: s3Location.key,
      }));

      if (!response.Body) {
        throw new PlatformError('Empty S3 response body', {
        code: SwarmErrorCode.PLATFORM_MEDIA_UPLOAD_ERROR,
        platform: 'twitter',
      });
      }

      const buffer = await streamToBuffer(response.Body as Readable);
      logger.debug('Twitter media download: S3 fetch successful', {
        bucket: s3Location.bucket,
        key: s3Location.key,
        size: buffer.length,
        contentType: response.ContentType,
      });
      return { buffer, contentType: response.ContentType, source: 's3' };
    } catch (error) {
      logger.warn('Twitter media download: S3 fetch failed, falling back to HTTP', {
        bucket: s3Location.bucket,
        key: s3Location.key,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    logger.debug('Twitter media download: no S3 location, using HTTP');
  }

  logger.debug('Twitter media download: fetching via HTTP', { url });
  const response = await fetchWithRetry(url, undefined, { maxRetries: 2, timeoutMs: 20_000 });
  if (!response.ok) {
    throw new PlatformError(`HTTP fetch failed: ${response.status} ${response.statusText}`, {
      code: SwarmErrorCode.PLATFORM_API_ERROR,
      platform: 'twitter',
      statusCode: response.status,
      retryable: response.status >= 500,
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers?.get?.('content-type') ?? undefined;

  logger.debug('Twitter media download: HTTP fetch successful', {
    size: buffer.length,
    contentType,
  });

  return { buffer, contentType, source: 'http' };
}

function resolveS3Location(url: string): { bucket: string; key: string } | null {
  const bucketFromEnv = process.env.MEDIA_BUCKET;
  const cdnUrl = normalizeUrlPrefix(process.env.CDN_URL);
  if (cdnUrl && url.startsWith(cdnUrl) && bucketFromEnv) {
    const key = decodeURIComponent(url.slice(cdnUrl.length).replace(/^\/+/, ''));
    if (key) {
      return { bucket: bucketFromEnv, key };
    }
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));

    const virtualHostMatch = host.match(/^(.+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/);
    if (virtualHostMatch?.[1]) {
      return { bucket: virtualHostMatch[1], key: path };
    }

    if (host === 's3.amazonaws.com' || host.startsWith('s3.') || host.startsWith('s3-')) {
      const [bucket, ...rest] = path.split('/');
      if (bucket && rest.length > 0) {
        return { bucket, key: rest.join('/') };
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeUrlPrefix(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}
