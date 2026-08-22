/**
 * Twitter feed and moderation routes.
 *
 * - GET    /avatars/{id}/twitter/feed
 * - POST   /avatars/{id}/twitter/posts/{postId}/approve
 * - POST   /avatars/{id}/twitter/posts/{postId}/reject
 * - DELETE  /avatars/{id}/twitter/posts/{postId}
 * - PUT    /avatars/{id}/twitter/moderation
 */
import type { HttpResponse } from "@swarm/core";
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as twitterFeedService from '../../services/twitter-feed.js';

export async function handleTwitterRoutes(
  ctx: RouteContext,
): Promise<HttpResponse | null> {
  const { method, path, event, corsHeaders, session, walletAddress } = ctx;

  // ── GET /avatars/{id}/twitter/feed ───────────────────────────────────────
  const twitterFeedMatch = path.match(/^\/avatars\/([^/]+)\/twitter\/feed$/);
  if (method === 'GET' && twitterFeedMatch) {
    const avatarId = twitterFeedMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const feed = await twitterFeedService.getTwitterFeed(avatarId);
      return jsonResponse(corsHeaders, 200, feed);
    } catch (err) {
      logger.error('Failed to get Twitter feed', {
        event: 'twitter_feed_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to get Twitter feed' });
    }
  }

  // ── POST /avatars/{id}/twitter/posts/{postId}/approve ────────────────────
  const twitterApproveMatch = path.match(
    /^\/avatars\/([^/]+)\/twitter\/posts\/([^/]+)\/approve$/,
  );
  if (method === 'POST' && twitterApproveMatch) {
    const avatarId = twitterApproveMatch[1];
    const postId = twitterApproveMatch[2];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const reviewerId = walletAddress || session?.email || 'unknown';

    try {
      const post = await twitterFeedService.approvePost(avatarId, postId, reviewerId);
      if (!post) {
        return jsonResponse(corsHeaders, 404, { error: 'Post not found' });
      }
      return jsonResponse(corsHeaders, 200, post);
    } catch (err) {
      logger.error('Failed to approve post', {
        event: 'twitter_approve_failed',
        avatarId,
        postId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to approve post' });
    }
  }

  // ── POST /avatars/{id}/twitter/posts/{postId}/reject ─────────────────────
  const twitterRejectMatch = path.match(
    /^\/avatars\/([^/]+)\/twitter\/posts\/([^/]+)\/reject$/,
  );
  if (method === 'POST' && twitterRejectMatch) {
    const avatarId = twitterRejectMatch[1];
    const postId = twitterRejectMatch[2];
    const body = parseJsonBody<{ reason?: string }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const reviewerId = walletAddress || session?.email || 'unknown';
    const reason = body.reason || 'Rejected by reviewer';

    try {
      const post = await twitterFeedService.rejectPost(
        avatarId,
        postId,
        reviewerId,
        reason,
      );
      if (!post) {
        return jsonResponse(corsHeaders, 404, { error: 'Post not found' });
      }
      return jsonResponse(corsHeaders, 200, post);
    } catch (err) {
      logger.error('Failed to reject post', {
        event: 'twitter_reject_failed',
        avatarId,
        postId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to reject post' });
    }
  }

  // ── DELETE /avatars/{id}/twitter/posts/{postId} ──────────────────────────
  const twitterDeleteMatch = path.match(
    /^\/avatars\/([^/]+)\/twitter\/posts\/([^/]+)$/,
  );
  if (method === 'DELETE' && twitterDeleteMatch) {
    const avatarId = twitterDeleteMatch[1];
    const postId = twitterDeleteMatch[2];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const reviewerId = walletAddress || session?.email || 'unknown';

    try {
      const post = await twitterFeedService.cancelPost(avatarId, postId, reviewerId);
      if (!post) {
        return jsonResponse(corsHeaders, 404, { error: 'Post not found' });
      }
      return jsonResponse(corsHeaders, 204, null);
    } catch (err) {
      logger.error('Failed to cancel post', {
        event: 'twitter_cancel_failed',
        avatarId,
        postId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to cancel post' });
    }
  }

  // ── PUT /avatars/{id}/twitter/moderation ─────────────────────────────────
  const twitterModerationMatch = path.match(
    /^\/avatars\/([^/]+)\/twitter\/moderation$/,
  );
  if (method === 'PUT' && twitterModerationMatch) {
    const avatarId = twitterModerationMatch[1];
    const body = parseJsonBody<{
      mode?: 'pre' | 'post' | 'none';
    }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    if (!body.mode || !['pre', 'post', 'none'].includes(body.mode)) {
      return jsonResponse(corsHeaders, 400, {
        error: 'Valid mode required: pre, post, or none',
      });
    }

    try {
      const config = await twitterFeedService.setModerationMode(avatarId, body.mode);
      return jsonResponse(corsHeaders, 200, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update moderation mode';
      logger.error('Failed to update moderation mode', {
        event: 'twitter_moderation_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 400, { error: msg });
    }
  }

  return null;
}
