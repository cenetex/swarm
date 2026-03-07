/**
 * Identity Link Service Tests
 *
 * Uses an in-memory DynamoDB mock (same pattern as heartbeat-timing.test.ts).
 * Covers:
 *  - consent granted / denied / revoked paths
 *  - idempotent re-linking
 *  - revoked link reactivation
 *  - audit trail written for every lifecycle action
 *  - conflict scenarios (two platforms, two users)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  _setIdentityLinkDynamoClient,
  createIdentityLinkService,
} from './identity-link.js';

// ---------------------------------------------------------------------------
// In-memory DynamoDB mock (mirrors heartbeat-timing.test.ts pattern)
// ---------------------------------------------------------------------------

const store = new Map<string, Record<string, unknown>>();

function storeKey(pk: string, sk: string): string {
  return `${pk}||${sk}`;
}

const mockDocClient = {
  send: async (command: unknown) => {
    const cmd = command as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    const name = cmd.constructor.name;

    if (name === 'GetCommand') {
      const input = cmd.input as { Key: { pk: string; sk: string } };
      const key = storeKey(input.Key.pk, input.Key.sk);
      const item = store.get(key);
      return { Item: item ?? undefined };
    }

    if (name === 'PutCommand') {
      const input = cmd.input as {
        Item: Record<string, unknown> & { pk: string; sk: string };
      };
      const key = storeKey(input.Item.pk, input.Item.sk);
      store.set(key, { ...input.Item });
      return {};
    }

    if (name === 'UpdateCommand') {
      const input = cmd.input as {
        Key: { pk: string; sk: string };
        UpdateExpression: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
      const key = storeKey(input.Key.pk, input.Key.sk);
      const existing = store.get(key) ?? { pk: input.Key.pk, sk: input.Key.sk };

      // Very simplified UpdateExpression parser for SET only.
      const setMatch = input.UpdateExpression.match(/SET (.+)/);
      if (setMatch) {
        const assignments = setMatch[1].split(',').map((s) => s.trim());
        const updated = { ...existing };
        for (const assignment of assignments) {
          const [rawAttr, rawVal] = assignment.split('=').map((s) => s.trim());
          // Resolve attribute name alias (#foo → foo via ExpressionAttributeNames)
          const attrName =
            input.ExpressionAttributeNames?.[rawAttr] ?? rawAttr;
          // Resolve value alias (:foo → value via ExpressionAttributeValues)
          const value = input.ExpressionAttributeValues?.[rawVal] ?? rawVal;
          updated[attrName] = value;
        }
        store.set(key, updated);
      }
      return {};
    }

    if (name === 'QueryCommand') {
      const input = cmd.input as {
        ExpressionAttributeValues: { ':pk': string; ':prefix': string };
      };
      const pk = input.ExpressionAttributeValues[':pk'];
      const prefix = input.ExpressionAttributeValues[':prefix'];
      const items: Record<string, unknown>[] = [];
      for (const [k, v] of store.entries()) {
        const [itemPk, itemSk] = k.split('||');
        if (itemPk === pk && itemSk.startsWith(prefix)) {
          items.push(v);
        }
      }
      return { Items: items };
    }

    throw new Error(`Unexpected DynamoDB command: ${name}`);
  },
} as unknown as DynamoDBDocumentClient;

const TABLE = 'test-identity-link-table';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  store.clear();
  _setIdentityLinkDynamoClient(mockDocClient);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createIdentityLinkService', () => {
  describe('linkIdentity — consent granted path', () => {
    it('creates an active link and returns it', async () => {
      const svc = createIdentityLinkService(TABLE);
      const link = await svc.linkIdentity('user-1', 'telegram', 'tg-111');

      expect(link.userId).toBe('user-1');
      expect(link.platform).toBe('telegram');
      expect(link.platformUserId).toBe('tg-111');
      expect(link.status).toBe('active');
      expect(link.consentGrantedAt).toBeTruthy();
      expect(link.consentRevokedAt).toBeUndefined();
    });

    it('persists the link so hasConsent returns true', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-1', 'telegram', 'tg-111');

      const allowed = await svc.hasConsent('user-1', 'telegram', 'tg-111');
      expect(allowed).toBe(true);
    });

    it('is idempotent — second call returns the same active link', async () => {
      const svc = createIdentityLinkService(TABLE);
      const first = await svc.linkIdentity('user-1', 'discord', 'dc-222');
      const second = await svc.linkIdentity('user-1', 'discord', 'dc-222');

      // Status stays active and original linkedAt is preserved.
      expect(second.status).toBe('active');
      expect(second.linkedAt).toBe(first.linkedAt);
    });

    it('reactivates a previously revoked link', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-1', 'twitter', 'tw-333');
      await svc.revokeLink('user-1', 'twitter', 'tw-333');

      // Confirm revoked.
      expect(await svc.hasConsent('user-1', 'twitter', 'tw-333')).toBe(false);

      // Re-link.
      const relinked = await svc.linkIdentity('user-1', 'twitter', 'tw-333');
      expect(relinked.status).toBe('active');
      expect(relinked.consentRevokedAt).toBeUndefined();
      expect(await svc.hasConsent('user-1', 'twitter', 'tw-333')).toBe(true);
    });
  });

  describe('hasConsent — denied paths', () => {
    it('returns false when no link exists', async () => {
      const svc = createIdentityLinkService(TABLE);
      const allowed = await svc.hasConsent('user-99', 'telegram', 'tg-999');
      expect(allowed).toBe(false);
    });

    it('returns false after consent is revoked', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-1', 'discord', 'dc-444');
      await svc.revokeLink('user-1', 'discord', 'dc-444');

      expect(await svc.hasConsent('user-1', 'discord', 'dc-444')).toBe(false);
    });
  });

  describe('revokeLink', () => {
    it('sets status to revoked and records consentRevokedAt', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-2', 'telegram', 'tg-555');
      const revoked = await svc.revokeLink('user-2', 'telegram', 'tg-555');

      expect(revoked).not.toBeNull();
      expect(revoked!.status).toBe('revoked');
      expect(revoked!.consentRevokedAt).toBeTruthy();
    });

    it('returns null when no link exists', async () => {
      const svc = createIdentityLinkService(TABLE);
      const result = await svc.revokeLink('ghost', 'discord', 'dc-000');
      expect(result).toBeNull();
    });

    it('is idempotent — revoking twice does not throw', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-2', 'twitter', 'tw-666');
      await svc.revokeLink('user-2', 'twitter', 'tw-666');
      // Second revoke should succeed without error (link already revoked).
      const second = await svc.revokeLink('user-2', 'twitter', 'tw-666');
      expect(second).not.toBeNull();
      expect(second!.status).toBe('revoked');
    });
  });

  describe('getLinkedIdentities', () => {
    it('returns all links for a user regardless of status', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-3', 'telegram', 'tg-777');
      await svc.linkIdentity('user-3', 'discord', 'dc-888');
      await svc.revokeLink('user-3', 'discord', 'dc-888');

      const links = await svc.getLinkedIdentities('user-3');
      expect(links.length).toBe(2);

      const tgLink = links.find((l) => l.platform === 'telegram');
      const dcLink = links.find((l) => l.platform === 'discord');

      expect(tgLink?.status).toBe('active');
      expect(dcLink?.status).toBe('revoked');
    });

    it('returns empty array for unknown user', async () => {
      const svc = createIdentityLinkService(TABLE);
      const links = await svc.getLinkedIdentities('nobody');
      expect(links).toEqual([]);
    });
  });

  describe('audit trail', () => {
    it('writes an audit entry for link_created', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-4', 'telegram', 'tg-000');

      // Audit entries are stored under pk='AUDIT'
      const auditEntries = [...store.entries()]
        .filter(([k]) => k.startsWith('AUDIT'))
        .map(([, v]) => v);

      const created = auditEntries.find((e) => e.action === 'link_created');
      expect(created).toBeDefined();
      expect(created!.userId).toBe('user-4');
      expect(created!.platform).toBe('telegram');
    });

    it('writes an audit entry for link_revoked', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-5', 'discord', 'dc-001');
      await svc.revokeLink('user-5', 'discord', 'dc-001');

      const auditEntries = [...store.entries()]
        .filter(([k]) => k.startsWith('AUDIT'))
        .map(([, v]) => v);

      const revoked = auditEntries.find((e) => e.action === 'link_revoked');
      expect(revoked).toBeDefined();
      expect(revoked!.userId).toBe('user-5');
    });

    it('writes an audit entry for consent_checked when denied', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.hasConsent('user-6', 'twitter', 'tw-002');

      const auditEntries = [...store.entries()]
        .filter(([k]) => k.startsWith('AUDIT'))
        .map(([, v]) => v);

      const checked = auditEntries.find((e) => e.action === 'consent_checked');
      expect(checked).toBeDefined();
      expect(checked!.userId).toBe('user-6');
    });

    it('does not write audit entry when consent is active', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-6b', 'telegram', 'tg-active');

      // Clear all audit entries so we can detect new writes.
      for (const key of [...store.keys()]) {
        if (key.startsWith('AUDIT')) store.delete(key);
      }

      await svc.hasConsent('user-6b', 'telegram', 'tg-active');

      const auditEntries = [...store.entries()]
        .filter(([k]) => k.startsWith('AUDIT'))
        .map(([, v]) => v);

      expect(auditEntries.length).toBe(0);
    });
  });

  describe('conflict scenarios — multiple identities', () => {
    it('tracks separate links per platform independently', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-7', 'telegram', 'tg-A');
      await svc.linkIdentity('user-7', 'discord', 'dc-B');

      // Revoke only discord.
      await svc.revokeLink('user-7', 'discord', 'dc-B');

      expect(await svc.hasConsent('user-7', 'telegram', 'tg-A')).toBe(true);
      expect(await svc.hasConsent('user-7', 'discord', 'dc-B')).toBe(false);
    });

    it('different users with the same platform IDs do not collide', async () => {
      const svc = createIdentityLinkService(TABLE);
      await svc.linkIdentity('user-alpha', 'telegram', 'shared-tg-id');
      await svc.linkIdentity('user-beta', 'telegram', 'shared-tg-id');

      await svc.revokeLink('user-alpha', 'telegram', 'shared-tg-id');

      expect(await svc.hasConsent('user-alpha', 'telegram', 'shared-tg-id')).toBe(false);
      expect(await svc.hasConsent('user-beta', 'telegram', 'shared-tg-id')).toBe(true);
    });
  });
});
