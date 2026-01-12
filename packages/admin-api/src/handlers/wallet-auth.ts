/**
 * Wallet Authentication Handler
 * Endpoints for Solana wallet sign-in (SIWS)
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import {
  createChallenge,
  verifyAndCreateSession,
  getSessionWithUser,
  deleteSession,
} from '../services/wallet-auth.js';

// ============================================================================
// Request Schemas
// ============================================================================

const ChallengeRequestSchema = z.object({
  walletAddress: z.string().min(32).max(44), // Solana addresses are 32-44 chars base58
});

const VerifyRequestSchema = z.object({
  signature: z.string().min(64), // Base58 signature
  publicKey: z.string().min(32).max(44), // Wallet public key
  nonce: z.string().min(1), // Challenge nonce
});

// ============================================================================
// Cookie Helpers
// ============================================================================

const COOKIE_NAME = 'swarm_session';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict' as const,
  path: '/',
  maxAge: 24 * 60 * 60, // 24 hours in seconds
};

function setSessionCookie(sessionToken: string): string {
  const parts = [
    `${COOKIE_NAME}=${sessionToken}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=${COOKIE_OPTIONS.sameSite}`,
    `Path=${COOKIE_OPTIONS.path}`,
    `Max-Age=${COOKIE_OPTIONS.maxAge}`,
  ];
  return parts.join('; ');
}

function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function getSessionFromCookie(event: APIGatewayProxyEventV2): string | null {
  const cookies = event.cookies || [];
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === COOKIE_NAME && value) {
      return value;
    }
  }
  return null;
}

// ============================================================================
// Response Helpers
// ============================================================================

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function corsHeaders(event: APIGatewayProxyEventV2): Record<string, string> {
  const origin = event.headers.origin || event.headers.Origin || '';
  // Allow localhost for development
  const allowedOrigins = [
    'https://admin.rati.chat',
    'http://localhost:5173',
    'http://localhost:3000',
  ];
  
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /auth/challenge
 * Generate a challenge for the user to sign
 */
export async function handleChallenge(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Parse request
    const body = JSON.parse(event.body || '{}');
    const parsed = ChallengeRequestSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { walletAddress } = parsed.data;

    // Create challenge
    const challenge = await createChallenge(walletAddress);

    return jsonResponse(200, challenge, cors);
  } catch (error) {
    console.error('[WalletAuth] Challenge error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/verify
 * Verify signature and create session
 */
export async function handleVerify(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Parse request
    const body = JSON.parse(event.body || '{}');
    const parsed = VerifyRequestSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { signature, publicKey, nonce } = parsed.data;

    // Get client info
    const userAgent = event.headers['user-agent'];
    const ipAddress = event.requestContext.http.sourceIp;

    // Verify and create session
    const result = await verifyAndCreateSession(
      signature,
      publicKey,
      nonce,
      userAgent,
      ipAddress
    );

    if (!result.success || !result.session || !result.user) {
      return jsonResponse(401, { error: result.error || 'Authentication failed' }, cors);
    }

    // Set session cookie
    const cookie = setSessionCookie(result.session.sessionToken);

    return jsonResponse(200, {
      success: true,
      session: {
        token: result.session.sessionToken,
        expiresAt: result.session.expiresAt,
      },
      user: {
        walletAddress: result.user.walletAddress,
        displayName: result.user.displayName,
        inhabitedAgentId: result.user.inhabitedAgentId,
      },
    }, {
      ...cors,
      'Set-Cookie': cookie,
    });
  } catch (error) {
    console.error('[WalletAuth] Verify error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /auth/me
 * Get current authenticated user
 */
export async function handleMe(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Get session from cookie
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(200, { authenticated: false }, cors);
    }

    // Get session and user
    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(200, { authenticated: false }, {
        ...cors,
        'Set-Cookie': clearSessionCookie(),
      });
    }

    return jsonResponse(200, {
      authenticated: true,
      user: {
        walletAddress: session.user.walletAddress,
        displayName: session.user.displayName,
        avatarUrl: session.user.avatarUrl,
        inhabitedAgentId: session.user.inhabitedAgentId,
        createdAt: session.user.createdAt,
        sessionCount: session.user.sessionCount,
      },
    }, cors);
  } catch (error) {
    console.error('[WalletAuth] Me error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/logout
 * End current session
 */
export async function handleLogout(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Get session from cookie
    const sessionToken = getSessionFromCookie(event);
    if (sessionToken) {
      await deleteSession(sessionToken);
    }

    return jsonResponse(200, { success: true }, {
      ...cors,
      'Set-Cookie': clearSessionCookie(),
    });
  } catch (error) {
    console.error('[WalletAuth] Logout error:', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /auth/* endpoints
 */
export async function handleWalletAuth(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath;
  const method = event.requestContext.http.method;
  const cors = corsHeaders(event);

  // Handle preflight for all auth routes
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  // Route to appropriate handler
  if (path === '/auth/challenge' && method === 'POST') {
    return handleChallenge(event);
  }

  if (path === '/auth/verify' && method === 'POST') {
    return handleVerify(event);
  }

  if (path === '/auth/me' && method === 'GET') {
    return handleMe(event);
  }

  if (path === '/auth/logout' && method === 'POST') {
    return handleLogout(event);
  }

  return jsonResponse(404, { error: 'Not found' }, cors);
}
