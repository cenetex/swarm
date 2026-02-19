/**
 * Token Launch Service
 *
 * Enables avatars with Twitter accounts to launch tokens through the configured
 * token launch provider API.
 */
import {
  type Commitment,
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  createVanityMatcher,
  resolveVanityMintConfig,
  type ResolvedVanityMintConfig,
  type VanityMatchInfo,
  type VanityMatchPosition,
  type VanityMintConfig,
  type VanityMintMode,
} from './vanity-mint.js';

import { _getSecretValueInternal, secretExists } from './secrets.js';
import { getAvatar } from './avatars.js';
import { canLaunchToken } from './burn-stats.js';
import { BURN_TIERS } from '@swarm/core';
import type { AvatarRecord } from '../types.js';
import { getDynamoClient } from './dynamo-client.js';

// ---------------------------------------------------------------------------
// Tier Helper
// ---------------------------------------------------------------------------

/**
 * Get tier name by tier number
 */
function getTierName(tier: number): string {
  const burnTier = BURN_TIERS.find(t => t.tier === tier);
  return burnTier?.name ?? 'Unknown';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** System wallet that always receives platform fee share */
export const PLATFORM_WALLET = '7xprTy9L24qT6agsqpHrFDUnUTFEWF2RijPzSxnroJwc';

/** Platform fee share in basis points (20% = 2000 bps) */
export const PLATFORM_FEE_BPS = 2000;

/** Avatar (Twitter account) fee share in basis points (80% = 8000 bps) */
export const AVATAR_FEE_BPS = 8000;

/** Total BPS must equal 10000 */
const TOTAL_BPS = PLATFORM_FEE_BPS + AVATAR_FEE_BPS;
if (TOTAL_BPS !== 10000) {
  throw new Error(`Fee BPS must total 10000, got ${TOTAL_BPS}`);
}

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const dynamoClient = getDynamoClient();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenLaunchConfig {
  /** Token name (max 32 chars) */
  name: string;
  /** Token symbol (max 10 chars) */
  symbol: string;
  /** Token description (max 1000 chars) */
  description?: string;
  /** Image URL for token - defaults to avatar profile image if not provided */
  imageUrl?: string;
  /** Initial buy in SOL (default: 0.01) */
  initialBuySol?: number;
  /** Twitter URL for token page */
  twitterUrl?: string;
  /** Website URL for token page */
  websiteUrl?: string;
  /** Telegram URL for token page */
  telegramUrl?: string;
  /**
   * Optional vanity mint policy.
   *
   * strict:
   * - requires mint to start or end with pattern
   *
   * best_effort:
   * - attempts to match pattern anywhere
   */
  mintVanity?: VanityMintConfig;
}

export interface TokenLaunchResult {
  success: boolean;
  avatarId: string;
  tokenMint?: string;
  symbol?: string;
  name?: string;
  signature?: string;
  metadataUrl?: string;
  launchUrl?: string;
  error?: string;
  errorCode?: 'NO_TWITTER' | 'ALREADY_LAUNCHED' | 'NO_WALLET' | 'NO_API_KEY' | 'NO_PROFILE_IMAGE' | 'LAUNCH_FAILED' | 'TWITTER_NOT_REGISTERED' | 'INSUFFICIENT_TIER';
  /** Current burn tier (0-5) */
  tier?: number;
  /** RATI needed to burn to unlock token launch */
  burnNeeded?: number;
  /** Vanity pattern evaluated against the resulting mint (if requested) */
  vanityPattern?: string;
  /** Vanity policy used (if requested) */
  vanityMode?: VanityMintMode;
  /** Whether resulting mint satisfied vanity policy */
  vanityMatched?: boolean;
  /** Where the pattern matched in resulting mint */
  vanityPosition?: VanityMatchPosition;
  /** Additional note about vanity execution */
  vanityNote?: string;
}

export interface TokenLaunchInfo {
  mint: string;
  symbol: string;
  name: string;
  launchedAt: number;
  signature: string;
  metadataUrl: string;
  launchUrl: string;
}

export interface TokenLaunchPreflightResult {
  canLaunch: boolean;
  avatarId: string;
  twitterUsername?: string;
  hasProfileImage: boolean;
  hasWallet: boolean;
  hasApiKey: boolean;
  existingToken?: TokenLaunchInfo;
  error?: string;
  errorCode?: 'NO_TWITTER' | 'ALREADY_LAUNCHED' | 'NO_WALLET' | 'NO_API_KEY' | 'NO_PROFILE_IMAGE' | 'INSUFFICIENT_TIER';
  /** Current burn tier (0-5) */
  tier?: number;
  /** Tier name (e.g., 'Spark', 'Ember', 'Inferno') */
  tierName?: string;
  /** RATI needed to burn to unlock token launch (0 if already unlocked) */
  burnNeeded?: number;
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

async function getAvatarSolanaKeypair(avatarId: string): Promise<Keypair> {
  const secret = await _getSecretValueInternal(avatarId, 'solana_wallet_key', 'default');
  if (!secret) {
    throw new Error('Missing solana_wallet_key secret (name=default)');
  }
  const secretBytes = bs58.decode(secret);
  return Keypair.fromSecretKey(secretBytes);
}

async function getLaunchApiKey(avatarId: string): Promise<string | null> {
  // Try avatar-specific key first, then fall back to global
  let apiKey = await _getSecretValueInternal(avatarId, 'token_launch_api_key', 'default');
  if (!apiKey) {
    apiKey = await _getSecretValueInternal(null, 'token_launch_api_key', 'default');
  }
  return apiKey;
}

async function getLaunchPartnerKey(): Promise<string | null> {
  // Partner key is global only (platform-level)
  return _getSecretValueInternal(null, 'token_launch_partner_key', 'default');
}

function getTwitterUsername(avatar: AvatarRecord): string | null {
  return avatar.platforms?.twitter?.username || null;
}

// ---------------------------------------------------------------------------
// Token launch API + Solana Helpers
// ---------------------------------------------------------------------------

/** Default Solana RPC URL (can be overridden via env) */
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

/** Token launch provider API base URL */
const TOKEN_LAUNCH_API_BASE_URL = process.env.TOKEN_LAUNCH_API_BASE_URL;
/** Public token page base URL */
const TOKEN_LAUNCH_WEB_BASE_URL = (process.env.TOKEN_LAUNCH_WEB_BASE_URL || 'https://solscan.io/token').replace(/\/+$/, '');

/** Token launch fee-share-v2 on-chain program id used for partner PDA derivation */
const TOKEN_LAUNCH_FEE_SHARE_V2_PROGRAM_ID = 'FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK';

const SOLANA_COMMITMENT: Commitment = 'processed';
const TOKEN_LAUNCH_ENGINE = process.env.TOKEN_LAUNCH_ENGINE || 'external';
const TOKEN_LAUNCH_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const TOKEN_LAUNCH_VANITY_MAX_REQUEST_TIMEOUT_MS = 12_000;
const EXTERNAL_VANITY_MAX_ATTEMPTS_CAP = 120;
const EXTERNAL_VANITY_STRICT_CONCURRENCY = 2;
const EXTERNAL_VANITY_BEST_EFFORT_CONCURRENCY = 4;

type LaunchProvider = 'twitter' | 'tiktok' | 'kick' | 'github';

type LaunchApiSuccess<T> = {
  success: true;
  response: T;
};

type LaunchApiFailure = {
  success: false;
  error: string;
};

type LaunchApiEnvelope<T> = LaunchApiSuccess<T> | LaunchApiFailure;

interface LaunchWalletResponse {
  provider: string;
  platformData: unknown;
  wallet: string;
}

interface CreateTokenInfoResponse {
  tokenMint: string;
  tokenMetadata: string;
}

interface CreateTokenInfoParams {
  imageUrl: string;
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  website?: string;
  telegram?: string;
}

interface VanityTokenInfoResult {
  tokenInfo: CreateTokenInfoResponse;
  match: VanityMatchInfo | null;
  note?: string;
  attempts: number;
  elapsedMs: number;
}

interface VanityAttemptSuccess {
  attempt: number;
  tokenInfo: CreateTokenInfoResponse;
  match: VanityMatchInfo;
}

interface VanityAttemptFailure {
  attempt: number;
  error: Error;
  aborted: boolean;
}

interface InFlightVanityAttempt {
  attempt: number;
  controller: AbortController;
  promise: Promise<VanityAttemptSuccess | VanityAttemptFailure>;
}

interface TransactionWithBlockhash {
  transaction: string;
  blockhash: {
    blockhash: string;
    lastValidBlockHeight: number;
  };
}

interface CreateFeeShareConfigResponse {
  needsCreation: boolean;
  feeShareAuthority: string;
  meteoraConfigKey?: string;
  transactions?: TransactionWithBlockhash[];
  bundles?: TransactionWithBlockhash[][];
}

interface CreateFeeShareConfigParams {
  feeClaimers: Array<{ user: PublicKey; userBps: number }>;
  payer: PublicKey;
  baseMint: PublicKey;
  partner?: PublicKey;
  partnerConfig?: PublicKey;
  additionalLookupTables?: PublicKey[];
}

interface CreateLaunchTransactionParams {
  metadataUrl: string;
  tokenMint: PublicKey;
  launchWallet: PublicKey;
  initialBuyLamports: number;
  configKey: PublicKey;
}

interface CreateFeeShareConfigResult {
  transactions: VersionedTransaction[];
  bundles: VersionedTransaction[][];
  meteoraConfigKey: PublicKey;
}

function deriveFeeShareV2PartnerConfigPda(partner: PublicKey): PublicKey {
  const [partnerConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('partner_config'), partner.toBuffer()],
    new PublicKey(TOKEN_LAUNCH_FEE_SHARE_V2_PROGRAM_ID)
  );
  return partnerConfig;
}

function buildLaunchApiUrl(path: string, query?: Record<string, string>): string {
  if (!TOKEN_LAUNCH_API_BASE_URL) {
    throw new Error('TOKEN_LAUNCH_API_BASE_URL is not configured');
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${TOKEN_LAUNCH_API_BASE_URL}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function getLaunchApiErrorMessage(status: number, payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string' && error.length > 0) return error;

    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return `Token launch API request failed with status ${status}`;
}

async function parseLaunchResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function launchApiRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
  query?: Record<string, string>,
  timeoutMs: number = TOKEN_LAUNCH_DEFAULT_REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-api-key', apiKey);

  const timeoutController = new AbortController();
  const onExternalAbort = () => timeoutController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      timeoutController.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    const response = await fetch(buildLaunchApiUrl(path, query), {
      ...init,
      headers,
      signal: timeoutController.signal,
    });

    const payload = await parseLaunchResponsePayload(response);

    if (!response.ok) {
      throw new Error(getLaunchApiErrorMessage(response.status, payload));
    }

    if (typeof payload !== 'object' || payload === null || !('success' in payload)) {
      throw new Error('Unexpected Token launch API response format');
    }

    const envelope = payload as LaunchApiEnvelope<T>;
    if (envelope.success) {
      return envelope.response;
    }

    throw new Error(envelope.error || 'Token launch API request failed');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Token launch API request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function getLaunchWalletV2(
  apiKey: string,
  username: string,
  provider: LaunchProvider
): Promise<PublicKey> {
  const response = await launchApiRequest<LaunchWalletResponse>(
    apiKey,
    '/token-launch/fee-share/wallet/v2',
    { method: 'GET' },
    { username, provider }
  );
  return new PublicKey(response.wallet);
}

async function createTokenInfoAndMetadata(
  apiKey: string,
  params: CreateTokenInfoParams,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<CreateTokenInfoResponse> {
  const form = new FormData();
  form.append('imageUrl', params.imageUrl);
  form.append('name', params.name);
  form.append('symbol', params.symbol);
  form.append('description', params.description);

  if (params.twitter) form.append('twitter', params.twitter);
  if (params.website) form.append('website', params.website);
  if (params.telegram) form.append('telegram', params.telegram);

  return launchApiRequest<CreateTokenInfoResponse>(apiKey, '/token-launch/create-token-info', {
    method: 'POST',
    body: form,
  }, undefined, timeoutMs, signal);
}

function getEffectiveVanityMaxAttempts(config: ResolvedVanityMintConfig): number {
  if (TOKEN_LAUNCH_ENGINE !== 'external') {
    return config.maxAttempts;
  }
  return Math.min(config.maxAttempts, EXTERNAL_VANITY_MAX_ATTEMPTS_CAP);
}

function getVanityConcurrency(config: ResolvedVanityMintConfig): number {
  if (TOKEN_LAUNCH_ENGINE !== 'external') {
    return 1;
  }
  return config.mode === 'strict'
    ? EXTERNAL_VANITY_STRICT_CONCURRENCY
    : EXTERNAL_VANITY_BEST_EFFORT_CONCURRENCY;
}

function getVanityRequestTimeoutMs(deadlineMs: number): number {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return 1_000;
  return Math.max(1_000, Math.min(remainingMs, TOKEN_LAUNCH_VANITY_MAX_REQUEST_TIMEOUT_MS));
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isVanityAttemptSuccess(
  attempt: VanityAttemptSuccess | VanityAttemptFailure
): attempt is VanityAttemptSuccess {
  return 'tokenInfo' in attempt;
}

async function createTokenInfoWithVanityPolicy(
  apiKey: string,
  params: CreateTokenInfoParams,
  vanityConfig: ResolvedVanityMintConfig | null
): Promise<VanityTokenInfoResult> {
  if (!vanityConfig) {
    const startedAt = Date.now();
    const tokenInfo = await createTokenInfoAndMetadata(apiKey, params);
    return {
      tokenInfo,
      match: null,
      attempts: 1,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const maxAttempts = getEffectiveVanityMaxAttempts(vanityConfig);
  const deadlineMs = Date.now() + vanityConfig.maxSearchMs;
  const concurrency = getVanityConcurrency(vanityConfig);
  const matcher = createVanityMatcher(vanityConfig);

  let attemptsLaunched = 0;
  let latestCandidate: VanityAttemptSuccess | null = null;
  let latestBestEffortMatch: VanityAttemptSuccess | null = null;
  let strictMatch: VanityAttemptSuccess | null = null;
  let stopScheduling = false;
  const startedAt = Date.now();
  const inFlight: InFlightVanityAttempt[] = [];

  const scheduleNextAttempt = (): void => {
    attemptsLaunched += 1;
    const attempt = attemptsLaunched;
    const controller = new AbortController();
    const timeoutMs = getVanityRequestTimeoutMs(deadlineMs);

    const promise = createTokenInfoAndMetadata(
      apiKey,
      params,
      timeoutMs,
      controller.signal
    )
      .then((tokenInfo): VanityAttemptSuccess => ({
        attempt,
        tokenInfo,
        match: matcher(tokenInfo.tokenMint),
      }))
      .catch((error): VanityAttemptFailure => ({
        attempt,
        error: toError(error),
        aborted: controller.signal.aborted,
      }));

    inFlight.push({ attempt, controller, promise });
  };

  while (inFlight.length > 0 || !stopScheduling) {
    while (!stopScheduling && inFlight.length < concurrency) {
      if (attemptsLaunched >= maxAttempts || Date.now() >= deadlineMs) {
        stopScheduling = true;
        break;
      }
      scheduleNextAttempt();
    }

    if (inFlight.length === 0) break;

    const settled = await Promise.race(
      inFlight.map((attempt) => attempt.promise.then((result) => ({ attempt, result })))
    );

    const settledIndex = inFlight.findIndex((attempt) => attempt.attempt === settled.attempt.attempt);
    if (settledIndex >= 0) {
      inFlight.splice(settledIndex, 1);
    }

    if (!isVanityAttemptSuccess(settled.result)) {
      if (settled.result.aborted && strictMatch) {
        continue;
      }
      for (const pending of inFlight) {
        pending.controller.abort();
      }
      throw settled.result.error;
    }

    const successfulAttempt = settled.result;
    if (!latestCandidate || successfulAttempt.attempt > latestCandidate.attempt) {
      latestCandidate = successfulAttempt;
    }

    if (vanityConfig.mode === 'strict') {
      if (!strictMatch && successfulAttempt.match.matched) {
        strictMatch = successfulAttempt;
        stopScheduling = true;
        for (const pending of inFlight) {
          pending.controller.abort();
        }
      }
      continue;
    }

    if (
      successfulAttempt.match.matched &&
      (!latestBestEffortMatch || successfulAttempt.attempt > latestBestEffortMatch.attempt)
    ) {
      latestBestEffortMatch = successfulAttempt;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  if (!latestCandidate) {
    throw new Error('Failed to create token metadata during vanity search');
  }

  if (vanityConfig.mode === 'strict') {
    if (!strictMatch) {
      throw new Error(
        `No mint matched strict vanity policy "${vanityConfig.pattern}" ` +
        `within ${attemptsLaunched} attempt(s) over ${elapsedMs}ms`
      );
    }

    return {
      tokenInfo: strictMatch.tokenInfo,
      match: strictMatch.match,
      attempts: attemptsLaunched,
      elapsedMs,
      note:
        `Mint matched strict vanity policy at attempt ${strictMatch.attempt} ` +
        `of ${attemptsLaunched} (${elapsedMs}ms).`,
    };
  }

  if (latestBestEffortMatch) {
    return {
      tokenInfo: latestBestEffortMatch.tokenInfo,
      match: latestBestEffortMatch.match,
      attempts: attemptsLaunched,
      elapsedMs,
      note:
        `Mint matched best-effort vanity policy at attempt ${latestBestEffortMatch.attempt} ` +
        `of ${attemptsLaunched} (${elapsedMs}ms).`,
    };
  }

  return {
    tokenInfo: latestCandidate.tokenInfo,
    match: latestCandidate.match,
    attempts: attemptsLaunched,
    elapsedMs,
    note:
      `No mint matched "${vanityConfig.pattern}" in ${attemptsLaunched} attempt(s) over ${elapsedMs}ms. ` +
      'Launch continued with the most recent mint due to best-effort policy.',
  };
}

async function createFeeShareConfig(
  apiKey: string,
  params: CreateFeeShareConfigParams
): Promise<CreateFeeShareConfigResult> {
  const totalBps = params.feeClaimers.reduce((sum, claimer) => sum + claimer.userBps, 0);
  if (totalBps !== 10000) {
    throw new Error(`Total BPS must be 10000, got ${totalBps}`);
  }

  if ((params.partner && !params.partnerConfig) || (!params.partner && params.partnerConfig)) {
    throw new Error('partner and partnerConfig must be provided together');
  }

  const response = await launchApiRequest<CreateFeeShareConfigResponse>(
    apiKey,
    '/fee-share/config',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        basisPointsArray: params.feeClaimers.map((claimer) => claimer.userBps),
        payer: params.payer.toBase58(),
        baseMint: params.baseMint.toBase58(),
        partner: params.partner?.toBase58(),
        partnerConfig: params.partnerConfig?.toBase58(),
        claimersArray: params.feeClaimers.map((claimer) => claimer.user.toBase58()),
        additionalLookupTables: params.additionalLookupTables?.map((lookupTable) => lookupTable.toBase58()),
      }),
    }
  );

  if (!response.needsCreation) {
    throw new Error('Config already exists');
  }

  if (!response.meteoraConfigKey) {
    throw new Error('Token launch API response missing meteoraConfigKey');
  }

  return {
    transactions: (response.transactions ?? []).map(({ transaction }) =>
      VersionedTransaction.deserialize(bs58.decode(transaction))
    ),
    bundles: (response.bundles ?? []).map((bundle) =>
      bundle.map(({ transaction }) => VersionedTransaction.deserialize(bs58.decode(transaction)))
    ),
    meteoraConfigKey: new PublicKey(response.meteoraConfigKey),
  };
}

async function createLaunchTransaction(
  apiKey: string,
  params: CreateLaunchTransactionParams
): Promise<VersionedTransaction> {
  const encodedTransaction = await launchApiRequest<string>(
    apiKey,
    '/token-launch/create-launch-transaction',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ipfs: params.metadataUrl,
        tokenMint: params.tokenMint.toBase58(),
        wallet: params.launchWallet.toBase58(),
        initialBuyLamports: params.initialBuyLamports,
        configKey: params.configKey.toBase58(),
      }),
    }
  );

  return VersionedTransaction.deserialize(bs58.decode(encodedTransaction));
}

async function signAndSendTransaction(
  connection: Connection,
  commitment: Commitment,
  transaction: VersionedTransaction,
  keypair: Keypair
): Promise<string> {
  transaction.sign([keypair]);

  const latestBlockhash = await connection.getLatestBlockhash(commitment);
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: true,
    maxRetries: 0,
  });

  const confirmed = await connection.confirmTransaction(
    {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature,
    },
    commitment
  );

  if (confirmed.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmed.value.err)}`);
  }

  return signature;
}

// ---------------------------------------------------------------------------
// Main Service Functions
// ---------------------------------------------------------------------------

/**
 * Check if an avatar can launch a token
 */
export async function preflightTokenLaunch(avatarId: string): Promise<TokenLaunchPreflightResult> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    return {
      canLaunch: false,
      avatarId,
      hasProfileImage: false,
      hasWallet: false,
      hasApiKey: false,
      error: 'Avatar not found',
    };
  }

  // Check for existing token
  if (avatar.tokenLaunch) {
    return {
      canLaunch: false,
      avatarId,
      hasProfileImage: true,
      hasWallet: true,
      hasApiKey: true,
      existingToken: avatar.tokenLaunch as TokenLaunchInfo,
      error: 'Avatar has already launched a token',
      errorCode: 'ALREADY_LAUNCHED',
    };
  }

  // Check Twitter username
  const twitterUsername = getTwitterUsername(avatar);
  if (!twitterUsername) {
    return {
      canLaunch: false,
      avatarId,
      hasProfileImage: false,
      hasWallet: false,
      hasApiKey: false,
      error: 'Avatar must have a Twitter account configured to launch on Token launch',
      errorCode: 'NO_TWITTER',
    };
  }

  // Check profile image
  const profileUrl = typeof avatar.profileImage === 'string'
    ? avatar.profileImage
    : avatar.profileImage?.url;
  if (!profileUrl) {
    return {
      canLaunch: false,
      avatarId,
      twitterUsername,
      hasProfileImage: false,
      hasWallet: false,
      hasApiKey: false,
      error: 'Avatar must have a profile image set before launching a token',
      errorCode: 'NO_PROFILE_IMAGE',
    };
  }

  // Check Solana wallet
  const hasWallet = await secretExists(avatarId, 'solana_wallet_key', 'default');

  // Check Token launch API key
  const apiKey = await getLaunchApiKey(avatarId);
  const hasApiKey = !!apiKey;

  if (!hasWallet) {
    return {
      canLaunch: false,
      avatarId,
      twitterUsername,
      hasProfileImage: true,
      hasWallet: false,
      hasApiKey,
      error: 'Avatar must have a Solana wallet configured',
      errorCode: 'NO_WALLET',
    };
  }

  if (!hasApiKey) {
    return {
      canLaunch: false,
      avatarId,
      twitterUsername,
      hasProfileImage: true,
      hasWallet: true,
      hasApiKey: false,
      error: 'Token launch API key not configured',
      errorCode: 'NO_API_KEY',
    };
  }

  // Check burn tier requirement (Tier 3 / Inferno required for token launch)
  const tierCheck = await canLaunchToken(avatarId);
  if (!tierCheck.allowed) {
    return {
      canLaunch: false,
      avatarId,
      twitterUsername,
      hasProfileImage: true,
      hasWallet: true,
      hasApiKey: true,
      error: tierCheck.error,
      errorCode: 'INSUFFICIENT_TIER',
      tier: tierCheck.tier,
      tierName: getTierName(tierCheck.tier),
      burnNeeded: tierCheck.burnNeeded,
    };
  }

  return {
    canLaunch: true,
    avatarId,
    twitterUsername,
    hasProfileImage: true,
    hasWallet: true,
    hasApiKey: true,
    tier: tierCheck.tier,
    tierName: getTierName(tierCheck.tier),
    burnNeeded: 0,
  };
}

/**
 * Launch a token for an avatar on Token launch
 *
 * Requirements:
 * - Avatar must have Twitter username configured
 * - Avatar must have Solana wallet (solana_wallet_key secret)
 * - Token launch API key must be configured (avatar or global)
 * - Avatar must not have already launched a token
 *
 * Fee distribution:
 * - 20% (2000 bps) to platform wallet (7xprTy9L24qT6agsqpHrFDUnUTFEWF2RijPzSxnroJwc)
 * - 80% (8000 bps) to avatar's Twitter account wallet on Token launch
 */
export async function launchToken(
  avatarId: string,
  config: TokenLaunchConfig
): Promise<TokenLaunchResult> {
  console.log(`[TokenLaunch] Starting token launch for avatar=${avatarId}`);

  let vanityConfig: ResolvedVanityMintConfig | null = null;
  try {
    vanityConfig = resolveVanityMintConfig(config.mintVanity);
  } catch (error) {
    return {
      success: false,
      avatarId,
      error: error instanceof Error ? error.message : 'Invalid vanity mint config',
      errorCode: 'LAUNCH_FAILED',
    };
  }

  // Run preflight checks (includes tier requirement check)
  const preflight = await preflightTokenLaunch(avatarId);
  if (!preflight.canLaunch) {
    console.log(`[TokenLaunch] Preflight failed: ${preflight.error}`);
    return {
      success: false,
      avatarId,
      error: preflight.error,
      errorCode: preflight.errorCode,
      tier: preflight.tier,
      burnNeeded: preflight.burnNeeded,
      vanityPattern: vanityConfig?.pattern,
      vanityMode: vanityConfig?.mode,
    };
  }

  const twitterUsername = preflight.twitterUsername!;
  console.log(`[TokenLaunch] Twitter username: @${twitterUsername}`);

  try {
    // Get credentials
    const apiKey = (await getLaunchApiKey(avatarId))!;
    const keypair = await getAvatarSolanaKeypair(avatarId);
    const commitment = SOLANA_COMMITMENT;
    const connection = new Connection(SOLANA_RPC_URL);

    console.log(`[TokenLaunch] Avatar wallet: ${keypair.publicKey.toBase58()}`);

    // Step 1: Look up avatar's Twitter account wallet on Token launch API
    console.log(`[TokenLaunch] Looking up launch wallet for @${twitterUsername}...`);
    let avatarLaunchWallet: PublicKey;
    try {
      avatarLaunchWallet = await getLaunchWalletV2(apiKey, twitterUsername, 'twitter');
      console.log(`[TokenLaunch] Found launch wallet: ${avatarLaunchWallet.toBase58()}`);
    } catch (err) {
      console.error(`[TokenLaunch] Failed to find launch wallet for @${twitterUsername}:`, err instanceof Error ? err.message : String(err));
      return {
        success: false,
        avatarId,
        error: `Twitter account @${twitterUsername} is not registered on token launch provider. The account must be linked to Token launch first.`,
        errorCode: 'TWITTER_NOT_REGISTERED',
        vanityPattern: vanityConfig?.pattern,
        vanityMode: vanityConfig?.mode,
      };
    }

    // Step 2: Create token metadata using Token launch API
    console.log('[TokenLaunch] Creating token metadata...');
    const avatar = (await getAvatar(avatarId))!;
    const profileUrl = typeof avatar.profileImage === 'string'
      ? avatar.profileImage
      : avatar.profileImage?.url;

    // Require a proper image - don't launch with placeholder
    const imageUrl = config.imageUrl || profileUrl;
    if (!imageUrl) {
      return {
        success: false,
        avatarId,
        error: 'Avatar must have a profile image set before launching a token. Use the profile image tool first.',
        errorCode: 'LAUNCH_FAILED',
        vanityPattern: vanityConfig?.pattern,
        vanityMode: vanityConfig?.mode,
      };
    }

    // Sanitize symbol: uppercase, strip $, alphanumeric only
    const sanitizedSymbol = config.symbol
      .toUpperCase()
      .replace(/^\$/, '')
      .replace(/[^A-Z0-9]/g, '');

    if (sanitizedSymbol.length === 0 || sanitizedSymbol.length > 10) {
      return {
        success: false,
        avatarId,
        error: 'Token symbol must be 1-10 alphanumeric characters',
        errorCode: 'LAUNCH_FAILED',
        vanityPattern: vanityConfig?.pattern,
        vanityMode: vanityConfig?.mode,
      };
    }

    // Use avatar description as fallback for token description
    const tokenDescription = config.description || avatar.description || `${config.name} - launched by @${twitterUsername}`;

    const tokenInfoResult = await createTokenInfoWithVanityPolicy(apiKey, {
      imageUrl,
      name: config.name.trim(),
      description: tokenDescription,
      symbol: sanitizedSymbol,
      twitter: config.twitterUrl,
      website: config.websiteUrl,
      telegram: config.telegramUrl,
    }, vanityConfig);

    const tokenInfo = tokenInfoResult.tokenInfo;

    const tokenMint = new PublicKey(tokenInfo.tokenMint);
    console.log(`[TokenLaunch] Token mint: ${tokenMint.toBase58()}`);
    console.log(`[TokenLaunch] Metadata URL: ${tokenInfo.tokenMetadata}`);
    if (vanityConfig) {
      console.log(
        `[TokenLaunch] Vanity search completed: attempts=${tokenInfoResult.attempts} ` +
        `elapsedMs=${tokenInfoResult.elapsedMs} engine=${TOKEN_LAUNCH_ENGINE}`
      );
    }
    const vanityMatch = tokenInfoResult.match;
    const vanityNote = tokenInfoResult.note;
    if (vanityNote) {
      console.log(`[TokenLaunch] ${vanityNote}`);
    }

    // Step 3: Create fee share config with proper distribution
    // - Platform wallet: 2000 bps (20%)
    // - Avatar's Twitter launch wallet: 8000 bps (80%)
    // - Partner receives additional fees from Token launch (separate from above)
    console.log('[TokenLaunch] Creating fee share configuration...');
    console.log(`  - Platform (${PLATFORM_WALLET}): ${PLATFORM_FEE_BPS / 100}%`);
    console.log(`  - Avatar @${twitterUsername} (${avatarLaunchWallet.toBase58()}): ${AVATAR_FEE_BPS / 100}%`);

    const platformWallet = new PublicKey(PLATFORM_WALLET);
    const feeClaimers = [
      { user: avatarLaunchWallet, userBps: AVATAR_FEE_BPS },   // 80% to avatar's Twitter wallet
      { user: platformWallet, userBps: PLATFORM_FEE_BPS },   // 20% to platform
    ];

    // Get partner key if configured (for platform-level partner fees)
    const partnerKeyStr = await getLaunchPartnerKey();
    let partner: PublicKey | undefined;
    let partnerConfig: PublicKey | undefined;
    
    if (partnerKeyStr) {
      partner = new PublicKey(partnerKeyStr);
      partnerConfig = deriveFeeShareV2PartnerConfigPda(partner);
      console.log(`[TokenLaunch] Using partner key: ${partner.toBase58()}`);
      console.log(`[TokenLaunch] Partner config PDA: ${partnerConfig.toBase58()}`);
    }

    const configResult = await createFeeShareConfig(apiKey, {
      payer: keypair.publicKey,
      baseMint: tokenMint,
      feeClaimers,
      partner,
      partnerConfig,
    });

    // Sign and send config creation transactions
    for (const tx of configResult.transactions || []) {
      await signAndSendTransaction(connection, commitment, tx, keypair);
    }

    // Handle bundles if present (for large fee claimer sets)
    if (configResult.bundles && configResult.bundles.length > 0) {
      console.log(`[TokenLaunch] Sending ${configResult.bundles.length} bundle(s)...`);
      for (const bundle of configResult.bundles) {
        for (const tx of bundle) {
          tx.sign([keypair]);
          // Send via SDK's Jito integration if available
          await signAndSendTransaction(connection, commitment, tx, keypair);
        }
      }
    }

    console.log(`[TokenLaunch] Config key: ${configResult.meteoraConfigKey.toBase58()}`);

    // Step 4: Create launch transaction using Token launch API
    console.log('[TokenLaunch] Creating launch transaction...');
    const initialBuyLamports = Math.floor((config.initialBuySol || 0.01) * LAMPORTS_PER_SOL);

    const launchTx = await createLaunchTransaction(apiKey, {
      metadataUrl: tokenInfo.tokenMetadata,
      tokenMint,
      launchWallet: keypair.publicKey,
      initialBuyLamports,
      configKey: configResult.meteoraConfigKey,
    });

    // Step 5: Sign and send launch transaction
    console.log('[TokenLaunch] Signing and broadcasting transaction...');
    const signature = await signAndSendTransaction(connection, commitment, launchTx, keypair);
    console.log(`[TokenLaunch] Transaction confirmed: ${signature}`);

    // Step 6: Store token info on avatar record
    const tokenLaunch: TokenLaunchInfo = {
      mint: tokenInfo.tokenMint,
      symbol: sanitizedSymbol,
      name: config.name.trim(),
      launchedAt: Date.now(),
      signature,
      metadataUrl: tokenInfo.tokenMetadata,
      launchUrl: `${TOKEN_LAUNCH_WEB_BASE_URL}/${tokenInfo.tokenMint}`,
    };

    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      UpdateExpression: 'SET tokenLaunch = :token, updatedAt = :now',
      ExpressionAttributeValues: {
        ':token': tokenLaunch,
        ':now': Date.now(),
      },
    }));

    console.log(`[TokenLaunch] ✅ Token launched successfully!`);
    console.log(`[TokenLaunch] View at: ${tokenLaunch.launchUrl}`);

    return {
      success: true,
      avatarId,
      tokenMint: tokenLaunch.mint,
      symbol: tokenLaunch.symbol,
      name: tokenLaunch.name,
      signature: tokenLaunch.signature,
      metadataUrl: tokenLaunch.metadataUrl,
      launchUrl: tokenLaunch.launchUrl,
      vanityPattern: vanityConfig?.pattern,
      vanityMode: vanityConfig?.mode,
      vanityMatched: vanityMatch?.matched,
      vanityPosition: vanityMatch?.position,
      vanityNote,
    };
  } catch (error) {
    console.error('[TokenLaunch] Launch failed:', error instanceof Error ? error.message : String(error));
    return {
      success: false,
      avatarId,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'LAUNCH_FAILED',
      vanityPattern: vanityConfig?.pattern,
      vanityMode: vanityConfig?.mode,
    };
  }
}

/**
 * Get token status for an avatar
 */
export async function getTokenStatus(avatarId: string): Promise<{
  hasToken: boolean;
  token?: TokenLaunchInfo;
  twitterUsername?: string;
  canLaunch: boolean;
}> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    return { hasToken: false, canLaunch: false };
  }

  const twitterUsername = getTwitterUsername(avatar);

  if (avatar.tokenLaunch) {
    return {
      hasToken: true,
      token: avatar.tokenLaunch as TokenLaunchInfo,
      twitterUsername: twitterUsername || undefined,
      canLaunch: false,
    };
  }

  const preflight = await preflightTokenLaunch(avatarId);

  return {
    hasToken: false,
    twitterUsername: twitterUsername || undefined,
    canLaunch: preflight.canLaunch,
  };
}
