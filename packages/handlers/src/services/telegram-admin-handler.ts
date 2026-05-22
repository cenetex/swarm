/**
 * Telegram Admin Handler
 * Entry point for admin bot messages from the webhook handler
 */
import type { Update } from 'grammy/types';
import { logger, type AvatarConfig, type SwarmEnvelope, type CreateAvatarFromTelegramParams } from '@swarm/core';
import { createTelegramAdminService, type TelegramAdminService } from './telegram-admin.js';
import { getAdminTable } from './env-validation.js';
import { getTelegramBotTokenFromSecrets } from '../telegram/bot-token-secrets.js';

// Lazy-loaded admin-api operations (avoids static dependency on @swarm/admin-api)
let _adminOps: {
  createAvatarFromTelegram: (params: CreateAvatarFromTelegramParams) => Promise<{ success: boolean; avatarId?: string; error?: string; message?: string }>;
  getManagedBotToken: (managerBotToken: string, managedBotUserId: number) => Promise<{ success: boolean; token?: string; error?: string }>;
  getAvatar: (id: string) => Promise<Record<string, unknown> | null>;
  updateAvatarFromTelegram: (id: string, updates: { name?: string; description?: string; persona?: string }, by: string) => Promise<unknown>;
} | null = null;

async function getAdminOps() {
  if (!_adminOps) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - dynamic import avoids static dependency on admin-api
    const mod = await import('@swarm/admin-api');
    _adminOps = {
      createAvatarFromTelegram: mod.createAvatarFromTelegram,
      getManagedBotToken: mod.getManagedBotToken,
      getAvatar: mod.getAvatar as (id: string) => Promise<Record<string, unknown> | null>,
      updateAvatarFromTelegram: mod.updateAvatarFromTelegram,
    };
  }
  return _adminOps!;
}

// Cache for admin service instances
const adminServiceCache = new Map<string, { service: TelegramAdminService; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cache for bot tokens
const botTokenCache = new Map<string, { token: string; expiresAt: number }>();

type TelegramAdminAvatar = {
  avatarId: string;
  name: string;
  description?: string;
  persona?: string;
  platforms?: {
    telegram?: { enabled: boolean; botUsername?: string; isAdminBot?: boolean; allowAllDms?: boolean };
    twitter?: { enabled: boolean; username?: string };
    discord?: { enabled: boolean };
  };
  profileImage?: { url: string };
};

/**
 * Get bot token from Secrets Manager
 */
async function getBotToken(avatarId: string, allowGlobalFallback = false): Promise<string | null> {
  const cacheKey = `${avatarId}:${allowGlobalFallback ? 'global' : 'avatar'}`;
  const cached = botTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const result = await getTelegramBotTokenFromSecrets(avatarId, { allowGlobalFallback });
  if (result?.token) {
    botTokenCache.set(cacheKey, { token: result.token, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return result?.token || null;
}

/**
 * Get or create an admin service instance
 */
async function getAdminService(avatarId: string, _avatarConfig: AvatarConfig): Promise<TelegramAdminService | null> {
  const cached = adminServiceCache.get(avatarId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.service;
  }

  const botToken = await getBotToken(avatarId, Boolean(_avatarConfig.platforms.telegram?.isAdminBot));
  if (!botToken) {
    logger.error('No bot token for admin bot', {
      avatarId,
      allowGlobalFallback: Boolean(_avatarConfig.platforms.telegram?.isAdminBot),
    });
    return null;
  }

  const service = createTelegramAdminService({
    adminTable: getAdminTable(),
    botToken,
    managerBotUsername: _avatarConfig.platforms.telegram?.botUsername,
    createAvatar: async (params: CreateAvatarFromTelegramParams) => {
      const ops = await getAdminOps();
      const result = await ops.createAvatarFromTelegram(params);
      return {
        success: result.success,
        avatarId: result.avatarId,
        error: result.message || result.error,
      };
    },
    getManagedBotToken: async (managedBotUserId: number) => {
      const ops = await getAdminOps();
      return ops.getManagedBotToken(botToken, managedBotUserId);
    },
    getAvatar: async (id: string) => {
      const ops = await getAdminOps();
      const avatar = await ops.getAvatar(id) as TelegramAdminAvatar | null;
      if (!avatar) return null;
      return {
        avatarId: avatar.avatarId,
        name: avatar.name,
        description: avatar.description,
        persona: avatar.persona,
        platforms: {
          telegram: avatar.platforms?.telegram
            ? {
                enabled: avatar.platforms.telegram.enabled,
                botUsername: avatar.platforms.telegram.botUsername,
                isAdminBot: avatar.platforms.telegram.isAdminBot,
                allowAllDms: avatar.platforms.telegram.allowAllDms,
              }
            : undefined,
          twitter: avatar.platforms?.twitter
            ? {
                enabled: avatar.platforms.twitter.enabled,
                username: avatar.platforms.twitter.username,
              }
            : undefined,
          discord: avatar.platforms?.discord
            ? {
                enabled: avatar.platforms.discord.enabled,
              }
            : undefined,
        },
        profileImage: avatar.profileImage,
      };
    },
    updateAvatar: async (id: string, updates: { name?: string; description?: string; persona?: string }) => {
      const ops = await getAdminOps();
      await ops.updateAvatarFromTelegram(id, updates, 'admin-service');
    },
  });

  adminServiceCache.set(avatarId, { service, expiresAt: Date.now() + CACHE_TTL_MS });
  return service;
}

/**
 * Process an admin bot message (DM)
 * Called from the webhook handler for admin bot DMs
 */
export async function processAdminMessage(
  avatarId: string,
  avatarConfig: AvatarConfig,
  envelope: SwarmEnvelope
): Promise<void> {
  const service = await getAdminService(avatarId, avatarConfig);
  if (!service) {
    logger.error('Failed to initialize admin service', { avatarId });
    return;
  }

  await service.processMessage(envelope);
}

/**
 * Process an admin bot callback query (inline button press)
 * Called from the webhook handler for admin bot callback queries
 */
export async function processAdminCallbackQuery(
  avatarId: string,
  avatarConfig: AvatarConfig,
  update: unknown
): Promise<void> {
  const service = await getAdminService(avatarId, avatarConfig);
  if (!service) {
    logger.error('Failed to initialize admin service', { avatarId });
    return;
  }

  await service.processUpdate(update as Update);
}

/**
 * Process an admin bot managed-bot update.
 * Called from the webhook handler when Telegram reports a managed bot creation.
 */
export async function processAdminManagedBotUpdate(
  avatarId: string,
  avatarConfig: AvatarConfig,
  update: unknown
): Promise<void> {
  const service = await getAdminService(avatarId, avatarConfig);
  if (!service) {
    logger.error('Failed to initialize admin service', { avatarId });
    return;
  }

  await service.processManagedBotUpdate(update);
}
