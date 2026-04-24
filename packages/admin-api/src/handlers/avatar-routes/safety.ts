/**
 * Safety routes (anomaly detection, circuit breakers).
 *
 * - POST /avatars/{id}/anomaly/reset
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { resetAnomalyState } from '../../services/anomaly-detector.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';

export async function handleSafetyRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, corsHeaders } = ctx;

  // ── POST /avatars/{id}/anomaly/reset ──────────────────────────────────────
  const anomalyResetMatch = path.match(/^\/avatars\/([^/]+)\/anomaly\/reset$/);
  if (method === 'POST' && anomalyResetMatch) {
    const avatarId = anomalyResetMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const channelId = ctx.event?.queryStringParameters?.channelId as string | undefined;

    try {
      await resetAnomalyState(avatarId, channelId);
      logger.info('Anomaly reset requested', {
        event: 'anomaly_reset_requeste',
        avatarId,
        channelId,
      });
      return jsonResponse(corsHeaders, 200, {
        success: true,
        message: channelId
          ? `Anomaly state cleared for avatar in channel ${channelId}`
          : 'Anomaly state cleared for avatar',
        avatarId,
        channelId,
      });
    } catch (error) {
      logger.error('Failed to reset anomaly state', error, {
        avatarId,
        channelId,
      });
      return jsonResponse(corsHeaders, 500, {
        error: 'Failed to reset anomaly state',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}
