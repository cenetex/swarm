/**
 * Avatar safety routes.
 *
 * - POST /avatars/{id}/anomaly/reset
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as anomalyDetector from '../../../handlers/src/services/anomaly-detector.js';

export async function handleSafetyRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, event, corsHeaders, effectiveIsAdmin } = ctx;

  // ── POST /avatars/{id}/anomaly/reset ─────────────────────────────────────
  const anomalyResetMatch = path.match(/^\/avatars\/([^/]+)\/anomaly\/reset$/);
  if (method === 'POST' && anomalyResetMatch) {
    const avatarId = anomalyResetMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const body = parseJsonBody<{ channelId?: string }>(event);
    const channelId = typeof body?.channelId === 'string' ? body.channelId : undefined;

    try {
      await anomalyDetector.resetAnomalyState(avatarId, channelId);

      logger.info('Anomaly state reset', {
        event: 'anomaly_reset',
        avatarId,
        channelId,
      });

      return jsonResponse(corsHeaders, 200, {
        success: true,
        message: 'Anomaly state cleared',
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
      });
    }
  }

  return null;
}
