import { describe, it, expect, vi } from 'vitest';
import { createLinkWalletChallenge, verifyLinkWallet, type WalletLinkDeps } from './wallet-link.js';

import type { DynamoDBDocumentClient } from '@swarm/core';

type DbItem = Record<string, unknown>;

function makeInMemoryDynamo() {
  const store = new Map<string, DbItem>();
  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;

  const send: DynamoDBDocumentClient['send'] = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const input = command?.input ?? {};

    if (command?.constructor?.name === 'PutCommand' && (input as { Item?: DbItem }).Item) {
      const item = (input as { Item: DbItem }).Item;
      store.set(keyOf(item.pk, item.sk), item);
      return {};
    }

    if (command?.constructor?.name === 'GetCommand' && (input as { Key?: { pk: string; sk: string } }).Key) {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      return { Item: store.get(keyOf(pk, sk)) };
    }

    if (command?.constructor?.name === 'DeleteCommand' && (input as { Key?: { pk: string; sk: string } }).Key) {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      const existing = store.get(keyOf(pk, sk));
      const condition = (input as { ConditionExpression?: string }).ConditionExpression;

      if (condition) {
        const names = (input as { ExpressionAttributeNames?: Record<string, string> }).ExpressionAttributeNames || {};
        const values = (input as { ExpressionAttributeValues?: Record<string, unknown> }).ExpressionAttributeValues || {};

        const expiresAtAttr = names['#expiresAt'] || 'expiresAt';
        const accountIdAttr = names['#accountId'] || 'accountId';
        const walletAddressAttr = names['#walletAddress'] || 'walletAddress';

        const expiresAt = typeof existing?.[expiresAtAttr] === 'number' ? Number(existing?.[expiresAtAttr]) : Number.NaN;
        const accountId = String(existing?.[accountIdAttr] || '');
        const walletAddress = String(existing?.[walletAddressAttr] || '');

        const now = Number(values[':now']);
        const expectedAccountId = String(values[':accountId'] || '');
        const expectedWalletAddress = String(values[':walletAddress'] || '');

        const conditionMet = Boolean(existing)
          && Number.isFinite(expiresAt)
          && expiresAt > now
          && accountId === expectedAccountId
          && walletAddress === expectedWalletAddress;

        if (!conditionMet) {
          const err = new Error('Conditional check failed');
          (err as Error & { name: string }).name = 'ConditionalCheckFailedException';
          throw err;
        }
      }

      store.delete(keyOf(pk, sk));
      const returnValues = (input as { ReturnValues?: string }).ReturnValues;
      return returnValues === 'ALL_OLD' ? { Attributes: existing } : {};
    }

    throw new Error(`Unexpected Dynamo command: ${command?.constructor?.name}`);
  };

  return { store, send };
}

function makeDeps(overrides?: Partial<WalletLinkDeps>): { deps: WalletLinkDeps; db: ReturnType<typeof makeInMemoryDynamo> } {
  const db = makeInMemoryDynamo();
  const deps: WalletLinkDeps = {
    dynamoClient: { send: db.send },
    tableName: 'test-admin-table',
    domain: 'admin.example.test',
    now: () => 1_700_000_000_000,
    generateNonce: () => 'nonce-1',
    verifySignature: () => true,
    getAccountIdForIdentity: async () => null,
    ensureIdentityLinkedToAccount: async () => ({ linked: true, conflict: false }),
    ...(overrides ?? {}),
  };
  return { deps, db };
}

// ---------------------------------------------------------------------------
// createLinkWalletChallenge
// ---------------------------------------------------------------------------

describe('wallet-link service', () => {
  describe('createLinkWalletChallenge', () => {
    it('errors when wallet is already linked to another account', async () => {
      const { deps } = makeDeps({
        getAccountIdForIdentity: async () => 'acct-other',
      });

      const result = await createLinkWalletChallenge({ accountId: 'acct-1', walletAddress: 'wallet-1' }, deps);

      expect('error' in result && result.error).toBe('Wallet is already linked to another account');
    });

    it('stores a challenge record and returns message', async () => {
      const { deps, db } = makeDeps();

      const result = await createLinkWalletChallenge({ accountId: 'acct-1', walletAddress: 'wallet-1' }, deps);

      expect('nonce' in result).toBe(true);
      if ('nonce' in result) {
        expect(result.nonce).toBe('nonce-1');
        expect(result.message).toContain('Domain: admin.example.test');
        expect(result.message).toContain('Account: acct-1');
        expect(result.message).toContain('Wallet: wallet-1');
        expect(result.expiresAt).toBeGreaterThan(deps.now());
      }

      const stored = db.store.get('LINKCHALLENGE#nonce-1|DATA');
      expect(stored?.walletAddress).toBe('wallet-1');
      expect(stored?.accountId).toBe('acct-1');
    });

    it('allows re-linking wallet already linked to the same account (idempotent)', async () => {
      const { deps } = makeDeps({
        getAccountIdForIdentity: async () => 'acct-1',
      });

      const result = await createLinkWalletChallenge({ accountId: 'acct-1', walletAddress: 'wallet-1' }, deps);

      // Same account -> no conflict, should succeed
      expect('nonce' in result).toBe(true);
      if ('nonce' in result) {
        expect(result.nonce).toBe('nonce-1');
      }
    });

    it('allows creating a challenge when wallet has no existing link', async () => {
      const { deps } = makeDeps({
        getAccountIdForIdentity: async () => null,
      });

      const result = await createLinkWalletChallenge({ accountId: 'acct-new', walletAddress: 'wallet-new' }, deps);

      expect('nonce' in result).toBe(true);
      if ('nonce' in result) {
        expect(result.message).toContain('Account: acct-new');
        expect(result.message).toContain('Wallet: wallet-new');
      }
    });

    it('challenge message includes Nonce and Expiration fields', async () => {
      const { deps } = makeDeps();

      const result = await createLinkWalletChallenge({ accountId: 'acct-1', walletAddress: 'wallet-1' }, deps);

      expect('nonce' in result).toBe(true);
      if ('nonce' in result) {
        expect(result.message).toContain('Nonce: nonce-1');
        expect(result.message).toContain('Expiration:');
        expect(result.message).toContain('This signature will not trigger any blockchain transaction');
      }
    });

    it('challenge TTL is stored in DynamoDB record', async () => {
      const { deps, db } = makeDeps();

      await createLinkWalletChallenge({ accountId: 'acct-1', walletAddress: 'wallet-1' }, deps);

      const stored = db.store.get('LINKCHALLENGE#nonce-1|DATA');
      expect(stored).toBeDefined();
      expect(typeof stored?.ttl).toBe('number');
      expect(typeof stored?.expiresAt).toBe('number');
      expect(typeof stored?.createdAt).toBe('number');
      // TTL should be expiresAt in seconds (for DynamoDB TTL)
      expect(stored?.ttl).toBe(Math.floor((stored?.expiresAt as number) / 1000));
    });
  });

  // ---------------------------------------------------------------------------
  // verifyLinkWallet
  // ---------------------------------------------------------------------------

  describe('verifyLinkWallet', () => {
    it('consumes challenge, validates signature, and links identity (success path)', async () => {
      const verifySignature = vi.fn(() => true);
      const ensureIdentityLinkedToAccount = vi.fn(async () => ({ linked: true, conflict: false }));
      const { deps, db } = makeDeps({ verifySignature, ensureIdentityLinkedToAccount });

      // Seed challenge record
      db.store.set('LINKCHALLENGE#nonce-1|DATA', {
        pk: 'LINKCHALLENGE#nonce-1',
        sk: 'DATA',
        nonce: 'nonce-1',
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
        message: 'hello',
        createdAt: deps.now(),
        expiresAt: deps.now() + 1000,
        ttl: Math.floor((deps.now() + 1000) / 1000),
      });

      const result = await verifyLinkWallet(
        {
          accountId: 'acct-1',
          walletAddress: 'wallet-1',
          nonce: 'nonce-1',
          signatureBase58: 'sig',
        },
        deps
      );

      expect(result).toEqual({ success: true });
      expect(verifySignature).toHaveBeenCalledTimes(1);
      expect(verifySignature).toHaveBeenCalledWith('hello', 'sig', 'wallet-1');
      expect(ensureIdentityLinkedToAccount).toHaveBeenCalledTimes(1);
      expect(ensureIdentityLinkedToAccount).toHaveBeenCalledWith({
        accountId: 'acct-1',
        type: 'wallet',
        providerId: 'wallet-1',
      });

      // Challenge should be consumed (deleted)
      expect(db.store.has('LINKCHALLENGE#nonce-1|DATA')).toBe(false);
    });

    it('returns error on invalid signature and consumes the challenge (no retry)', async () => {
      const verifySignature = vi.fn(() => false);
      const { deps, db } = makeDeps({ verifySignature });

      db.store.set('LINKCHALLENGE#nonce-1|DATA', {
        pk: 'LINKCHALLENGE#nonce-1',
        sk: 'DATA',
        nonce: 'nonce-1',
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
        message: 'hello',
        createdAt: deps.now(),
        expiresAt: deps.now() + 1000,
        ttl: Math.floor((deps.now() + 1000) / 1000),
      });

      const result = await verifyLinkWallet(
        {
          accountId: 'acct-1',
          walletAddress: 'wallet-1',
          nonce: 'nonce-1',
          signatureBase58: 'bad-sig',
        },
        deps
      );

      expect(result).toEqual({ success: false, error: 'Invalid signature' });
      expect(verifySignature).toHaveBeenCalledTimes(1);
      // Challenge is consumed even on invalid sig (one-time use)
      expect(db.store.has('LINKCHALLENGE#nonce-1|DATA')).toBe(false);
    });

    it('returns error for expired nonce', async () => {
      const verifySignature = vi.fn(() => true);
      const { deps, db } = makeDeps({ verifySignature });

      // Seed an expired challenge (expiresAt is in the past)
      db.store.set('LINKCHALLENGE#nonce-1|DATA', {
        pk: 'LINKCHALLENGE#nonce-1',
        sk: 'DATA',
        nonce: 'nonce-1',
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
        message: 'hello',
        createdAt: deps.now() - 600_000,
        expiresAt: deps.now() - 1, // expired
        ttl: Math.floor((deps.now() - 1) / 1000),
      });

      const result = await verifyLinkWallet(
        {
          accountId: 'acct-1',
          walletAddress: 'wallet-1',
          nonce: 'nonce-1',
          signatureBase58: 'sig',
        },
        deps
      );

      expect(result).toEqual({ success: false, error: 'Invalid or expired challenge' });
      // Signature should never be checked for expired challenge
      expect(verifySignature).toHaveBeenCalledTimes(0);
    });

    it('returns error for consumed (already-used) nonce', async () => {
      const verifySignature = vi.fn(() => true);
      const ensureIdentityLinkedToAccount = vi.fn(async () => ({ linked: true, conflict: false }));
      const { deps, db } = makeDeps({ verifySignature, ensureIdentityLinkedToAccount });

      // Seed challenge
      db.store.set('LINKCHALLENGE#nonce-1|DATA', {
        pk: 'LINKCHALLENGE#nonce-1',
        sk: 'DATA',
        nonce: 'nonce-1',
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
        message: 'hello',
        createdAt: deps.now(),
        expiresAt: deps.now() + 1000,
        ttl: Math.floor((deps.now() + 1000) / 1000),
      });

      // First verify succeeds
      const first = await verifyLinkWallet(
        {
          accountId: 'acct-1',
          walletAddress: 'wallet-1',
          nonce: 'nonce-1',
          signatureBase58: 'sig',
        },
        deps
      );
      expect(first).toEqual({ success: true });

      // Second verify with same nonce fails because challenge was consumed
      const second = await verifyLinkWallet(
        {
          accountId: 'acct-1',
          walletAddress: 'wallet-1',
          nonce: 'nonce-1',
          signatureBase58: 'sig',
        },
        deps
      );
      expect(second).toEqual({ success: false, error: 'Invalid or expired challenge' });
      // verifySignature called only once (first attempt)
      expect(verifySignature).toHaveBeenCalledTimes(1);
    });

    it('returns error when wallet is already linked to another account at verify time', async () => {
      const verifySignature = vi.fn(() => true);
      const ensureIdentityLinkedToAccount = vi.fn(async () => ({
        linked: false,
        conflict: true,
        existingAccountId: 'acct-other',
      }));
      const { deps, db } = makeDeps({ verifySignature, ensureIdentityLinkedToAccount });

      db.store.set('LINKCHALLENGE#nonce-1|DATA', {
        pk: 'LINKCHALLENGE#nonce-1',
        sk: 'DATA',
        nonce: 'nonce-1',
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
        message: 'hello',
        createdAt: deps.now(),
        expiresAt: deps.now() + 1000,
        ttl: Math.floor((deps.now() + 1000) / 1000),
      });

      const result = await verifyLinkWallet(
        {
          accountId: 'acct-1',
          walletAddress: 'wallet-1',
          nonce: 'nonce-1',
          signatureBase58: 'sig',
        },
        deps
      );

      expect(result).toEqual({ success: false, error: 'Wallet is already linked to another account' });
      expect(verifySignature).toHaveBeenCalledTimes(1);
      expect(ensureIdentityLinkedToAccount).toHaveBeenCalledTimes(1);
    });

    it('rejects mismatched wallet/account atomically and leaves challenge untouched', async () => {
      const verifySignature = vi.fn(() => true);
      const { deps, db } = makeDeps({ verifySignature });

      db.store.set('LINKCHALLENGE#nonce-1|DATA', {
        pk: 'LINKCHALLENGE#nonce-1',
        sk: 'DATA',
        nonce: 'nonce-1',
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
        message: 'hello',
        createdAt: deps.now(),
        expiresAt: deps.now() + 1000,
        ttl: Math.floor((deps.now() + 1000) / 1000),
      });

      const result = await verifyLinkWallet(
        {
          accountId: 'acct-2',
          walletAddress: 'wallet-2',
          nonce: 'nonce-1',
          signatureBase58: 'sig',
        },
        deps
      );

      expect(result).toEqual({ success: false, error: 'Invalid or expired challenge' });
      expect(verifySignature).toHaveBeenCalledTimes(0);
      // Challenge remains because the conditional delete failed (wrong account/wallet)
      expect(db.store.has('LINKCHALLENGE#nonce-1|DATA')).toBe(true);
    });

    it('returns error for nonexistent nonce', async () => {
      const verifySignature = vi.fn(() => true);
      const { deps } = makeDeps({ verifySignature });

      // No challenge seeded in the store

      const result = await verifyLinkWallet(
        {
          accountId: 'acct-1',
          walletAddress: 'wallet-1',
          nonce: 'nonexistent-nonce',
          signatureBase58: 'sig',
        },
        deps
      );

      expect(result).toEqual({ success: false, error: 'Invalid or expired challenge' });
      expect(verifySignature).toHaveBeenCalledTimes(0);
    });

    it('idempotent: re-linking same wallet to same account succeeds', async () => {
      const ensureIdentityLinkedToAccount = vi.fn(async () => ({
        linked: true,
        conflict: false,
      }));
      const { deps } = makeDeps({ ensureIdentityLinkedToAccount });

      // Seed two challenges with different nonces
      let nonceCounter = 0;
      deps.generateNonce = () => `nonce-${++nonceCounter}`;

      // Create first challenge
      const challenge1 = await createLinkWalletChallenge(
        { accountId: 'acct-1', walletAddress: 'wallet-1' },
        deps
      );
      expect('nonce' in challenge1).toBe(true);

      // Create second challenge (for repeat attempt)
      const challenge2 = await createLinkWalletChallenge(
        { accountId: 'acct-1', walletAddress: 'wallet-1' },
        deps
      );
      expect('nonce' in challenge2).toBe(true);

      // Verify first
      if ('nonce' in challenge1) {
        const result1 = await verifyLinkWallet(
          {
            accountId: 'acct-1',
            walletAddress: 'wallet-1',
            nonce: challenge1.nonce,
            signatureBase58: 'sig1',
          },
          deps
        );
        expect(result1).toEqual({ success: true });
      }

      // Verify second (idempotent re-link)
      if ('nonce' in challenge2) {
        const result2 = await verifyLinkWallet(
          {
            accountId: 'acct-1',
            walletAddress: 'wallet-1',
            nonce: challenge2.nonce,
            signatureBase58: 'sig2',
          },
          deps
        );
        expect(result2).toEqual({ success: true });
      }

      expect(ensureIdentityLinkedToAccount).toHaveBeenCalledTimes(2);
    });
  });
});
