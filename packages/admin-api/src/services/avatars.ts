/**
 * Avatar Management Service
 */
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, DEFAULT_LLM_TEMPERATURE, DEFAULT_LLM_MAX_TOKENS } from '@swarm/core';
import type { AvatarRecord, UserSession } from '../types.js';
import { syncAvatarConfig } from './config-sync.js';
import {
  getGateStatus,
  decrementCreatorCount,
  incrementCreatorCount,
  checkNFTGate,
  reserveCreatorSlot,
  isNFTClaimed,
  verifyNFTOwnership,
  isCollectionWhitelisted,
  type GateStatus,
  type ClaimableNFT,
} from './nft-gate.js';
import { storeSecret, deleteAllAvatarSecrets } from './secrets.js';
import { registerTelegramWebhook, generateWebhookSecret } from './telegram.js';
import {
  registerHomeChannel,
  removeAvatarFromAllHomeChannels,
} from './home-channel.js';
import { clearStripeDataForAvatar } from './entitlements.js';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/**
 * Generate a URL-safe avatar ID from name
 */
function generateAvatarId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}-${suffix}`;
}

/**
 * Create a new avatar (legacy - uses email session)
 */
export async function createAvatar(
  name: string,
  session: UserSession,
  description?: string
): Promise<AvatarRecord> {
  const avatarId = generateAvatarId(name);
  const now = Date.now();

  const avatar: AvatarRecord = {
    pk: `AVATAR#${avatarId}`,
    sk: 'CONFIG',
    avatarId,
    name,
    description,
    platforms: {},
    voiceConfig: {
      enabled: true,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: DEFAULT_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      useGlobalKey: true,
    },
    currentEra: 0,
    status: 'draft',
    createdAt: now,
    createdBy: session.email,
    updatedAt: now,
    updatedBy: session.email,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: avatar,
    ConditionExpression: 'attribute_not_exists(pk)',
  }));

  // Sync to state table so handlers can access it
  await syncAvatarConfig(avatar);

  return avatar;
}

/**
 * Create avatar result with gate status
 */
export interface CreateAvatarResult {
  success: boolean;
  avatar?: AvatarRecord;
  gateStatus?: GateStatus;
  error?: 'no_gate_slot' | 'invalid_name' | 'name_taken' | 'gate_check_failed';
}

/**
 * Create a new avatar with wallet-based gating
 * Requires the wallet to hold an unused Gate NFT slot
 */
export async function createAvatarWithWalletLegacy(
  name: string,
  creatorWallet: string,
  description?: string
): Promise<CreateAvatarResult> {
  // Atomically reserve a gate slot to prevent race conditions under concurrency.
  // Slot formula is (1 free) + (Orb NFTs held).
  const nftResult = await checkNFTGate(creatorWallet);
  const totalSlots = 1 + nftResult.ownedCount;

  const reservation = await reserveCreatorSlot(creatorWallet, totalSlots);
  if (!reservation.reserved) {
    const gateStatus = await getGateStatus(creatorWallet);
    console.log(
      `[Avatars] No gate slot for wallet=${creatorWallet.slice(0, 8)}... (held=${gateStatus.nftsHeld}, created=${gateStatus.avatarsCreated})`
    );
    return { success: false, error: 'no_gate_slot', gateStatus };
  }

  const avatarId = generateAvatarId(name);
  const now = Date.now();

  // Determine slot type: first avatar = free, subsequent = orb (NFT-backed)
  const slotType: 'free' | 'orb' = reservation.previousCreated === 0 ? 'free' : 'orb';

  const avatar: AvatarRecord = {
    pk: `AVATAR#${avatarId}`,
    sk: 'CONFIG',
    avatarId,
    name,
    description,
    platforms: {},
    voiceConfig: {
      enabled: true,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: DEFAULT_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      useGlobalKey: true,
    },
    creatorWallet,  // Track who created for slot counting
    slotType,       // Track whether free or orb-backed
    healthStatus: 'healthy',
    currentEra: 0,
    status: 'draft',
    createdAt: now,
    createdBy: creatorWallet,
    updatedAt: now,
    updatedBy: creatorWallet,
  };

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: avatar,
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err: unknown) {
    // Roll back reserved slot on failure.
    await decrementCreatorCount(creatorWallet);
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      const gateStatus = await getGateStatus(creatorWallet);
      return { success: false, error: 'name_taken', gateStatus };
    }
    throw err;
  }

  const finalStatus = await getGateStatus(creatorWallet);

  // Sync to state table so handlers can access it
  await syncAvatarConfig(avatar);

  console.log(`[Avatars] Created avatar=${avatarId} by wallet=${creatorWallet.slice(0, 8)}...`);

  return {
    success: true,
    avatar,
    gateStatus: finalStatus,
  };
}

/**
 * Create a new avatar with wallet-based gating.
 * Backward-compatible export used by existing callers.
 */
export async function createAvatarWithWallet(
  name: string,
  creatorWallet: string,
  description?: string
): Promise<CreateAvatarResult> {
  return createAvatarWithWalletLegacy(name, creatorWallet, description);
}

/**
 * Onboarding v2 avatar creation path.
 * Uses the legacy implementation today; rollout routing stays runtime-controlled.
 */
export async function createAvatarWithWalletV2(
  name: string,
  creatorWallet: string,
  description?: string
): Promise<CreateAvatarResult> {
  return createAvatarWithWalletLegacy(name, creatorWallet, description);
}

/**
 * List unclaimed avatars (no inhabitant)
 * Only checks inhabitantWallet - ownerWallet is a legacy field
 */
export async function listUnclaimedAvatars(): Promise<AvatarRecord[]> {
  const result = await dynamoClient.send(new ScanCommand({
    TableName: ADMIN_TABLE,
    FilterExpression: 'sk = :sk AND #status <> :deleted AND attribute_not_exists(inhabitantWallet)',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':sk': 'CONFIG',
      ':deleted': 'deleted',
    },
  }));

  return (result.Items as AvatarRecord[]) || [];
}

/**
 * Get an avatar by ID
 */
export async function getAvatar(avatarId: string): Promise<AvatarRecord | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  return result.Item as AvatarRecord | null;
}

/**
 * Update an avatar
 */
export async function updateAvatar(
  avatarId: string,
  updates: Partial<Pick<
    AvatarRecord,
    'name'
    | 'description'
    | 'persona'
    | 'platforms'
    | 'llmConfig'
    | 'status'
    | 'profileImage'
    | 'characterReference'
    | 'mediaConfig'
    | 'voiceConfig'
    | 'stickerPack'
  >>,
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  // Block persona and profile image updates for ascended avatars (permanently locked)
  if (existing.isAscended) {
    if (updates.persona !== undefined) {
      throw new Error('Cannot update persona of ascended avatar - it is permanently locked');
    }
    if (updates.profileImage !== undefined) {
      throw new Error('Cannot update profile image of ascended avatar - it is permanently locked');
    }
  }

  // Filter out undefined values to avoid overwriting existing fields
  const cleanUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, v]) => v !== undefined)
  );

  const updated: AvatarRecord = {
    ...existing,
    ...cleanUpdates,
    platforms: updates.platforms
      ? {
          ...existing.platforms,
          ...updates.platforms,
          telegram: updates.platforms.telegram
            ? { ...(existing.platforms.telegram ?? {}), ...updates.platforms.telegram }
            : existing.platforms.telegram,
          twitter: updates.platforms.twitter
            ? { ...(existing.platforms.twitter ?? {}), ...updates.platforms.twitter }
            : existing.platforms.twitter,
          discord: updates.platforms.discord
            ? { ...(existing.platforms.discord ?? {}), ...updates.platforms.discord }
            : existing.platforms.discord,
          web: updates.platforms.web
            ? { ...(existing.platforms.web ?? {}), ...updates.platforms.web }
            : existing.platforms.web,
        }
      : existing.platforms,
    voiceConfig: updates.voiceConfig
      ? { ...(existing.voiceConfig ?? {}), ...updates.voiceConfig }
      : existing.voiceConfig,
    updatedAt: Date.now(),
    updatedBy: session.email,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: updated,
  }));

  // Sync to state table so handlers can access it
  await syncAvatarConfig(updated);

  // Register home channel if configured
  const telegramConfig = updated.platforms?.telegram;
  if (telegramConfig?.homeChannelId && telegramConfig?.botUsername) {
    try {
      await registerHomeChannel(
        avatarId,
        telegramConfig.homeChannelId,
        telegramConfig.botUsername,
        telegramConfig.homeChannelUsername
      );
    } catch (err) {
      console.warn(`[Avatars] Failed to register home channel for ${avatarId}:`, err instanceof Error ? err.message : String(err));
      // Don't fail the update if home channel registration fails
    }
  }

  // Treat allowedChatIds as global home channels.
  // NOTE: This is intentionally add-only; we do not auto-unregister on config changes
  // to avoid removing channels still used by other avatars.
  if (telegramConfig?.botUsername && telegramConfig?.allowedChatIds && telegramConfig.allowedChatIds.length > 0) {
    const botUsername = telegramConfig.botUsername;
    const results = await Promise.allSettled(
      telegramConfig.allowedChatIds.map((chatId) =>
        registerHomeChannel(avatarId, chatId, botUsername)
      )
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      console.warn(`[Avatars] Failed to register some allowedChatIds as home channels for ${avatarId} (${failures.length}/${results.length})`);
    }
  }

  return updated;
}

/**
 * List all avatars
 */
export async function listAvatars(): Promise<AvatarRecord[]> {
  // Query GSI1 (sk -> pk) for CONFIG records and AVATAR# keys.
  const items: AvatarRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'sk = :sk AND begins_with(pk, :avatarPrefix)',
      FilterExpression: '#status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':avatarPrefix': 'AVATAR#',
        ':deleted': 'deleted',
      },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...((result.Items as AvatarRecord[]) || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

/**
 * List avatars owned by a specific wallet
 * Returns avatars where creatorWallet matches.
 */
export async function listAvatarsByWallet(walletAddress: string): Promise<AvatarRecord[]> {
  // Query GSI1 for avatar configs, then filter by creator wallet.
  const items: AvatarRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'sk = :sk AND begins_with(pk, :avatarPrefix)',
      FilterExpression: '#status <> :deleted AND creatorWallet = :wallet',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':avatarPrefix': 'AVATAR#',
        ':deleted': 'deleted',
        ':wallet': walletAddress,
      },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...((result.Items as AvatarRecord[]) || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

/**
 * Delete an avatar (soft delete)
 */
export async function deleteAvatar(
  avatarId: string,
  session: UserSession
): Promise<void> {
  const existing = await getAvatar(avatarId);
  if (existing?.creatorWallet && existing.status !== 'deleted') {
    await decrementCreatorCount(existing.creatorWallet);
  }

  // Unregister home channel if configured
  try {
    await removeAvatarFromAllHomeChannels(avatarId);
  } catch (err) {
    console.warn(`[Avatars] Failed to unregister home channel for ${avatarId}:`, err instanceof Error ? err.message : String(err));
    // Don't fail the delete if home channel unregistration fails
  }

  // Clean up Secrets Manager secrets to avoid ongoing per-secret charges
  try {
    await deleteAllAvatarSecrets(avatarId, session);
  } catch (err) {
    console.warn(`[Avatars] Failed to clean up secrets for ${avatarId}:`, err instanceof Error ? err.message : String(err));
    // Don't fail the delete if secret cleanup fails
  }

  await updateAvatar(avatarId, { status: 'deleted' }, session);
}

/**
 * Configure Telegram for an avatar
 */
export async function configureTelegram(
  avatarId: string,
  botUsername: string,
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  return updateAvatar(avatarId, {
    platforms: {
      ...existing.platforms,
      telegram: {
        enabled: true,
        botUsername,
      },
    },
  }, session);
}

/**
 * Configure Twitter for an avatar
 */
export async function configureTwitter(
  avatarId: string,
  username: string,
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  return updateAvatar(avatarId, {
    platforms: {
      ...existing.platforms,
      twitter: {
        enabled: true,
        username,
      },
    },
  }, session);
}

/**
 * Configure Discord for an avatar
 */
export async function configureDiscord(
  avatarId: string,
  guildId: string | undefined,
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  return updateAvatar(avatarId, {
    platforms: {
      ...existing.platforms,
      discord: {
        enabled: true,
        guildId,
      },
    },
  }, session);
}

/**
 * Reassign avatar ownership (admin-only)
 * Handles slot count adjustments when changing creatorWallet
 */
export async function reassignAvatar(
  avatarId: string,
  updates: {
    creatorWallet?: string;
  },
  session: UserSession
): Promise<AvatarRecord> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  const now = Date.now();
  const oldCreatorWallet = existing.creatorWallet;
  const newCreatorWallet = updates.creatorWallet;

  // Handle slot count adjustments when creatorWallet changes
  if (newCreatorWallet && newCreatorWallet !== oldCreatorWallet) {
    // Decrement old creator's count (frees up their slot)
    if (oldCreatorWallet) {
      await decrementCreatorCount(oldCreatorWallet);
    }
    // Increment new creator's count
    await incrementCreatorCount(newCreatorWallet);

    // Clear Stripe customer/subscription data from existing entitlements
    // to prevent the new owner from inheriting the previous owner's
    // Stripe billing context.
    try {
      await clearStripeDataForAvatar(avatarId, session.email);
    } catch (err) {
      console.warn(
        `[Avatars] Failed to clear Stripe data during reassignment for ${avatarId}:`,
        err instanceof Error ? err.message : String(err)
      );
      // Don't fail the reassignment if Stripe cleanup fails
    }
  }

  // Build the update
  const updated: AvatarRecord = {
    ...existing,
    updatedAt: now,
    updatedBy: session.email,
  };

  if (newCreatorWallet !== undefined) {
    updated.creatorWallet = newCreatorWallet;
  }

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: updated,
  }));

  // Sync to state table
  await syncAvatarConfig(updated);

  return updated;
}

// =============================================================================
// NFT Collection Avatar Support
// =============================================================================

/**
 * Create avatar from NFT result
 */
export interface CreateAvatarFromNFTResult {
  success: boolean;
  avatar?: AvatarRecord;
  gateStatus?: GateStatus;
  error?: 'no_gate_slot' | 'nft_already_claimed' | 'nft_not_in_collection' | 'nft_not_owned';
}

/**
 * Create a new avatar from an NFT in a whitelisted collection
 * Uses the normal slot system (free + Orb NFTs)
 */
export async function createAvatarFromNFT(
  nft: ClaimableNFT,
  creatorWallet: string
): Promise<CreateAvatarFromNFTResult> {
  // 1. Verify collection is whitelisted
  if (!isCollectionWhitelisted(nft.collection)) {
    console.log(`[Avatars] Collection ${nft.collection} is not whitelisted`);
    return {
      success: false,
      error: 'nft_not_in_collection',
    };
  }

  // 2. Verify NFT not already claimed
  if (await isNFTClaimed(nft.mint)) {
    console.log(`[Avatars] NFT ${nft.mint.slice(0, 8)}... already claimed as avatar`);
    return {
      success: false,
      error: 'nft_already_claimed',
    };
  }

  // 3. Verify wallet owns this NFT
  if (!(await verifyNFTOwnership(creatorWallet, nft.mint))) {
    console.log(`[Avatars] Wallet ${creatorWallet.slice(0, 8)}... does not own NFT ${nft.mint.slice(0, 8)}...`);
    return {
      success: false,
      error: 'nft_not_owned',
    };
  }

  // 4. Check gate status (uses normal slot system)
  const gateStatus = await getGateStatus(creatorWallet);
  if (!gateStatus.canCreate) {
    console.log(`[Avatars] No gate slot for wallet=${creatorWallet.slice(0, 8)}...`);
    return {
      success: false,
      error: 'no_gate_slot',
      gateStatus,
    };
  }

  // 5. Generate avatar ID from NFT name
  const avatarId = generateAvatarId(nft.name);
  const now = Date.now();

  // Determine slot type: first avatar = free, subsequent = orb
  const slotType: 'free' | 'orb' = gateStatus.avatarsCreated === 0 ? 'free' : 'orb';

  // Build description from NFT metadata
  const description = nft.description || `Avatar created from NFT: ${nft.name}`;

  // Build persona from NFT personality trait and other attributes
  let persona: string | undefined;
  if (nft.personality) {
    // Use the personality trait as the core persona
    persona = nft.personality;

    // Optionally enrich with other attributes
    if (nft.attributes && nft.attributes.length > 0) {
      const otherTraits = nft.attributes
        .filter((attr) => attr.trait_type?.toLowerCase() !== 'personality')
        .map((attr) => `${attr.trait_type}: ${attr.value}`)
        .join(', ');
      if (otherTraits) {
        persona = `${persona}\n\nTraits: ${otherTraits}`;
      }
    }
  }

  const avatar: AvatarRecord = {
    pk: `AVATAR#${avatarId}`,
    sk: 'CONFIG',
    avatarId,
    name: nft.name,
    description,
    persona,
    platforms: {},
    voiceConfig: {
      enabled: true,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: DEFAULT_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      useGlobalKey: true,
    },
    // Set profile image from NFT
    profileImage: nft.image ? {
      url: nft.image,
      s3Key: '', // External URL, not in S3
      updatedAt: now,
    } : undefined,
    // NFT-backing fields
    nftMint: nft.mint,
    nftCollection: nft.collection,
    nftName: nft.name,
    nftImage: nft.image,
    // Ownership tracking
    creatorWallet,
    slotType,
    healthStatus: 'healthy',
    currentEra: 0,
    status: 'draft',
    createdAt: now,
    createdBy: creatorWallet,
    updatedAt: now,
    updatedBy: creatorWallet,
  };

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: avatar,
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      // Rare case: avatar ID collision
      return { success: false, error: 'nft_already_claimed', gateStatus };
    }
    throw err;
  }

  await incrementCreatorCount(creatorWallet);

  // Sync to state table
  await syncAvatarConfig(avatar);

  console.log(`[Avatars] Created NFT avatar=${avatarId} from mint=${nft.mint.slice(0, 8)}... by wallet=${creatorWallet.slice(0, 8)}...`);

  return {
    success: true,
    avatar,
    gateStatus: await getGateStatus(creatorWallet),
  };
}

/**
 * Get an avatar with NFT ownership verification
 * For NFT-backed avatars, verifies the wallet still owns the NFT
 * Returns null if the avatar is inaccessible (NFT sold)
 */
export async function getAvatarWithOwnershipCheck(
  avatarId: string,
  walletAddress: string
): Promise<AvatarRecord | null> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    return null;
  }

  // If not NFT-backed, standard access rules apply
  if (!avatar.nftMint) {
    return avatar;
  }

  // For NFT-backed avatars, verify current ownership
  const stillOwns = await verifyNFTOwnership(walletAddress, avatar.nftMint);
  if (!stillOwns) {
    console.log(
      `[Avatars] NFT ownership lost: avatar=${avatarId}, nft=${avatar.nftMint.slice(0, 8)}..., wallet=${walletAddress.slice(0, 8)}...`
    );
    return null; // Avatar inaccessible - NFT was sold
  }

  return avatar;
}

/**
 * Find avatar by NFT mint address
 */
export async function getAvatarByNFTMint(mintAddress: string): Promise<AvatarRecord | null> {
  try {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'sk = :sk AND nftMint = :mint AND #status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':mint': mintAddress,
        ':deleted': 'deleted',
      },
      Limit: 1,
    }));

    if (result.Items && result.Items.length > 0) {
      return result.Items[0] as AvatarRecord;
    }
    return null;
  } catch (error) {
    console.error('[Avatars] Error finding avatar by NFT mint:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

// =============================================================================
// Telegram Bot Creator Support
// =============================================================================

/**
 * Create avatar from Telegram result
 */
export interface CreateAvatarFromTelegramResult {
  success: boolean;
  avatarId?: string;
  avatar?: AvatarRecord;
  error?: 'token_already_used' | 'name_taken' | 'webhook_failed' | 'unknown';
  message?: string;
}

/**
 * Create avatar from Telegram params
 */
export interface CreateAvatarFromTelegramParams {
  /** Bot token from BotFather */
  botToken: string;
  /** Bot username (without @) */
  botUsername: string;
  /** Bot ID (numeric) */
  botId: number;
  /** Display name for the avatar */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional persona/personality */
  persona?: string;
  /** Telegram user ID of the creator */
  telegramUserId: string;
  /** Telegram username of the creator (without @) */
  telegramUsername?: string;
}

/**
 * Create a new avatar from Telegram bot creation flow.
 * This is the entry point for creating bots via the @ratibots admin bot.
 *
 * Key differences from wallet-based creation:
 * - No NFT gating required
 * - Bot token provided by user (from BotFather)
 * - Webhook is automatically registered
 * - Secrets are stored automatically
 * - One bot per Telegram user limit (enforced by caller)
 */
export async function createAvatarFromTelegram(
  params: CreateAvatarFromTelegramParams
): Promise<CreateAvatarFromTelegramResult> {
  const {
    botToken,
    botUsername,
    botId,
    name,
    description,
    persona,
    telegramUserId,
    telegramUsername,
  } = params;

  // Generate avatar ID from bot username (more predictable than name)
  const avatarId = botUsername.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const now = Date.now();

  // Create a pseudo-session for the Telegram user
  const session: UserSession = {
    email: `telegram:${telegramUserId}`,
    userId: `telegram:${telegramUserId}`,
    isAdmin: false,
    accessToken: 'telegram-flow', // Not used for Telegram auth
  };

  // 1. Check if bot token is already registered (by checking if avatar with this botId exists)
  const existingByBotId = await findAvatarByTelegramBotId(botId);
  if (existingByBotId) {
    console.log(`[Avatars] Bot ${botUsername} (ID: ${botId}) already registered as avatar ${existingByBotId.avatarId}`);
    return {
      success: false,
      error: 'token_already_used',
      message: 'This bot is already registered with another account.',
    };
  }

  // 2. Register webhook first (fail fast if this doesn't work)
  const webhookSecret = generateWebhookSecret();
  const webhookResult = await registerTelegramWebhook(botToken, avatarId, webhookSecret);

  if (!webhookResult.success) {
    console.error(`[Avatars] Failed to register webhook for ${botUsername}:`, webhookResult.message);
    return {
      success: false,
      error: 'webhook_failed',
      message: webhookResult.message || 'Failed to register Telegram webhook',
    };
  }

  // 3. Create the avatar record
  const avatar: AvatarRecord = {
    pk: `AVATAR#${avatarId}`,
    sk: 'CONFIG',
    avatarId,
    name,
    description,
    persona,
    platforms: {
      telegram: {
        enabled: true,
        botUsername,
        botId,
      },
    },
    voiceConfig: {
      enabled: true,
      ttsProvider: 'voice-clone',
      format: 'ogg',
    },
    llmConfig: {
      provider: DEFAULT_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
      temperature: DEFAULT_LLM_TEMPERATURE,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      useGlobalKey: true,
    },
    // Track creator (Telegram user, not wallet)
    creatorWallet: undefined, // No wallet for Telegram-created bots
    slotType: 'free',
    healthStatus: 'healthy',
    currentEra: 0,
    status: 'draft',
    createdAt: now,
    createdBy: `telegram:${telegramUserId}${telegramUsername ? ` (@${telegramUsername})` : ''}`,
    updatedAt: now,
    updatedBy: session.email,
    // Add GSI for Telegram bot ID lookup
    gsi3pk: `TELEGRAM_BOT#${botId}`,
    gsi3sk: 'AVATAR',
  };

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: avatar,
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return {
        success: false,
        error: 'name_taken',
        message: `An avatar with ID "${avatarId}" already exists. Please choose a different bot username.`,
      };
    }
    throw err;
  }

  // 4. Store secrets
  await Promise.all([
    storeSecret(
      avatarId,
      'telegram_bot_token',
      'default',
      botToken,
      session,
      `Telegram bot token for ${avatarId}`
    ),
    storeSecret(
      avatarId,
      'telegram_webhook_secret',
      'default',
      webhookSecret,
      session,
      `Telegram webhook secret for ${avatarId}`
    ),
  ]);

  // 5. Sync to state table
  await syncAvatarConfig(avatar);

  console.log(`[Avatars] Created Telegram avatar=${avatarId} by telegram:${telegramUserId}`);

  return {
    success: true,
    avatarId,
    avatar,
  };
}

/**
 * Find avatar by Telegram bot ID
 */
export async function findAvatarByTelegramBotId(botId: number): Promise<AvatarRecord | null> {
  try {
    // First try GSI3 lookup (fast)
    const gsiResult = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'gsi3pk = :gsi3pk AND #status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':gsi3pk': `TELEGRAM_BOT#${botId}`,
        ':deleted': 'deleted',
      },
      Limit: 1,
    }));

    if (gsiResult.Items && gsiResult.Items.length > 0) {
      return gsiResult.Items[0] as AvatarRecord;
    }

    // Fallback: scan for botId in platforms.telegram.botId
    const scanResult = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'sk = :sk AND #status <> :deleted AND platforms.telegram.botId = :botId',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':deleted': 'deleted',
        ':botId': botId,
      },
      Limit: 1,
    }));

    if (scanResult.Items && scanResult.Items.length > 0) {
      return scanResult.Items[0] as AvatarRecord;
    }

    return null;
  } catch (error) {
    console.error('[Avatars] Error finding avatar by Telegram bot ID:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Update avatar for Telegram admin (simplified session)
 */
export async function updateAvatarFromTelegram(
  avatarId: string,
  updates: {
    name?: string;
    description?: string;
    persona?: string;
  },
  telegramUserId: string
): Promise<AvatarRecord> {
  const session: UserSession = {
    email: `telegram:${telegramUserId}`,
    userId: `telegram:${telegramUserId}`,
    isAdmin: false,
    accessToken: 'telegram-flow', // Not used for Telegram auth
  };

  return updateAvatar(avatarId, updates, session);
}

// ============================================================================
// Avatar Activation (M1 Deploy/Activate Flow)
// ============================================================================

export interface ActivationResult {
  success: boolean;
  error?: string;
}

/**
 * Activate an avatar for production use
 * Changes status from 'draft' or 'paused' to 'active'
 */
export async function activateAvatar(
  avatarId: string,
  actorId: string
): Promise<ActivationResult> {
  try {
    const now = Date.now();

    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: `
        SET #status = :active,
            activatedAt = :now,
            activatedBy = :actor,
            updatedAt = :now,
            updatedBy = :actor
      `,
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':now': now,
        ':actor': actorId,
      },
      ConditionExpression: 'attribute_exists(pk)',
    }));

    // Sync to state table
    const updated = await getAvatar(avatarId);
    if (updated) {
      await syncAvatarConfig(updated);
    }

    return { success: true };
  } catch (error) {
    console.error('[Avatars] Failed to activate avatar:', error instanceof Error ? error.message : String(error));
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Deactivate an avatar (pause it)
 * Changes status from 'active' to 'paused'
 */
export async function deactivateAvatar(
  avatarId: string,
  actorId: string
): Promise<ActivationResult> {
  try {
    const now = Date.now();

    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: `
        SET #status = :paused,
            updatedAt = :now,
            updatedBy = :actor
      `,
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':paused': 'paused',
        ':now': now,
        ':actor': actorId,
      },
      ConditionExpression: 'attribute_exists(pk)',
    }));

    // Sync to state table
    const updated = await getAvatar(avatarId);
    if (updated) {
      await syncAvatarConfig(updated);
    }

    return { success: true };
  } catch (error) {
    console.error('[Avatars] Failed to deactivate avatar:', error instanceof Error ? error.message : String(error));
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
