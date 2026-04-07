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
  createSqsOffloadServiceFromEnv: () => null,
  createCircuitBreaker: () => ({ canExecute: () => true, recordSuccess: () => {}, recordFailure: () => {}, state: () => 'closed' }),
  LLMError: class LLMError extends Error { constructor(message: string) { super(message); this.name = 'LLMError'; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_NOT_INITIALIZED: 'PLATFORM_NOT_INITIALIZED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_ERROR: 'PLATFORM_WEBHOOK_ERROR',
    PLATFORM_MEDIA_UPLOAD_ERROR: 'PLATFORM_MEDIA_UPLOAD_ERROR',
    PLATFORM_UNSUPPORTED_MEDIA: 'PLATFORM_UNSUPPORTED_MEDIA',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_TIMEOUT: 'LLM_TIMEOUT',
    CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
    CONFIG_VALIDATION_ERROR: 'CONFIG_VALIDATION_ERROR',
    CONFIG_MISSING_SECRET: 'CONFIG_MISSING_SECRET',
    STATE_READ_ERROR: 'STATE_READ_ERROR',
    STATE_WRITE_ERROR: 'STATE_WRITE_ERROR',
    MEDIA_GENERATION_ERROR: 'MEDIA_GENERATION_ERROR',
    MEDIA_FETCH_ERROR: 'MEDIA_FETCH_ERROR',
    MEDIA_LIMIT_REACHED: 'MEDIA_LIMIT_REACHED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
    AUTH_ACCESS_DENIED: 'AUTH_ACCESS_DENIED',
    QUEUE_SEND_ERROR: 'QUEUE_SEND_ERROR',
    QUEUE_PARSE_ERROR: 'QUEUE_PARSE_ERROR',
    NETWORK_FETCH_ERROR: 'NETWORK_FETCH_ERROR',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
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
