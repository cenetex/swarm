/**
 * Tests for avatar-routes/secrets.ts — audit logging coverage.
 *
 * Routes:
 *   POST /avatars/{id}/secrets
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let storeSecretCalls: unknown[][] = [];
let recordAuditEventCalls: unknown[] = [];
let setupTelegramResult: unknown = { success: true, status: null };

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
  updateAvatar: async (..._args: unknown[]) => ({}),
}));

vi.mock('../../services/secrets.js', () => ({
  storeSecret: async (...args: unknown[]) => {
    storeSecretCalls.push(args);
  },
  listSecrets: async () => [],
}));

vi.mock('../../services/audit-log.js', () => ({
  recordAuditEvent: async (params: unknown) => {
    recordAuditEventCalls.push(params);
    return { id: 'audit-mock', ...params as Record<string, unknown>, timestamp: Date.now() };
  },
}));

vi.mock('../../services/discord.js', () => ({
  validateBotToken: async () => ({ valid: true, warnings: [] }),
  validateWebhookUrl: async () => ({ valid: true }),
}));

vi.mock('@swarm/core', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
  // Transitive exports needed when handlers import services that depend on @swarm/core
  createSqsOffloadServiceFromEnv: () => null,
  createGallerySaver: () => ({ save: () => Promise.resolve() }),
  LLMError: class LLMError extends Error { code: string; constructor(msg: string, opts?: any) { super(msg); this.code = opts?.code ?? ''; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_ADAPTER_NOT_FOUND: 'PLATFORM_ADAPTER_NOT_FOUND',
    PLATFORM_CONFIG_INVALID: 'PLATFORM_CONFIG_INVALID',
    PLATFORM_AUTH_FAILED: 'PLATFORM_AUTH_FAILED',
    PLATFORM_CONNECTION_FAILED: 'PLATFORM_CONNECTION_FAILED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_INVALID: 'PLATFORM_WEBHOOK_INVALID',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_INVALID_SCHEMA: 'LLM_INVALID_SCHEMA',
    CONFIG_MISSING_REQUIRED_FIELD: 'CONFIG_MISSING_REQUIRED_FIELD',
    CONFIG_INVALID_ENUM_VALUE: 'CONFIG_INVALID_ENUM_VALUE',
    CONFIG_NESTED_OBJECT_INVALID: 'CONFIG_NESTED_OBJECT_INVALID',
    STATE_SERIALIZATION_FAILED: 'STATE_SERIALIZATION_FAILED',
    STATE_DESERIALIZATION_FAILED: 'STATE_DESERIALIZATION_FAILED',
    MEDIA_PROVIDER_ERROR: 'MEDIA_PROVIDER_ERROR',
    MEDIA_UPLOAD_FAILED: 'MEDIA_UPLOAD_FAILED',
    MEDIA_DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_EXPIRED_TOKEN: 'AUTH_EXPIRED_TOKEN',
    AUTH_INSUFFICIENT_PERMISSIONS: 'AUTH_INSUFFICIENT_PERMISSIONS',
    QUEUE_SEND_FAILED: 'QUEUE_SEND_FAILED',
    QUEUE_RECEIVE_FAILED: 'QUEUE_RECEIVE_FAILED',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
    NETWORK_CONNECTION_ERROR: 'NETWORK_CONNECTION_ERROR',
  },
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────
import { handleSecretsRoutes } from './secrets.js';
import { makeCtx, MOCK_AVATAR } from './test-helpers.js';
import * as telegramService from '../../services/telegram.js';
import * as telegramAdminService from '../../services/telegram-admin.js';
import * as replicateService from '../../services/replicate.js';

beforeEach(() => {
  getAvatarResult = null;
  storeSecretCalls = [];
  recordAuditEventCalls = [];
  setupTelegramResult = { success: true, status: null };
  vi.spyOn(telegramService, 'validateTelegramToken').mockResolvedValue({ valid: true } as never);
  vi.spyOn(telegramService, 'registerTelegramWebhook').mockResolvedValue({ success: true } as never);
  vi.spyOn(telegramService, 'generateWebhookSecret').mockReturnValue('mock-webhook-secret');
  vi.spyOn(telegramAdminService, 'setupTelegramIntegration').mockImplementation(
    async () => setupTelegramResult as never
  );
  vi.spyOn(replicateService, 'validateReplicateApiKey').mockResolvedValue({ valid: true } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// Audit logging on secret set
// =========================================================================
describe('audit logging on secret set', () => {
  it('records secret_set audit event for a standard secret', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/secrets',
      body: JSON.stringify({ key: 'openai_api_key', value: 'sk-test-key' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleSecretsRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);

    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('avatar-1');
    expect(call.eventType).toBe('secret_set');
    expect(call.actorId).toBe('wallet-1');
    expect(call.actorType).toBe('owner');
    const details = call.details as Record<string, unknown>;
    expect(details.secretKey).toBe('openai_api_key');
    // Secret value must NOT appear in audit details
    expect(details).not.toHaveProperty('value');
  });

  it('records secret_set audit event for telegram token via setupTelegramIntegration', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    setupTelegramResult = { success: true, status: { webhookUrl: 'https://hook', webhookInfo: {} } };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/secrets',
      body: JSON.stringify({ key: 'telegram_bot_token', value: '123456:ABC-DEF' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleSecretsRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);

    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('avatar-1');
    expect(call.eventType).toBe('secret_set');
    const details = call.details as Record<string, unknown>;
    expect(details.secretKey).toBe('telegram_bot_token');
  });

  it('does not record audit event when secret validation fails', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/secrets',
      body: JSON.stringify({ key: 'invalid_key_type', value: 'test' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleSecretsRoutes(ctx);
    expect(result!.statusCode).toBe(400);
    expect(recordAuditEventCalls.length).toBe(0);
  });

  it('does not record audit event when telegram setup fails', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    setupTelegramResult = { success: false, error: 'Invalid token' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/secrets',
      body: JSON.stringify({ key: 'telegram_bot_token', value: 'bad-token' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleSecretsRoutes(ctx);
    expect(result!.statusCode).toBe(400);
    expect(recordAuditEventCalls.length).toBe(0);
  });

  it('records admin actor type when admin sets secret', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/secrets',
      body: JSON.stringify({ key: 'openai_api_key', value: 'sk-test-key' }),
      effectiveIsAdmin: true,
    });
    const result = await handleSecretsRoutes(ctx);
    expect(result!.statusCode).toBe(200);

    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.actorType).toBe('admin');
  });
});
