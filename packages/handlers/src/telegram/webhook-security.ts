/**
 * Webhook Security Module
 * Handles webhook secret verification, avatar config/status caching,
 * bot token management, and Telegram adapter lifecycle for the webhook handler.
 */
import { GetSecretValueCommand } from '@swarm/core';
import { getSecretsClient } from '../services/aws-clients.js';
import { timingSafeEqual } from 'crypto';
import {
  TelegramAdapter,
  createStateService,
  logger,
  type AvatarConfig,
} from '@swarm/core';
import { getTelegramBotTokenFromSecrets } from './bot-token-secrets.js';

const secretsClient = getSecretsClient();

const STATE_TABLE = process.env.STATE_TABLE!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

const CONFIG_TTL_MS = 60_000;
const TOKEN_TTL_MS = 5 * 60_000;
const WEBHOOK_SECRET_TTL_MS = 5 * 60_000;

// Lazy-initialized services
let stateService: ReturnType<typeof createStateService>;

type AvatarStatus = 'draft' | 'active' | 'paused' | 'deleted';
type CachedAvatarConfig = {
  value: AvatarConfig;
  status?: AvatarStatus;
  expiresAt: number;
};

// Per-avatar caches
export const avatarConfigCache = new Map<string, CachedAvatarConfig>();
const telegramAdapterCache = new Map<string, { value: TelegramAdapter; expiresAt: number }>();
const botTokenCache = new Map<string, { value: string; expiresAt: number }>();
const webhookSecretCache = new Map<string, { value: string; expiresAt: number }>();

export async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
}

export function getStateService(): ReturnType<typeof createStateService> {
  return stateService;
}

export function setWebhookSecurityStateServiceForTest(service: ReturnType<typeof createStateService>): void {
  stateService = service;
}

export async function getWebhookSecret(avatarId: string): Promise<string | null> {
  const now = Date.now();
  const cached = webhookSecretCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  const secretName = `${SECRET_PREFIX}/${avatarId}/telegram_webhook_secret/default`;
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    const value = response.SecretString || '';
    if (!value) return null;
    webhookSecretCache.set(avatarId, { value, expiresAt: now + WEBHOOK_SECRET_TTL_MS });
    return value;
  } catch {
    return null;
  }
}

export function verifySecretToken(provided: string | undefined, expected: string): boolean {
  const providedBuf = Buffer.from(provided || '');
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export async function getAvatarConfig(avatarId: string): Promise<AvatarConfig | null> {
  const now = Date.now();
  const cached = avatarConfigCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  const result = await stateService.getAvatarConfigWithStatus(avatarId);
  if (!result) return null;

  avatarConfigCache.set(avatarId, {
    value: result.config,
    status: result.status,
    expiresAt: now + CONFIG_TTL_MS,
  });
  return result.config;
}

export function invalidateAvatarConfigCache(avatarId: string): void {
  avatarConfigCache.delete(avatarId);
}

export async function getAvatarStatus(avatarId: string): Promise<AvatarStatus> {
  const now = Date.now();
  const cached = avatarConfigCache.get(avatarId);
  if (cached && cached.expiresAt > now && cached.status) return cached.status;

  const result = await stateService.getAvatarConfigWithStatus(avatarId);
  if (!result) return 'draft';

  avatarConfigCache.set(avatarId, {
    value: result.config,
    status: result.status,
    expiresAt: now + CONFIG_TTL_MS,
  });
  return result.status;
}

export async function getBotToken(
  avatarId: string,
  options: { allowGlobalFallback?: boolean } = {}
): Promise<string | null> {
  const now = Date.now();
  const cacheKey = `${avatarId}:${options.allowGlobalFallback ? 'global' : 'avatar'}`;
  const cached = botTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const result = await getTelegramBotTokenFromSecrets(avatarId, {
    allowGlobalFallback: options.allowGlobalFallback,
  });
  if (!result) {
    logger.warn('Telegram bot token not found in Secrets Manager', {
      avatarId,
      allowGlobalFallback: Boolean(options.allowGlobalFallback),
    });
    return null;
  }

  logger.info('Successfully retrieved Telegram bot token', {
    avatarId,
    source: result.source,
    tokenLength: result.token.length,
  });
  botTokenCache.set(cacheKey, { value: result.token, expiresAt: now + TOKEN_TTL_MS });
  return result.token;
}

export async function getTelegramAdapter(avatarId: string, avatarConfig: AvatarConfig): Promise<TelegramAdapter | null> {
  const now = Date.now();
  const cached = telegramAdapterCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  const token = await getBotToken(avatarId, {
    allowGlobalFallback: Boolean(avatarConfig.platforms.telegram?.isAdminBot),
  });
  if (!token) return null;

  const adapter = new TelegramAdapter(avatarConfig, token);
  telegramAdapterCache.set(avatarId, { value: adapter, expiresAt: now + TOKEN_TTL_MS });
  return adapter;
}
