/**
 * API key management and tool-call resume routes.
 *
 * - POST /avatars/{id}/api-keys
 * - POST /api-keys  (wildcard, admin-only)
 * - POST /avatars/{id}/tools/{toolCallId}
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import { parseJsonBody } from '../../http/request-body.js';
import { resumeChatAfterToolResult } from '../chat.js';
import { getKeyUsageRollups } from '../../services/token-accounting.js';

export async function handleApiKeyRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, event, corsHeaders, session, walletAddress, effectiveIsAdmin } = ctx;

  // ── POST /avatars/{id}/tools/{toolCallId} — Resume chat after tool ──────
  const toolsMatch = path.match(/^\/avatars\/([^/]+)\/tools\/([^/]+)$/);
  if (method === 'POST' && toolsMatch) {
    const avatarId = toolsMatch[1];
    const toolCallId = toolsMatch[2];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const body = parseJsonBody<{ result?: unknown }>(event);
    if (!('result' in body)) {
      return jsonResponse(corsHeaders, 400, { error: 'result is required' });
    }

    try {
      const resumed = await resumeChatAfterToolResult({
        avatarId,
        toolCallId,
        result: body.result,
        session,
      });

      return jsonResponse(corsHeaders, 200, {
        response: resumed.response,
        history: resumed.history,
        media: resumed.media,
        pendingJobs: resumed.pendingJobs,
        pendingToolCall: resumed.pendingToolCall,
        avatarUpdates: resumed.avatarUpdates,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to resume tool call';
      return jsonResponse(corsHeaders, 400, { error: msg });
    }
  }

  // ── POST /avatars/{id}/api-keys — Create API key for an avatar ──────────
  const apiKeysMatch = path.match(/^\/avatars\/([^/]+)\/api-keys$/);
  if (method === 'POST' && apiKeysMatch) {
    const avatarId = apiKeysMatch[1];
    const body = parseJsonBody<{ name?: string }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const { createApiKey } = await import('../openai-compat.js');
      const result = await createApiKey({
        avatarId,
        name: body.name || 'API Key',
        createdBy: session.email || walletAddress || 'unknown',
      });

      logger.info('API key created', {
        event: 'api_key_created',
        avatarId,
        keyPrefix: result.keyPrefix,
      });

      return jsonResponse(corsHeaders, 201, {
        apiKey: result.fullKey,
        keyPrefix: result.keyPrefix,
        message: 'API key created. Save this key - it will not be shown again.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create API key';
      logger.error('Failed to create API key', {
        event: 'api_key_create_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: msg });
    }
  }

  // ── GET /api-keys/{keyHash}/usage/tokens — Token usage for an API key (admin-only)
  const keyUsageMatch = path.match(/^\/api-keys\/([^/]+)\/usage\/tokens$/);
  if (method === 'GET' && keyUsageMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, {
        error: 'Admin access required for API key usage queries',
      });
    }

    const keyHash = keyUsageMatch[1];
    const params = event.queryStringParameters || {};
    const days = Math.min(Math.max(parseInt(params.days || '7', 10) || 7, 1), 90);

    const rollups = await getKeyUsageRollups(keyHash, days);

    const totals = rollups.reduce(
      (acc, r) => ({
        requestCount: acc.requestCount + r.requestCount,
        totalPromptTokens: acc.totalPromptTokens + r.totalPromptTokens,
        totalCompletionTokens: acc.totalCompletionTokens + r.totalCompletionTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        totalCostMicroUsd: acc.totalCostMicroUsd + r.totalCostMicroUsd,
        providerReportedCount: acc.providerReportedCount + r.providerReportedCount,
        estimatedCount: acc.estimatedCount + r.estimatedCount,
      }),
      {
        requestCount: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCostMicroUsd: 0,
        providerReportedCount: 0,
        estimatedCount: 0,
      },
    );

    return jsonResponse(corsHeaders, 200, {
      keyHash,
      days,
      totals,
      daily: rollups,
    });
  }

  // ── POST /api-keys — Create wildcard API key (admin-only) ───────────────
  if (method === 'POST' && path === '/api-keys') {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, {
        error: 'Admin access required for wildcard API keys',
      });
    }

    const body = parseJsonBody<{ name?: string }>(event);

    try {
      const { createApiKey } = await import('../openai-compat.js');
      const result = await createApiKey({
        name: body.name || 'Wildcard API Key',
        createdBy: session.email || walletAddress || 'unknown',
      });

      logger.info('Wildcard API key created', {
        event: 'api_key_created_wildcard',
        keyPrefix: result.keyPrefix,
      });

      return jsonResponse(corsHeaders, 201, {
        apiKey: result.fullKey,
        keyPrefix: result.keyPrefix,
        message:
          'Wildcard API key created. This key can access all avatars. Save it - it will not be shown again.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create API key';
      logger.error('Failed to create wildcard API key', {
        event: 'api_key_create_failed',
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: msg });
    }
  }

  return null;
}
