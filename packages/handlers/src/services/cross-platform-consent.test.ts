/**
 * Tests for cross-platform consent revocation and purge semantics.
 *
 * Covers:
 * - Consent grant -> revocation -> forward block
 * - Purge behaviour on revocation
 * - Re-grant after revocation (fresh start)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type {
  ConsentRevocationResult,
  IdentityLink,
  IdentityLinkAuditEvent,
  IdentityLinkService,
  Platform,
} from '@swarm/core';
import {
  checkCrossPlatformConsent,
  revokeConsentAndPurge,
} from './cross-platform-consent.js';

// ---------------------------------------------------------------------------
// In-memory mock IdentityLinkService
// ---------------------------------------------------------------------------

interface MockMemory {
  pk: string;
  sk: string;
  userId: string;
  sourcePlatform?: string;
}

class MockIdentityLinkService implements IdentityLinkService {
  links: Map<string, IdentityLink> = new Map();
  auditEvents: IdentityLinkAuditEvent[] = [];
  memories: MockMemory[] = [];

  private _key(userId: string, platform: Platform, platformUserId: string) {
    return `${userId}#${platform}#${platformUserId}`;
  }

  async linkIdentity(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<IdentityLink> {
    const key = this._key(userId, platform, platformUserId);
    const existing = this.links.get(key);
    const now = new Date().toISOString();

    if (existing?.status === 'active') return existing;

    const link: IdentityLink = {
      userId,
      platform,
      platformUserId,
      linkedAt: existing?.linkedAt ?? now,
      consentGrantedAt: now,
      consentRevokedAt: undefined,
      status: 'active',
    };
    this.links.set(key, link);

    await this.auditLog({
      action: existing?.status === 'revoked' ? 'link_regrant' : 'link_created',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
      reason:
        existing?.status === 'revoked'
          ? 'consent_regranted_after_revocation — fresh_start — previously_purged_data_not_recovered'
          : undefined,
    });

    return link;
  }

  async revokeLink(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<IdentityLink | null> {
    const key = this._key(userId, platform, platformUserId);
    const existing = this.links.get(key);
    if (!existing) return null;

    const now = new Date().toISOString();
    const revoked: IdentityLink = {
      ...existing,
      status: 'revoked',
      consentRevokedAt: now,
    };
    this.links.set(key, revoked);

    await this.auditLog({
      action: 'link_revoked',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
    });

    return revoked;
  }

  async getLinkedIdentities(userId: string): Promise<IdentityLink[]> {
    return Array.from(this.links.values()).filter((l) => l.userId === userId);
  }

  async hasConsent(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<boolean> {
    const key = this._key(userId, platform, platformUserId);
    const link = this.links.get(key);
    return link?.status === 'active';
  }

  async auditLog(event: IdentityLinkAuditEvent): Promise<void> {
    this.auditEvents.push(event);
  }

  async revokeAndPurge(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<ConsentRevocationResult> {
    const now = new Date().toISOString();

    // 1. Revoke link
    const revokedLink = await this.revokeLink(userId, platform, platformUserId);

    // 2. Log purge start
    await this.auditLog({
      action: 'purge_started',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
    });

    // 3. Purge cross-platform memories
    const before = this.memories.length;
    this.memories = this.memories.filter(
      (m) =>
        !(m.userId === userId && m.sourcePlatform === platform),
    );
    const memoriesPurged = before - this.memories.length;

    // 4. Retention exceptions
    const retentionExceptions = [
      {
        store: 'audit_log',
        reason: 'Immutable audit trail, metadata only',
        lawfulBasis: 'GDPR Art. 17(3)(e)',
      },
      {
        store: 'channel_state_buffers',
        reason: 'Self-expiring 90-day TTL',
        lawfulBasis: 'GDPR Art. 17(3)(e)',
      },
      {
        store: 'cloudwatch_logs',
        reason: 'Cannot selectively purge',
        lawfulBasis: 'GDPR Art. 17(3)(e)',
      },
    ];

    for (const exc of retentionExceptions) {
      await this.auditLog({
        action: 'purge_limitation_documented',
        userId,
        platform,
        platformUserId,
        occurredAt: now,
        reason: `${exc.store}: ${exc.reason} (${exc.lawfulBasis})`,
      });
    }

    // 5. Log purge complete
    await this.auditLog({
      action: 'purge_completed',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
      reason: `memories_purged=${memoriesPurged}`,
    });

    return {
      revokedLink,
      memoriesPurged,
      retentionExceptions,
      revokedAt: now,
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-platform consent revocation', () => {
  let svc: MockIdentityLinkService;
  const userId = 'user-123';
  const platform: Platform = 'telegram';
  const platformUserId = 'tg-456';

  beforeEach(() => {
    svc = new MockIdentityLinkService();
    process.env.STATE_TABLE = 'test-state-table';
  });

  // =========================================================================
  // Grant -> Revocation -> Forward Block
  // =========================================================================

  describe('consent grant -> revocation -> forward block', () => {
    it('allows merges when consent is active', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);

      const result = await checkCrossPlatformConsent(
        userId,
        platform,
        platformUserId,
        svc,
      );

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('consent_active');
    });

    it('blocks merges after consent is revoked', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);
      await svc.revokeLink(userId, platform, platformUserId);

      const result = await checkCrossPlatformConsent(
        userId,
        platform,
        platformUserId,
        svc,
      );

      expect(result.allowed).toBe(false);
    });

    it('blocks merges when no link exists', async () => {
      const result = await checkCrossPlatformConsent(
        userId,
        platform,
        platformUserId,
        svc,
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('no_active_link');
    });

    it('records link_revoked audit event on revocation', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);
      await svc.revokeLink(userId, platform, platformUserId);

      const revokeEvents = svc.auditEvents.filter(
        (e) => e.action === 'link_revoked',
      );
      expect(revokeEvents.length).toBe(1);
      expect(revokeEvents[0].userId).toBe(userId);
      expect(revokeEvents[0].platform).toBe(platform);
    });
  });

  // =========================================================================
  // Purge Behaviour on Revocation
  // =========================================================================

  describe('purge behaviour on revocation', () => {
    it('purges cross-platform memories on revocation', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);

      // Add some memories -- some cross-platform, some single-platform
      svc.memories = [
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#1#mem-1',
          userId,
          sourcePlatform: 'telegram',
        },
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#2#mem-2',
          userId,
          sourcePlatform: 'telegram',
        },
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#3#mem-3',
          userId,
          // no sourcePlatform -- single-platform memory
        },
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#4#mem-4',
          userId: 'other-user',
          sourcePlatform: 'telegram',
        },
      ];

      const result = await revokeConsentAndPurge(
        userId,
        platform,
        platformUserId,
        svc,
      );

      expect(result.memoriesPurged).toBe(2);
      // Single-platform memory and other user's memory should remain
      expect(svc.memories.length).toBe(2);
      expect(svc.memories[0].sk).toBe('immediate#3#mem-3');
      expect(svc.memories[1].userId).toBe('other-user');
    });

    it('returns zero purged when no cross-platform memories exist', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);

      svc.memories = [
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#1#mem-1',
          userId,
          // no sourcePlatform
        },
      ];

      const result = await revokeConsentAndPurge(
        userId,
        platform,
        platformUserId,
        svc,
      );

      expect(result.memoriesPurged).toBe(0);
      expect(svc.memories.length).toBe(1);
    });

    it('documents retention exceptions with lawful basis', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);

      const result = await revokeConsentAndPurge(
        userId,
        platform,
        platformUserId,
        svc,
      );

      expect(result.retentionExceptions.length).toBe(3);

      const storeNames = result.retentionExceptions.map((e) => e.store);
      expect(storeNames).toContain('audit_log');
      expect(storeNames).toContain('channel_state_buffers');
      expect(storeNames).toContain('cloudwatch_logs');

      // All exceptions must have a lawful basis
      for (const exc of result.retentionExceptions) {
        expect(exc.lawfulBasis).toBeTruthy();
        expect(exc.reason).toBeTruthy();
      }
    });

    it('logs full purge lifecycle in audit trail', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);

      await revokeConsentAndPurge(userId, platform, platformUserId, svc);

      const actions = svc.auditEvents.map((e) => e.action);
      expect(actions).toContain('link_revoked');
      expect(actions).toContain('purge_started');
      expect(actions).toContain('purge_limitation_documented');
      expect(actions).toContain('purge_completed');
    });

    it('returns empty result when no link exists', async () => {
      const result = await revokeConsentAndPurge(
        userId,
        platform,
        platformUserId,
        svc,
      );

      expect(result.revokedLink).toBeNull();
      expect(result.memoriesPurged).toBe(0);
    });
  });

  // =========================================================================
  // Re-grant After Revocation
  // =========================================================================

  describe('re-grant after revocation', () => {
    it('allows merges after re-granting consent', async () => {
      // Grant
      await svc.linkIdentity(userId, platform, platformUserId);
      // Revoke
      await revokeConsentAndPurge(userId, platform, platformUserId, svc);
      // Verify blocked
      const blocked = await checkCrossPlatformConsent(
        userId,
        platform,
        platformUserId,
        svc,
      );
      expect(blocked.allowed).toBe(false);

      // Re-grant
      await svc.linkIdentity(userId, platform, platformUserId);

      // Verify allowed again
      const allowed = await checkCrossPlatformConsent(
        userId,
        platform,
        platformUserId,
        svc,
      );
      expect(allowed.allowed).toBe(true);
      expect(allowed.reason).toBe('consent_active');
    });

    it('records link_regrant audit event (not link_created)', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);
      await revokeConsentAndPurge(userId, platform, platformUserId, svc);
      await svc.linkIdentity(userId, platform, platformUserId);

      const regrantEvents = svc.auditEvents.filter(
        (e) => e.action === 'link_regrant',
      );
      expect(regrantEvents.length).toBe(1);
      expect(regrantEvents[0].reason).toContain('fresh_start');
      expect(regrantEvents[0].reason).toContain(
        'previously_purged_data_not_recovered',
      );
    });

    it('does not recover previously purged memories on re-grant', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);

      svc.memories = [
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#1#mem-1',
          userId,
          sourcePlatform: 'telegram',
        },
      ];

      await revokeConsentAndPurge(userId, platform, platformUserId, svc);
      expect(svc.memories.length).toBe(0);

      // Re-grant
      await svc.linkIdentity(userId, platform, platformUserId);

      // Memories should still be empty -- no recovery
      expect(svc.memories.length).toBe(0);
    });

    it('resets consentGrantedAt on re-grant', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);

      await revokeConsentAndPurge(userId, platform, platformUserId, svc);

      const regranted = await svc.linkIdentity(userId, platform, platformUserId);

      // consentGrantedAt should be reset and link should be active
      expect(regranted.consentGrantedAt).toBeTruthy();
      expect(regranted.status).toBe('active');
      expect(regranted.consentRevokedAt).toBeUndefined();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('returns gracefully when STATE_TABLE env is missing', async () => {
      delete process.env.STATE_TABLE;

      const result = await revokeConsentAndPurge(
        userId,
        platform,
        platformUserId,
      );

      expect(result.revokedLink).toBeNull();
      expect(result.memoriesPurged).toBe(0);
      expect(result.revokedAt).toBeTruthy();
    });

    it('only purges memories for the specific platform being revoked', async () => {
      await svc.linkIdentity(userId, platform, platformUserId);
      await svc.linkIdentity(userId, 'discord', 'dc-789');

      svc.memories = [
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#1#mem-1',
          userId,
          sourcePlatform: 'telegram',
        },
        {
          pk: 'MEMORY#avatar-1',
          sk: 'immediate#2#mem-2',
          userId,
          sourcePlatform: 'discord',
        },
      ];

      // Revoke only telegram
      const result = await revokeConsentAndPurge(
        userId,
        platform,
        platformUserId,
        svc,
      );

      expect(result.memoriesPurged).toBe(1);
      expect(svc.memories.length).toBe(1);
      expect(svc.memories[0].sourcePlatform).toBe('discord');
    });
  });
});
