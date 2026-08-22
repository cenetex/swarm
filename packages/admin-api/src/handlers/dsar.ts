/**
 * DSAR (Data Subject Access Request) Handler
 *
 * REST endpoints for privacy data operations:
 *   GET  /dsar/inventory — return data class inventory for the authenticated user
 *   POST /dsar/export    — trigger data export, return JSON
 *   POST /dsar/erase     — trigger erasure (requires { confirm: true } in body)
 *
 * Auth: all endpoints require an authenticated session.
 * Users can only request their own data. The DSAR service operates on accountId
 * (not the legacy userId/walletAddress) to correctly traverse the live schema.
 */
import type {
  HttpRequest,
  HttpResponse,
} from "@swarm/core";
import { logger } from '@swarm/core';
import { getCorsHeaders } from '../http/cors.js';
import { parseJsonBody } from '../http/request-body.js';
import { authenticateRequest } from '../auth/request-auth.js';
import { getOrCreateAccountForWallet } from '../services/accounts.js';
import {
  discoverUserData,
  exportUserData,
  eraseUserData,
} from '../services/dsar.js';

/**
 * Lambda handler for DSAR API
 */
export async function handler(
  event: HttpRequest,
): Promise<HttpResponse> {
  const corsHeaders = getCorsHeaders(event);
  const method = event.requestContext.http.method;
  const rawPath = event.rawPath;
  const normalizedPath = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const path = normalizedPath.replace(/^\/dsar/, '') || '/';

  // Handle preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  logger.setContext({ subsystem: 'dsar', requestId: event.requestContext.requestId });

  try {
    // All DSAR endpoints require authentication
    const session = await authenticateRequest(event);

    // Resolve the accountId — this is what the DSAR service operates on.
    // authenticateRequest may already set accountId; fall back to wallet lookup.
    const accountId = session.accountId || await getOrCreateAccountForWallet(session.userId);

    // GET /dsar/inventory
    if (method === 'GET' && (path === '/inventory' || path === '/inventory/')) {
      logger.info('DSAR inventory requested', { event: 'dsar_inventory', accountId });
      const inventory = await discoverUserData(accountId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(inventory),
      };
    }

    // POST /dsar/export
    if (method === 'POST' && (path === '/export' || path === '/export/')) {
      logger.info('DSAR export requested', { event: 'dsar_export', accountId });
      const exportData = await exportUserData(accountId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(exportData),
      };
    }

    // POST /dsar/erase
    if (method === 'POST' && (path === '/erase' || path === '/erase/')) {
      const body = parseJsonBody<{ confirm?: boolean; dryRun?: boolean }>(event);

      if (!body.confirm) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Erasure requires confirmation',
            message: 'Set { "confirm": true } in request body to proceed with data erasure.',
          }),
        };
      }

      const dryRun = body.dryRun ?? false;
      logger.info('DSAR erasure requested', { event: 'dsar_erase', accountId, dryRun });
      const result = await eraseUserData(accountId, { dryRun });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };
    }

    // Not found
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode || 500;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (statusCode === 401 || statusCode === 403) {
      return {
        statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: errorMessage }),
      };
    }

    logger.error('DSAR handler error', error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', message: errorMessage }),
    };
  }
}
