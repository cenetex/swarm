/**
 * Avatar health dashboard route.
 *
 * - GET /avatars/health — paginated health summary for all avatars
 */
import type { HttpResponse } from "@swarm/core";
import type { RouteContext } from './types.js';
import { jsonResponse } from './shared.js';
import { getAvatarHealthSummaries } from '../../services/avatar-health.js';

export async function handleHealthRoutes(
  ctx: RouteContext,
): Promise<HttpResponse | null> {
  const { method, path, event, corsHeaders, effectiveIsAdmin } = ctx;

  // ── GET /avatars/health ───────────────────────────────────────────────────
  if (method === 'GET' && path === '/avatars/health') {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const params = event.queryStringParameters || {};
    const limit = params.limit ? Number.parseInt(params.limit, 10) : 20;
    const cursor = params.cursor || undefined;

    const result = await getAvatarHealthSummaries(limit, cursor);

    return jsonResponse(corsHeaders, 200, result);
  }

  return null;
}
