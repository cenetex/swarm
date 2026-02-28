/**
 * Auth Orchestrator
 *
 * Provides a single entry point for authentication that combines identity resolution,
 * session creation, and challenge verification. Replaces the scattered auth logic
 * across wallet-auth and privy-auth handlers.
 */
import { randomUUID } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { logger } from '@swarm/core';
import {
  resolveAccountForIdentity,
  linkIdentity,
  getAccountIdForIdentity,
  type Identity,
} from './identity-service.js';
import {
  createSession,
  type SessionRecord,
} from './session-service.js';
import {
  createAuthChallenge,
  createLinkChallenge,
  consumeChallenge,
} from './challenge-service.js';
import { recordAccountSession, getAccountSummary, type AccountSummary } from '../accounts.js';
import { checkNFTGate, type NFTGateResult } from '../web3/nft-gate.js';
import {
  buildOnboardingErrorEnvelope,
  type OnboardingErrorEnvelope,
  type OnboardingErrorCode,
} from '../onboarding/errors.js';

// ============================================================================
// Types
// ============================================================================

export interface OnboardingOrchestrationContext {
  runId: string;
  state: string;
  step?: string;
  failureSeq?: number;
  resumeToken?: string;
  correlationId?: string;
  attempt?: number;
  maxAttempts?: number;
}

export interface OnboardingResponseMetadata {
  runId: string;
  state: string;
  step?: string;
  failureSeq?: number;
  resumeToken?: string;
  correlationId: string;
}

export interface AuthenticateWalletParams {
  signature: string;
  publicKey: string;
  nonce: string;
  userAgent?: string;
  ipAddress?: string;
  onboarding?: OnboardingOrchestrationContext;
}

export interface AuthenticatePrivyParams {
  privyUserId: string;
  walletAddress?: string;
  email?: string;
  userAgent?: string;
  ipAddress?: string;
  onboarding?: OnboardingOrchestrationContext;
}

export interface AuthenticateResult {
  success: boolean;
  session?: SessionRecord;
  account?: AccountSummary;
  nftGate?: NFTGateResult;
  error?: string;
  onboarding?: OnboardingResponseMetadata;
  onboardingError?: OnboardingErrorEnvelope;
  conflict?: {
    identity: Identity;
    existingAccountId: string;
  };
}

export interface LinkWalletParams {
  accountId: string;
  walletAddress: string;
  signature: string;
  nonce: string;
  onboarding?: OnboardingOrchestrationContext;
}

export interface LinkWalletResult {
  success: boolean;
  account?: AccountSummary;
  error?: string;
  onboarding?: OnboardingResponseMetadata;
  onboardingError?: OnboardingErrorEnvelope;
  conflict?: {
    identity: Identity;
    existingAccountId: string;
  };
}

interface OnboardingStepContext {
  state: string;
  step: string;
}

function mapAuthOrchestratorErrorCode(errorMessage: string): OnboardingErrorCode {
  const lower = errorMessage.toLowerCase();

  if (lower.includes('already consumed') || lower.includes('idempotency')) {
    return 'idempotency_key_conflict';
  }
  if (
    lower.includes('does not match')
    || lower.includes('mismatch')
    || lower.includes('not found')
    || lower.includes('expired')
  ) {
    return 'step_payload_invalid';
  }
  if (
    lower.includes('invalid signature')
    || lower.includes('not authorized')
    || lower.includes('already linked to another account')
  ) {
    return 'actor_not_authorized';
  }
  if (lower.includes('rate limit')) {
    return 'step_rate_limited';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'step_dependency_timeout';
  }
  if (lower.includes('missing') || lower.includes('not configured')) {
    return 'configuration_missing';
  }
  if (lower.includes('conflict') || lower.includes('conditionalcheckfailed')) {
    return 'transition_write_conflict';
  }

  return 'step_dependency_unavailable';
}

function buildOnboardingMetadata(
  context: OnboardingOrchestrationContext | undefined,
  stepContext: OnboardingStepContext
): OnboardingResponseMetadata | undefined {
  if (!context) {
    return undefined;
  }

  return {
    runId: context.runId,
    state: context.state || stepContext.state,
    step: context.step || stepContext.step,
    failureSeq: context.failureSeq,
    resumeToken: context.resumeToken,
    correlationId: context.correlationId || randomUUID(),
  };
}

function buildFailureResponse(
  message: string,
  context: OnboardingOrchestrationContext | undefined,
  stepContext: OnboardingStepContext,
  errorCode = mapAuthOrchestratorErrorCode(message)
): {
  error: string;
  onboarding?: OnboardingResponseMetadata;
  onboardingError?: OnboardingErrorEnvelope;
} {
  const onboarding = buildOnboardingMetadata(context, stepContext);
  if (!onboarding) {
    return { error: message };
  }

  const onboardingError = buildOnboardingErrorEnvelope({
    errorCode,
    message,
    runId: onboarding.runId,
    state: onboarding.state,
    step: onboarding.step,
    resumeToken: onboarding.resumeToken,
    correlationId: onboarding.correlationId,
    attempt: context?.attempt,
    maxAttempts: context?.maxAttempts,
  });

  return {
    error: message,
    onboarding,
    onboardingError,
  };
}

function buildSuccessResponse(
  context: OnboardingOrchestrationContext | undefined,
  stepContext: OnboardingStepContext
): Pick<AuthenticateResult, 'onboarding'> {
  const onboarding = buildOnboardingMetadata(context, stepContext);
  return onboarding ? { onboarding } : {};
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify a Solana wallet signature.
 */
export function verifyWalletSignature(
  message: string,
  signatureBase58: string,
  publicKeyBase58: string
): boolean {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signatureBase58);
    const publicKeyBytes = bs58.decode(publicKeyBase58);

    // Solana public keys are 32 bytes
    if (publicKeyBytes.length !== 32) {
      logger.warn('[AuthOrchestrator] Invalid public key length', { length: publicKeyBytes.length });
      return false;
    }

    // Solana signatures are 64 bytes
    if (signatureBytes.length !== 64) {
      logger.warn('[AuthOrchestrator] Invalid signature length', { length: signatureBytes.length });
      return false;
    }

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    return isValid;
  } catch (error) {
    logger.error('[AuthOrchestrator] Signature verification error', error);
    return false;
  }
}

// ============================================================================
// Wallet Authentication
// ============================================================================

/**
 * Create an auth challenge for wallet sign-in.
 */
export async function createWalletChallenge(
  walletAddress: string,
  idempotencyKey?: string
): Promise<{ nonce: string; message: string; expiresAt: number }> {
  return createAuthChallenge({ walletAddress, idempotencyKey });
}

/**
 * Authenticate a user with a wallet signature.
 * This is the main entry point for wallet-based authentication.
 */
export async function authenticateWallet(
  params: AuthenticateWalletParams
): Promise<AuthenticateResult> {
  const { signature, publicKey, nonce, userAgent, ipAddress, onboarding } = params;
  const stepContext: OnboardingStepContext = {
    state: 'authenticating',
    step: 'wallet_verify',
  };

  // 1. Consume the challenge (retry-safe)
  const requestId = `${publicKey}:${nonce}:${Date.now()}`;
  const challengeResult = await consumeChallenge('auth', nonce, requestId);

  if (!challengeResult.success) {
    return {
      success: false,
      ...buildFailureResponse(challengeResult.error, onboarding, stepContext),
    };
  }

  const challenge = challengeResult.challenge;

  // Verify the wallet matches the challenge
  if (challenge.walletAddress !== publicKey) {
    return {
      success: false,
      ...buildFailureResponse('Wallet address does not match challenge', onboarding, stepContext, 'step_payload_invalid'),
    };
  }

  // 2. Verify the signature
  const isValid = verifyWalletSignature(challenge.message, signature, publicKey);
  if (!isValid) {
    logger.warn('[AuthOrchestrator] Invalid signature', { wallet: publicKey.slice(0, 8) });
    return {
      success: false,
      ...buildFailureResponse('Invalid signature', onboarding, stepContext, 'actor_not_authorized'),
    };
  }

  // 3. Check NFT gate (non-blocking)
  const nftGate = await checkNFTGate(publicKey);
  if (!nftGate.allowed) {
    logger.info('[AuthOrchestrator] No Orb NFT (limited access)', { wallet: publicKey.slice(0, 8) });
  }

  // 4. Resolve account for this wallet
  const accountResult = await resolveAccountForIdentity({
    primaryIdentity: { type: 'wallet', providerId: publicKey },
    createIfNotFound: true,
  });

  if (!accountResult.success) {
    return {
      success: false,
      ...buildFailureResponse(accountResult.error, onboarding, stepContext),
      conflict: accountResult.conflict,
    };
  }

  // 5. Record session activity on account
  await recordAccountSession(accountResult.accountId);

  // 6. Create session
  const session = await createSession({
    accountId: accountResult.accountId,
    walletAddress: publicKey,
    authProvider: 'wallet',
    authProviderId: publicKey,
    userAgent,
    ipAddress,
  });

  // 7. Get account summary
  const account = await getAccountSummary(accountResult.accountId);

  logger.info('[AuthOrchestrator] Wallet auth successful', { wallet: publicKey.slice(0, 8) });

  return {
    success: true,
    session,
    account: account ?? undefined,
    nftGate,
    ...buildSuccessResponse(onboarding, stepContext),
  };
}

// ============================================================================
// Privy Authentication
// ============================================================================

/**
 * Authenticate a user with Privy credentials.
 * This should be called after Privy access token verification.
 */
export async function authenticatePrivy(
  params: AuthenticatePrivyParams
): Promise<AuthenticateResult> {
  const {
    privyUserId,
    walletAddress,
    userAgent,
    ipAddress,
    onboarding,
  } = params;
  const stepContext: OnboardingStepContext = {
    state: 'authenticating',
    step: 'privy_verify',
  };

  // Build identities to link
  const primaryIdentity: Identity = { type: 'privy', providerId: privyUserId };
  const additionalIdentities: Identity[] = [];

  if (walletAddress) {
    additionalIdentities.push({ type: 'wallet', providerId: walletAddress });
  }

  // Check NFT gate if we have a wallet
  let nftGate: NFTGateResult | undefined;
  if (walletAddress) {
    nftGate = await checkNFTGate(walletAddress);
    if (!nftGate.allowed) {
      logger.info('[AuthOrchestrator] No Orb NFT (limited access)', { wallet: walletAddress.slice(0, 8) });
    }
  }

  // Resolve account
  const accountResult = await resolveAccountForIdentity({
    primaryIdentity,
    additionalIdentities,
    createIfNotFound: true,
  });

  if (!accountResult.success) {
    return {
      success: false,
      ...buildFailureResponse(accountResult.error, onboarding, stepContext),
      conflict: accountResult.conflict,
    };
  }

  // Record session activity
  await recordAccountSession(accountResult.accountId);

  // Create session
  const session = await createSession({
    accountId: accountResult.accountId,
    walletAddress: walletAddress || privyUserId, // Use privy ID as fallback
    authProvider: 'privy',
    authProviderId: privyUserId,
    userAgent,
    ipAddress,
  });

  // Get account summary
  const account = await getAccountSummary(accountResult.accountId);

  logger.info('[AuthOrchestrator] Privy auth successful', { privyUser: privyUserId.slice(0, 8) });

  return {
    success: true,
    session,
    account: account ?? undefined,
    nftGate,
    ...buildSuccessResponse(onboarding, stepContext),
  };
}

// ============================================================================
// Identity Linking
// ============================================================================

/**
 * Create a challenge for linking a wallet to an existing account.
 */
export async function createWalletLinkChallenge(
  accountId: string,
  walletAddress: string,
  idempotencyKey?: string,
  onboarding?: OnboardingOrchestrationContext
): Promise<
  | {
      nonce: string;
      message: string;
      expiresAt: number;
      onboarding?: OnboardingResponseMetadata;
    }
  | {
      error: string;
      onboarding?: OnboardingResponseMetadata;
      onboardingError?: OnboardingErrorEnvelope;
    }
> {
  const stepContext: OnboardingStepContext = {
    state: 'linking_identity',
    step: 'wallet_link_challenge',
  };

  // Check if wallet is already linked to a different account
  const existingAccountId = await getAccountIdForIdentity({ type: 'wallet', providerId: walletAddress });
  if (existingAccountId && existingAccountId !== accountId) {
    return {
      ...buildFailureResponse('Wallet is already linked to another account', onboarding, stepContext, 'actor_not_authorized'),
    };
  }

  const challenge = await createLinkChallenge({ accountId, walletAddress, idempotencyKey });
  return {
    ...challenge,
    ...buildSuccessResponse(onboarding, stepContext),
  };
}

/**
 * Verify a wallet link signature and link the wallet to an account.
 */
export async function verifyAndLinkWallet(params: LinkWalletParams): Promise<LinkWalletResult> {
  const { accountId, walletAddress, signature, nonce, onboarding } = params;
  const stepContext: OnboardingStepContext = {
    state: 'linking_identity',
    step: 'wallet_link_verify',
  };

  // 1. Consume the challenge (retry-safe)
  const requestId = `${accountId}:${walletAddress}:${nonce}:${Date.now()}`;
  const challengeResult = await consumeChallenge('link', nonce, requestId);

  if (!challengeResult.success) {
    return {
      success: false,
      ...buildFailureResponse(challengeResult.error, onboarding, stepContext),
    };
  }

  const challenge = challengeResult.challenge;

  // Verify the challenge matches the request
  if (challenge.accountId !== accountId || challenge.walletAddress !== walletAddress) {
    return {
      success: false,
      ...buildFailureResponse('Challenge does not match request', onboarding, stepContext, 'step_payload_invalid'),
    };
  }

  // 2. Verify the signature
  const isValid = verifyWalletSignature(challenge.message, signature, walletAddress);
  if (!isValid) {
    return {
      success: false,
      ...buildFailureResponse('Invalid signature', onboarding, stepContext, 'actor_not_authorized'),
    };
  }

  // 3. Link the identity
  const linkResult = await linkIdentity(accountId, { type: 'wallet', providerId: walletAddress });

  if (!linkResult.success) {
    return {
      success: false,
      ...buildFailureResponse(linkResult.error, onboarding, stepContext),
      conflict: linkResult.conflict,
    };
  }

  // 4. Get updated account summary
  const account = await getAccountSummary(accountId);

  logger.info('[AuthOrchestrator] Wallet linked to account', { accountId });

  return {
    success: true,
    account: account ?? undefined,
    ...buildSuccessResponse(onboarding, stepContext),
  };
}

/**
 * Link a Privy identity to an existing account.
 */
export async function linkPrivy(
  accountId: string,
  privyUserId: string,
  walletAddress?: string,
  onboarding?: OnboardingOrchestrationContext
): Promise<LinkWalletResult> {
  const stepContext: OnboardingStepContext = {
    state: 'linking_identity',
    step: 'privy_link',
  };

  // Link Privy identity
  const privyResult = await linkIdentity(accountId, {
    type: 'privy',
    providerId: privyUserId,
  });

  if (!privyResult.success) {
    return {
      success: false,
      ...buildFailureResponse(privyResult.error, onboarding, stepContext),
      conflict: privyResult.conflict,
    };
  }

  // Link wallet if provided
  if (walletAddress) {
    const walletResult = await linkIdentity(accountId, {
      type: 'wallet',
      providerId: walletAddress,
    });

    if (!walletResult.success) {
      return {
        success: false,
        ...buildFailureResponse(walletResult.error, onboarding, stepContext),
        conflict: walletResult.conflict,
      };
    }
  }

  const account = await getAccountSummary(accountId);

  return {
    success: true,
    account: account ?? undefined,
    ...buildSuccessResponse(onboarding, stepContext),
  };
}

// ============================================================================
// Session Management (Re-exports for convenience)
// ============================================================================

export { getAndTouchSession, deleteSession } from './session-service.js';
export type { SessionRecord } from './session-service.js';
