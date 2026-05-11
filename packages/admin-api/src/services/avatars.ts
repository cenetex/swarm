/**
 * Avatar Management Service
 */
import {
  DeleteCommand,
  PutCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  TransactWriteCommand,
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
  verifyNFTOwnership,
  isCollectionWhitelisted,
  type GateStatus,
  type ClaimableNFT,
} from './web3/nft-gate.js';
import { storeSecret, deleteAllAvatarSecrets, _getSecretValueInternal } from './secrets.js';
import { deleteTelegramWebhook } from './platform/telegram.js';
import {
  getCachedNFTOwner,
  invalidateNFTOwnerCache,
} from './nft-ownership-cache.js';
import { recordAuditEvent } from './audit-log.js';
import { registerTelegramWebhook, generateWebhookSecret } from './telegram.js';
import {
  registerHomeChannel,
  removeAvatarFromAllHomeChannels,
} from './home-channel.js';
import { clearStripeDataForAvatar } from './billing/entitlements.js';
import { getDynamoClient } from './dynamo-client.js';
import { emitAvatarCreated, emitAvatarCreationFailed } from './funnel-emitter.js';
import { createSystemLogger } from './structured-logger.js';

const log = createSystemLogger('avatar-service');

function getAdminTable(): string {
  return process.env.ADMIN_TABLE!;
}

async function releaseClaimedNFTMint(mintAddress: string): Promise<void> {
  await getDynamoClient().send(new DeleteCommand({
    TableName: getAdminTable(),
    Key: {
      pk: `CLAIMED_NFT#${mintAddress}`,
      sk: 'AVATAR',
    },
  }));
}

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

  await getDynamoClient().send(new PutCommand({
    TableName: getAdminTable(),
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
    log.info('create', 'no_gate_slot', {
      walletPrefix: creatorWallet.slice(0, 8),
      nftsHeld: gateStatus.nftsHeld,
      avatarsCreated: gateStatus.avatarsCreated,
    });
    // GTM funnel: F2 failure — no gate slot
    emitAvatarCreationFailed(creatorWallet, 'no_gate_slot', { nftsHeld: gateStatus.nftsHeld, avatarsCreated: gateStatus.avatarsCreated });
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
    await getDynamoClient().send(new PutCommand({
      TableName: getAdminTable(),
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

  log.info('create', 'avatar_created', {
    avatarId,
    walletPrefix: creatorWallet.slice(0, 8),
  });

  // GTM funnel: F2 — avatar created
  emitAvatarCreated(creatorWallet, avatarId, { creationMethod: 'wallet', slotType });

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
  const result = await getDynamoClient().send(new ScanCommand({
    TableName: getAdminTable(),
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
  const result = await getDynamoClient().send(new GetCommand({
    TableName: getAdminTable(),
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  return result.Item as AvatarRecord | null;
}

/**
 * System-level update of avatar profile image (no session required).
 * Used by async webhook handlers where no user session is available.
 */
export async function updateAvatarProfileImage(
  avatarId: string,
  profileImage: { url: string; s3Key: string; updatedAt: number }
): Promise<void> {
  const existing = await getAvatar(avatarId);
  if (!existing) {
    throw new Error(`Avatar not found: ${avatarId}`);
  }

  // Do not overwrite profile image on ascended avatars
  if (existing.isAscended) {
    log.warn('update', 'profile_image_skipped_ascended', { avatarId });
    return;
  }

  await getDynamoClient().send(new UpdateCommand({
    TableName: getAdminTable(),
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
    UpdateExpression: 'SET profileImage = :pi, updatedAt = :now',
    ExpressionAttributeValues: {
      ':pi': profileImage,
      ':now': Date.now(),
    },
  }));

  // Sync to state table
  const updated = await getAvatar(avatarId);
  if (updated) {
    await syncAvatarConfig(updated);
  }
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
    | 'systemPromptOverride'
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

  // Block persona, systemPromptOverride, and profile image updates for ascended
  // avatars (permanently locked — #1522 override is treated like persona).
  if (existing.isAscended) {
    if (updates.persona !== undefined) {
      throw new Error('Cannot update persona of ascended avatar - it is permanently locked');
    }
    if (updates.systemPromptOverride !== undefined) {
      throw new Error('Cannot update systemPromptOverride of ascended avatar - it is permanently locked');
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

  await getDynamoClient().send(new PutCommand({
    TableName: getAdminTable(),
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
      log.warn('home_channel', 'register_failed', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
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
      log.warn('home_channel', 'register_allowed_chat_ids_partial_failure', {
        avatarId,
        failed: failures.length,
        total: results.length,
      });
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
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: getAdminTable(),
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
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: getAdminTable(),
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

/** Injectable deps for deleteAvatar (test seam) */
export interface DeleteAvatarDeps {
  decrementCreatorCount: typeof decrementCreatorCount;
  removeAvatarFromAllHomeChannels: typeof removeAvatarFromAllHomeChannels;
  deleteAllAvatarSecrets: typeof deleteAllAvatarSecrets;
  getTelegramBotToken: (avatarId: string) => Promise<string | null>;
  deleteTelegramWebhook: typeof deleteTelegramWebhook;
}

const _defaultDeleteDeps: DeleteAvatarDeps = {
  decrementCreatorCount,
  removeAvatarFromAllHomeChannels,
  deleteAllAvatarSecrets,
  getTelegramBotToken: (avatarId: string) =>
    _getSecretValueInternal(avatarId, 'telegram_bot_token', 'default'),
  deleteTelegramWebhook,
};

/**
 * Delete an avatar (soft delete)
 */
export async function deleteAvatar(
  avatarId: string,
  session: UserSession,
  deps: DeleteAvatarDeps = _defaultDeleteDeps,
): Promise<void> {
  const existing = await getAvatar(avatarId);
  if (existing?.creatorWallet && existing.status !== 'deleted' && existing.slotType !== 'nft') {
    await deps.decrementCreatorCount(existing.creatorWallet);
  }

  // Unregister home channel if configured
  try {
    await deps.removeAvatarFromAllHomeChannels(avatarId);
  } catch (err) {
    log.warn('home_channel', 'unregister_failed', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Don't fail the delete if home channel unregistration fails
  }

  // Deregister the Telegram webhook before secrets are wiped — once the
  // bot token is gone we can't tell Telegram to stop POSTing updates to
  // the (now-orphaned) webhook URL.
  if (existing?.platforms?.telegram?.enabled) {
    try {
      const token = await deps.getTelegramBotToken(avatarId);
      if (token) {
        await deps.deleteTelegramWebhook(token);
      }
    } catch (err) {
      log.warn('delete', 'telegram_webhook_deregister_failed', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't fail the delete if Telegram is unreachable
    }
  }

  // Clean up Secrets Manager secrets to avoid ongoing per-secret charges
  try {
    await deps.deleteAllAvatarSecrets(avatarId, session);
  } catch (err) {
    log.warn('secrets', 'cleanup_failed', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Don't fail the delete if secret cleanup fails
  }

  await updateAvatar(avatarId, { status: 'deleted' }, session);

  if (existing?.nftMint) {
    await releaseClaimedNFTMint(existing.nftMint);
  }
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
      log.warn('reassign', 'clear_stripe_data_failed', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
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

  await getDynamoClient().send(new PutCommand({
    TableName: getAdminTable(),
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

export interface CreateAvatarFromNFTOptions {
  /**
   * Collection NFT-backed avatars use the NFT itself as the entitlement.
   * Leave true for legacy/manual claim behavior that consumes normal creator slots.
   */
  reserveCreatorSlot?: boolean;
}

/**
 * Create a new avatar from an NFT in a whitelisted collection
 * Uses the normal slot system by default. Bulk collection scans can bypass
 * creator slots because the source NFT is the entitlement.
 *
 * Atomicity guarantees:
 * - Slot reservation uses DynamoDB ConditionExpression (prevents oversubscription)
 * - Avatar creation + NFT claim use TransactWriteItems (prevents double-claim)
 */
export async function createAvatarFromNFT(
  nft: ClaimableNFT,
  creatorWallet: string,
  options: CreateAvatarFromNFTOptions = {}
): Promise<CreateAvatarFromNFTResult> {
  const reserveSlot = options.reserveCreatorSlot !== false;

  // 1. Verify collection is whitelisted
  if (!isCollectionWhitelisted(nft.collection)) {
    log.info('create_from_nft', 'collection_not_whitelisted', {
      collection: nft.collection,
    });
    return {
      success: false,
      error: 'nft_not_in_collection',
    };
  }

  // 2. Verify wallet owns this NFT
  if (!(await verifyNFTOwnership(creatorWallet, nft.mint))) {
    log.info('create_from_nft', 'nft_not_owned', {
      walletPrefix: creatorWallet.slice(0, 8),
      mintPrefix: nft.mint.slice(0, 8),
    });
    return {
      success: false,
      error: 'nft_not_owned',
    };
  }

  // 3. Atomically reserve a creator slot when using legacy/manual claim behavior.
  // Bulk scans bypass this because each whitelisted collection NFT is its own slot.
  let previousCreated = 0;
  if (reserveSlot) {
    const nftResult = await checkNFTGate(creatorWallet);
    const totalSlots = 1 + nftResult.ownedCount;

    const reservation = await reserveCreatorSlot(creatorWallet, totalSlots);
    if (!reservation.reserved) {
      const gateStatus = await getGateStatus(creatorWallet);
      log.info('create_from_nft', 'no_gate_slot', {
        walletPrefix: creatorWallet.slice(0, 8),
        nftsHeld: gateStatus.nftsHeld,
        avatarsCreated: gateStatus.avatarsCreated,
      });
      emitAvatarCreationFailed(creatorWallet, 'no_gate_slot', { nftsHeld: gateStatus.nftsHeld, avatarsCreated: gateStatus.avatarsCreated });
      return {
        success: false,
        error: 'no_gate_slot',
        gateStatus,
      };
    }
    previousCreated = reservation.previousCreated;
  }

  // 4. Generate avatar ID from NFT name
  const avatarId = generateAvatarId(nft.name);
  const now = Date.now();

  const slotType: 'free' | 'orb' | 'nft' = reserveSlot
    ? previousCreated === 0 ? 'free' : 'orb'
    : 'nft';

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

  // 5. Atomically create avatar + claim NFT mint (prevents double-claim)
  try {
    await getDynamoClient().send(new TransactWriteCommand({
      TransactItems: [
        {
          // Create the avatar record (fails if avatar ID already exists)
          Put: {
            TableName: getAdminTable(),
            Item: avatar,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          // Claim the NFT mint (fails if mint already claimed)
          Put: {
            TableName: getAdminTable(),
            Item: {
              pk: `CLAIMED_NFT#${nft.mint}`,
              sk: 'AVATAR',
              avatarId,
              creatorWallet,
              claimedAt: now,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TransactionCanceledException') {
      // Roll back the reserved slot since avatar creation failed
      if (reserveSlot) {
        await decrementCreatorCount(creatorWallet);
      }

      // Check which condition failed by inspecting the cancellation reasons
      const cancelReasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
      if (cancelReasons && cancelReasons.length >= 2) {
        // Index 1 = CLAIMED_NFT condition
        if (cancelReasons[1]?.Code === 'ConditionalCheckFailed') {
          log.info('create_from_nft', 'nft_already_claimed', {
            mintPrefix: nft.mint.slice(0, 8),
          });
          return { success: false, error: 'nft_already_claimed' };
        }
        // Index 0 = avatar ID condition (collision)
        if (cancelReasons[0]?.Code === 'ConditionalCheckFailed') {
          log.info('create_from_nft', 'avatar_id_collision', {
            avatarId,
            mintPrefix: nft.mint.slice(0, 8),
          });
          // Avatar ID collision is rare; caller can retry
          return { success: false, error: 'nft_already_claimed' };
        }
      }

      // Fallback: could not determine which condition failed
      log.info('create_from_nft', 'transaction_cancelled_treated_as_claimed', {
        mintPrefix: nft.mint.slice(0, 8),
      });
      return { success: false, error: 'nft_already_claimed' };
    }
    // Non-transaction error: roll back slot and re-throw
    if (reserveSlot) {
      await decrementCreatorCount(creatorWallet);
    }
    throw err;
  }

  // Sync to state table
  await syncAvatarConfig(avatar);

  // #1385: a fresh claim guarantees the NFT just moved — bust any cached
  // owner row so the first access goes to Helius instead of serving stale.
  try {
    await invalidateNFTOwnerCache(nft.mint);
  } catch (err) {
    log.warn('create_from_nft', 'invalidate_nft_owner_cache_failed', {
      mintPrefix: nft.mint.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('create_from_nft', 'avatar_created', {
    avatarId,
    mintPrefix: nft.mint.slice(0, 8),
    walletPrefix: creatorWallet.slice(0, 8),
  });

  // GTM funnel: F2 — avatar created from NFT
  emitAvatarCreated(creatorWallet, avatarId, { creationMethod: 'nft', slotType, nftCollection: nft.collection });

  return {
    success: true,
    avatar,
    gateStatus: await getGateStatus(creatorWallet),
  };
}

/**
 * Error thrown by `assertAvatarOwnership` when a caller cannot be granted
 * access to an avatar. The `code` field disambiguates the failure so the
 * caller can map it to an HTTP status:
 *
 *   - `not_found`                 → 404 (avatar does not exist)
 *   - `not_owner`                 → 404 (non-NFT avatar, creatorWallet mismatch)
 *   - `nft_revoked`               → 404 (NFT was transferred away from caller)
 *   - `verification_unavailable`  → 503 (Helius unreachable, fail-closed)
 *
 * Using 404 for both `not_owner` and `nft_revoked` preserves the existing
 * "don't leak existence to unauthorized callers" semantics of crud.ts.
 */
export type AvatarOwnershipErrorCode =
  | 'not_found'
  | 'not_owner'
  | 'nft_revoked'
  | 'verification_unavailable';

export class AvatarOwnershipError extends Error {
  readonly code: AvatarOwnershipErrorCode;

  constructor(params: { code: AvatarOwnershipErrorCode; message?: string }) {
    super(params.message ?? params.code);
    this.name = 'AvatarOwnershipError';
    this.code = params.code;
  }
}

/**
 * Best-effort audit event for an ownership-denial branch. We extend the
 * existing AuditEventType union with `avatar_ownership_denied` elsewhere
 * (see audit-log.ts). Failures to record are swallowed — audit logging
 * must never take the request path down.
 */
async function recordOwnershipAudit(
  avatarId: string,
  actorId: string,
  code: AvatarOwnershipErrorCode,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await recordAuditEvent({
      avatarId,
      eventType: 'avatar_ownership_denied',
      actorId: actorId || 'unknown',
      actorType: 'owner',
      details: { code, ...extra },
    });
  } catch (err) {
    log.warn('ownership', 'audit_record_failed', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Unified avatar-access gate.
 *
 * This is the ONE entry point that every admin-api request path should use
 * to resolve an avatar on behalf of a caller. It handles:
 *
 *   - admin bypass (when `opts.isAdmin === true`)
 *   - non-NFT avatars — straight `creatorWallet === walletAddress` check
 *   - NFT-backed avatars — current on-chain owner compared against the
 *     caller, via the cached Helius lookup in `nft-ownership-cache.ts`.
 *     This re-verifies on every access (subject to the cache TTL) so that
 *     transferring the backing NFT revokes access within ~1 minute.
 *
 * Throws `AvatarOwnershipError` on any failure path so callers can map the
 * `code` to an HTTP status (see `AvatarOwnershipErrorCode`).
 */
export async function assertAvatarOwnership(
  avatarId: string,
  walletAddress: string,
  opts?: { isAdmin?: boolean },
): Promise<AvatarRecord> {
  const avatar = await getAvatar(avatarId);
  if (!avatar) {
    throw new AvatarOwnershipError({ code: 'not_found' });
  }

  // Admin bypass — same semantics as today's handler-level admin check.
  if (opts?.isAdmin === true) {
    return avatar;
  }

  // Non-NFT avatars: legacy creatorWallet-equality gate.
  if (!avatar.nftMint) {
    if (!walletAddress || avatar.creatorWallet !== walletAddress) {
      await recordOwnershipAudit(avatarId, walletAddress, 'not_owner');
      throw new AvatarOwnershipError({ code: 'not_owner' });
    }
    return avatar;
  }

  // NFT-backed avatars: re-verify current ownership via cached Helius.
  let currentOwner: string | null;
  try {
    currentOwner = await getCachedNFTOwner(avatar.nftMint);
  } catch (err) {
    await recordOwnershipAudit(avatarId, walletAddress, 'verification_unavailable', {
      mintPrefix: avatar.nftMint.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    throw new AvatarOwnershipError({ code: 'verification_unavailable' });
  }

  if (!walletAddress || currentOwner !== walletAddress) {
    await recordOwnershipAudit(avatarId, walletAddress, 'nft_revoked', {
      mintPrefix: avatar.nftMint.slice(0, 8),
      expectedWalletPrefix: walletAddress ? walletAddress.slice(0, 8) : null,
      actualOwnerPrefix: currentOwner ? currentOwner.slice(0, 8) : null,
    });
    throw new AvatarOwnershipError({ code: 'nft_revoked' });
  }

  return avatar;
}

/**
 * Get an avatar with NFT ownership verification.
 *
 * Now wired through `assertAvatarOwnership` (#1385). For NFT-backed avatars
 * this re-verifies ownership against Helius on every access (cached 60s).
 * Returns `null` when the caller does not currently have access; throws
 * only if the Helius lookup fails with no cached fallback.
 *
 * Prefer `assertAvatarOwnership` directly in new code — it surfaces the
 * specific failure (`not_found` vs `not_owner` vs `nft_revoked` vs
 * `verification_unavailable`) via `AvatarOwnershipError.code`. This helper
 * is kept for back-compat with earlier callers.
 */
export async function getAvatarWithOwnershipCheck(
  avatarId: string,
  walletAddress: string
): Promise<AvatarRecord | null> {
  try {
    return await assertAvatarOwnership(avatarId, walletAddress);
  } catch (err) {
    if (err instanceof AvatarOwnershipError) {
      if (err.code === 'verification_unavailable') throw err;
      return null;
    }
    throw err;
  }
}

/**
 * Find avatar by NFT mint address
 */
export async function getAvatarByNFTMint(mintAddress: string): Promise<AvatarRecord | null> {
  try {
    const result = await getDynamoClient().send(new ScanCommand({
      TableName: getAdminTable(),
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
    log.error('lookup', 'get_by_nft_mint_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
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
    log.info('create_from_telegram', 'bot_already_registered', {
      botUsername,
      botId,
      existingAvatarId: existingByBotId.avatarId,
    });
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
    log.error('create_from_telegram', 'webhook_registration_failed', {
      botUsername,
      message: webhookResult.message,
    });
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
    await getDynamoClient().send(new PutCommand({
      TableName: getAdminTable(),
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

  log.info('create_from_telegram', 'avatar_created', {
    avatarId,
    telegramUserId,
  });

  // GTM funnel: F2 — avatar created from Telegram
  emitAvatarCreated(`telegram:${telegramUserId}`, avatarId, { creationMethod: 'telegram', botUsername });

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
    const gsiResult = await getDynamoClient().send(new ScanCommand({
      TableName: getAdminTable(),
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
    const scanResult = await getDynamoClient().send(new ScanCommand({
      TableName: getAdminTable(),
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
    log.error('lookup', 'get_by_telegram_bot_id_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
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

    await getDynamoClient().send(new UpdateCommand({
      TableName: getAdminTable(),
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
    log.error('activation', 'activate_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
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

    await getDynamoClient().send(new UpdateCommand({
      TableName: getAdminTable(),
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
    log.error('activation', 'deactivate_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
