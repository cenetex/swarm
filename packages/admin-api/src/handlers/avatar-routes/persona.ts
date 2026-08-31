/**
 * Persona editing and preview routes.
 *
 * - GET  /avatars/{id}/persona — Show current persona
 * - POST /avatars/{id}/persona/preview — Preview new persona with diff and token delta
 * - PATCH /avatars/{id}/persona — Update persona, record audit event
 * - GET /avatars/{id}/persona/history — List persona edit history
 */
import type { HttpResponse } from "@swarm/core";
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import * as avatarService from '../../services/avatars.js';
import * as auditLogService from '../../services/audit-log.js';
import {
  previewPersonaChange,
  updatePersona,
} from '../../services/persona.js';

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

export async function handlePersonaRoutes(
  ctx: RouteContext,
): Promise<HttpResponse | null> {
  const { method, path, event, corsHeaders, session, walletAddress, effectiveIsAdmin } = ctx;

  // ── GET /avatars/{id}/persona — Show current persona ───────────────────────
  const getMatch = path.match(/^\/avatars\/([^/]+)\/persona$/);
  if (method === 'GET' && getMatch) {
    const avatarId = getMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    return jsonResponse(corsHeaders, 200, {
      persona: avatar.persona || '',
      name: avatar.name,
      avatarId: avatar.avatarId,
    });
  }

  // ── POST /avatars/{id}/persona/preview — Preview new persona ────────────────
  const previewMatch = path.match(/^\/avatars\/([^/]+)\/persona\/preview$/);
  if (method === 'POST' && previewMatch) {
    const avatarId = previewMatch[1];
    const body = parseJsonBody<{ persona?: string }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    try {
      return jsonResponse(corsHeaders, 200, previewPersonaChange(avatar, body.persona));
    } catch (error) {
      if (hasErrorName(error, 'PersonaValidationError')) {
        return jsonResponse(corsHeaders, 400, { error: error.message });
      }
      throw error;
    }
  }

  // ── PATCH /avatars/{id}/persona — Update persona ───────────────────────────
  const updateMatch = path.match(/^\/avatars\/([^/]+)\/persona$/);
  if (method === 'PATCH' && updateMatch) {
    const avatarId = updateMatch[1];
    const body = parseJsonBody<{ persona?: string }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const actorId = walletAddress || session?.email || 'unknown';
      const updated = await updatePersona(
        {
          avatarId,
          persona: body.persona,
          session,
          actorId,
          actorType: effectiveIsAdmin ? 'admin' : 'owner',
        },
        {
          getAvatar: avatarService.getAvatar,
          updateAvatar: avatarService.updateAvatar,
          recordAuditEvent: auditLogService.recordAuditEvent,
        },
      );
      return jsonResponse(corsHeaders, 200, updated);
    } catch (error) {
      if (hasErrorName(error, 'PersonaValidationError')) {
        return jsonResponse(corsHeaders, 400, { error: error.message });
      }
      if (hasErrorName(error, 'PersonaLockedError')) {
        return jsonResponse(corsHeaders, 403, { error: error.message });
      }
      if (hasErrorName(error, 'PersonaNotFoundError')) {
        return jsonResponse(corsHeaders, 404, { error: error.message });
      }
      throw error;
    }
  }

  // ── GET /avatars/{id}/persona/history — List persona edit history ──────────
  const historyMatch = path.match(/^\/avatars\/([^/]+)\/persona\/history$/);
  if (method === 'GET' && historyMatch) {
    const avatarId = historyMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    // Query audit events
    const events = await auditLogService.listAuditEvents(avatarId, {
      eventType: 'persona_updated',
      limit: 100,
    });

    // Map to history response (no full personas, just metadata)
    const history = events.map(event => ({
      timestamp: event.timestamp,
      updatedBy: event.actorId,
      oldHash: event.details.oldHash,
      newHash: event.details.newHash,
      lengthBefore: event.details.oldLength,
      lengthAfter: event.details.newLength,
      tokenDelta: event.details.tokenDelta,
    }));

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      personas: history,
      total: history.length,
    });
  }

  return null;
}
