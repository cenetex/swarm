/**
 * Tests for avatar-routes/persona.ts
 *
 * Routes:
 *   GET  /avatars/{id}/persona
 *   POST /avatars/{id}/persona/preview
 *   PATCH /avatars/{id}/persona
 *   GET  /avatars/{id}/persona/history
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let getAvatarResult: unknown = null;
let updateAvatarResult: unknown = null;
let recordAuditEventCalls: unknown[] = [];
let listAuditEventsResult: unknown[] = [];

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
  updateAvatar: async () => updateAvatarResult,
}));

vi.mock('../../services/audit-log.js', () => ({
  recordAuditEvent: async (params: unknown) => {
    recordAuditEventCalls.push(params);
    return { id: 'audit-mock', ...params as Record<string, unknown>, timestamp: Date.now() };
  },
  listAuditEvents: async () => listAuditEventsResult,
}));

vi.mock('@swarm/core', () => ({
  ...RealSwarmCore,
  buildDynamicSystemPrompt: () => 'System prompt for avatar',
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

import { handlePersonaRoutes } from './persona.js';
import { makeCtx, MOCK_AVATAR, parseBody } from './test-helpers.js';
import * as RealSwarmCore from '../../../../core/src/index.js';

beforeEach(() => {
  getAvatarResult = null;
  updateAvatarResult = null;
  recordAuditEventCalls = [];
  listAuditEventsResult = [];
});

// =========================================================================
// GET /avatars/{id}/persona — Show current persona
// =========================================================================
describe('GET /avatars/{id}/persona', () => {
  it('returns 404 for non-owner when avatar not found', async () => {
    getAvatarResult = null;
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/persona',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('returns 404 for non-owner of avatar', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-2' };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/persona',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('returns 200 with persona for owner', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      persona: 'I am a helpful assistant',
    };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/persona',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.persona).toBe('I am a helpful assistant');
    expect(body.name).toBe('Test Avatar');
    expect(body.avatarId).toBe('avatar-1');
  });

  it('returns 200 with empty persona if not set', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/persona',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.persona).toBe('');
  });

  it('allows admin to view any persona', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-2',
      persona: 'Admin can see this',
    };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/persona',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: true,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.persona).toBe('Admin can see this');
  });
});

// =========================================================================
// POST /avatars/{id}/persona/preview — Preview new persona
// =========================================================================
describe('POST /avatars/{id}/persona/preview', () => {
  it('returns 404 for non-owner', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-2' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/persona/preview',
      body: JSON.stringify({ persona: 'new persona' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('returns 400 if persona is not a string', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/persona/preview',
      body: JSON.stringify({ persona: 123 }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(400);
  });

  it('returns 400 if persona is empty after trim', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/persona/preview',
      body: JSON.stringify({ persona: '   ' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(400);
  });

  it('returns preview with system prompt, diff, and token delta', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      persona: 'Old persona text\nFirst trait',
    };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/persona/preview',
      body: JSON.stringify({ persona: 'New persona text\nSecond trait' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.systemPrompt).toBe('System prompt for avatar');
    expect(body.diff).toBeDefined();
    expect((body.diff as Record<string, unknown>).added).toBeDefined();
    expect((body.diff as Record<string, unknown>).removed).toBeDefined();
    expect(typeof body.tokenDelta).toBe('number');
    expect(body.preview).toBeDefined();
  });

  it('does not persist avatar on preview', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1', persona: 'Old' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/persona/preview',
      body: JSON.stringify({ persona: 'New' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    // No audit event should be recorded
    expect(recordAuditEventCalls.length).toBe(0);
  });

  it('computes diff correctly', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      persona: 'Line 1\nLine 2\nLine 3',
    };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/persona/preview',
      body: JSON.stringify({ persona: 'Line 1\nLine 2 Modified\nLine 4' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    const diff = body.diff as Record<string, unknown[]>;
    // Lines removed: Line 3, Line 2 (original)
    // Lines added: Line 2 Modified, Line 4
    expect(diff.added).toContain('Line 2 Modified');
    expect(diff.added).toContain('Line 4');
    expect(diff.removed).toContain('Line 3');
    expect(diff.removed).toContain('Line 2');
  });
});

// =========================================================================
// PATCH /avatars/{id}/persona — Update persona
// =========================================================================
describe('PATCH /avatars/{id}/persona', () => {
  it('returns 404 for non-owner', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-2' };
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/persona',
      body: JSON.stringify({ persona: 'new' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('returns 400 if persona is empty', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/persona',
      body: JSON.stringify({ persona: '' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result!.statusCode).toBe(400);
  });

  it('returns 403 if avatar is ascended (locked)', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      isAscended: true,
    };
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/persona',
      body: JSON.stringify({ persona: 'new persona' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
  });

  it('updates avatar and records audit event', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      persona: 'Old persona',
    };
    updateAvatarResult = {
      ...MOCK_AVATAR,
      persona: 'New persona',
      updatedAt: Date.now(),
      updatedBy: 'wallet-1',
    };
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/persona',
      body: JSON.stringify({ persona: 'New persona' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);

    // Verify audit event was recorded
    expect(recordAuditEventCalls.length).toBe(1);
    const auditCall = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(auditCall.avatarId).toBe('avatar-1');
    expect(auditCall.eventType).toBe('persona_updated');
    expect(auditCall.actorId).toBe('wallet-1');
    expect(auditCall.actorType).toBe('owner');
    const details = auditCall.details as Record<string, unknown>;
    expect(details.oldHash).toBeDefined();
    expect(details.newHash).toBeDefined();
    expect(details.oldLength).toBe('Old persona'.length);
    expect(details.newLength).toBe('New persona'.length);
    expect(typeof details.tokenDelta).toBe('number');
  });

  it('records eventType as persona_updated with audit details', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      persona: 'Short',
    };
    updateAvatarResult = {
      ...MOCK_AVATAR,
      persona: 'Much longer persona text here',
      updatedAt: Date.now(),
    };
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/persona',
      body: JSON.stringify({ persona: 'Much longer persona text here' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result!.statusCode).toBe(200);

    const auditCall = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(auditCall.eventType).toBe('persona_updated');
    const details = auditCall.details as Record<string, unknown>;
    // Verify hashes are 64-char SHA256 hex strings
    expect((details.oldHash as string).length).toBe(64);
    expect((details.newHash as string).length).toBe(64);
    // Old hash should not equal new hash
    expect(details.oldHash).not.toBe(details.newHash);
  });

  it('allows admin to update any avatar', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-2',
      persona: 'Old',
    };
    updateAvatarResult = { ...MOCK_AVATAR, persona: 'New', updatedAt: Date.now() };
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/persona',
      body: JSON.stringify({ persona: 'New' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: true,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const auditCall = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(auditCall.actorType).toBe('admin');
  });

  it('handles long personas correctly', async () => {
    const longPersona = 'x'.repeat(5000);
    getAvatarResult = {
      ...MOCK_AVATAR,
      creatorWallet: 'wallet-1',
      persona: 'Old',
    };
    updateAvatarResult = { ...MOCK_AVATAR, persona: longPersona, updatedAt: Date.now() };
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/persona',
      body: JSON.stringify({ persona: longPersona }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect(body.persona).toBe(longPersona);
  });
});

// =========================================================================
// GET /avatars/{id}/persona/history — List edit history
// =========================================================================
describe('GET /avatars/{id}/persona/history', () => {
  it('returns 404 for non-owner', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-2' };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/persona/history',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('returns empty history for no edits', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    listAuditEventsResult = [];
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/persona/history',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    expect((body.personas as Array<unknown>).length).toBe(0);
  });

  it('returns history of persona edits without full texts', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const now = Date.now();
    listAuditEventsResult = [
      {
        id: 'audit-1',
        avatarId: 'avatar-1',
        eventType: 'persona_updated',
        actorId: 'wallet-1',
        actorType: 'owner',
        timestamp: now,
        details: {
          oldHash: 'aaa...',
          newHash: 'bbb...',
          oldLength: 100,
          newLength: 150,
          tokenDelta: 12,
        },
      },
    ];
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/persona/history',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handlePersonaRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result) as Record<string, unknown>;
    const personas = body.personas as Array<Record<string, unknown>>;
    expect(personas.length).toBe(1);
    expect(personas[0].timestamp).toBe(now);
    expect(personas[0].updatedBy).toBe('wallet-1');
    expect(personas[0].oldHash).toBe('aaa...');
    expect(personas[0].newHash).toBe('bbb...');
    expect(personas[0].lengthBefore).toBe(100);
    expect(personas[0].lengthAfter).toBe(150);
    expect(personas[0].tokenDelta).toBe(12);
  });
});
