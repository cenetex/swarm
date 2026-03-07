/**
 * Memory management routes for avatars.
 *
 * - DELETE /avatars/{id}/memories          - Delete all memories for an avatar
 * - DELETE /avatars/{id}/memories/{memId}  - Delete a specific memory
 * - GET    /avatars/{id}/memories/export   - Export all memories as JSON
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as memoryService from '../../services/memory.js';
import { isMemoryEnabled } from '../../services/billing/entitlements.js';

export async function handleMemoryRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, corsHeaders } = ctx;

  // ── GET /avatars/{id}/memories/export ──────────────────────────────────
  const exportMatch = path.match(/^\/avatars\/([^/]+)\/memories\/export$/);
  if (method === 'GET' && exportMatch) {
    const avatarId = exportMatch[1];

    const authError = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (authError) return authError;

    const memoryEnabled = await isMemoryEnabled(avatarId);
    if (!memoryEnabled) {
      return jsonResponse(corsHeaders, 403, {
        error: 'Memory is not enabled for this avatar. Upgrade to a paid plan to use memory features.',
      });
    }

    try {
      const [immediate, recent, core, ephemeral, durable, archival] = await Promise.all([
        memoryService.getMemories(avatarId, { tier: 'immediate', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'recent', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'core', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'ephemeral', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'durable', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'archival', limit: 500 }),
      ]);

      const counts = {
        immediate: immediate.length,
        recent: recent.length,
        core: core.length,
        ephemeral: ephemeral.length,
        durable: durable.length,
        archival: archival.length,
        total: immediate.length + recent.length + core.length + ephemeral.length + durable.length + archival.length,
      };

      // Strip internal DynamoDB keys (pk, sk) and embeddings from export
      const sanitize = (memories: typeof immediate) =>
        memories.map(({ pk: _pk, sk: _sk, embedding: _embedding, embeddingModel: _embeddingModel, embeddingVersion: _embeddingVersion, ...rest }) => rest);

      const exportData = {
        avatarId,
        exportedAt: new Date().toISOString(),
        counts,
        memories: {
          immediate: sanitize(immediate),
          recent: sanitize(recent),
          core: sanitize(core),
          ephemeral: sanitize(ephemeral),
          durable: sanitize(durable),
          archival: sanitize(archival),
        },
      };

      logger.info('Memory export completed', {
        event: 'memory_export',
        avatarId,
        totalMemories: counts.total,
      });

      return jsonResponse(corsHeaders, 200, exportData);
    } catch (error) {
      logger.error('Memory export failed', {
        event: 'memory_export_error',
        avatarId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to export memories' });
    }
  }

  // ── DELETE /avatars/{id}/memories/{memoryId} ───────────────────────────
  const singleDeleteMatch = path.match(/^\/avatars\/([^/]+)\/memories\/([^/]+)$/);
  if (method === 'DELETE' && singleDeleteMatch) {
    const avatarId = singleDeleteMatch[1];
    const memoryId = singleDeleteMatch[2];

    // Avoid matching the "export" path as a memoryId
    if (memoryId === 'export') return null;

    const authError = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (authError) return authError;

    const memoryEnabled = await isMemoryEnabled(avatarId);
    if (!memoryEnabled) {
      return jsonResponse(corsHeaders, 403, {
        error: 'Memory is not enabled for this avatar. Upgrade to a paid plan to use memory features.',
      });
    }

    try {
      // Find the memory first (need the sk for deletion)
      const memory = await memoryService.getMemory(avatarId, memoryId);
      if (!memory) {
        return jsonResponse(corsHeaders, 404, { error: 'Memory not found' });
      }

      await memoryService.deleteMemory(avatarId, memory.sk);

      logger.info('Memory deleted', {
        event: 'memory_single_delete',
        avatarId,
        memoryId,
        tier: memory.tier,
      });

      return jsonResponse(corsHeaders, 200, {
        success: true,
        avatarId,
        memoryId,
        deleted: true,
      });
    } catch (error) {
      logger.error('Memory deletion failed', {
        event: 'memory_single_delete_error',
        avatarId,
        memoryId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to delete memory' });
    }
  }

  // ── DELETE /avatars/{id}/memories ──────────────────────────────────────
  const bulkDeleteMatch = path.match(/^\/avatars\/([^/]+)\/memories$/);
  if (method === 'DELETE' && bulkDeleteMatch) {
    const avatarId = bulkDeleteMatch[1];

    const authError = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (authError) return authError;

    const memoryEnabled = await isMemoryEnabled(avatarId);
    if (!memoryEnabled) {
      return jsonResponse(corsHeaders, 403, {
        error: 'Memory is not enabled for this avatar. Upgrade to a paid plan to use memory features.',
      });
    }

    try {
      // Fetch all memories across tiers (legacy + durable)
      const [immediate, recent, core, ephemeral, durable, archival] = await Promise.all([
        memoryService.getMemories(avatarId, { tier: 'immediate', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'recent', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'core', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'ephemeral', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'durable', limit: 500 }),
        memoryService.getMemories(avatarId, { tier: 'archival', limit: 500 }),
      ]);

      const allSks = [
        ...immediate.map(m => m.sk),
        ...recent.map(m => m.sk),
        ...core.map(m => m.sk),
        ...ephemeral.map(m => m.sk),
        ...durable.map(m => m.sk),
        ...archival.map(m => m.sk),
      ];

      if (allSks.length === 0) {
        return jsonResponse(corsHeaders, 200, {
          success: true,
          avatarId,
          deletedCount: 0,
        });
      }

      await memoryService.deleteMemories(avatarId, allSks);

      logger.info('All memories deleted', {
        event: 'memory_bulk_delete',
        avatarId,
        deletedCount: allSks.length,
      });

      return jsonResponse(corsHeaders, 200, {
        success: true,
        avatarId,
        deletedCount: allSks.length,
      });
    } catch (error) {
      logger.error('Bulk memory deletion failed', {
        event: 'memory_bulk_delete_error',
        avatarId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to delete memories' });
    }
  }

  return null;
}
