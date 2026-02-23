/**
 * Request Authentication
 *
 * Authenticates admin API requests using first-party credentials:
 * - `swarm_session` cookie, or
 * - Bearer session token
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getHeaderValue, hasValidInternalTestKey, logger } from '@swarm/core';
import type { UserSession } from '../types.js';
import { getSessionFromCookie } from './session-cookie.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getAccountSummary, getOrCreateAccountForWallet } from '../services/accounts.js';
import { AuthError } from './errors.js';
import { checkActiveUserAccess } from '../services/active-user-limit.js';

function getBearerSessionToken(event: APIGatewayProxyEventV2): string | null {
  const authorization = getHeaderValue(event.headers, 'authorization');
  if (!authorization) return null;

  const [scheme, token] = authorization.split(' ', 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;

  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Authenticate a request using first-party session auth.
 */
export async function authenticateRequest(
  event: APIGatewayProxyEventV2
): Promise<UserSession> {
  // Internal test key bypass - NEVER allow in production
  const internalTestKey = process.env.INTERNAL_TEST_KEY;
  if (hasValidInternalTestKey({
    headers: event.headers,
    internalTestKey,
    environment: process.env.ENVIRONMENT,
    nodeEnv: process.env.NODE_ENV,
  })) {
    logger.info('Auth: Internal test mode enabled');
    return {
      email: 'internal-test@aws.local',
      userId: 'internal-test-user',
      isAdmin: true,
      accessToken: 'internal-test',
    };
  }

  const sessionToken = getSessionFromCookie(event) || getBearerSessionToken(event);
  if (!sessionToken) {
    throw new Error('No authentication token provided');
  }

  const session = await getSessionWithUser(sessionToken);
  if (!session) {
    throw new Error('Session expired');
  }

  // Look up admin role from account record in database
  const accountId = session.accountId || await getOrCreateAccountForWallet(session.walletAddress);
  const account = await getAccountSummary(accountId);
  const isAdmin = account?.role === 'admin';

  // Enforce active-user slots (when configured)
  const access = await checkActiveUserAccess({ accountId, isAdmin, isOrbHolder: session.isOrbHolder });
  if (!access.allowed) {
    throw new AuthError('Active user slots full', 403, {
      limit: access.limit,
      cutoffLastSeenAt: access.cutoffLastSeenAt,
      accountId,
    });
  }

  const email = (session.user as { email?: string }).email || '';

  return {
    email: email || session.walletAddress,
    userId: session.walletAddress,
    isAdmin,
    accessToken: sessionToken,
    accountId,
  };
}

/**
 * Require admin access - returns true if admin, false otherwise
 */
export function requireAdmin(session: UserSession): boolean {
  return session.isAdmin;
}

/**
 * Create a session for development/testing.
 */
export function createDevSession(email: string = 'dev@localhost'): UserSession {
  return {
    email,
    userId: 'dev-user',
    isAdmin: true,
    accessToken: 'dev-token',
  };
}
