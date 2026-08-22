/**
 * Persona editing and preview routes.
 *
 * - GET  /avatars/{id}/persona — Show current persona
 * - POST /avatars/{id}/persona/preview — Preview new persona with diff and token delta
 * - PATCH /avatars/{id}/persona — Update persona, record audit event
 * - GET /avatars/{id}/persona/history — List persona edit history
 */
import type { HttpResponse } from "@swarm/core";
import { createHash } from 'crypto';
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import * as avatarService from '../../services/avatars.js';
import * as auditLogService from '../../services/audit-log.js';
import type { ActorType } from '../../services/audit-log.js';
import { buildDynamicSystemPrompt } from '@swarm/core';
import type { ProcessorAvatarConfig } from '@swarm/core';
import { logger } from '@swarm/core';

function resolveActorType(effectiveIsAdmin: boolean): ActorType {
  return effectiveIsAdmin ? 'admin' : 'owner';
}

function hashPersona(persona: string): string {
  return createHash('sha256').update(persona).digest('hex');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compute diff between old and new persona.
 * Returns arrays of added/removed chunks (split by newlines).
 */
function computePersonaDiff(oldPersona: string, newPersona: string): { added: string[]; removed: string[] } {
  const oldLines = oldPersona.trim().split('\n').filter(l => l.trim().length > 0);
  const newLines = newPersona.trim().split('\n').filter(l => l.trim().length > 0);

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const added = newLines.filter(line => !oldSet.has(line));
  const removed = oldLines.filter(line => !newSet.has(line));

  return { added, removed };
}

/**
 * Build system prompt for persona preview (reusing existing logic but with overridden persona).
 */
function buildPersonaPreview(avatar: { avatarId: string; name: string; description?: string }, newPersona: string): string {
  const config: ProcessorAvatarConfig = {
    avatarId: avatar.avatarId,
    name: avatar.name,
    description: avatar.description,
    persona: newPersona,
    enabledCategories: [],
  };
  return buildDynamicSystemPrompt(config, 'admin-ui');
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

    if (typeof body.persona !== 'string') {
      return jsonResponse(corsHeaders, 400, { error: 'persona must be a non-empty string' });
    }

    const newPersona = body.persona.trim();
    if (newPersona.length === 0) {
      return jsonResponse(corsHeaders, 400, { error: 'persona cannot be empty' });
    }

    const oldPersona = avatar.persona || '';

    // Build new system prompt
    const newSystemPrompt = buildPersonaPreview(avatar, newPersona);

    // Compute diff
    const diff = computePersonaDiff(oldPersona, newPersona);

    // Compute token delta
    const oldTokens = estimateTokens(oldPersona);
    const newTokens = estimateTokens(newPersona);
    const tokenDelta = newTokens - oldTokens;

    return jsonResponse(corsHeaders, 200, {
      systemPrompt: newSystemPrompt,
      diff,
      tokenDelta,
      preview: {
        oldLength: oldPersona.length,
        newLength: newPersona.length,
        oldTokens,
        newTokens,
      },
    });
  }

  // ── PATCH /avatars/{id}/persona — Update persona ───────────────────────────
  const updateMatch = path.match(/^\/avatars\/([^/]+)\/persona$/);
  if (method === 'PATCH' && updateMatch) {
    const avatarId = updateMatch[1];
    const body = parseJsonBody<{ persona?: string }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    // Check ascended status (persona is locked)
    if (avatar.isAscended) {
      return jsonResponse(corsHeaders, 403, {
        error: 'Cannot update persona of ascended avatar - it is permanently locked',
      });
    }

    if (typeof body.persona !== 'string') {
      return jsonResponse(corsHeaders, 400, { error: 'persona must be a non-empty string' });
    }

    const newPersona = body.persona.trim();
    if (newPersona.length === 0) {
      return jsonResponse(corsHeaders, 400, { error: 'persona cannot be empty' });
    }

    const oldPersona = avatar.persona || '';
    const oldHash = hashPersona(oldPersona);
    const newHash = hashPersona(newPersona);

    // Compute token delta for audit log
    const oldTokens = estimateTokens(oldPersona);
    const newTokens = estimateTokens(newPersona);
    const tokenDelta = newTokens - oldTokens;

    // Update avatar
    const updated = await avatarService.updateAvatar(
      avatarId,
      { persona: newPersona },
      session,
    );

    // Record audit event
    try {
      const actorId = walletAddress || session?.email || 'unknown';
      await auditLogService.recordAuditEvent({
        avatarId,
        eventType: 'persona_updated',
        actorId,
        actorType: resolveActorType(effectiveIsAdmin),
        details: {
          oldHash,
          newHash,
          oldLength: oldPersona.length,
          newLength: newPersona.length,
          oldTokens,
          newTokens,
          tokenDelta,
        },
      });
    } catch (err) {
      logger.warn('Failed to record persona_updated audit event', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      avatarId: updated.avatarId,
      name: updated.name,
      persona: updated.persona,
      updatedAt: updated.updatedAt,
      updatedBy: updated.updatedBy,
      tokenDelta,
    });
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
