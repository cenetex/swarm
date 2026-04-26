/**
 * Tool preferences and operating-principles override routes.
 *
 * - GET  /avatars/{id}/tools — List all tools with current state
 * - PATCH /avatars/{id}/tools — Update tool preferences (disable/enable)
 * - PUT /avatars/{id}/operating-principles-override — Set operating principles override
 * - DELETE /avatars/{id}/operating-principles-override — Remove operating principles override
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import type { UserSession } from '../../types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import * as avatarService from '../../services/avatars.js';
import * as auditLogService from '../../services/audit-log.js';
import type { ActorType } from '../../services/audit-log.js';
import { logger } from '@swarm/core';
import {
  ToolRegistry,
  registerAllTools,
  type ToolContext,
} from '@swarm/mcp-server';
import { createMCPServices } from '../../services/mcp-adapter.js';

// Core tools that cannot be disabled
const CORE_TOOLS = new Set(['request_secret', 'configure_integration', 'report_issue']);

type SystemPromptOverrideShape =
  | { kind: 'inline'; text: string }
  | { kind: 'url'; url: string; cacheTtlSec?: number };

interface ToolMeta {
  name: string;
  description: string;
  category?: string;
  enabled: boolean;
  source: 'platform' | 'preference' | 'core';
  isCore: boolean;
}

function resolveActorType(effectiveIsAdmin: boolean): ActorType {
  return effectiveIsAdmin ? 'admin' : 'owner';
}

/**
 * Get all available tools from the registry.
 */
async function getAvailableTools(
  avatarId: string,
  session: UserSession
): Promise<Array<{ name: string; description: string }>> {
  try {
    const mcpServices = createMCPServices(avatarId, session, undefined, {
      readOnly: true,
    });
    const toolRegistry = new ToolRegistry();
    registerAllTools(toolRegistry, mcpServices);

    const toolContext: ToolContext = {
      avatarId,
      platform: 'admin-ui',
      session: {
        email: session.email || '',
        isAdmin: session.isAdmin || false,
      },
    };

    const allTools = toolRegistry.getForPlatform(toolContext.platform);
    return allTools.map(tool => ({
      name: tool.name,
      description: tool.description,
    }));
  } catch (e) {
    logger.warn('Failed to get available tools', {
      avatarId,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * Determine tool state based on platform config and preferences.
 */
function determineToolState(
  toolName: string,
  platformEnabledTools: Set<string>,
  preferences?: { disabled?: string[]; enabled?: string[] }
): { enabled: boolean; source: 'platform' | 'preference' | 'core' } {
  // Core tools are always enabled
  if (CORE_TOOLS.has(toolName)) {
    return { enabled: true, source: 'core' };
  }

  // Check if explicitly disabled in preferences
  if (preferences?.disabled?.includes(toolName)) {
    return { enabled: false, source: 'preference' };
  }

  // Check if explicitly enabled in preferences
  if (preferences?.enabled?.includes(toolName)) {
    return { enabled: true, source: 'preference' };
  }

  // Check if enabled from platform
  if (platformEnabledTools.has(toolName)) {
    return { enabled: true, source: 'platform' };
  }

  return { enabled: false, source: 'platform' };
}

/**
 * Get platform-enabled tools based on configuration.
 */
function getPlatformEnabledTools(avatar: {
  platforms?: {
    twitter?: { enabled?: boolean };
    telegram?: { enabled?: boolean };
    discord?: { enabled?: boolean };
  };
}): Set<string> {
  const platformTools = new Set<string>();

  if (avatar.platforms?.twitter?.enabled) {
    [
      'twitter_status',
      'twitter_get_tweet',
      'twitter_get_mentions',
      'twitter_get_timeline',
      'twitter_reply',
      'twitter_post',
      'twitter_like',
      'twitter_unlike',
      'twitter_retweet',
      'twitter_unretweet',
      'twitter_quote',
      'twitter_get_activity_summary',
    ].forEach(t => platformTools.add(t));
  }

  if (avatar.platforms?.telegram?.enabled) {
    [
      'get_my_gallery',
      'search_gallery',
      'send_gallery_image',
      'generate_image',
      'generate_video',
      'get_job_status',
      'list_jobs',
    ].forEach(t => platformTools.add(t));
  }

  // Add core tools always
  CORE_TOOLS.forEach(t => platformTools.add(t));

  return platformTools;
}

export async function handleToolsRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, event, corsHeaders, session, walletAddress, effectiveIsAdmin } = ctx;

  // ── GET /avatars/{id}/tools — List tools with state ────────────────────
  const getMatch = path.match(/^\/avatars\/([^/]+)\/tools$/);
  if (method === 'GET' && getMatch) {
    const avatarId = getMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    // Get all available tools from registry
    const availableTools = await getAvailableTools(avatarId, session);
    const platformEnabled = getPlatformEnabledTools(avatar);

    // Build tool state for each available tool
    const toolStates: ToolMeta[] = availableTools.map(tool => {
      const state = determineToolState(tool.name, platformEnabled, avatar.toolPreferences);
      return {
        name: tool.name,
        description: tool.description,
        enabled: state.enabled,
        source: state.source,
        isCore: CORE_TOOLS.has(tool.name),
      };
    });

    return jsonResponse(corsHeaders, 200, {
      available: toolStates,
      state: toolStates.map(t => ({
        name: t.name,
        enabled: t.enabled,
        source: t.source,
      })),
    });
  }

  // ── PATCH /avatars/{id}/tools — Update tool preferences ──────────────────
  const patchMatch = path.match(/^\/avatars\/([^/]+)\/tools$/);
  if (method === 'PATCH' && patchMatch) {
    const avatarId = patchMatch[1];
    const body = parseJsonBody<{ disable?: string[]; enable?: string[] }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    const disable = body.disable || [];
    const enable = body.enable || [];

    // Validate: cannot disable core tools
    const invalidDisable = disable.filter(t => CORE_TOOLS.has(t));
    if (invalidDisable.length > 0) {
      return jsonResponse(corsHeaders, 400, {
        error: 'Cannot disable core tools',
        coreTools: Array.from(invalidDisable),
      });
    }

    // Update preferences — if both lists are empty, pass undefined to clear
    const oldPrefs = avatar.toolPreferences;
    const toolPreferences = (disable.length > 0 || enable.length > 0)
      ? {
          disabled: disable.length > 0 ? disable : undefined,
          enabled: enable.length > 0 ? enable : undefined,
        }
      : undefined;

    const updated = await avatarService.updateAvatar(avatarId, { toolPreferences }, session);

    // Audit
    try {
      const actorId = walletAddress || session?.email || 'unknown';
      await auditLogService.recordAuditEvent({
        avatarId,
        eventType: 'tools_updated',
        actorId,
        actorType: resolveActorType(effectiveIsAdmin),
        details: {
          oldPreferences: oldPrefs,
          newPreferences: toolPreferences,
          disabledTools: disable,
          enabledTools: enable,
        },
      });
    } catch (err) {
      logger.warn('Failed to record tools_updated audit event', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      avatarId: updated.avatarId,
      toolPreferences: updated.toolPreferences,
    });
  }

  // ── PUT /avatars/{id}/operating-principles-override ────────────────────────
  const putMatch = path.match(/^\/avatars\/([^/]+)\/operating-principles-override$/);
  if (method === 'PUT' && putMatch) {
    const avatarId = putMatch[1];
    const body = parseJsonBody<{
      kind?: string;
      text?: string;
      url?: string;
      cacheTtlSec?: number;
    }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    // Validate input
    if (!body.kind || !['inline', 'url'].includes(body.kind)) {
      return jsonResponse(corsHeaders, 400, {
        error: 'kind must be "inline" or "url"',
      });
    }

    if (body.kind === 'inline' && typeof body.text !== 'string') {
      return jsonResponse(corsHeaders, 400, {
        error: 'text is required when kind is "inline"',
      });
    }

    if (body.kind === 'url' && typeof body.url !== 'string') {
      return jsonResponse(corsHeaders, 400, {
        error: 'url is required when kind is "url"',
      });
    }

    // Build override object
    const override: SystemPromptOverrideShape =
      body.kind === 'inline'
        ? { kind: 'inline', text: body.text! }
        : {
            kind: 'url',
            url: body.url!,
            ...(body.cacheTtlSec && { cacheTtlSec: body.cacheTtlSec }),
          };

    const oldOverride = avatar.operatingPrinciplesOverride;
    const updated = await avatarService.updateAvatar(
      avatarId,
      { operatingPrinciplesOverride: override },
      session
    );

    // Audit
    try {
      const actorId = walletAddress || session?.email || 'unknown';
      await auditLogService.recordAuditEvent({
        avatarId,
        eventType: 'operating_principles_override_updated',
        actorId,
        actorType: resolveActorType(effectiveIsAdmin),
        details: {
          previousOverride: oldOverride,
          newOverride: override,
        },
      });
    } catch (err) {
      logger.warn('Failed to record operating_principles_override_updated audit event', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      avatarId: updated.avatarId,
      operatingPrinciplesOverride: updated.operatingPrinciplesOverride,
    });
  }

  // ── DELETE /avatars/{id}/operating-principles-override ──────────────────────
  const deleteMatch = path.match(/^\/avatars\/([^/]+)\/operating-principles-override$/);
  if (method === 'DELETE' && deleteMatch) {
    const avatarId = deleteMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    if (!avatar.operatingPrinciplesOverride) {
      return jsonResponse(corsHeaders, 404, {
        error: 'No operating principles override set',
      });
    }

    const oldOverride = avatar.operatingPrinciplesOverride;
    await avatarService.updateAvatar(
      avatarId,
      { operatingPrinciplesOverride: undefined },
      session
    );

    // Audit
    try {
      const actorId = walletAddress || session?.email || 'unknown';
      await auditLogService.recordAuditEvent({
        avatarId,
        eventType: 'operating_principles_override_deleted',
        actorId,
        actorType: resolveActorType(effectiveIsAdmin),
        details: {
          deletedOverride: oldOverride,
        },
      });
    } catch (err) {
      logger.warn('Failed to record operating_principles_override_deleted audit event', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 204, {});
  }

  return null;
}
