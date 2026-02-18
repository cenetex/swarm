/**
 * Twitter OAuth Handler
 * Handles the OAuth 1.0a 3-legged flow for connecting X/Twitter accounts
 *
 * Routes:
 * - GET /oauth/twitter/start?avatarId=xxx - Start OAuth flow
 * - GET /oauth/twitter/callback?oauth_token=xxx&oauth_verifier=xxx - OAuth callback
 * - GET /oauth/twitter/health?live=1 - Health check (admin only)
 * - GET /oauth/twitter/status/{avatarId} - Check connection status
 * - DELETE /oauth/twitter/{avatarId} - Disconnect Twitter
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/request-auth.js';
import { getSessionFromCookie } from '../auth/session-cookie.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import {
  isConfigured as twitterIsConfigured,
  probeOAuthStart as twitterProbeOAuthStart,
  startOAuthFlow as twitterStartOAuthFlow,
  completeOAuthFlow as twitterCompleteOAuthFlow,
  getConnectionStatus as twitterGetConnectionStatus,
  disconnectTwitter as twitterDisconnectTwitter,
} from '../services/twitter-oauth.js';
import {
  getAvatar as avataretAgent,
  updateAvatar as avatarpdateAgent,
} from '../services/avatars.js';
import type { UserSession, AvatarRecord } from '../types.js';
import { getCorsHeaders } from '../http/cors.js';
import { isAuthError } from '../auth/errors.js';

/**
 * Dependencies interface for dependency injection (testing)
 */
export interface TwitterOAuthHandlerDeps {
  twitterOAuth: {
    isConfigured: () => Promise<boolean>;
    probeOAuthStart: () => Promise<void>;
    startOAuthFlow: (avatarId: string) => Promise<{ authorizationUrl: string; oauthToken: string }>;
    completeOAuthFlow: (oauthToken: string, oauthVerifier: string, session: UserSession) => Promise<{
      success: boolean;
      avatarId: string;
      username?: string;
      userId?: string;
      error?: string;
    }>;
    getConnectionStatus: (avatarId: string) => Promise<{
      connected: boolean;
      username?: string;
      userId?: string;
      connectedAt?: number;
    }>;
    disconnectTwitter: (avatarId: string, session: UserSession) => Promise<void>;
  };
  avatarService: {
    getAvatar: (avatarId: string) => Promise<AvatarRecord | null>;
    updateAvatar: (avatarId: string, updates: Partial<AvatarRecord>, session: UserSession) => Promise<AvatarRecord>;
  };
  auth: {
    authenticateRequest: (event: APIGatewayProxyEventV2) => Promise<UserSession>;
    requireAdmin: (session: UserSession) => boolean;
    getWalletAddress: (event: APIGatewayProxyEventV2) => Promise<string | null>;
  };
}

/**
 * Check if a user can manage an avatar (admin OR creator)
 */
function canManageAvatar(
  session: UserSession,
  avatar: AvatarRecord,
  walletAddress: string | null,
  requireAdminFn: (s: UserSession) => boolean
): boolean {
  if (requireAdminFn(session)) {
    return true;
  }
  if (!walletAddress) {
    return false;
  }
  return avatar.creatorWallet === walletAddress;
}

/**
 * Get wallet address from session cookie
 */
async function getWalletAddressFromEvent(event: APIGatewayProxyEventV2): Promise<string | null> {
  const sessionToken = getSessionFromCookie(event);
  if (!sessionToken) return null;
  const session = await getSessionWithUser(sessionToken);
  return session?.walletAddress ?? null;
}

// Create default dependencies lazily to avoid issues with namespace imports at module load time
function getDefaultDeps(): TwitterOAuthHandlerDeps {
  return {
    twitterOAuth: {
      isConfigured: twitterIsConfigured,
      probeOAuthStart: twitterProbeOAuthStart,
      startOAuthFlow: twitterStartOAuthFlow,
      completeOAuthFlow: twitterCompleteOAuthFlow,
      getConnectionStatus: twitterGetConnectionStatus,
      disconnectTwitter: twitterDisconnectTwitter,
    },
    avatarService: {
      getAvatar: avataretAgent,
      updateAvatar: avatarpdateAgent,
    },
    auth: {
      authenticateRequest,
      requireAdmin,
      getWalletAddress: getWalletAddressFromEvent,
    },
  };
}

const ADMIN_UI_URL = process.env.ADMIN_UI_URL || process.env.ALLOWED_ORIGINS?.split(',')[0] || 'http://localhost:5173';

/**
 * Lambda handler for Twitter OAuth endpoints
 * @param event - API Gateway event
 * @param depsOrContext - Optional dependencies for testing (Lambda context is passed but ignored)
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  depsOrContext?: TwitterOAuthHandlerDeps | unknown
): Promise<APIGatewayProxyStructuredResultV2> {
  // Check if deps has the expected shape (not Lambda context)
  // Lambda context has properties like functionName, awsRequestId, etc.
  const deps = depsOrContext && 'twitterOAuth' in (depsOrContext as object)
    ? (depsOrContext as TwitterOAuthHandlerDeps)
    : undefined;
  const resolvedDeps = deps || getDefaultDeps();
  const { twitterOAuth, avatarService, auth } = resolvedDeps;

  const corsHeaders = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  const method = event.requestContext.http.method;
  const rawPath = event.rawPath;
  // CloudFront routes the admin API under `/api/*` but API Gateway handlers historically
  // matched on `/...` paths. Normalize so both work.
  const path = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;

  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'twitter-oauth',
    event: 'request_received',
    method,
    path,
    rawPath,
    query: event.queryStringParameters,
  }));

  try {
    // GET /oauth/twitter/callback?oauth_token=xxx&oauth_verifier=xxx - OAuth callback
    // This route must remain callable by Twitter without authenticated session headers.
    if (method === 'GET' && path === '/oauth/twitter/callback') {
      const result = await handleCallback(event, resolvedDeps);
      return {
        ...result,
        headers: { ...corsHeaders, ...(result.headers || {}) },
      };
    }

    // GET /oauth/twitter/start?avatarId=xxx - Start OAuth flow
    // This redirects to Twitter; the callback will store tokens for the specified avatarId.
    if (method === 'GET' && path === '/oauth/twitter/start') {
      // Require authentication for start to prevent unauthorized account linking.
      const session = await auth.authenticateRequest(event);
      const walletAddress = await auth.getWalletAddress(event);

      const avatarId = event.queryStringParameters?.avatarId;
      const reconnect = event.queryStringParameters?.reconnect === '1' || event.queryStringParameters?.reconnect === 'true';

      if (!avatarId) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'avatarId query parameter is required' }),
        };
      }

      const avatar = await avatarService.getAvatar(avatarId);
      if (!avatar) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        };
      }

      // Allow admin OR avatar creator to connect Twitter
      if (!canManageAvatar(session, avatar, walletAddress, auth.requireAdmin)) {
        return {
          statusCode: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'You must be the avatar owner to connect Twitter' }),
        };
      }

      if (!(await twitterOAuth.isConfigured())) {
        return {
          statusCode: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Twitter OAuth not configured',
            message: 'Ensure swarm/global/twitter-app-credentials secret exists and TWITTER_OAUTH_CALLBACK_URL is set',
          }),
        };
      }

      // Optional safety: disconnect existing connection BEFORE starting reconnect.
      // This avoids cases where the UI thinks a reconnect happened but old tokens remain active.
      if (reconnect) {
        try {
          await twitterOAuth.disconnectTwitter(avatarId, session);
        } catch {
          // ignore
        }
        try {
          await avatarService.updateAvatar(avatarId, {
            platforms: {
              twitter: {
                enabled: false,
                username: undefined,
              },
            },
          }, session);
        } catch {
          // ignore
        }
      }

      let authorizationUrl: string;
      try {
        ({ authorizationUrl } = await twitterOAuth.startOAuthFlow(avatarId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          level: 'ERROR',
          subsystem: 'twitter-oauth',
          event: 'oauth_start_failed',
          avatarId,
          error: message,
        }));
        return {
          statusCode: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Twitter OAuth start failed',
            message,
          }),
        };
      }

      return {
        statusCode: 302,
        headers: {
          ...corsHeaders,
          Location: authorizationUrl,
        },
        body: '',
      };
    }

    // GET /oauth/twitter/health - Health/smoke test for Twitter OAuth configuration (admin only)
    if (method === 'GET' && path === '/oauth/twitter/health') {
      const session = await auth.authenticateRequest(event);
      if (!auth.requireAdmin(session)) {
        return {
          statusCode: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Admin access required' }),
        };
      }

      const configured = await twitterOAuth.isConfigured();
      const live = event.queryStringParameters?.live === '1' || event.queryStringParameters?.live === 'true';

      let probeOk: boolean | undefined;
      let probeError: string | undefined;

      if (live) {
        if (!configured) {
          probeOk = false;
          probeError = 'Not configured';
        } else {
          try {
            await twitterOAuth.probeOAuthStart();
            probeOk = true;
          } catch (error) {
            probeOk = false;
            probeError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      const ok = configured && (!live || probeOk === true);

      return {
        statusCode: ok ? 200 : 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok,
          configured,
          live,
          probeOk,
          probeError,
          callbackUrl: process.env.TWITTER_OAUTH_CALLBACK_URL || '',
        }),
      };
    }

    // GET /oauth/twitter/status/{avatarId} - Get connection status (avatar owner or admin)
    const statusMatch = path.match(/^\/oauth\/twitter\/status\/([^/]+)$/);
    if (method === 'GET' && statusMatch) {
      const session = await auth.authenticateRequest(event);
      const walletAddress = await auth.getWalletAddress(event);
      const avatarId = statusMatch[1];

      const avatar = await avatarService.getAvatar(avatarId);
      if (!avatar) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        };
      }

      if (!canManageAvatar(session, avatar, walletAddress, auth.requireAdmin)) {
        return {
          statusCode: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'You must be the avatar owner to view Twitter status' }),
        };
      }

      const status = await twitterOAuth.getConnectionStatus(avatarId);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(status),
      };
    }

    // DELETE /oauth/twitter/{avatarId} - Disconnect Twitter (avatar owner or admin)
    const disconnectMatch = path.match(/^\/oauth\/twitter\/([^/]+)$/);
    if (method === 'DELETE' && disconnectMatch) {
      const session = await auth.authenticateRequest(event);
      const walletAddress = await auth.getWalletAddress(event);
      const avatarId = disconnectMatch[1];

      const avatar = await avatarService.getAvatar(avatarId);
      if (!avatar) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Avatar not found' }),
        };
      }

      if (!canManageAvatar(session, avatar, walletAddress, auth.requireAdmin)) {
        return {
          statusCode: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'You must be the avatar owner to disconnect Twitter' }),
        };
      }

      await twitterOAuth.disconnectTwitter(avatarId, session);

      // Update avatar config to disable Twitter
      await avatarService.updateAvatar(avatarId, {
        platforms: {
          twitter: {
            enabled: false,
            username: undefined,
          },
        },
      }, session);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: 'Twitter disconnected' }),
      };
    }

    // Unknown route
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    if (isAuthError(error)) {
      return {
        statusCode: error.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message, details: error.details }),
      };
    }

    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'twitter-oauth',
      event: 'handler_error',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

/**
 * Handle the OAuth callback from Twitter
 * This is called after the user authorizes on Twitter
 */
async function handleCallback(
  event: APIGatewayProxyEventV2,
  deps: TwitterOAuthHandlerDeps
): Promise<APIGatewayProxyStructuredResultV2> {
  const { twitterOAuth, avatarService } = deps;
  const { oauth_token, oauth_verifier, denied } = event.queryStringParameters || {};

  // User denied authorization
  if (denied) {
    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}?twitter_error=denied`,
      },
      body: '',
    };
  }

  if (!oauth_token || !oauth_verifier) {
    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}?twitter_error=missing_params`,
      },
      body: '',
    };
  }

  try {
    // Create a system session for the callback (user already authenticated with Twitter)
    const systemSession = {
      email: 'oauth-callback@system',
      userId: 'system',
      isAdmin: true,
      accessToken: 'oauth-callback',
    };

    const result = await twitterOAuth.completeOAuthFlow(
      oauth_token,
      oauth_verifier,
      systemSession
    );

    if (!result.success) {
      return {
        statusCode: 302,
        headers: {
          Location: `${ADMIN_UI_URL}?twitter_error=${encodeURIComponent(result.error || 'unknown')}`,
        },
        body: '',
      };
    }

    // Update avatar config to enable Twitter with the connected username
    await avatarService.updateAvatar(result.avatarId, {
      platforms: {
        twitter: {
          enabled: true,
          username: result.username,
        },
      },
    }, systemSession);

    // Redirect back to admin UI with success
    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}/avatars/${result.avatarId}?twitter_connected=${result.username}`,
      },
      body: '',
    };

  } catch (error) {
    console.error('OAuth callback error:', error instanceof Error ? error.message : String(error));

    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}?twitter_error=${encodeURIComponent(error instanceof Error ? error.message : 'unknown')}`,
      },
      body: '',
    };
  }
}
