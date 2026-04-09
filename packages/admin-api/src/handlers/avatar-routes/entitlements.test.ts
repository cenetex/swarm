/**
 * Tests for avatar-routes/entitlements.ts
 *
 * Routes:
 *   PUT / DELETE /avatars/{id}/orb
 *   GET / PUT    /avatars/{id}/entitlement
 *   GET          /avatars/{id}/effective-limits
 *   POST         /avatars/{id}/activate
 *   POST         /avatars/{id}/deactivate
 *   GET          /avatars/{id}/audit-log
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let slotOrbResult: unknown = { success: true };
let unslotOrbResult: unknown = { success: true };
let getEntitlementResult: unknown = null;
let setEntitlementResult: unknown = {};
let activateResult: unknown = { success: true };
let deactivateResult: unknown = { success: true };
let recordAuditEventCalls: unknown[] = [];
let listAuditEventsResult: unknown[] = [];
let activationReadinessResult: unknown = {
  version: 'activation_readiness_v1',
  avatarId: 'avatar-1',
  evaluatedAt: '2026-02-06T00:00:00.000Z',
  gateStatus: 'pass',
  summary: {
    requiredTotal: 0,
    requiredPassing: 0,
    requiredFailing: 0,
    optionalTotal: 0,
    optionalFailing: 0,
  },
  checks: [],
};

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
  activateAvatar: async () => activateResult,
  deactivateAvatar: async () => deactivateResult,
}));

vi.mock('../../services/web3/orb-slots.js', () => ({
  slotOrbToAvatar: async () => slotOrbResult,
  unslotOrbFromAvatar: async () => unslotOrbResult,
}));

vi.mock('../../services/billing/entitlements.js', () => ({
  getEntitlement: async () => getEntitlementResult,
  setEntitlement: async () => setEntitlementResult,
}));

// NOTE: We do NOT mock runtime-limits.js here to avoid interfering with
// runtime-limits.test.ts when tests run in parallel. The real implementation
// works fine for these tests.

vi.mock('../../services/audit-log.js', () => ({
  recordAuditEvent: async (params: unknown) => {
    recordAuditEventCalls.push(params);
    return { id: 'audit-mock', ...params as Record<string, unknown>, timestamp: Date.now() };
  },
  listAuditEvents: async () => listAuditEventsResult,
}));

vi.mock('./runtime-sync.js', () => ({
  syncRuntimeContractForAvatar: async () => {},
  buildRuntimeAugmentations: async () => undefined,
}));

vi.mock('@swarm/core', () => ({
  ...RealSwarmCore,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────
import { handleEntitlementRoutes } from './entitlements.js';
import { makeCtx, parseBody, MOCK_AVATAR } from './test-helpers.js';
import * as activationReadinessModule from '../../services/activation-readiness.js';

// Bypass mocks below to access real @swarm/core for spreading into the factory.
import * as RealSwarmCore from '../../../../core/src/index.js';

beforeEach(() => {
  getAvatarResult = null;
  slotOrbResult = { success: true };
  unslotOrbResult = { success: true };
  getEntitlementResult = null;
  setEntitlementResult = { plan: 'pro' };
  activateResult = { success: true };
  deactivateResult = { success: true };
  recordAuditEventCalls = [];
  listAuditEventsResult = [];
  activationReadinessResult = {
    version: 'activation_readiness_v1',
    avatarId: 'avatar-1',
    evaluatedAt: '2026-02-06T00:00:00.000Z',
    gateStatus: 'pass',
    summary: {
      requiredTotal: 0,
      requiredPassing: 0,
      requiredFailing: 0,
      optionalTotal: 0,
      optionalFailing: 0,
    },
    checks: [],
  };
  vi.spyOn(activationReadinessModule, 'evaluateActivationReadiness').mockImplementation(
    async () => activationReadinessResult as never
  );
  vi.spyOn(activationReadinessModule, 'toLegacyActivationIssues').mockImplementation(() => {
    const result = activationReadinessResult as { gateStatus?: string };
    return result.gateStatus === 'fail' ? ['blocked'] : [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// PUT /avatars/{id}/orb
// =========================================================================
describe('PUT /avatars/{id}/orb', () => {
  it('slots orb for owner', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-1' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(parseBody(result!)).toEqual({ success: true, avatarId: 'avatar-1', mintAddress: 'mint-1' });
  });

  it('requires wallet sign-in', async () => {
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-1' }),
      walletAddress: null,
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('returns 404 when avatar not found', async () => {
    getAvatarResult = null;
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/orb',
      body: JSON.stringify({ mintAddress: 'mint-1' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });
});

// =========================================================================
// DELETE /avatars/{id}/orb
// =========================================================================
describe('DELETE /avatars/{id}/orb', () => {
  it('unslots orb for owner', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'DELETE',
      path: '/avatars/avatar-1/orb',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });
});

// =========================================================================
// GET /avatars/{id}/entitlement
// =========================================================================
describe('GET /avatars/{id}/entitlement', () => {
  it('returns entitlement for admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    getEntitlementResult = { plan: 'pro', status: 'active' };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/entitlement', effectiveIsAdmin: true });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { avatarId: string; entitlement: unknown };
    expect(body.avatarId).toBe('avatar-1');
    expect(body.entitlement).toEqual({ plan: 'pro', status: 'active' });
  });

  it('returns 404 when avatar not found', async () => {
    getAvatarResult = null;
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/entitlement', effectiveIsAdmin: true });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });
});

// =========================================================================
// PUT /avatars/{id}/entitlement
// =========================================================================
describe('PUT /avatars/{id}/entitlement', () => {
  it('admin sets entitlement', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    setEntitlementResult = { plan: 'pro', status: 'active' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'pro', accountId: 'acc-1' }),
      effectiveIsAdmin: true,
      accountId: 'acc-1',
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });

  it('non-admin gets 403', async () => {
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'pro' }),
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('rejects invalid plan', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'invalid' }),
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(400);
  });
});

// =========================================================================
// GET /avatars/{id}/effective-limits
// =========================================================================
describe('GET /avatars/{id}/effective-limits', () => {
  it('returns effective limits', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/effective-limits', effectiveIsAdmin: true });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { plan: string };
    expect(body.plan).toBe('free');
  });
});

// =========================================================================
// GET /avatars/{id}/activation-readiness
// =========================================================================
describe('GET /avatars/{id}/activation-readiness', () => {
  it('returns readiness payload', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    activationReadinessResult = {
      ...(activationReadinessResult as Record<string, unknown>),
      avatarId: 'avatar-1',
      gateStatus: 'pass',
    };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/activation-readiness',
      effectiveIsAdmin: true,
    });

    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { version: string; avatarId: string };
    expect(body.version).toBe('activation_readiness_v1');
    expect(body.avatarId).toBe('avatar-1');
  });
});

// =========================================================================
// POST /avatars/{id}/activate
// =========================================================================
describe('POST /avatars/{id}/activate', () => {
  it('activates avatar with platform enabled', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      status: 'draft',
      platforms: { telegram: { enabled: true, botUsername: 'mybot' } },
    };
    activationReadinessResult = {
      ...(activationReadinessResult as Record<string, unknown>),
      avatarId: 'avatar-1',
      gateStatus: 'pass',
    };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/activate',
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { success: boolean; status: string };
    expect(body.success).toBe(true);
    expect(body.status).toBe('active');
  });

  it('fails when no platform enabled', async () => {
    getAvatarResult = { ...MOCK_AVATAR, platforms: {} };
    activationReadinessResult = {
      ...(activationReadinessResult as Record<string, unknown>),
      avatarId: 'avatar-1',
      gateStatus: 'fail',
    };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/activate',
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(409);
  });

  it('non-owner gets 403', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/activate',
      walletAddress: 'wallet-other',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });
});

// =========================================================================
// POST /avatars/{id}/deactivate
// =========================================================================
describe('POST /avatars/{id}/deactivate', () => {
  it('deactivates avatar', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/deactivate',
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { success: boolean; status: string };
    expect(body.status).toBe('paused');
  });
});

// =========================================================================
// Audit logging on activate
// =========================================================================
describe('audit logging on activate', () => {
  it('records audit event on successful activation', async () => {
    getAvatarResult = {
      ...MOCK_AVATAR,
      status: 'draft',
      platforms: { telegram: { enabled: true, botUsername: 'mybot' } },
    };
    activationReadinessResult = {
      ...(activationReadinessResult as Record<string, unknown>),
      avatarId: 'avatar-1',
      gateStatus: 'pass',
    };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/activate',
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('avatar-1');
    expect(call.eventType).toBe('activated');
    expect(call.actorType).toBe('admin');
  });

  it('does not record audit event when activation is blocked', async () => {
    getAvatarResult = { ...MOCK_AVATAR, platforms: {} };
    activationReadinessResult = {
      ...(activationReadinessResult as Record<string, unknown>),
      avatarId: 'avatar-1',
      gateStatus: 'fail',
    };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/activate',
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(409);
    expect(recordAuditEventCalls.length).toBe(0);
  });
});

// =========================================================================
// Audit logging on deactivate
// =========================================================================
describe('audit logging on deactivate', () => {
  it('records audit event on successful deactivation', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1', status: 'active' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/deactivate',
      body: JSON.stringify({ reason: 'scheduled maintenance' }),
      walletAddress: 'wallet-1',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('avatar-1');
    expect(call.eventType).toBe('deactivated');
    expect(call.actorType).toBe('owner');
    const details = call.details as Record<string, unknown>;
    expect(details.reason).toBe('scheduled maintenance');
    expect(details.previousStatus).toBe('active');
  });
});

// =========================================================================
// Audit logging on entitlement change
// =========================================================================
describe('audit logging on entitlement change', () => {
  it('records audit event when entitlement is set', async () => {
    getAvatarResult = { ...MOCK_AVATAR };
    setEntitlementResult = { plan: 'pro', status: 'active' };
    const ctx = makeCtx({
      method: 'PUT',
      path: '/avatars/avatar-1/entitlement',
      body: JSON.stringify({ plan: 'pro', accountId: 'acc-1' }),
      effectiveIsAdmin: true,
      accountId: 'acc-1',
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(recordAuditEventCalls.length).toBe(1);
    const call = recordAuditEventCalls[0] as Record<string, unknown>;
    expect(call.avatarId).toBe('avatar-1');
    expect(call.eventType).toBe('entitlement_changed');
    expect(call.actorType).toBe('admin');
    const details = call.details as Record<string, unknown>;
    expect(details.plan).toBe('pro');
    expect(details.accountId).toBe('acc-1');
  });
});

// =========================================================================
// GET /avatars/{id}/audit-log
// =========================================================================
describe('GET /avatars/{id}/audit-log', () => {
  it('returns audit events for admin', async () => {
    listAuditEventsResult = [
      {
        id: 'audit-1',
        avatarId: 'avatar-1',
        eventType: 'activated',
        actorId: 'admin@test.com',
        actorType: 'admin',
        details: {},
        timestamp: Date.now(),
      },
    ];
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/audit-log',
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { avatarId: string; events: unknown[]; count: number };
    expect(body.avatarId).toBe('avatar-1');
    expect(body.events.length).toBe(1);
    expect(body.count).toBe(1);
  });

  it('non-admin gets 403', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/audit-log',
      effectiveIsAdmin: false,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('returns empty array when no events exist', async () => {
    listAuditEventsResult = [];
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/audit-log',
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { events: unknown[]; count: number };
    expect(body.events).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('passes query parameters through', async () => {
    listAuditEventsResult = [];
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/audit-log',
      queryStringParameters: { eventType: 'activated', limit: '10', since: '1700000000000' },
      effectiveIsAdmin: true,
    });
    const result = await handleEntitlementRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });
});

// =========================================================================
// Unmatched routes
// =========================================================================
describe('unmatched routes', () => {
  it('returns null', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/unknown' });
    const result = await handleEntitlementRoutes(ctx);
    expect(result).toBeNull();
  });
});
