/**
 * Wallet Authentication Handler
 * Endpoints for Solana wallet sign-in (SIWS)
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { hasValidInternalTestKey, logger } from '@swarm/core';
import { z } from 'zod';
import {
  createChallenge,
  verifyAndCreateSession,
  getSessionWithUser,
  deleteSession,
} from '../services/wallet-auth.js';
import { getAccountSummary, getOrCreateAccountForWallet } from '../services/accounts.js';
import { createLinkWalletChallenge, verifyLinkWallet } from '../services/wallet-link.js';
import { getAccountGateStatus } from '../services/account-gate.js';
import {
  getClearSessionCookies,
  getSessionFromCookie,
  getSetSessionCookies,
} from '../auth/session-cookie.js';
import { getCorsHeaders } from '../http/cors.js';
import { parseJsonBody } from '../http/request-body.js';
import { isRequestValidationError } from '../middleware/validate.js';
import { getGateStatus } from '../services/nft-gate.js';
import { recordBurn } from '../services/burn-stats.js';
import { getBurnStats } from '../services/burn-stats.js';
import { getEnergyStatus, getEnergyBankBalance } from '../services/energy.js';
import { getEntitlement } from '../services/entitlements.js';
import {
  getEffectiveLimitsForAvatar,
  applyOrbHolderBoost,
  toRuntimeLimits,
  syncRuntimeLimitsToState,
  type RuntimeAugmentations,
} from '../services/runtime-limits.js';
import { getAvatar } from '../services/avatars.js';
import { checkNFTGate } from '../services/nft-gate.js';
import { handlePrivyAuth } from './privy-auth.js';
import {
  preflightAscend,
  verifyAscensionBurns,
  executeAscension,
  getAvatarAscensionStatus,
} from '../services/avatar-ascend.js';

// Internal test key for E2E tests - bypasses NFT gate requirements
// NEVER active in production
const INTERNAL_TEST_KEY = process.env.INTERNAL_TEST_KEY;

/**
 * Check if request has valid internal test key.
 * Always returns false in production.
 */
function hasInternalTestKey(event: APIGatewayProxyEventV2): boolean {
  return hasValidInternalTestKey({
    headers: event.headers,
    internalTestKey: INTERNAL_TEST_KEY,
    environment: process.env.ENVIRONMENT,
    nodeEnv: process.env.NODE_ENV,
  });
}

export interface WalletAuthHandlerDeps {
  walletAuth: {
    getSessionWithUser: typeof getSessionWithUser;
  };
  nftGate: {
    getGateStatus: typeof getGateStatus;
  };
  accountGate?: {
    getAccountGateStatus: typeof getAccountGateStatus;
  };
  accounts?: {
    getOrCreateAccountForWallet: typeof getOrCreateAccountForWallet;
    getAccountSummary: typeof getAccountSummary;
  };
}

function getDefaultDeps(): WalletAuthHandlerDeps {
  return {
    walletAuth: {
      getSessionWithUser,
    },
    nftGate: {
      getGateStatus,
    },
    accountGate: {
      getAccountGateStatus,
    },
    accounts: {
      getOrCreateAccountForWallet,
      getAccountSummary,
    },
  };
}

async function buildRuntimeAugmentations(avatarId: string): Promise<RuntimeAugmentations | undefined> {
  const [burnResult, energyResult, bankResult] = await Promise.allSettled([
    getBurnStats(avatarId),
    getEnergyStatus(avatarId),
    getEnergyBankBalance(avatarId),
  ]);

  const burn = burnResult.status === 'fulfilled'
    ? {
        totalBurned: burnResult.value.totalBurned,
        tier: burnResult.value.tier,
        tierName: burnResult.value.tierName,
        maxEnergy: burnResult.value.maxEnergy,
        regenPerHour: burnResult.value.regenPerHour,
        updatedAt: burnResult.value.lastVerifiedAt,
      }
    : undefined;

  const energy = energyResult.status === 'fulfilled'
    ? {
        current: energyResult.value.current,
        max: energyResult.value.max,
        refillPerHour: energyResult.value.refillPerHour,
        nextRefillIn: energyResult.value.nextRefillIn,
        bankCredits: bankResult.status === 'fulfilled' ? bankResult.value.credits : undefined,
        updatedAt: Date.now(),
      }
    : undefined;

  if (!burn && !energy) return undefined;
  return {
    ...(burn ? { burn } : {}),
    ...(energy ? { energy } : {}),
  };
}

async function syncRuntimeContractForAvatar(avatarId: string): Promise<void> {
  const entitlement = await getEntitlement(avatarId);
  let effective = getEffectiveLimitsForAvatar(avatarId, entitlement);

  // Orb-holder auto-boost: if on free plan, check if creator
  // holds Gate NFTs and apply boosted limits.
  if (effective.plan === 'free') {
    try {
      const avatar = await getAvatar(avatarId);
      const walletToCheck = avatar?.creatorWallet;
      if (walletToCheck) {
        const nftResult = await checkNFTGate(walletToCheck);
        if (nftResult.ownedCount >= 1) {
          effective = applyOrbHolderBoost(effective);
        }
      }
    } catch {
      // Swallow errors - boost is best-effort, never blocks sync
    }
  }

  const augmentations = await buildRuntimeAugmentations(avatarId);
  await syncRuntimeLimitsToState({
    avatarId,
    runtimeLimits: toRuntimeLimits(effective.limits),
    plan: effective.plan,
    source: effective.source,
    entitlementStatus: effective.entitlementStatus,
    augmentations,
  });
}

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

const LinkWalletChallengeSchema = z.object({
  walletAddress: z.string().min(32).max(44),
});

const LinkWalletVerifySchema = z.object({
  walletAddress: z.string().min(32).max(44),
  nonce: z.string().min(1),
  signature: z.string().min(64),
});

// Cookie helpers live in ../auth/session-cookie.ts

// ============================================================================
// Response Helpers
// ============================================================================

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
  const cors = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Parse request
    const body = parseJsonBody(event);
    const parsed = ChallengeRequestSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { walletAddress } = parsed.data;
    const ipAddress = event.requestContext.http.sourceIp;

    // Create challenge (with rate limiting)
    const result = await createChallenge(walletAddress, ipAddress);

    // Check if rate limited
    if ('error' in result) {
      return jsonResponse(429, {
        error: result.error,
        retryAfter: result.retryAfter,
      }, {
        ...cors,
        'Retry-After': String(result.retryAfter),
      });
    }

    return jsonResponse(200, result, cors);
  } catch (error) {
    if (isRequestValidationError(error)) {
      return jsonResponse(error.statusCode, {
        error: error.message,
        details: error.details,
      }, cors);
    }
    logger.error('[WalletAuth] Challenge error', error);
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
  const cors = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Parse request
    const body = parseJsonBody(event);
    const parsed = VerifyRequestSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { signature, publicKey, nonce } = parsed.data;

    // Get client info
    const userAgent = event.headers['user-agent'] || event.headers['User-Agent'] || '';
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
      // Include NFT gate info in error response for better UX
      return jsonResponse(401, { 
        error: result.error || 'Authentication failed',
        nftGate: result.nftGate,
      }, cors);
    }

    // Get gate status for the wallet (for access control on frontend)
    const gate = await getAccountGateStatus(
      result.session.accountId || (await getOrCreateAccountForWallet(result.user.walletAddress))
    );

    // Bypass NFT gate for internal test key (E2E testing)
    const isTestBypass = hasInternalTestKey(event);
    if (isTestBypass) {
      logger.info('[WalletAuth] Internal test key detected - bypassing NFT gate requirements');
    }

    // Set session cookies (and clear any stale host-only cookie)
    const cookies = getSetSessionCookies(result.session.sessionToken);

    const accountId = result.session.accountId || (await getOrCreateAccountForWallet(result.user.walletAddress));
    const account = await getAccountSummary(accountId);

    return jsonResponse(200, {
      success: true,
      session: {
        token: result.session.sessionToken,
        expiresAt: result.session.expiresAt,
      },
      account,
      user: {
        walletAddress: result.user.walletAddress,
        displayName: result.user.displayName,
      },
      // Include NFT info for display
      nftGate: result.nftGate,
      // Include gate status for access control
      // Test bypass grants full access
      gateStatus: gate.gateStatus
        ? {
            nftsHeld: isTestBypass ? 999 : gate.gateStatus.nftsHeld,
            avatarsCreated: gate.gateStatus.avatarsCreated,
            availableSlots: isTestBypass ? 999 : gate.gateStatus.availableSlots,
            canCreate: isTestBypass ? true : gate.gateStatus.canCreate,
            canAbandon: isTestBypass ? true : gate.gateStatus.canAbandon,
            ownedNFTs: gate.gateStatus.ownedNFTs,
          }
        : {
            nftsHeld: isTestBypass ? 999 : 0,
            avatarsCreated: 0,
            availableSlots: isTestBypass ? 999 : 0,
            canCreate: isTestBypass,
            canAbandon: isTestBypass,
            ownedNFTs: [],
          },
      gateWallet: gate.gateWallet,
      gateStatusByWallet: gate.gateStatusByWallet,
    }, cors, cookies);
  } catch (error) {
    if (isRequestValidationError(error)) {
      return jsonResponse(error.statusCode, {
        error: error.message,
        details: error.details,
      }, cors);
    }
    logger.error('[WalletAuth] Verify error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /auth/me
 * Get current authenticated user with gate status
 */
export async function handleMe(
  event: APIGatewayProxyEventV2,
  deps?: WalletAuthHandlerDeps
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const resolvedDeps = deps || getDefaultDeps();

    // Get session from cookie
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(200, { authenticated: false }, cors);
    }

    // Get session and user
    const session = await resolvedDeps.walletAuth.getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(200, { authenticated: false }, {
        ...cors,
      }, getClearSessionCookies());
    }

    const accountId = session.accountId ||
      (resolvedDeps.accounts
        ? await resolvedDeps.accounts.getOrCreateAccountForWallet(session.user.walletAddress)
        : undefined);
    const account = accountId && resolvedDeps.accounts
      ? await resolvedDeps.accounts.getAccountSummary(accountId)
      : null;

    const gate = accountId && resolvedDeps.accountGate
      ? await resolvedDeps.accountGate.getAccountGateStatus(accountId)
      : { gateStatus: null, gateWallet: null, gateStatusByWallet: {} };

    // Bypass NFT gate for internal test key (E2E testing)
    const isTestBypass = hasInternalTestKey(event);

    return jsonResponse(200, {
      authenticated: true,
      account,
      user: {
        walletAddress: session.user.walletAddress,
        displayName: session.user.displayName,
        avatarUrl: session.user.avatarUrl,
        createdAt: session.user.createdAt,
        sessionCount: session.user.sessionCount,
      },
      // Test bypass grants full access
      gateStatus: gate.gateStatus
        ? {
            nftsHeld: isTestBypass ? 999 : gate.gateStatus.nftsHeld,
            avatarsCreated: gate.gateStatus.avatarsCreated,
            availableSlots: isTestBypass ? 999 : gate.gateStatus.availableSlots,
            canCreate: isTestBypass ? true : gate.gateStatus.canCreate,
            canAbandon: isTestBypass ? true : gate.gateStatus.canAbandon,
            ownedNFTs: gate.gateStatus.ownedNFTs,
          }
        : {
            nftsHeld: isTestBypass ? 999 : 0,
            avatarsCreated: 0,
            availableSlots: isTestBypass ? 999 : 0,
            canCreate: isTestBypass,
            canAbandon: isTestBypass,
            ownedNFTs: [],
          },
      gateWallet: gate.gateWallet,
      gateStatusByWallet: gate.gateStatusByWallet,
    }, cors);
  } catch (error) {
    logger.error('[WalletAuth] Me error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/link/wallet/challenge
 * Create a signed message challenge to link a wallet identity to the current account.
 */
export async function handleLinkWalletChallenge(
  event: APIGatewayProxyEventV2,
  deps?: WalletAuthHandlerDeps
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const resolvedDeps = deps || getDefaultDeps();
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Not authenticated' }, cors, getClearSessionCookies());
    }

    const session = await resolvedDeps.walletAuth.getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const body = parseJsonBody(event);
    const parsed = LinkWalletChallengeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, cors);
    }

    const accountId = session.accountId ||
      (resolvedDeps.accounts
        ? await resolvedDeps.accounts.getOrCreateAccountForWallet(session.user.walletAddress)
        : undefined);
    if (!accountId) {
      return jsonResponse(500, { error: 'Account resolution unavailable' }, cors);
    }
    const result = await createLinkWalletChallenge({
      accountId,
      walletAddress: parsed.data.walletAddress,
    });

    if ('error' in result) {
      return jsonResponse(409, { error: result.error }, cors);
    }

    return jsonResponse(200, result, cors);
  } catch (error) {
    if (isRequestValidationError(error)) {
      return jsonResponse(error.statusCode, {
        error: error.message,
        details: error.details,
      }, cors);
    }
    logger.error('[WalletAuth] Link wallet challenge error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /auth/link/wallet/verify
 * Verify signature and attach wallet identity to the current account.
 */
export async function handleLinkWalletVerify(
  event: APIGatewayProxyEventV2,
  deps?: WalletAuthHandlerDeps
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const resolvedDeps = deps || getDefaultDeps();
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Not authenticated' }, cors, getClearSessionCookies());
    }

    const session = await resolvedDeps.walletAuth.getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const body = parseJsonBody(event);
    const parsed = LinkWalletVerifySchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, cors);
    }

    const accountId = session.accountId ||
      (resolvedDeps.accounts
        ? await resolvedDeps.accounts.getOrCreateAccountForWallet(session.user.walletAddress)
        : undefined);
    if (!accountId) {
      return jsonResponse(500, { error: 'Account resolution unavailable' }, cors);
    }
    const verifyResult = await verifyLinkWallet({
      accountId,
      walletAddress: parsed.data.walletAddress,
      nonce: parsed.data.nonce,
      signatureBase58: parsed.data.signature,
    });

    if (!verifyResult.success) {
      const status = verifyResult.error.includes('already linked') ? 409 : 400;
      return jsonResponse(status, { error: verifyResult.error }, cors);
    }

    const account = resolvedDeps.accounts ? await resolvedDeps.accounts.getAccountSummary(accountId) : null;
    return jsonResponse(200, { success: true, account }, cors);
  } catch (error) {
    if (isRequestValidationError(error)) {
      return jsonResponse(error.statusCode, {
        error: error.message,
        details: error.details,
      }, cors);
    }
    logger.error('[WalletAuth] Link wallet verify error', error);
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
  const cors = getCorsHeaders(event);

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

    return jsonResponse(200, { success: true }, cors, getClearSessionCookies());
  } catch (error) {
    logger.error('[WalletAuth] Logout error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /auth/gate-status
 * Get NFT gate status for current user
 */
export async function handleGateStatus(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
      }, getClearSessionCookies());
    }

    const gateStatus = await getGateStatus(session.user.walletAddress);

    return jsonResponse(200, { gateStatus }, cors);
  } catch (error) {
    logger.error('[WalletAuth] Gate status error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

// ============================================================================
// ASCENSION ENDPOINTS
// ============================================================================

/**
 * GET /avatar/:id/ascension-status
 * Get ascension status for an avatar
 */
export async function handleAscensionStatus(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Extract avatarId from path
    const pathMatch = event.rawPath.match(/\/avatar\/([^/]+)\/ascension-status/);
    const avatarId = pathMatch?.[1];

    if (!avatarId) {
      return jsonResponse(400, { error: 'Avatar ID required' }, cors);
    }

    const status = await getAvatarAscensionStatus(avatarId);

    return jsonResponse(200, status, cors);
  } catch (error) {
    logger.error('[WalletAuth] Ascension status error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /avatar/:id/ascend/preflight
 * Check if user can ascend an avatar (requirements check)
 */
export async function handleAscensionPreflight(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    // Extract avatarId from path
    const pathMatch = event.rawPath.match(/\/avatar\/([^/]+)\/ascend\/preflight/);
    const avatarId = pathMatch?.[1];

    if (!avatarId) {
      return jsonResponse(400, { error: 'Avatar ID required' }, cors);
    }

    const result = await preflightAscend(avatarId, session.user.walletAddress);

    return jsonResponse(200, result, cors);
  } catch (error) {
    logger.error('[WalletAuth] Ascension preflight error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /avatar/:id/ascend
 * Execute ascension after burns have been verified
 *
 * Request body:
 * - orbBurnSignature: REQUIRED - The signature of the Orb NFT burn transaction
 * - ratiBurnSignature: REQUIRED - The signature of the RATI token burn transaction
 * - nftMint: REQUIRED - The mint address of the newly created Ascension NFT
 */
export async function handleExecuteAscension(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = getCorsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    // Extract avatarId from path
    const pathMatch = event.rawPath.match(/\/avatar\/([^/]+)\/ascend$/);
    const avatarId = pathMatch?.[1];

    if (!avatarId) {
      return jsonResponse(400, { error: 'Avatar ID required' }, cors);
    }

    // Parse request body
    const body = parseJsonBody<{
      orbBurnSignature?: unknown;
      ratiBurnSignature?: unknown;
      nftMint?: unknown;
    }>(event);
    const { orbBurnSignature, ratiBurnSignature, nftMint } = body;

    if (!orbBurnSignature || typeof orbBurnSignature !== 'string') {
      return jsonResponse(400, {
        error: 'orbBurnSignature is required. You must burn an Orb NFT first.',
      }, cors);
    }

    if (!ratiBurnSignature || typeof ratiBurnSignature !== 'string') {
      return jsonResponse(400, {
        error: 'ratiBurnSignature is required. You must burn RATI tokens first.',
      }, cors);
    }

    if (!nftMint || typeof nftMint !== 'string') {
      return jsonResponse(400, {
        error: 'nftMint is required. You must provide the Ascension NFT mint address.',
      }, cors);
    }

    // First do a preflight check to get the required RATI amount
    const preflight = await preflightAscend(avatarId, session.user.walletAddress);
    if (!preflight.canAscend) {
      return jsonResponse(400, {
        error: preflight.error || 'Cannot ascend this avatar',
        ...preflight,
      }, cors);
    }

    // Verify both burns on-chain before accepting the ascension.
    const burnVerification = await verifyAscensionBurns(
      session.user.walletAddress,
      orbBurnSignature,
      ratiBurnSignature,
      preflight.requiredRatiBurn
    );

    if (!burnVerification.verified) {
      return jsonResponse(400, {
        error: burnVerification.error || 'Burn verification failed',
        orb: burnVerification.orbResult,
        rati: burnVerification.ratiResult,
      }, cors);
    }

    const burnedRatiAmount = burnVerification.ratiResult.burnedAmount ?? preflight.requiredRatiBurn;

    // Record the burn so tiers/leaderboard reflect verified burns.
    await recordBurn({
      avatarId,
      signature: ratiBurnSignature,
      amount: burnedRatiAmount,
      walletAddress: session.user.walletAddress,
    });

    // Execute the ascension
    const result = await executeAscension(
      avatarId,
      session.user.walletAddress,
      nftMint,
      orbBurnSignature,
      ratiBurnSignature,
      burnedRatiAmount
    );

    if (!result.success) {
      return jsonResponse(400, {
        error: result.error || 'Ascension failed',
      }, cors);
    }

    try {
      await syncRuntimeContractForAvatar(avatarId);
    } catch (syncError) {
      logger.warn('[WalletAuth] Failed to sync runtime limits after ascension', { errorMessage: syncError instanceof Error ? syncError.message : String(syncError) });
    }

    return jsonResponse(200, {
      success: true,
      avatarId: result.avatarId,
      avatarName: result.avatarName,
      ascendedNftMint: result.ascendedNftMint,
      ascendedAt: result.ascendedAt,
      message: `Avatar has been ascended! Persona and profile image are now permanently locked.`,
    }, cors);
  } catch (error) {
    if (isRequestValidationError(error)) {
      return jsonResponse(error.statusCode, {
        error: error.message,
        details: error.details,
      }, cors);
    }
    logger.error('[WalletAuth] Execute ascension error', error);
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /auth/* endpoints
 */
export async function handleWalletAuth(
  event: APIGatewayProxyEventV2,
  depsOrContext?: WalletAuthHandlerDeps | unknown
): Promise<APIGatewayProxyResultV2> {
  const deps = depsOrContext && 'walletAuth' in (depsOrContext as object)
    ? (depsOrContext as WalletAuthHandlerDeps)
    : undefined;
  const resolvedDeps = deps || getDefaultDeps();

  const rawPath = event.rawPath;
  const path = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const method = event.requestContext.http.method;
  const cors = getCorsHeaders(event);

  // Handle preflight for all auth routes
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  // Route Privy auth to separate handler
  if (path.startsWith('/auth/privy') || path.startsWith('/auth/link/privy')) {
    return handlePrivyAuth(event);
  }

  // Route to appropriate handler
  if (path === '/auth/challenge' && method === 'POST') {
    return handleChallenge(event);
  }

  if (path === '/auth/verify' && method === 'POST') {
    return handleVerify(event);
  }

  if (path === '/auth/me' && method === 'GET') {
    return handleMe(event, resolvedDeps);
  }

  if (path === '/auth/link/wallet/challenge' && method === 'POST') {
    return handleLinkWalletChallenge(event, resolvedDeps);
  }

  if (path === '/auth/link/wallet/verify' && method === 'POST') {
    return handleLinkWalletVerify(event, resolvedDeps);
  }

  if (path === '/auth/logout' && method === 'POST') {
    return handleLogout(event);
  }

  if (path === '/auth/gate-status' && method === 'GET') {
    return handleGateStatus(event);
  }

  // Ascension endpoints
  if (path.match(/^\/avatar\/[^/]+\/ascension-status$/) && method === 'GET') {
    return handleAscensionStatus(event);
  }

  if (path.match(/^\/avatar\/[^/]+\/ascend\/preflight$/) && method === 'POST') {
    return handleAscensionPreflight(event);
  }

  if (path.match(/^\/avatar\/[^/]+\/ascend$/) && method === 'POST') {
    return handleExecuteAscension(event);
  }

  return jsonResponse(404, { error: 'Not found' }, cors);
}
