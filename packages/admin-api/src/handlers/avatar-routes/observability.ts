/**
 * Observability routes: logs, activity, issues, and events.
 *
 * - GET   /avatars/{id}/logs
 * - GET   /avatars/{id}/activity
 * - GET   /avatars/{id}/issues
 * - GET   /avatars/{id}/events
 * - GET   /avatars/{id}/events/counts
 * - PATCH /avatars/{id}/events/{eventId}
 */
import type { HttpResponse } from "@swarm/core";
import type { RouteContext } from './types.js';
import { jsonResponse, parseSinceParam, parseSinceQueryParam, requireOwnerOrAdmin } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import * as avatarService from '../../services/avatars.js';
import * as logsService from '../../services/logs.js';
import * as avatarLogsService from '../../services/avatar-observability.js';
import * as avatarEventsService from '../../services/avatar-observability.js';
import * as observabilityService from '../../services/observability.js';
import { listAvatarIssues } from '../../services/auto-issues.js';

const EVENT_STATUSES = ['open', 'acknowledged', 'resolved', 'wont_fix'] as const;

export async function handleObservabilityRoutes(
  ctx: RouteContext,
): Promise<HttpResponse | null> {
  const { method, path, event, corsHeaders, session, effectiveIsAdmin } = ctx;

  // ── GET /avatars/{id}/logs ───────────────────────────────────────────────
  const logsMatch = path.match(/^\/avatars\/([^/]+)\/logs$/);
  if (method === 'GET' && logsMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const avatarId = logsMatch[1];
    const params = event.queryStringParameters || {};

    const compact = params.compact === 'true';
    const includeLogGroups = compact ? false : params.includeLogGroups !== 'false';

    // Fast path: DynamoDB-backed logs
    if (params.fast === 'true') {
      const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
      const since = params.since ? parseSinceParam(params.since) : undefined;
      const result = await avatarLogsService.listAvatarLogs(avatarId, {
        level: params.level?.toUpperCase() as avatarLogsService.LogLevel | undefined,
        subsystem: params.subsystem || params.component,
        since,
        limit,
        query: params.query,
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          avatarId,
          logs: result.logs,
          hasMore: result.hasMore,
          source: 'dynamodb',
        }),
      };
    }

    const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
    const startTimeRaw = params.start ? Number.parseInt(params.start, 10) : undefined;
    const endTimeRaw = params.end ? Number.parseInt(params.end, 10) : undefined;
    const startTime = Number.isFinite(startTimeRaw) ? startTimeRaw : undefined;
    const endTime = Number.isFinite(endTimeRaw) ? endTimeRaw : undefined;

    const result = await logsService.queryAvatarLogs(avatarId, {
      level: params.level,
      subsystem: params.subsystem || params.component,
      since: params.since,
      limit,
      startTime,
      endTime,
      query: params.query,
    });

    const responseBody = includeLogGroups ? result : { ...result, logGroups: undefined };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...responseBody, source: 'cloudwatch' }),
    };
  }

  // ── GET /avatars/{id}/activity ───────────────────────────────────────────
  const activityMatch = path.match(/^\/avatars\/([^/]+)\/activity$/);
  if (method === 'GET' && activityMatch) {
    const avatarId = activityMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const params = event.queryStringParameters || {};
    const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
    const since = parseSinceQueryParam(params.since);

    const activity = await observabilityService.getAvatarActivity(avatarId, { since, limit });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(activity),
    };
  }

  // ── GET /avatars/{id}/issues — Legacy CloudWatch-backed issues ───────────
  const issuesMatch = path.match(/^\/avatars\/([^/]+)\/issues$/);
  if (method === 'GET' && issuesMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const avatarId = issuesMatch[1];
    const params = event.queryStringParameters || {};
    const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
    const status = params.status as 'open' | 'resolved' | 'all' | undefined;
    const severity = params.severity as 'low' | 'medium' | 'high' | 'critical' | undefined;

    const issues = await listAvatarIssues(avatarId, { limit, status, severity });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarId, issues }),
    };
  }

  // ── GET /avatars/{id}/events/counts ──────────────────────────────────────
  const eventCountsMatch = path.match(/^\/avatars\/([^/]+)\/events\/counts$/);
  if (method === 'GET' && eventCountsMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const avatarId = eventCountsMatch[1];
    const counts = await avatarEventsService.getAvatarEventCounts(avatarId);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarId, ...counts }),
    };
  }

  // ── PATCH /avatars/{id}/events/{eventId} ─────────────────────────────────
  const eventUpdateMatch = path.match(/^\/avatars\/([^/]+)\/events\/([^/]+)$/);
  if (method === 'PATCH' && eventUpdateMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const avatarId = eventUpdateMatch[1];
    const eventId = eventUpdateMatch[2];
    const body = parseJsonBody<{ status?: unknown }>(event);
    const status =
      typeof body.status === 'string' &&
      EVENT_STATUSES.includes(body.status as (typeof EVENT_STATUSES)[number])
        ? (body.status as (typeof EVENT_STATUSES)[number])
        : null;

    if (!status) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Valid status required: open, acknowledged, resolved, wont_fix',
        }),
      };
    }

    await avatarEventsService.updateIssueStatus(avatarId, eventId, status, session?.email);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, eventId, status }),
    };
  }

  // ── GET /avatars/{id}/events ─────────────────────────────────────────────
  const eventsMatch = path.match(/^\/avatars\/([^/]+)\/events$/);
  if (method === 'GET' && eventsMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const avatarId = eventsMatch[1];
    const params = event.queryStringParameters || {};
    const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
    const type = params.type as 'issue' | 'feedback' | undefined;
    const severity = params.severity as avatarEventsService.IssueSeverity | undefined;
    const sentiment = params.sentiment as avatarEventsService.FeedbackSentiment | undefined;
    const status = params.status as avatarEventsService.IssueStatus | undefined;
    const since = params.since ? Number.parseInt(params.since, 10) : undefined;

    const events = await avatarEventsService.listAvatarEvents(avatarId, {
      type,
      limit,
      since,
      severity,
      sentiment,
      status,
    });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarId, events, count: events.length }),
    };
  }

  return null;
}
