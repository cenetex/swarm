/**
 * Avatar Management API Handler — Thin Router
 *
 * Authenticates the request, builds a RouteContext, and dispatches to
 * domain-specific route handlers under ./avatar-routes/.
 *
 * The heavy lifting (route matching, business logic) lives in the domain
 * modules so each can be tested in isolation with minimal mocks.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/request-auth.js';
import { logger } from '@swarm/core';
import { recordError } from '../services/auto-issues.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getSessionFromCookie } from '../auth/session-cookie.js';
import { getCorsHeaders } from '../http/cors.js';
import { isAuthError } from '../auth/errors.js';
import { isRequestValidationError } from '../middleware/validate.js';
import { isAdminWallet, jsonResponse } from './avatar-routes/shared.js';
import type { RouteContext, RouteHandler } from './avatar-routes/types.js';

// Domain route handlers
import { handleSystemRoutes } from './avatar-routes/system.js';
import { handleCrudRoutes } from './avatar-routes/crud.js';
import { handleEntitlementRoutes } from './avatar-routes/entitlements.js';
import { handleTelegramRoutes } from './avatar-routes/telegram.js';
import { handleDiscordRoutes } from './avatar-routes/discord.js';
import { handleSecretsRoutes } from './avatar-routes/secrets.js';
import { handleEnergyRoutes } from './avatar-routes/energy.js';
import { handleObservabilityRoutes } from './avatar-routes/observability.js';
import { handleTwitterRoutes } from './avatar-routes/twitter.js';
import { handleApiKeyRoutes } from './avatar-routes/api-keys.js';
import { handleMemoryRoutes } from './avatar-routes/memory.js';
import { handleUsageRoutes } from './avatar-routes/usage.js';
import { handleOnboardingAvatarRoutes } from './avatar-routes/onboarding.js';
import { handleDesignPartnerRoutes } from './avatar-routes/design-partner.js';

// ── Helpers ────────────────────────────────────────────────────────────────

async function getWalletSessionFromEvent(event: APIGatewayProxyEventV2) {
  const sessionToken = getSessionFromCookie(event);
  if (!sessionToken) return null;
  return getSessionWithUser(sessionToken);
}

// ── Route dispatch order ───────────────────────────────────────────────────

const routeHandlers: RouteHandler[] = [
  handleSystemRoutes,
  handleCrudRoutes,
  handleEntitlementRoutes,
  handleDesignPartnerRoutes,
  handleTelegramRoutes,
  handleDiscordRoutes,
  handleOnboardingAvatarRoutes,
  handleSecretsRoutes,
  handleEnergyRoutes,
  handleObservabilityRoutes,
  handleTwitterRoutes,
  handleApiKeyRoutes,
  handleMemoryRoutes,
  handleUsageRoutes,
];

// ── Lambda handler ─────────────────────────────────────────────────────────

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate
    const session = await authenticateRequest(event);
    const isAdmin = requireAdmin(session);
    const walletSession = await getWalletSessionFromEvent(event);
    const walletAddress = walletSession?.walletAddress ?? null;
    const effectiveIsAdmin =
      isAdmin || (walletAddress ? isAdminWallet(walletAddress) : false);

    const method = event.requestContext.http.method;
    const rawPath = event.rawPath;
    // CloudFront (and some gateway setups) route the admin API under `/api/*`
    // but our Lambda handlers historically matched on `/...` paths. Normalize.
    const path =
      rawPath === '/api'
        ? '/'
        : rawPath.startsWith('/api/')
          ? rawPath.slice('/api'.length)
          : rawPath;

    // Build context shared by all domain handlers
    const ctx: RouteContext = {
      event,
      method,
      path,
      corsHeaders,
      session,
      walletAddress,
      accountId: walletSession?.accountId,
      effectiveIsAdmin,
    };

    // Try each domain handler in order
    for (const handle of routeHandlers) {
      const result = await handle(ctx);
      if (result) return result;
    }

    // No route matched
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

    if (isAuthError(error)) {
      return {
        statusCode: error.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message, details: error.details }),
      };
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    if (
      errorMessage === 'No authentication token provided' ||
      errorMessage === 'Session expired'
    ) {
      return jsonResponse(corsHeaders, 401, { error: errorMessage });
    }

    logger.setContext({ subsystem: 'avatars' });
    logger.error('Avatar handler error', error);

    // Record error in auto-issues system
    recordError({
      error: errorMessage,
      stack: errorStack,
      subsystem: 'avatars',
      category: 'handler_error',
      requestId: event.requestContext.requestId,
    }).catch(() => {
      // Ignore recording failures
    });

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: errorMessage,
      }),
    };
  }
}
