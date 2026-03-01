/**
 * Tests for avatar-routes/secrets.ts — audit logging coverage.
 *
 * Routes:
 *   POST /avatars/{id}/secrets
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../services/telegram.js', () => ({
  validateTelegramToken: async () => ({ valid: true }),
  registerTelegramWebhook: async () => ({ success: true }),
  generateWebhookSecret: () => 'mock-webhook-secret',
}));

vi.mock('../../services/discord.js', () => ({
  validateBotToken: async () => ({ valid: true, warnings: [] }),
  validateWebhookUrl: async () => ({ valid: true }),
}));

vi.mock('../../services/telegram-admin.js', () => ({
  setupTelegramIntegration: async () => setupTelegramResult,
}));

vi.mock('../../services/replicate.js', () => ({
  validateReplicateApiKey: async () => ({ valid: true }),
}));

vi.mock('@swarm/core', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────
import { handleSecretsRoutes } from './secrets.js';
import { makeCtx, MOCK_AVATAR } from './test-helpers.js';

beforeEach(() => {
  getAvatarResult = null;
  storeSecretCalls = [];
  recordAuditEventCalls = [];
  setupTelegramResult = { success: true, status: null };
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
