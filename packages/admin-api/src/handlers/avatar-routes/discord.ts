/**
 * Discord integration routes.
 *
 * - GET  /avatars/{id}/discord/status
 */
import type { HttpResponse } from "@swarm/core";
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as discordService from '../../services/discord.js';

export async function handleDiscordRoutes(
  ctx: RouteContext,
): Promise<HttpResponse | null> {
  const { method, path, corsHeaders } = ctx;

  // ── GET /avatars/{id}/discord/status ───────────────────────────────────
  const statusMatch = path.match(/^\/avatars\/([^/]+)\/discord\/status$/);
  if (method === 'GET' && statusMatch) {
    const avatarId = statusMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      // Fetch avatar to get Discord mode config
      const avatar = await avatarService.getAvatar(avatarId);
      const discordMode = avatar?.platforms?.discord?.mode as
        | 'webhook'
        | 'bot'
        | 'hybrid'
        | undefined;

      const status = await discordService.getConnectionStatus(avatarId, discordMode);
      return jsonResponse(corsHeaders, 200, status);
    } catch (err) {
      logger.error('Discord status check failed', {
        event: 'discord_status_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Discord status check failed' });
    }
  }

  return null;
}
