/**
 * Issues API Handler
 *
 * REST endpoints for the auto-issues tracking system.
 * Allows external services (like browser tests, CI) to report errors
 * that get fingerprinted and deduplicated.
 *
 * Endpoints:
 *   POST /issues - Record a new error/issue occurrence
 *   GET /issues - List all issues (optionally filtered)
 *   GET /issues/{id} - Get issue details with occurrences
 *   PATCH /issues/{id} - Update issue status
 */
import type {
  HttpRequest,
  HttpResponse,
} from "@swarm/core";
import { hasValidInternalTestKey, logger } from '@swarm/core';
import { z } from 'zod';
import * as autoIssues from '../services/auto-issues.js';
import { getCorsHeaders } from '../http/cors.js';
import { parseJsonBody } from '../http/request-body.js';
import { isRequestValidationError, validateRequestBody } from '../middleware/validate.js';
import { authenticateRequest, requireAdmin } from '../auth/request-auth.js';

// Internal test key for CI/CD access (set in Lambda env)
function getInternalTestKey(): string | undefined {
  return process.env.INTERNAL_TEST_KEY;
}

const IssueCreateSchema = z.object({
  error: z.string().min(1),
  stack: z.string().optional(),
  subsystem: z.string().min(1),
  category: z.string().optional(),
  avatarId: z.string().optional(),
  requestId: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const ISSUE_STATUSES = ['open', 'acknowledged', 'investigating', 'resolved', 'wontfix'] as const;

/**
 * Validate internal test key for CI/CD requests
 */
function validateTestKey(event: HttpRequest): boolean {
  return hasValidInternalTestKey({
    headers: event.headers,
    internalTestKey: getInternalTestKey(),
    environment: process.env.ENVIRONMENT,
    nodeEnv: process.env.NODE_ENV,
  });
}

async function isAuthorized(event: HttpRequest): Promise<boolean> {
  if (validateTestKey(event)) {
    return true;
  }

  try {
    const session = await authenticateRequest(event);
    return requireAdmin(session);
  } catch {
    return false;
  }
}

/**
 * Lambda handler for issues API
 */
export async function handler(
  event: HttpRequest
): Promise<HttpResponse> {
  const corsHeaders = getCorsHeaders(event);
  const method = event.requestContext.http.method;
  const rawPath = event.rawPath;
  const normalizedPath = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const path = normalizedPath.replace(/^\/issues/, '') || '/';

  // Handle preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  // Set logging context
  logger.setContext({ subsystem: 'issues', requestId: event.requestContext.requestId });

  try {
    const authorized = await isAuthorized(event);
    if (!authorized) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // POST /issues - Record a new error
    if (method === 'POST' && path === '/') {
      const { error, stack, subsystem, category, avatarId, requestId, context } =
        await validateRequestBody(IssueCreateSchema)(event);

      const result = await autoIssues.recordError({
        error,
        stack,
        subsystem,
        category,
        avatarId,
        requestId,
        context,
      });

      logger.info('Issue recorded', {
        event: 'issue_recorded',
        issueId: result.issueId,
        isNew: result.isNew,
        occurrenceCount: result.occurrenceCount,
        subsystem,
      });

      return {
        statusCode: result.isNew ? 201 : 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          ...result,
        }),
      };
    }

    // GET /issues - List all issues
    if (method === 'GET' && path === '/') {
      const params = event.queryStringParameters || {};
      const status = params.status as autoIssues.IssueStatus | undefined;
      const severity = params.severity as autoIssues.IssueSeverity | undefined;
      const subsystem = params.subsystem;
      const limit = params.limit ? parseInt(params.limit, 10) : undefined;

      const issues = await autoIssues.listIssues({ status, severity, subsystem, limit });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ issues, count: issues.length }),
      };
    }

    // GET /issues/{id} - Get issue details
    const issueMatch = path.match(/^\/([^/]+)$/);
    if (method === 'GET' && issueMatch) {
      const issueId = issueMatch[1];
      const result = await autoIssues.getIssue(issueId);

      if (!result.issue) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Issue not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };
    }

    // PATCH /issues/{id} - Update issue status
    if (method === 'PATCH' && issueMatch) {
      const issueId = issueMatch[1];
      const body = parseJsonBody<Record<string, unknown>>(event);
      const { status } = body;

      if (typeof status !== 'string' || !ISSUE_STATUSES.includes(status as (typeof ISSUE_STATUSES)[number])) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid status' }),
        };
      }

      await autoIssues.updateIssueStatus(issueId, status as autoIssues.IssueStatus);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, issueId, status }),
      };
    }

    // Not found
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    if (isRequestValidationError(error)) {
      return {
        statusCode: error.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message, details: error.details }),
      };
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Issues handler error', error);

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', message: errorMessage }),
    };
  }
}
