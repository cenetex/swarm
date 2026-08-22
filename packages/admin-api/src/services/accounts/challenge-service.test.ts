import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAuthChallenge,
  createLinkChallenge,
  consumeChallenge,
  getChallenge,
  type ChallengeServiceDeps,
} from './challenge-service.js';

import type { DynamoDBDocumentClient } from '@swarm/core';

type DbItem = Record<string, unknown>;

function makeInMemoryDynamo() {
  const store = new Map<string, DbItem>();

  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;

  const send: DynamoDBDocumentClient['send'] = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const input = command?.input ?? {};

    // Get
    if ((input as { Key?: { pk: string; sk: string } }).Key && command?.constructor?.name !== 'UpdateCommand') {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      return { Item: store.get(keyOf(pk, sk)) };
    }

    // Update
    if ((input as { Key?: { pk: string; sk: string } }).Key && command?.constructor?.name === 'UpdateCommand') {
      const { pk, sk } = (input as { Key: { pk: string; sk: string } }).Key;
      const key = keyOf(pk, sk);
      const existing = store.get(key);

      if (!existing) {
        return {};
      }

      const updateExpr = (input as { UpdateExpression?: string }).UpdateExpression ?? '';
      const eavs = (input as { ExpressionAttributeValues?: Record<string, unknown> }).ExpressionAttributeValues ?? {};
      const condExpr = (input as { ConditionExpression?: string }).ConditionExpression;

      // Handle condition
      if (condExpr === 'attribute_not_exists(consumedAt)') {
        if (existing.consumedAt !== undefined) {
          const err = new Error('ConditionalCheckFailedException');
          (err as { name?: string }).name = 'ConditionalCheckFailedException';
          throw err;
        }
      }

      // Simple SET parsing
      if (updateExpr.includes('consumedAt')) {
        existing.consumedAt = eavs[':now'];
        existing.consumedBy = eavs[':consumerId'];
        store.set(key, existing);
      }

      return {};
    }

    // Put
    if ((input as { Item?: DbItem }).Item) {
      const item = (input as { Item: DbItem }).Item;
      const pk = item.pk as string;
      const sk = item.sk as string;
      store.set(keyOf(pk, sk), item);
      return {};
    }

    throw new Error(`Unexpected Dynamo command shape: ${JSON.stringify(input)}`);
  };

  return { store, send };
}

describe('challenge-service', () => {
  let db: ReturnType<typeof makeInMemoryDynamo>;
  let deps: ChallengeServiceDeps;
  let nonceCounter: number;
  let currentTime: number;

  beforeEach(() => {
    db = makeInMemoryDynamo();
    nonceCounter = 0;
    currentTime = 1_700_000_000_000;
    deps = {
      dynamoClient: { send: db.send },
      tableName: 'test-admin-table',
      domain: 'test.example.com',
      now: () => currentTime,
      generateNonce: () => `nonce-${++nonceCounter}`,
    };
  });

  describe('createAuthChallenge', () => {
    it('creates an auth challenge with correct message format', async () => {
      const result = await createAuthChallenge({ walletAddress: 'wallet-1' }, deps);

      expect(result.nonce).toBe('nonce-1');
      expect(result.message).toContain('Sign this message to authenticate');
      expect(result.message).toContain('Domain: test.example.com');
      expect(result.message).toContain('Wallet: wallet-1');
      expect(result.message).toContain('Nonce: nonce-1');
      expect(result.expiresAt).toBe(currentTime + 5 * 60 * 1000);
    });

    it('stores challenge in database with legacy key format', async () => {
      await createAuthChallenge({ walletAddress: 'wallet-1' }, deps);

      // Uses legacy format: CHALLENGE#<nonce> for backwards compatibility
      const stored = db.store.get('CHALLENGE#nonce-1|DATA');
      expect(stored).toBeDefined();
      expect(stored?.walletAddress).toBe('wallet-1');
      expect(stored?.challengeType).toBe('auth');
    });
  });

  describe('createLinkChallenge', () => {
    it('creates a link challenge with account info', async () => {
      const result = await createLinkChallenge({
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
      }, deps);

      expect(result.nonce).toBe('nonce-1');
      expect(result.message).toContain('Sign this message to link');
      expect(result.message).toContain('Account: acct-1');
      expect(result.message).toContain('Wallet: wallet-1');
    });

    it('stores challenge with legacy key format', async () => {
      await createLinkChallenge({
        accountId: 'acct-1',
        walletAddress: 'wallet-1',
      }, deps);

      // Uses legacy format: LINKCHALLENGE#<nonce> for backwards compatibility
      const stored = db.store.get('LINKCHALLENGE#nonce-1|DATA');
      expect(stored).toBeDefined();
      expect(stored?.accountId).toBe('acct-1');
      expect(stored?.challengeType).toBe('link');
    });
  });

  describe('consumeChallenge', () => {
    it('consumes challenge successfully', async () => {
      await createAuthChallenge({ walletAddress: 'wallet-1' }, deps);

      const result = await consumeChallenge('auth', 'nonce-1', 'consumer-1', deps);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.challenge.walletAddress).toBe('wallet-1');
        expect(result.challenge.consumedBy).toBe('consumer-1');
      }
    });

    it('returns error for non-existent challenge', async () => {
      const result = await consumeChallenge('auth', 'non-existent', 'consumer-1', deps);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Challenge not found');
      }
    });

    it('returns error for expired challenge', async () => {
      await createAuthChallenge({ walletAddress: 'wallet-1' }, deps);

      // Advance time past expiration
      currentTime += 6 * 60 * 1000; // 6 minutes

      const result = await consumeChallenge('auth', 'nonce-1', 'consumer-1', deps);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Challenge expired');
      }
    });

    it('returns error when already consumed by different consumer', async () => {
      await createAuthChallenge({ walletAddress: 'wallet-1' }, deps);

      // First consumer
      await consumeChallenge('auth', 'nonce-1', 'consumer-1', deps);

      // Second consumer
      const result = await consumeChallenge('auth', 'nonce-1', 'consumer-2', deps);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Challenge already consumed');
        expect(result.alreadyConsumed).toBe(true);
      }
    });

    it('is idempotent for same consumer', async () => {
      await createAuthChallenge({ walletAddress: 'wallet-1' }, deps);

      // Same consumer twice
      const result1 = await consumeChallenge('auth', 'nonce-1', 'consumer-1', deps);
      const result2 = await consumeChallenge('auth', 'nonce-1', 'consumer-1', deps);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });

  describe('getChallenge', () => {
    it('returns challenge without consuming', async () => {
      await createAuthChallenge({ walletAddress: 'wallet-1' }, deps);

      const challenge = await getChallenge('auth', 'nonce-1', deps);

      expect(challenge).not.toBeNull();
      expect(challenge?.walletAddress).toBe('wallet-1');
      expect(challenge?.consumedAt).toBeUndefined();
    });

    it('returns null for non-existent challenge', async () => {
      const challenge = await getChallenge('auth', 'non-existent', deps);
      expect(challenge).toBeNull();
    });
  });
});
