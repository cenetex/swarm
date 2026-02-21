/**
 * Telegram Admin Handler
 * Entry point for admin bot messages from the webhook handler
 */
import type { Update } from 'grammy/types';
import { logger, type AvatarConfig, type SwarmEnvelope, type CreateAvatarFromTelegramParams } from '@swarm/core';
import { createTelegramAdminService, type TelegramAdminService } from './telegram-admin.js';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getAdminTable } from './env-validation.js';

// Lazy-loaded admin-api operations (avoids static dependency on @swarm/admin-api)
let _adminOps: {
  createAvatarFromTelegram: (params: CreateAvatarFromTelegramParams) => Promise<{ success: boolean; avatarId?: string; error?: string; message?: string }>;
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
      getAvatar: mod.getAvatar as (id: string) => Promise<Record<string, unknown> | null>,
      updateAvatarFromTelegram: mod.updateAvatarFromTelegram,
    };
  }
  return _adminOps!;
}

const secretsClient = new SecretsManagerClient({});
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

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
    telegram?: { enabled: boolean; botUsername?: string };
    twitter?: { enabled: boolean; username?: string };
    discord?: { enabled: boolean };
  };
  profileImage?: { url: string };
};

/**
 * Get bot token from Secrets Manager
 */
async function getBotToken(avatarId: string): Promise<string | null> {
  const cached = botTokenCache.get(avatarId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const secretName = `${SECRET_PREFIX}/${avatarId}/telegram_bot_token/default`;
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    const token = response.SecretString || '';
    if (token) {
      botTokenCache.set(avatarId, { token, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Get or create an admin service instance
 */
async function getAdminService(avatarId: string, _avatarConfig: AvatarConfig): Promise<TelegramAdminService | null> {
  const cached = adminServiceCache.get(avatarId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.service;
  }

  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    logger.error('No bot token for admin bot', { avatarId });
    return null;
  }

  const service = createTelegramAdminService({
    adminTable: getAdminTable(),
    botToken,
    createAvatar: async (params: CreateAvatarFromTelegramParams) => {
      const ops = await getAdminOps();
      const result = await ops.createAvatarFromTelegram(params);
      return {
        success: result.success,
        avatarId: result.avatarId,
        error: result.message || result.error,
      };
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
