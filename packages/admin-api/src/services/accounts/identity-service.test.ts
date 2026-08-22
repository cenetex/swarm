import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveAccountForIdentity,
  linkIdentity,
  unlinkIdentity,
  getAccountIdForIdentity,
  getAccountIdentities,
  type IdentityServiceDeps,
} from './identity-service.js';

import type { DynamoDBDocumentClient } from '@swarm/core';

type DbItem = Record<string, unknown>;

function makeInMemoryDynamo() {
  const store = new Map<string, DbItem>();

  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;

  const send: DynamoDBDocumentClient['send'] = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const input = command?.input ?? {};

    // Delete
    if ((input as { Key?: { pk: string; sk: string } }).Key && command?.constructor?.name === 'DeleteCommand') {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      store.delete(keyOf(pk, sk));
      return {};
    }

    // Get
    if ((input as { Key?: { pk: string; sk: string } }).Key) {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      return { Item: store.get(keyOf(pk, sk)) };
    }

    // Query
    if ((input as { KeyConditionExpression?: unknown; ExpressionAttributeValues?: Record<string, unknown> }).KeyConditionExpression) {
      const eavs = (input as { ExpressionAttributeValues: Record<string, unknown> }).ExpressionAttributeValues;
      const pk = eavs[':pk'] as string;
      const prefix = eavs[':prefix'] as string;
      const items: DbItem[] = [];
      for (const [key, item] of store.entries()) {
        const [itemPk, itemSk] = key.split('|');
        if (itemPk === pk && typeof itemSk === 'string' && itemSk.startsWith(prefix)) {
          items.push(item);
        }
      }
      return { Items: items };
    }

    // Put
    if ((input as { Item?: DbItem }).Item) {
      const item = (input as { Item: DbItem }).Item;
      const pk = item.pk as string;
      const sk = item.sk as string;

      if ((input as { ConditionExpression?: string }).ConditionExpression === 'attribute_not_exists(pk)') {
        const existing = store.get(keyOf(pk, sk));
        if (existing) {
          const err = new Error('ConditionalCheckFailedException');
          (err as { name?: string }).name = 'ConditionalCheckFailedException';
          throw err;
        }
      }

      store.set(keyOf(pk, sk), item);
      return {};
    }

    throw new Error(`Unexpected Dynamo command shape: ${JSON.stringify(input)}`);
  };

  return { store, send };
}

describe('identity-service', () => {
  let db: ReturnType<typeof makeInMemoryDynamo>;
  let deps: IdentityServiceDeps;
  let uuidCounter: number;

  beforeEach(() => {
    db = makeInMemoryDynamo();
    uuidCounter = 0;
    deps = {
      dynamoClient: { send: db.send },
      tableName: 'test-admin-table',
      now: () => 1_700_000_000_000,
      uuid: () => `acct-${++uuidCounter}`,
    };
  });

  describe('resolveAccountForIdentity', () => {
    it('creates a new account for a new wallet identity', async () => {
      const result = await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.accountId).toBe('acct-1');
        expect(result.created).toBe(true);
        expect(result.linkedIdentities).toEqual([{ type: 'wallet', providerId: 'wallet-1' }]);
      }
    });

    it('returns existing account for known wallet identity', async () => {
      // First create
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      // Second resolve
      const result = await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.accountId).toBe('acct-1');
        expect(result.created).toBe(false);
        expect(result.linkedIdentities).toEqual([]); // Already linked
      }
    });

    it('links additional identities to existing account', async () => {
      // Create with wallet
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      // Resolve with privy + same wallet
      const result = await resolveAccountForIdentity({
        primaryIdentity: { type: 'privy', providerId: 'privy-1' },
        additionalIdentities: [{ type: 'wallet', providerId: 'wallet-1' }],
      }, deps);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.accountId).toBe('acct-1');
        expect(result.created).toBe(false);
        expect(result.linkedIdentities).toEqual([{ type: 'privy', providerId: 'privy-1' }]);
      }
    });

    it('returns conflict when identities belong to different accounts', async () => {
      // Create account 1 with wallet-1
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      // Create account 2 with privy-1
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'privy', providerId: 'privy-1' },
      }, deps);

      // Try to merge them - should fail
      const result = await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
        additionalIdentities: [{ type: 'privy', providerId: 'privy-1' }],
      }, deps);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.conflict.identity.type).toBe('privy');
        expect(result.conflict.existingAccountId).toBe('acct-2');
      }
    });
  });

  describe('linkIdentity', () => {
    it('links identity to account successfully', async () => {
      // Create account
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      // Link additional identity
      const result = await linkIdentity('acct-1', { type: 'privy', providerId: 'privy-1' }, deps);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.linked).toBe(true);
      }
    });

    it('returns conflict when linking identity already linked to different account', async () => {
      // Create two accounts
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'privy', providerId: 'privy-1' },
      }, deps);

      // Try to link privy-1 to wallet-1's account
      const result = await linkIdentity('acct-1', { type: 'privy', providerId: 'privy-1' }, deps);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('already linked');
        expect(result.conflict?.existingAccountId).toBe('acct-2');
      }
    });

    it('is idempotent for same account', async () => {
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      // Link twice
      const result1 = await linkIdentity('acct-1', { type: 'privy', providerId: 'privy-1' }, deps);
      const result2 = await linkIdentity('acct-1', { type: 'privy', providerId: 'privy-1' }, deps);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      if (result2.success) {
        expect(result2.linked).toBe(false); // Already linked
      }
    });
  });

  describe('unlinkIdentity', () => {
    it('unlinks identity from account', async () => {
      // Create account with two identities
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
        additionalIdentities: [{ type: 'privy', providerId: 'privy-1' }],
      }, deps);

      // Unlink privy
      const result = await unlinkIdentity('acct-1', { type: 'privy', providerId: 'privy-1' }, deps);

      expect(result.success).toBe(true);

      // Verify it's unlinked
      const accountId = await getAccountIdForIdentity({ type: 'privy', providerId: 'privy-1' }, deps);
      expect(accountId).toBeNull();
    });

    it('fails when trying to unlink the last identity', async () => {
      // Create account with one identity
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      // Try to unlink the only identity
      const result = await unlinkIdentity('acct-1', { type: 'wallet', providerId: 'wallet-1' }, deps);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('last identity');
      }
    });

    it('fails when identity not linked to account', async () => {
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      const result = await unlinkIdentity('acct-1', { type: 'privy', providerId: 'privy-1' }, deps);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not linked');
      }
    });
  });

  describe('getAccountIdentities', () => {
    it('returns all linked identities', async () => {
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
        additionalIdentities: [{ type: 'privy', providerId: 'privy-1' }],
      }, deps);

      const identities = await getAccountIdentities('acct-1', deps);

      expect(identities).toHaveLength(2);
      expect(identities).toContainEqual({ type: 'wallet', providerId: 'wallet-1' });
      expect(identities).toContainEqual({ type: 'privy', providerId: 'privy-1' });
    });

    it('returns empty array for account with no identities', async () => {
      const identities = await getAccountIdentities('non-existent', deps);
      expect(identities).toEqual([]);
    });
  });

  describe('getAccountIdForIdentity', () => {
    it('returns accountId for linked identity', async () => {
      await resolveAccountForIdentity({
        primaryIdentity: { type: 'wallet', providerId: 'wallet-1' },
      }, deps);

      const accountId = await getAccountIdForIdentity({ type: 'wallet', providerId: 'wallet-1' }, deps);
      expect(accountId).toBe('acct-1');
    });

    it('returns null for unlinked identity', async () => {
      const accountId = await getAccountIdForIdentity({ type: 'wallet', providerId: 'wallet-1' }, deps);
      expect(accountId).toBeNull();
    });
  });
});
