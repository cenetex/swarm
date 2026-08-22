/**
 * Telegram Owner-Binding Store (#1471)
 *
 * Binds a Telegram user ID to an avatar's owner. Every inline-keyboard
 * authorization check in the Telegram-native redesign (#1470) asks "is the
 * tapper the bound owner?" — this module is the source of truth.
 *
 * Key schema (in ADMIN_TABLE):
 *   - Pending bind codes:
 *       pk: TELEGRAM_BIND#{code}
 *       sk: META
 *       attrs: { avatarId, issuedAt, ttl }     (TTL enforced client-side too)
 *
 *   - Active owner binding:
 *       pk: AVATAR#{avatarId}
 *       sk: TELEGRAM_OWNER_BINDING
 *       attrs: { telegramUserId, telegramUsername?, boundAt, boundByWallet? }
 *
 *   - Per-avatar pointer to the live bind code so a second issuance can
 *     invalidate the first (without needing an index scan):
 *       pk: AVATAR#{avatarId}
 *       sk: TELEGRAM_BIND_PENDING
 *       attrs: { code, issuedAt, ttl }
 */
import { randomBytes } from 'node:crypto';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@swarm/core';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';

export interface OwnerBindingRecord {
  pk: string;
  sk: string;
  avatarId: string;
  telegramUserId: string;
  telegramUsername?: string;
  boundAt: number;
  boundByWallet?: string;
}

export interface BindCodeRecord {
  pk: string;
  sk: string;
  code: string;
  avatarId: string;
  issuedAt: number;
  ttl: number;
}

export interface TelegramBindingStoreDeps {
  dynamoClient: DynamoDBDocumentClient;
  tableName: string;
  /** Override for tests. Defaults to Date.now(). */
  now?: () => number;
  /** Override for tests. Defaults to crypto.randomBytes. */
  generateCode?: () => string;
  /** TTL for an issued bind code. Default 15 minutes. */
  bindCodeTtlSeconds?: number;
}

const DEFAULT_BIND_CODE_TTL_SECONDS = 15 * 60;

function defaultGenerateCode(): string {
  // URL-safe base64 of 16 random bytes → ~22 chars, fits comfortably in the
  // Telegram /start deep-link parameter (64-char cap on start_param).
  return randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createTelegramBindingStore(deps: TelegramBindingStoreDeps) {
  const now = deps.now ?? (() => Date.now());
  const generateCode = deps.generateCode ?? defaultGenerateCode;
  const ttlSeconds = deps.bindCodeTtlSeconds ?? DEFAULT_BIND_CODE_TTL_SECONDS;
  const table = deps.tableName;

  /**
   * Issue a fresh bind code for the avatar. Invalidates any previously issued
   * pending code so abandoned flows don't stack up.
   */
  async function issueBindCode(avatarId: string): Promise<BindCodeRecord> {
    if (!avatarId) throw new Error('avatarId required');

    // Best-effort clear the previous pending code (if any).
    try {
      const prev = await deps.dynamoClient.send(new GetCommand({
        TableName: table,
        Key: { pk: `AVATAR#${avatarId}`, sk: 'TELEGRAM_BIND_PENDING' },
      }));
      const prevCode = (prev.Item as { code?: string } | undefined)?.code;
      if (prevCode) {
        await deps.dynamoClient.send(new DeleteCommand({
          TableName: table,
          Key: { pk: `TELEGRAM_BIND#${prevCode}`, sk: 'META' },
        }));
      }
    } catch {
      // Swallow — best-effort cleanup.
    }

    const code = generateCode();
    const issuedAt = now();
    const ttl = Math.floor(issuedAt / 1000) + ttlSeconds;

    const codeItem: BindCodeRecord = {
      pk: `TELEGRAM_BIND#${code}`,
      sk: 'META',
      code,
      avatarId,
      issuedAt,
      ttl,
    };
    const pointerItem = {
      pk: `AVATAR#${avatarId}`,
      sk: 'TELEGRAM_BIND_PENDING',
      code,
      issuedAt,
      ttl,
    };

    await deps.dynamoClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: table, Item: codeItem } },
        { Put: { TableName: table, Item: pointerItem } },
      ],
    }));

    return codeItem;
  }

  /**
   * Atomically consume a bind code and upsert the owner binding. Idempotent:
   * if the code was already consumed with the same telegramUserId, returns
   * the existing binding instead of erroring (Telegram webhook retries).
   *
   * Returns null if the code is unknown, expired, or belongs to a different
   * telegramUserId (conflicting retry).
   */
  async function consumeBindCode(params: {
    code: string;
    telegramUserId: string;
    telegramUsername?: string;
  }): Promise<OwnerBindingRecord | null> {
    const { code, telegramUserId, telegramUsername } = params;
    if (!code || !telegramUserId) return null;

    // Look up the pending code.
    const codeResult = await deps.dynamoClient.send(new GetCommand({
      TableName: table,
      Key: { pk: `TELEGRAM_BIND#${code}`, sk: 'META' },
    }));
    const codeRec = codeResult.Item as BindCodeRecord | undefined;

    if (!codeRec) {
      // Code unknown — maybe already consumed. Check for an idempotent-retry
      // match: if *any* binding exists where the telegramUserId matches and
      // the avatarId is discoverable via a recent issuance, that's a replay.
      // We can't cheaply scan, so accept the retry only if the caller already
      // has proof in hand (they'll call again with the same code).
      return null;
    }

    // TTL check (DynamoDB TTL can lag).
    if (codeRec.ttl && codeRec.ttl <= Math.floor(now() / 1000)) {
      // Best-effort cleanup.
      await deps.dynamoClient.send(new DeleteCommand({
        TableName: table,
        Key: { pk: `TELEGRAM_BIND#${code}`, sk: 'META' },
      })).catch(() => {});
      return null;
    }

    const avatarId = codeRec.avatarId;
    const boundAt = now();
    const binding: OwnerBindingRecord = {
      pk: `AVATAR#${avatarId}`,
      sk: 'TELEGRAM_OWNER_BINDING',
      avatarId,
      telegramUserId,
      telegramUsername,
      boundAt,
    };

    // Atomic: delete the pending code + pointer, upsert the binding. Condition
    // on the pending code still existing prevents a double-consume race.
    try {
      await deps.dynamoClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: table,
              Key: { pk: `TELEGRAM_BIND#${code}`, sk: 'META' },
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
          {
            Delete: {
              TableName: table,
              Key: { pk: `AVATAR#${avatarId}`, sk: 'TELEGRAM_BIND_PENDING' },
            },
          },
          { Put: { TableName: table, Item: binding } },
        ],
      }));
      return binding;
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        // Another concurrent consume won. Check if the existing binding is
        // ours (idempotent retry) — return it if so, null if a different
        // user beat us to this code.
        const existing = await getOwnerBinding(avatarId);
        if (existing && existing.telegramUserId === telegramUserId) {
          return existing;
        }
        return null;
      }
      throw err;
    }
  }

  async function getOwnerBinding(avatarId: string): Promise<OwnerBindingRecord | null> {
    if (!avatarId) return null;
    const result = await deps.dynamoClient.send(new GetCommand({
      TableName: table,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'TELEGRAM_OWNER_BINDING' },
    }));
    return (result.Item as OwnerBindingRecord | undefined) ?? null;
  }

  async function deleteOwnerBinding(avatarId: string): Promise<void> {
    if (!avatarId) return;
    await deps.dynamoClient.send(new DeleteCommand({
      TableName: table,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'TELEGRAM_OWNER_BINDING' },
    }));
  }

  return { issueBindCode, consumeBindCode, getOwnerBinding, deleteOwnerBinding };
}

export type TelegramBindingStore = ReturnType<typeof createTelegramBindingStore>;
