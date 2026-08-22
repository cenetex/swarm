/**
 * Idempotency Store Service
 *
 * DynamoDB-backed idempotency store with in-memory fallback.
 * Uses conditional PutItem (attribute_not_exists) for atomic check-and-set
 * to prevent race conditions across concurrent Lambda invocations.
 *
 * DynamoDB Key Schema:
 * - pk: IDEMPOTENCY#{key}
 * - sk: "IDEMPOTENCY"
 *
 * Falls back to an in-memory Map when DynamoDB is unavailable,
 * preserving basic deduplication within a single Lambda instance.
 *
 * @module idempotency
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@swarm/core';
import { getDynamoClient as getSharedDynamoClient, _setDynamoClient as _setSharedDynamoClient } from './dynamo-client.js';
import { logger } from '@swarm/core';

// ============================================================================
// Configuration
// ============================================================================

const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin-table';

/** Default TTL: 5 minutes in milliseconds */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Sort key constant for idempotency records */
const IDEMPOTENCY_SK = 'IDEMPOTENCY';

function logSafe(level: 'debug' | 'info' | 'warn', message: string, meta: Record<string, unknown>): void {
  try {
    if (level === 'debug') {
      logger.debug(message, meta);
      return;
    }
    if (level === 'info') {
      logger.info(message, meta);
      return;
    }
    logger.warn(message, meta);
  } catch {
    // no-op
  }
}

// ============================================================================
// DynamoDB Client (DI pattern)
// ============================================================================

function getDynamoClient(): DynamoDBDocumentClient {
  return getSharedDynamoClient();
}

/** For testing -- inject a mock DynamoDB client */
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  _setSharedDynamoClient(client);
}

// ============================================================================
// Types
// ============================================================================

export interface IdempotencyRecord<T> {
  value: T;
  expiresAt: number;
}

export interface IdempotencyStore<T> {
  /**
   * Check if a key exists and is not expired.
   * Returns the cached value or null.
   */
  get: (key: string) => Promise<T | null>;

  /**
   * Atomically claim a key if it does not already exist.
   * Returns true if the key was claimed (first writer wins),
   * false if the key already existed (duplicate detected).
   * Use this to acquire a lock before starting work.
   */
  set: (key: string, value: T) => Promise<boolean>;

  /**
   * Unconditionally overwrite the value for an existing key.
   * Use this after completing work to replace a claim sentinel
   * with the actual result.
   */
  update: (key: string, value: T) => Promise<void>;

  /**
   * Remove a key, releasing the in-flight claim.
   * Use this when a request fails with a transient error so the
   * client can retry with the same idempotency key.
   */
  remove: (key: string) => Promise<void>;

  /**
   * Clear all entries (primarily for testing).
   * Only clears the in-memory fallback; DynamoDB entries expire via TTL.
   */
  clear: () => void;
}

// ============================================================================
// In-Memory Fallback Store
// ============================================================================

function createInMemoryStore<T>(params: {
  now: () => number;
  ttlMs: number;
}): {
  get: (key: string) => T | null;
  has: (key: string) => boolean;
  set: (key: string, value: T) => void;
  delete: (key: string) => void;
  clear: () => void;
} {
  const { now, ttlMs } = params;
  const store = new Map<string, IdempotencyRecord<T>>();

  const getRecord = (key: string): IdempotencyRecord<T> | null => {
    const record = store.get(key);
    if (!record) return null;
    if (record.expiresAt <= now()) {
      store.delete(key);
      return null;
    }
    return record;
  };

  return {
    get(key: string): T | null {
      const record = getRecord(key);
      return record ? record.value : null;
    },
    has(key: string): boolean {
      return getRecord(key) !== null;
    },
    set(key: string, value: T): void {
      store.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
}

// ============================================================================
// DynamoDB-Backed Idempotency Store
// ============================================================================

export function createIdempotencyStore<T>(params?: {
  now?: () => number;
  ttlMs?: number;
  dynamoClient?: DynamoDBDocumentClient;
}): IdempotencyStore<T> {
  const now = params?.now ?? (() => Date.now());
  const ttlMs = params?.ttlMs ?? DEFAULT_TTL_MS;
  const dynamoClient = params?.dynamoClient;

  // In-memory fallback for when DynamoDB is unavailable
  const memoryStore = createInMemoryStore<T>({ now, ttlMs });

  const get = async (key: string): Promise<T | null> => {
    try {
      const result = await (dynamoClient ?? getDynamoClient()).send(new GetCommand({
        TableName: ADMIN_TABLE,
        Key: {
          pk: `IDEMPOTENCY#${key}`,
          sk: IDEMPOTENCY_SK,
        },
      }));

      if (!result.Item) return null;

      const record = result.Item;
      const ttlEpochSeconds = record.ttl as number | undefined;

      // Check if expired (ttl is epoch seconds)
      if (ttlEpochSeconds && ttlEpochSeconds <= Math.floor(now() / 1000)) {
        return null;
      }

      return record.value as T;
    } catch (error) {
      logSafe('warn', 'DynamoDB idempotency get failed, falling back to memory', {
        event: 'idempotency_dynamo_get_error',
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Fall back to in-memory store
      return memoryStore.get(key);
    }
  };

  const set = async (key: string, value: T): Promise<boolean> => {
    const ttlEpochSeconds = Math.floor(now() / 1000) + Math.floor(ttlMs / 1000);

    try {
      await (dynamoClient ?? getDynamoClient()).send(new PutCommand({
        TableName: ADMIN_TABLE,
        Item: {
          pk: `IDEMPOTENCY#${key}`,
          sk: IDEMPOTENCY_SK,
          value,
          ttl: ttlEpochSeconds,
          createdAt: now(),
        },
        // Atomic check-and-set: only write if key does not exist
        // OR if the existing record has expired
        ConditionExpression: 'attribute_not_exists(pk) OR #ttl <= :now',
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':now': Math.floor(now() / 1000),
        },
      }));

      // Also set in memory store for fast reads within same instance
      memoryStore.set(key, value);

      logSafe('debug', 'Idempotency key set in DynamoDB', {
        event: 'idempotency_set',
        key,
        ttlEpochSeconds,
      });

      return true;
    } catch (error) {
      // ConditionalCheckFailedException means the key already exists (duplicate)
      if (error instanceof ConditionalCheckFailedException ||
          (error instanceof Error && error.name === 'ConditionalCheckFailedException')) {
        logSafe('info', 'Idempotency key already exists (duplicate detected)', {
          event: 'idempotency_duplicate',
          key,
        });
        return false;
      }

      // DynamoDB is unavailable -- fall back to in-memory store
      logSafe('warn', 'DynamoDB idempotency set failed, falling back to memory', {
        event: 'idempotency_dynamo_set_error',
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Check in-memory first (simulate atomic check-and-set)
      if (memoryStore.has(key)) {
        return false; // Already exists in memory
      }

      memoryStore.set(key, value);
      return true;
    }
  };

  const update = async (key: string, value: T): Promise<void> => {
    const ttlEpochSeconds = Math.floor(now() / 1000) + Math.floor(ttlMs / 1000);

    try {
      await (dynamoClient ?? getDynamoClient()).send(new PutCommand({
        TableName: ADMIN_TABLE,
        Item: {
          pk: `IDEMPOTENCY#${key}`,
          sk: IDEMPOTENCY_SK,
          value,
          ttl: ttlEpochSeconds,
          createdAt: now(),
        },
        // No condition — unconditional overwrite
      }));

      memoryStore.set(key, value);
    } catch (error) {
      logSafe('warn', 'DynamoDB idempotency update failed, updating memory only', {
        event: 'idempotency_dynamo_update_error',
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      memoryStore.set(key, value);
    }
  };

  const remove = async (key: string): Promise<void> => {
    try {
      await (dynamoClient ?? getDynamoClient()).send(new DeleteCommand({
        TableName: ADMIN_TABLE,
        Key: {
          pk: `IDEMPOTENCY#${key}`,
          sk: IDEMPOTENCY_SK,
        },
      }));

      memoryStore.delete(key);

      logSafe('debug', 'Idempotency key removed', {
        event: 'idempotency_remove',
        key,
      });
    } catch (error) {
      logSafe('warn', 'DynamoDB idempotency remove failed, removing from memory only', {
        event: 'idempotency_dynamo_remove_error',
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      memoryStore.delete(key);
    }
  };

  const clear = () => {
    memoryStore.clear();
  };

  return { get, set, update, remove, clear };
}

// ============================================================================
// Singleton Store for Chat Handler
// ============================================================================

export const chatIdempotencyStore = createIdempotencyStore<unknown>();
