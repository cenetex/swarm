/**
 * Webhook Security Module
 * Handles webhook secret verification, avatar config/status caching,
 * bot token management, and Telegram adapter lifecycle for the webhook handler.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { timingSafeEqual } from 'crypto';
import {
  TelegramAdapter,
  createStateService,
  logger,
  type AvatarConfig,
} from '@swarm/core';

const secretsClient = new SecretsManagerClient({});

const STATE_TABLE = process.env.STATE_TABLE!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

const CONFIG_TTL_MS = 60_000;
const TOKEN_TTL_MS = 5 * 60_000;
const WEBHOOK_SECRET_TTL_MS = 5 * 60_000;

// Lazy-initialized services
let stateService: ReturnType<typeof createStateService>;

// Per-avatar caches
export const avatarConfigCache = new Map<string, { value: AvatarConfig; expiresAt: number }>();
const telegramAdapterCache = new Map<string, { value: TelegramAdapter; expiresAt: number }>();
const botTokenCache = new Map<string, { value: string; expiresAt: number }>();
const webhookSecretCache = new Map<string, { value: string; expiresAt: number }>();

type AvatarStatus = 'draft' | 'active' | 'paused' | 'deleted';
const avatarStatusCache = new Map<string, { value: AvatarStatus; expiresAt: number }>();

export async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
}

export function getStateService(): ReturnType<typeof createStateService> {
  return stateService;
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

  const config = await stateService.getAvatarConfig(avatarId);
  if (!config) return null;

  avatarConfigCache.set(avatarId, { value: config, expiresAt: now + CONFIG_TTL_MS });
  return config;
}

export function invalidateAvatarConfigCache(avatarId: string): void {
  avatarConfigCache.delete(avatarId);
}

export async function getAvatarStatus(avatarId: string): Promise<AvatarStatus> {
  const now = Date.now();
  const cached = avatarStatusCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  const result = await stateService.getAvatarConfigWithStatus(avatarId);
  const status = result?.status || 'draft';

  avatarStatusCache.set(avatarId, { value: status, expiresAt: now + CONFIG_TTL_MS });
  return status;
}

export async function getBotToken(avatarId: string): Promise<string | null> {
  const now = Date.now();
  const cached = botTokenCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  // Use direct Secrets Manager path (same pattern as getWebhookSecret)
  const secretName = `${SECRET_PREFIX}/${avatarId}/telegram_bot_token/default`;
  try {
    logger.info('Fetching bot token from Secrets Manager', { avatarId, secretName });
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    const token = response.SecretString || '';
    if (!token) {
      logger.warn('Bot token secret is empty', { avatarId, secretName });
      return null;
    }
    logger.info('Successfully retrieved bot token', { avatarId, tokenLength: token.length });
    botTokenCache.set(avatarId, { value: token, expiresAt: now + TOKEN_TTL_MS });
    return token;
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string; code?: string; $metadata?: unknown };
    logger.error('Failed to get bot token from Secrets Manager', undefined, {
      avatarId,
      secretName,
      errorMessage: err.message || 'Unknown error',
      errorName: err.name || 'Unknown',
      errorCode: err.code,
      metadata: err.$metadata ? JSON.stringify(err.$metadata) : undefined,
    });
    return null;
  }
}

export async function getTelegramAdapter(avatarId: string, avatarConfig: AvatarConfig): Promise<TelegramAdapter | null> {
  const now = Date.now();
  const cached = telegramAdapterCache.get(avatarId);
  if (cached && cached.expiresAt > now) return cached.value;

  const token = await getBotToken(avatarId);
  if (!token) return null;

  const adapter = new TelegramAdapter(avatarConfig, token);
  telegramAdapterCache.set(avatarId, { value: adapter, expiresAt: now + TOKEN_TTL_MS });
  return adapter;
}
