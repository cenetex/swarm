/**
 * Twitter OAuth Handler
 * Handles the OAuth 1.0a 3-legged flow for connecting X/Twitter accounts
 * 
 * Routes:
 * - GET /oauth/twitter/start?agentId=xxx - Start OAuth flow
 * - GET /oauth/twitter/callback?oauth_token=xxx&oauth_verifier=xxx - OAuth callback
 * - GET /oauth/twitter/status/{agentId} - Check connection status
 * - DELETE /oauth/twitter/{agentId} - Disconnect Twitter
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import * as twitterOAuth from '../services/twitter-oauth.js';
import * as agentService from '../services/agents.js';

// CORS headers
const allowedOrigin = process.env.ALLOWED_ORIGINS?.split(',')[0] || 'http://localhost:5173';
const ADMIN_UI_URL = process.env.ADMIN_UI_URL || allowedOrigin;

const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
  'Access-Control-Allow-Credentials': 'true',
};

/**
 * Lambda handler for Twitter OAuth endpoints
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  const method = event.requestContext.http.method;
  const path = event.rawPath;

  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'twitter-oauth',
    event: 'request_received',
    method,
    path,
  }));

  try {
    // GET /oauth/twitter/callback - OAuth callback from Twitter (no auth needed)
    // This is called by Twitter after user authorizes - they won't have auth headers
    if (method === 'GET' && path === '/oauth/twitter/callback') {
      return handleCallback(event);
    }

    // GET /oauth/twitter/start?agentId=xxx - Start OAuth flow (no auth needed)
    // This just redirects to Twitter - the actual authorization happens there
    // The callback will store tokens for the specified agentId
    if (method === 'GET' && path === '/oauth/twitter/start') {
      const agentId = event.queryStringParameters?.agentId;
      
      if (!agentId) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'agentId query parameter is required' }),
        };
      }

      // Verify agent exists
      const agent = await agentService.getAgent(agentId);
      if (!agent) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Agent not found' }),
        };
      }

      // Check if Twitter OAuth is configured
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

      const { authorizationUrl } = await twitterOAuth.startOAuthFlow(agentId);

      // Return authorization URL (admin UI will redirect the user)
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          authorizationUrl,
          message: 'Redirect user to authorizationUrl to authorize',
        }),
      };
    }

    // Routes below require authentication
    const session = await authenticateRequest(event);
    if (!requireAdmin(session)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // GET /oauth/twitter/status/{agentId} - Get connection status
    const statusMatch = path.match(/^\/oauth\/twitter\/status\/([^/]+)$/);
    if (method === 'GET' && statusMatch) {
      const agentId = statusMatch[1];
      
      const status = await twitterOAuth.getConnectionStatus(agentId);
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(status),
      };
    }

    // DELETE /oauth/twitter/{agentId} - Disconnect Twitter
    const disconnectMatch = path.match(/^\/oauth\/twitter\/([^/]+)$/);
    if (method === 'DELETE' && disconnectMatch) {
      const agentId = disconnectMatch[1];
      
      await twitterOAuth.disconnectTwitter(agentId, session);

      // Update agent config to disable Twitter
      await agentService.updateAgent(agentId, {
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
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
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

    // Update agent config to enable Twitter with the connected username
    await agentService.updateAgent(result.agentId, {
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
        Location: `${ADMIN_UI_URL}/agents/${result.agentId}?twitter_connected=${result.username}`,
      },
      body: '',
    };

  } catch (error) {
    console.error('OAuth callback error:', error);
    
    return {
      statusCode: 302,
      headers: {
        Location: `${ADMIN_UI_URL}?twitter_error=${encodeURIComponent(error instanceof Error ? error.message : 'unknown')}`,
      },
      body: '',
    };
  }
}
