import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureIdentityLinkedToAccount,
  getAccountIdForIdentity,
  getAccountSummary,
  getOrCreateAccountForWallet,
  type AccountsServiceDeps,
} from './accounts.js';

import type { DynamoDBDocumentClient } from '@swarm/core';

type DbItem = Record<string, unknown>;

function makeInMemoryDynamo() {
  const store = new Map<string, DbItem>();

  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;
  const hasPk = (pk: string) => {
    for (const key of store.keys()) {
      if (key.startsWith(`${pk}|`)) return true;
    }
    return false;
  };

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
        if (hasPk(pk)) {
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

describe('accounts service', () => {
  let db: ReturnType<typeof makeInMemoryDynamo>;
  let deps: AccountsServiceDeps;

  beforeEach(() => {
    db = makeInMemoryDynamo();
    deps = {
      dynamoClient: { send: db.send },
      tableName: 'test-admin-table',
      now: () => 1_700_000_000_000,
      uuid: () => 'acct-1',
    };
  });

  it('creates an account for a new wallet and links identity mapping + account identity', async () => {
    const accountId = await getOrCreateAccountForWallet('wallet-1', deps);
    expect(accountId).toBe('acct-1');

    const mapped = await getAccountIdForIdentity('wallet', 'wallet-1', deps);
    expect(mapped).toBe('acct-1');

    const summary = await getAccountSummary('acct-1', deps);
    expect(summary?.accountId).toBe('acct-1');
    expect(summary?.identities).toEqual([{ type: 'wallet', providerId: 'wallet-1' }]);
  });

  it('supports multiple linked wallets per account and lists them in account summary', async () => {
    const accountId = await getOrCreateAccountForWallet('wallet-1', deps);
    expect(accountId).toBe('acct-1');

    await ensureIdentityLinkedToAccount({ accountId, type: 'wallet', providerId: 'wallet-2' }, deps);

    const summary = await getAccountSummary(accountId, deps);
    const wallets = (summary?.identities ?? []).filter((i) => i.type === 'wallet').map((i) => i.providerId).sort();
    expect(wallets).toEqual(['wallet-1', 'wallet-2']);
  });

  it('links a Privy identity into an existing wallet-owned account', async () => {
    await ensureIdentityLinkedToAccount({ accountId: 'acct-existing', type: 'wallet', providerId: 'wallet-1' }, deps);
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-existing', sk: 'PROFILE', accountId: 'acct-existing', role: 'user', createdAt: deps.now() },
      },
    });

    const linkResult = await ensureIdentityLinkedToAccount({
      accountId: 'acct-existing',
      type: 'privy',
      providerId: 'privy-user-1',
    }, deps);

    expect(linkResult).toEqual({ linked: true, conflict: false });

    const mapped = await getAccountIdForIdentity('privy', 'privy-user-1', deps);
    expect(mapped).toBe('acct-existing');
  });

  it('reports a conflict when a Privy identity is already linked elsewhere', async () => {
    // Seed profiles
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-wallet', sk: 'PROFILE', accountId: 'acct-wallet', role: 'user', createdAt: deps.now() },
      },
    });
    await (deps.dynamoClient.send as any)({
      input: {
        TableName: deps.tableName,
        Item: { pk: 'ACCOUNT#acct-privy', sk: 'PROFILE', accountId: 'acct-privy', role: 'user', createdAt: deps.now() },
      },
    });

    await ensureIdentityLinkedToAccount({ accountId: 'acct-wallet', type: 'wallet', providerId: 'wallet-1' }, deps);
    await ensureIdentityLinkedToAccount({ accountId: 'acct-privy', type: 'privy', providerId: 'privy-user-1' }, deps);

    const linkResult = await ensureIdentityLinkedToAccount({
      accountId: 'acct-wallet',
      type: 'privy',
      providerId: 'privy-user-1',
    }, deps);

    expect(linkResult).toEqual({ linked: false, conflict: true, existingAccountId: 'acct-privy' });
  });
});
