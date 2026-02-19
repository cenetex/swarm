/**
 * MCP Twitter Adapter
 *
 * Provides Twitter service methods for the MCP adapter, including media
 * download/upload helpers. Extracted from mcp-adapter.ts for maintainability.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import {
  ensureTwitterImageWithinLimit,
  TWITTER_MAX_IMAGE_BYTES,
} from '@swarm/core';
import type { AllServices } from '@swarm/mcp-server';
import * as gallery from './gallery.js';
import * as twitterOAuth from './twitter-oauth.js';

// =============================================================================
// Constants
// =============================================================================

const API_TIMEOUT_MS = 10_000;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET;
const CDN_URL = process.env.CDN_URL;
const s3Client = new S3Client({});

// =============================================================================
// Media Helpers
// =============================================================================

function isReplicateUrl(url: string): boolean {
  return url.includes('replicate.delivery') || url.includes('replicate.com/v1');
}

function detectMimeType(url: string, contentType: string | null): string {
  if (contentType && !['application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
    return contentType.split(';')[0];
  }
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.webp')) return 'image/webp';
  if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) return 'image/jpeg';
  if (urlLower.includes('.gif')) return 'image/gif';
  return 'image/png';
}

function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

function normalizeUrlPrefix(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadFromS3(bucket: string, key: string): Promise<{ buffer: Buffer; contentType?: string }> {
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));

  if (!response.Body) {
    throw new Error('Empty S3 response body');
  }

  const buffer = await streamToBuffer(response.Body as Readable);
  return { buffer, contentType: response.ContentType };
}

function resolveS3Location(url: string): { bucket: string; key: string } | null {
  const cdnUrl = normalizeUrlPrefix(CDN_URL);
  if (cdnUrl && url.startsWith(cdnUrl) && MEDIA_BUCKET) {
    const key = decodeURIComponent(url.slice(cdnUrl.length).replace(/^\/+/, ''));
    if (key) {
      return { bucket: MEDIA_BUCKET, key };
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

async function downloadMedia(
  url: string,
  s3Key?: string,
  avatarId?: string
): Promise<{ buffer: Buffer; contentType?: string } | null> {
  const bucket = MEDIA_BUCKET;
  if (bucket && s3Key) {
    try {
      return await downloadFromS3(bucket, s3Key);
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'WARN',
        subsystem: 'twitter',
        event: 'twitter_media_s3_download_failed',
        avatarId,
        url: sanitizeUrlForLog(url),
        hasS3Key: true,
        error: error instanceof Error ? error.message : String(error),
        message: 'Failed S3 download by key; falling back to URL fetch',
      }));
    }
  }

  const resolved = resolveS3Location(url);
  if (bucket && resolved) {
    try {
      return await downloadFromS3(resolved.bucket, resolved.key);
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'WARN',
        subsystem: 'twitter',
        event: 'twitter_media_s3_url_download_failed',
        avatarId,
        url: sanitizeUrlForLog(url),
        error: error instanceof Error ? error.message : String(error),
        message: 'Failed S3 download by URL; falling back to URL fetch',
      }));
    }
  }

  try {
    const response = await fetchWithTimeout(url, {}, API_TIMEOUT_MS);
    if (!response.ok) {
      console.error(JSON.stringify({
        level: 'ERROR',
        subsystem: 'twitter',
        event: 'twitter_media_http_fetch_failed',
        avatarId,
        url: sanitizeUrlForLog(url),
        status: response.status,
        statusText: response.statusText,
      }));
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') ?? undefined;
    return { buffer, contentType };
  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'twitter',
      event: 'twitter_media_http_fetch_error',
      avatarId,
      url: sanitizeUrlForLog(url),
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

async function resolveMediaSources(
  mediaUrls: string[],
  avatarId?: string
): Promise<Array<{ url: string; s3Key?: string }>> {
  const sources: Array<{ url: string; s3Key?: string }> = [];

  for (const mediaUrl of mediaUrls) {
    const trimmed = mediaUrl?.trim();
    if (!trimmed) continue;

    if (!/^https?:\/\//i.test(trimmed) && avatarId) {
      try {
        const item = await gallery.getGalleryItem(avatarId, trimmed);
        if (item?.url) {
          sources.push({ url: item.url, s3Key: item.s3Key });
          continue;
        }
      } catch (error) {
        console.warn(`Failed to resolve gallery item ${trimmed}:`, error instanceof Error ? error.message : String(error));
      }
    }

    sources.push({ url: trimmed });
  }

  return sources;
}

async function uploadMediaToTwitter(
  client: InstanceType<typeof import('twitter-api-v2').TwitterApi>,
  mediaUrls: string[],
  avatarId?: string
): Promise<string[]> {
  const mediaIds: string[] = [];

  const sources = await resolveMediaSources(mediaUrls.slice(0, 4), avatarId);

  for (const source of sources) {
    let url = source.url;
    try {
      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'twitter',
        event: 'twitter_media_fetch_start',
        avatarId,
        url: sanitizeUrlForLog(url),
        hasS3Key: Boolean(source.s3Key),
      }));
      let download = await downloadMedia(url, source.s3Key, avatarId);

      if (!download && isReplicateUrl(url) && avatarId) {
        console.warn(JSON.stringify({
          level: 'WARN',
          subsystem: 'twitter',
          event: 'twitter_media_replicate_url_failed',
          avatarId,
          url: sanitizeUrlForLog(url),
          message: 'Replicate URL failed; searching gallery for S3 URL',
        }));
        try {
          const galleryItems = await gallery.getGallery(avatarId, { type: 'image', limit: 20 });
          const recentImage = galleryItems[0];
          if (recentImage?.url && !isReplicateUrl(recentImage.url)) {
            console.log(JSON.stringify({
              level: 'INFO',
              subsystem: 'twitter',
              event: 'twitter_media_gallery_fallback_url',
              avatarId,
              url: sanitizeUrlForLog(recentImage.url),
              hasS3Key: Boolean(recentImage.s3Key),
            }));
            url = recentImage.url;
            download = await downloadMedia(url, recentImage.s3Key, avatarId);
          }
        } catch (galleryErr) {
          console.error(JSON.stringify({
            level: 'ERROR',
            subsystem: 'twitter',
            event: 'twitter_media_gallery_fallback_failed',
            avatarId,
            error: galleryErr instanceof Error ? galleryErr.message : String(galleryErr),
          }));
        }
      }

      if (!download) {
        console.error(JSON.stringify({
          level: 'ERROR',
          subsystem: 'twitter',
          event: 'twitter_media_fetch_failed',
          avatarId,
          url: sanitizeUrlForLog(url),
          message: 'Failed to fetch media; skipping this attachment',
        }));
        continue;
      }

      let mimeType = detectMimeType(url, download.contentType ?? null);
      const originalBuffer = download.buffer;
      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'twitter',
        event: 'twitter_media_downloaded',
        avatarId,
        url: sanitizeUrlForLog(url),
        contentType: download.contentType,
        detectedMimeType: mimeType,
        bytes: originalBuffer.length,
      }));

      let uploadBuffer = originalBuffer;
      if (mimeType.startsWith('image/') && originalBuffer.length > TWITTER_MAX_IMAGE_BYTES) {
        try {
          const resized = await ensureTwitterImageWithinLimit(originalBuffer, mimeType);
          uploadBuffer = resized.buffer;
          mimeType = resized.mimeType;
          console.log('Using downsized image for Twitter upload', {
            originalBytes: originalBuffer.length,
            uploadBytes: uploadBuffer.length,
            mimeType,
          });
        } catch (resizeErr) {
          console.error('Failed to downsize image for Twitter upload (posting without this media)', {
            url,
            originalBytes: originalBuffer.length,
            error: resizeErr instanceof Error ? resizeErr.message : String(resizeErr),
          });
          continue;
        }
      }

      const mediaId = await client.v1.uploadMedia(uploadBuffer, {
        mimeType: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      });
      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'twitter',
        event: 'twitter_media_upload_success',
        avatarId,
        url: sanitizeUrlForLog(url),
        mediaId,
        mimeType,
        bytes: uploadBuffer.length,
      }));
      mediaIds.push(mediaId);
    } catch (err) {
      console.error(JSON.stringify({
        level: 'ERROR',
        subsystem: 'twitter',
        event: 'twitter_media_upload_failed',
        avatarId,
        url: sanitizeUrlForLog(url),
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  if (mediaUrls.length > 0 && mediaIds.length === 0) {
    console.warn('No Twitter media uploaded; tweet will be posted without media', {
      avatarId,
      requestedMediaCount: Math.min(mediaUrls.length, 4),
    });
  }

  return mediaIds;
}

// =============================================================================
// Gallery ID Resolution (shared by postTweet, reply, quoteTweet)
// =============================================================================

interface GalleryIdResolutionResult {
  resolvedMediaUrls: string[];
  failedGalleryIds: string[];
  error?: string;
}

async function resolveGalleryIdsToUrls(
  galleryIds: string[] | undefined,
  mediaUrls: string[] | undefined,
  avatarId: string,
  context: string
): Promise<GalleryIdResolutionResult> {
  let resolvedMediaUrls: string[] = [];
  const failedGalleryIds: string[] = [];
  const coercedMediaUrls: string[] = [];

  const GALLERY_ID_PATTERN = /^\d{10,15}_[a-z0-9]+$/i;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TWITTER_NUMERIC_ID_PATTERN = /^\d{18,22}$/;
  const looksLikeUrl = (value: string) => /^https?:\/\//i.test(value);
  const looksLikeS3Key = (value: string) => /\//.test(value) && /\.(png|jpe?g|gif|webp)$/i.test(value);
  const toCdnUrlFromKey = (key: string): string | null => {
    const cdn = normalizeUrlPrefix(CDN_URL);
    if (!cdn) return null;
    return `${cdn}/${key.replace(/^\/+/, '')}`;
  };

  if (galleryIds && galleryIds.length > 0) {
    console.log(`${context}: Resolving gallery IDs to URLs:`, galleryIds);
    for (const galleryId of galleryIds.slice(0, 4)) {
      if (GALLERY_ID_PATTERN.test(galleryId)) {
        try {
          const item = await gallery.getGalleryItem(avatarId, galleryId);
          if (item?.url) {
            resolvedMediaUrls.push(item.url);
          } else {
            console.warn(`Gallery item ${galleryId} not found`);
            failedGalleryIds.push(galleryId);
          }
        } catch (err) {
          console.error(`Failed to resolve gallery item ${galleryId}:`, err instanceof Error ? err.message : String(err));
          failedGalleryIds.push(galleryId);
        }
        continue;
      }

      if (looksLikeUrl(galleryId)) {
        coercedMediaUrls.push(galleryId);
        console.warn(JSON.stringify({
          level: 'WARN',
          subsystem: 'twitter',
          event: 'twitter_post_media_id_coerced_to_url',
          avatarId,
          provided: galleryId,
          message: 'mediaIds contained a URL; treating as mediaUrl for upload. Prefer passing gallery item id from generate_image/list_gallery.',
        }));
        continue;
      }

      if (looksLikeS3Key(galleryId)) {
        const cdnUrl = toCdnUrlFromKey(galleryId);
        if (cdnUrl) {
          coercedMediaUrls.push(cdnUrl);
          console.warn(JSON.stringify({
            level: 'WARN',
            subsystem: 'twitter',
            event: 'twitter_post_media_id_coerced_to_cdn_url',
            avatarId,
            provided: galleryId,
            coercedUrl: cdnUrl,
            message: 'mediaIds contained an S3 key; treating as CDN URL for upload. Prefer passing gallery item id from generate_image/list_gallery.',
          }));
          continue;
        }
      }

      const event = UUID_PATTERN.test(galleryId)
        ? 'twitter_post_invalid_gallery_id_uuid'
        : TWITTER_NUMERIC_ID_PATTERN.test(galleryId)
          ? 'twitter_post_invalid_gallery_id_twitter_numeric'
          : 'twitter_post_invalid_gallery_id';
      console.error(JSON.stringify({
        level: 'ERROR',
        subsystem: 'twitter',
        event,
        avatarId,
        galleryId,
        message: `Invalid gallery ID format. Expected format: "timestamp_randomId" (e.g., "1770228770932_abc123"). Got: "${galleryId}". Use the exact "id" value from generate_image or list_gallery.`,
      }));
      failedGalleryIds.push(galleryId);
    }

    if (resolvedMediaUrls.length === 0 && coercedMediaUrls.length > 0) {
      resolvedMediaUrls = coercedMediaUrls;
    }

    if (resolvedMediaUrls.length === 0 && failedGalleryIds.length > 0) {
      return {
        resolvedMediaUrls: [],
        failedGalleryIds,
        error: `Failed to resolve gallery images: ${failedGalleryIds.join(', ')}. Use the exact "id" from generate_image (format: "timestamp_randomId" like "1770228770932_abc123"). If you have a URL, pass it as mediaUrls instead.`,
      };
    }
  }

  if (resolvedMediaUrls.length === 0 && mediaUrls && mediaUrls.length > 0) {
    resolvedMediaUrls = mediaUrls;
  }

  return { resolvedMediaUrls, failedGalleryIds };
}

// =============================================================================
// Twitter Services Factory
// =============================================================================

export function createTwitterServices(avatarId: string): AllServices['twitter'] {
  return {
    getConnectionStatus: async () => {
      return twitterOAuth.getConnectionStatus(avatarId);
    },

    startOAuthFlow: async () => {
      try {
        const result = await twitterOAuth.startOAuthFlow(avatarId);
        return { authorizationUrl: result.authorizationUrl };
      } catch (error) {
        console.error('Failed to start Twitter OAuth flow:', error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    postTweet: async (text: string, mediaUrls?: string[], galleryIds?: string[]): Promise<{ tweetId: string; url: string } | { error: string } | null> => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) {
        console.error(JSON.stringify({
          level: 'ERROR',
          subsystem: 'twitter',
          event: 'twitter_post_no_credentials',
          avatarId,
          message: 'Twitter credentials not configured',
        }));
        return { error: 'Twitter is not configured. Please connect Twitter first.' };
      }

      const expectedConnection = await twitterOAuth.getConnectionStatus(avatarId);
      if (!expectedConnection.connected || !expectedConnection.userId) {
        console.error(JSON.stringify({
          level: 'ERROR',
          subsystem: 'twitter',
          event: 'twitter_connection_unverified',
          avatarId,
          connected: expectedConnection.connected,
          message: 'Twitter connection is not verified (missing userId). Reconnect required before posting.',
        }));
        return { error: 'Twitter connection is not verified. Please reconnect your Twitter account.' };
      }

      const resolution = await resolveGalleryIdsToUrls(galleryIds, mediaUrls, avatarId, 'postTweet');
      if (resolution.error) {
        console.error(JSON.stringify({
          level: 'ERROR',
          subsystem: 'twitter',
          event: 'twitter_post_all_media_failed',
          avatarId,
          failedGalleryIds: resolution.failedGalleryIds,
          message: 'All requested mediaIds failed to resolve/coerce. Tweet not posted.',
        }));
        return { error: resolution.error };
      }

      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'twitter',
        event: 'twitter_post_request',
        avatarId,
        textLength: text.length,
        requestedGalleryIds: galleryIds?.length ?? 0,
        resolvedMediaUrls: resolution.resolvedMediaUrls.length,
      }));

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const username = expectedConnection.username;

        const twitterMediaIds = resolution.resolvedMediaUrls.length > 0
          ? await uploadMediaToTwitter(client, resolution.resolvedMediaUrls, avatarId)
          : undefined;

        const tweetParams: Parameters<typeof client.v2.tweet>[0] = { text };
        if (twitterMediaIds && twitterMediaIds.length > 0) {
          tweetParams.media = { media_ids: twitterMediaIds as [string] };
        }

        if (resolution.resolvedMediaUrls.length > 0 && (!twitterMediaIds || twitterMediaIds.length === 0)) {
          console.warn(JSON.stringify({
            level: 'WARN',
            subsystem: 'twitter',
            event: 'twitter_post_media_dropped',
            avatarId,
            requestedMediaCount: resolution.resolvedMediaUrls.length,
            message: 'Media was requested but none uploaded; posting tweet without media.',
          }));
        }

        const result = await client.v2.tweet(tweetParams);
        const tweetId = result.data.id;
        console.log(JSON.stringify({
          level: 'INFO',
          subsystem: 'twitter',
          event: 'twitter_post_success',
          avatarId,
          tweetId,
          username,
          textLength: text.length,
          requestedMediaCount: resolution.resolvedMediaUrls.length,
          uploadedMediaCount: twitterMediaIds?.length ?? 0,
        }));
        return {
          tweetId,
          url: `https://x.com/${username}/status/${tweetId}`,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorData = (error as { data?: { detail?: string; title?: string } })?.data;
        const twitterError = errorData?.detail || errorData?.title || errorMessage;

        console.error(JSON.stringify({
          level: 'ERROR',
          subsystem: 'twitter',
          event: 'twitter_post_failed',
          avatarId,
          error: twitterError,
          errorRaw: errorMessage,
          textLength: text.length,
        }));
        return { error: `Failed to post tweet: ${twitterError}` };
      }
    },

    getTimeline: async (count = 20) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return [];

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const me = await client.v2.me();
        const timeline = await client.v2.userTimeline(me.data.id, {
          max_results: Math.min(count, 100),
          expansions: ['author_id'],
          'tweet.fields': ['created_at', 'public_metrics', 'conversation_id'],
          'user.fields': ['username', 'name'],
        });

        return (timeline.data.data || []).map(t => {
          const author = timeline.includes?.users?.find(u => u.id === t.author_id);
          return {
            id: t.id,
            text: t.text,
            authorId: t.author_id || '',
            authorUsername: author?.username,
            authorName: author?.name,
            createdAt: t.created_at || new Date().toISOString(),
            conversationId: t.conversation_id,
            metrics: t.public_metrics ? {
              replyCount: t.public_metrics.reply_count,
              retweetCount: t.public_metrics.retweet_count,
              likeCount: t.public_metrics.like_count,
              quoteCount: t.public_metrics.quote_count,
            } : undefined,
          };
        });
      } catch (error) {
        console.error('Failed to get Twitter timeline:', error instanceof Error ? error.message : String(error));
        return [];
      }
    },

    getMentions: async (sinceId?: string, count = 20) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return [];

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const me = await client.v2.me();
        const mentions = await client.v2.userMentionTimeline(me.data.id, {
          since_id: sinceId,
          max_results: Math.min(count, 100),
          expansions: ['author_id'],
          'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id'],
          'user.fields': ['username', 'name'],
        });

        return (mentions.data.data || []).map(t => {
          const author = mentions.includes?.users?.find(u => u.id === t.author_id);
          return {
            id: t.id,
            text: t.text,
            authorId: t.author_id || '',
            authorUsername: author?.username,
            authorName: author?.name,
            createdAt: t.created_at || new Date().toISOString(),
            conversationId: t.conversation_id,
            inReplyToUserId: t.in_reply_to_user_id,
          };
        });
      } catch (error) {
        console.error('Failed to get Twitter mentions:', error instanceof Error ? error.message : String(error));
        return [];
      }
    },

    getTweet: async (tweetId: string) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return null;

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const tweet = await client.v2.singleTweet(tweetId, {
          expansions: ['author_id', 'referenced_tweets.id'],
          'tweet.fields': ['created_at', 'public_metrics', 'conversation_id'],
          'user.fields': ['username', 'name'],
        });

        const author = tweet.includes?.users?.find(u => u.id === tweet.data.author_id);
        return {
          id: tweet.data.id,
          text: tweet.data.text,
          authorId: tweet.data.author_id || '',
          authorUsername: author?.username,
          authorName: author?.name,
          createdAt: tweet.data.created_at || new Date().toISOString(),
          conversationId: tweet.data.conversation_id,
          metrics: tweet.data.public_metrics ? {
            replyCount: tweet.data.public_metrics.reply_count,
            retweetCount: tweet.data.public_metrics.retweet_count,
            likeCount: tweet.data.public_metrics.like_count,
            quoteCount: tweet.data.public_metrics.quote_count,
          } : undefined,
          referencedTweets: tweet.data.referenced_tweets?.map(r => ({
            type: r.type as 'replied_to' | 'quoted' | 'retweeted',
            id: r.id,
          })),
        };
      } catch (error) {
        console.error('Failed to get tweet:', error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    reply: async (tweetId: string, text: string, mediaUrls?: string[], galleryIds?: string[]) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return null;

      const resolution = await resolveGalleryIdsToUrls(galleryIds, mediaUrls, avatarId, 'Reply');
      if (resolution.error) {
        return { error: resolution.error };
      }

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const me = await client.v2.me();

        const twitterMediaIds = resolution.resolvedMediaUrls.length > 0
          ? await uploadMediaToTwitter(client, resolution.resolvedMediaUrls, avatarId)
          : undefined;

        const tweetParams: Parameters<typeof client.v2.tweet>[0] = {
          text,
          reply: { in_reply_to_tweet_id: tweetId },
        };
        if (twitterMediaIds && twitterMediaIds.length > 0) {
          tweetParams.media = { media_ids: twitterMediaIds as [string] };
        }

        const result = await client.v2.tweet(tweetParams);
        return {
          tweetId: result.data.id,
          url: `https://x.com/${me.data.username}/status/${result.data.id}`,
        };
      } catch (error) {
        console.error('Failed to reply to tweet:', error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    like: async (tweetId: string) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return false;

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const me = await client.v2.me();
        await client.v2.like(me.data.id, tweetId);
        return true;
      } catch (error) {
        console.error('Failed to like tweet:', error instanceof Error ? error.message : String(error));
        return false;
      }
    },

    unlike: async (tweetId: string) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return false;

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const me = await client.v2.me();
        await client.v2.unlike(me.data.id, tweetId);
        return true;
      } catch (error) {
        console.error('Failed to unlike tweet:', error instanceof Error ? error.message : String(error));
        return false;
      }
    },

    retweet: async (tweetId: string) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return false;

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const me = await client.v2.me();
        await client.v2.retweet(me.data.id, tweetId);
        return true;
      } catch (error) {
        console.error('Failed to retweet:', error instanceof Error ? error.message : String(error));
        return false;
      }
    },

    unretweet: async (tweetId: string) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return false;

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const me = await client.v2.me();
        await client.v2.unretweet(me.data.id, tweetId);
        return true;
      } catch (error) {
        console.error('Failed to unretweet:', error instanceof Error ? error.message : String(error));
        return false;
      }
    },

    quoteTweet: async (tweetId: string, text: string, mediaUrls?: string[], galleryIds?: string[]) => {
      const creds = await twitterOAuth.getAvatarTwitterCredentials(avatarId);
      if (!creds.configured) return null;

      const resolution = await resolveGalleryIdsToUrls(galleryIds, mediaUrls, avatarId, 'Quote');
      if (resolution.error) {
        return { error: resolution.error };
      }

      const { TwitterApi } = await import('twitter-api-v2');
      const client = new TwitterApi({
        appKey: creds.appKey!,
        appSecret: creds.appSecret!,
        accessToken: creds.accessToken!,
        accessSecret: creds.accessSecret!,
      });

      try {
        const me = await client.v2.me();

        const twitterMediaIds = resolution.resolvedMediaUrls.length > 0
          ? await uploadMediaToTwitter(client, resolution.resolvedMediaUrls, avatarId)
          : undefined;

        const tweetParams: Parameters<typeof client.v2.tweet>[0] = {
          text,
          quote_tweet_id: tweetId,
        };
        if (twitterMediaIds && twitterMediaIds.length > 0) {
          tweetParams.media = { media_ids: twitterMediaIds as [string] };
        }

        const result = await client.v2.tweet(tweetParams);
        return {
          tweetId: result.data.id,
          url: `https://x.com/${me.data.username}/status/${result.data.id}`,
        };
      } catch (error) {
        console.error('Failed to quote tweet:', error instanceof Error ? error.message : String(error));
        return null;
      }
    },
  };
}
