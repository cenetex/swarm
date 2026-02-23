/**
 * Privy Authentication Handler
 * Endpoints for Privy email/social sign-in
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { logger } from '@swarm/core';

import { getClearSessionCookies, getSessionFromCookie, getSetSessionCookies } from '../auth/session-cookie.js';
import { getAccountSummary, linkPrivyIdentityToAccount } from '../services/accounts.js';
import { getAccountGateStatus } from '../services/account-gate.js';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getCorsHeaders } from '../http/cors.js';
import { parseJsonBody } from '../http/request-body.js';
import { isRequestValidationError } from '../middleware/validate.js';
import { verifyPrivyAccessTokenForLink, verifyPrivyAuth } from '../services/privy-auth.js';
import { onboardingAuthErrorStatusCode, resolveOnboardingAuthAccount } from '../services/accounts/onboarding-auth-resolver.js';

const PrivyVerifySchema = z.object({
  accessToken: z.string().min(1),
  userId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  walletAddress: z.string().min(32).max(44).optional(),
});

const PrivyLinkVerifySchema = PrivyVerifySchema.extend({
  intent: z.enum(['link', 'switch']).optional(),
});

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
  cookies?: string[]
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    cookies,
    body: JSON.stringify(body),
  };
}

/**
 * POST /auth/privy/verify
 * Verify Privy access token and create session
 */
export async function handlePrivyVerify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const body = parseJsonBody(event);
    const parsed = PrivyVerifySchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, cors);
    }

    const userAgent = event.headers['user-agent'] || event.headers['User-Agent'] || '';
    const ipAddress = event.requestContext.http.sourceIp;

    const result = await verifyPrivyAuth(parsed.data, userAgent, ipAddress);

    if (!result.success || !result.session || !result.user) {
      const statusCode = result.code ? onboardingAuthErrorStatusCode(result.code) : (result.conflict ? 409 : 401);
      return jsonResponse(
        statusCode,
        {
          error: result.error || 'Authentication failed',
          code: result.code,
          outcome: result.outcome,
          switchAccountId: result.switchAccountId,
          requiredIntent: result.requiredIntent,
          conflict: result.conflict,
        },
        cors
      );
    }

    const accountId = result.session.accountId;
    if (!accountId) {
      return jsonResponse(
        401,
        { error: 'Session expired', code: 'session_expired' },
        cors,
        getClearSessionCookies()
      );
    }
    const account = await getAccountSummary(accountId);

    const gate = await getAccountGateStatus(accountId);

    const cookies = getSetSessionCookies(result.session.sessionToken);

    return jsonResponse(
      200,
      {
        success: true,
        session: {
          token: result.session.sessionToken,
          expiresAt: result.session.expiresAt,
        },
        account,
        user: {
          walletAddress: result.user.walletAddress,
          displayName: result.user.displayName,
          email: (result.user as unknown as { email?: string })?.email,
          avatarUrl: result.user.avatarUrl,
        },
        nftGate: result.nftGate,
        authResolution: {
          outcome: result.outcome || 'allow_continue',
        },
        gateStatus: gate.gateStatus,
        gateWallet: gate.gateWallet,
        gateStatusByWallet: gate.gateStatusByWallet,
      },
      cors,
      cookies
    );
  } catch (error) {
    if (isRequestValidationError(error)) {
      return jsonResponse(error.statusCode, {
        error: error.message,
        details: error.details,
      }, cors);
    }
    logger.error('[PrivyAuth] Verify error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/link/privy/verify
 * Verify a Privy access token and link the Privy identity to the current account.
 * Does NOT create a new backend session or set cookies.
 */
export async function handleLinkPrivyVerify(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(
        401,
        { error: 'Session expired', code: 'session_expired' },
        cors,
        getClearSessionCookies()
      );
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(
        401,
        { error: 'Session expired', code: 'session_expired' },
        cors,
        getClearSessionCookies()
      );
    }

    const body = parseJsonBody(event);
    const parsed = PrivyLinkVerifySchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, cors);
    }

    const verified = await verifyPrivyAccessTokenForLink(parsed.data.accessToken);
    if (!verified.ok) {
      return jsonResponse(401, { error: verified.error }, cors);
    }

    if (parsed.data.userId && parsed.data.userId !== verified.privyUserId) {
      return jsonResponse(401, { error: 'Token user mismatch' }, cors);
    }

    const accountId = session.accountId;
    if (!accountId) {
      return jsonResponse(
        401,
        { error: 'Session expired', code: 'session_expired' },
        cors,
        getClearSessionCookies()
      );
    }

    const authResolution = await resolveOnboardingAuthAccount({
      mode: 'session',
      sessionAccountId: accountId,
      avatarOwnerAccountId: accountId,
      targetIdentities: [
        { type: 'privy', providerId: verified.privyUserId },
        ...(verified.walletAddress ? [{ type: 'wallet' as const, providerId: verified.walletAddress }] : []),
      ],
      intent: parsed.data.intent ?? 'link',
      requireExplicitLinkIntent: true,
    });

    if (!authResolution.success) {
      const conflictType = authResolution.identity?.type === 'wallet' ? 'wallet' : 'privy';
      const conflictProviderId = authResolution.identity?.providerId ?? verified.privyUserId;

      return jsonResponse(
        onboardingAuthErrorStatusCode(authResolution.code),
        {
          error: authResolution.error,
          code: authResolution.code,
          outcome: authResolution.outcome,
          switchAccountId: authResolution.switchAccountId,
          requiredIntent: authResolution.requiredIntent,
          providedIntent: authResolution.providedIntent,
          identity: authResolution.identity,
          conflict: authResolution.switchAccountId
            ? {
                type: conflictType,
                providerId: conflictProviderId,
                existingAccountId: authResolution.switchAccountId,
              }
            : undefined,
        },
        cors
      );
    }

    const linkResult = await linkPrivyIdentityToAccount({
      accountId,
      privyUserId: verified.privyUserId,
      walletAddress: verified.walletAddress ?? undefined,
    });

    if (!linkResult.success) {
      return jsonResponse(409, { error: linkResult.error, conflict: linkResult.conflict }, cors);
    }

    const account = await getAccountSummary(accountId);
    const gate = await getAccountGateStatus(accountId);

    return jsonResponse(
      200,
      {
        success: true,
        account,
        authResolution: {
          outcome: authResolution.outcome,
        },
        gateStatus: gate.gateStatus,
        gateWallet: gate.gateWallet,
        gateStatusByWallet: gate.gateStatusByWallet,
      },
      cors
    );
  } catch (error) {
    if (isRequestValidationError(error)) {
      return jsonResponse(error.statusCode, {
        error: error.message,
        details: error.details,
      }, cors);
    }
    logger.error('[PrivyAuth] Link verify error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /auth/privy/* endpoints
 */
export async function handlePrivyAuth(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const rawPath = event.rawPath;
  const path = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const method = event.requestContext.http.method;
  const cors = getCorsHeaders(event);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  if (path === '/auth/privy/verify' && method === 'POST') {
    return handlePrivyVerify(event);
  }

  if (path === '/auth/link/privy/verify' && method === 'POST') {
    return handleLinkPrivyVerify(event);
  }

  return jsonResponse(404, { error: 'Not found' }, cors);
}
