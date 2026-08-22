/**
 * KeyValueStore — storage abstraction for the swarm backend.
 *
 * Defines the minimal set of operations every storage backend
 * (DynamoDB, SQLite, Postgres, etc.) must support, plus the shared
 * types used across all implementations.
 *
 * All backends use the same CompositeKey { pk, sk } model.
 */

// ============================================================================
// Shared Types
// ============================================================================

/** Composite key used by all tables in this project. */
export interface CompositeKey {
  pk: string;
  sk: string;
}

/** Options for conditional put operations. */
export interface ConditionalPutOptions {
  onlyIfNotExists?: boolean;
  conditionExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
}

/** Options for query operations. */
export interface QueryOptions {
  skCondition?: {
    type: 'begins_with' | 'eq';
    value: string;
  };
  limit?: number;
  scanForward?: boolean;
  indexName?: string;
  projectionExpression?: string;
  filterExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
}

/** Result of a paginated query. */
export interface PaginatedResult<T> {
  items: T[];
  lastEvaluatedKey?: Record<string, unknown>;
}

// ============================================================================
// KeyValueStore Interface
// ============================================================================

export interface KeyValueStore {
  /** Get a single item by composite key. Returns null when absent. */
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    key: CompositeKey,
    opts?: { projectionExpression?: string; expressionAttributeNames?: Record<string, string> },
  ): Promise<T | null>;

  /** Upsert an item. Returns false on condition failure, true otherwise. */
  put(
    item: Record<string, unknown> & CompositeKey,
    options?: ConditionalPutOptions,
  ): Promise<boolean>;

  /** Delete an item by composite key. */
  delete(key: CompositeKey): Promise<void>;

  /** Query items by pk with optional sk condition. Returns all matching items. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
  ): Promise<T[]>;

  /** Query a single page, returning the pagination token. */
  queryPage<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
    exclusiveStartKey?: Record<string, unknown>,
  ): Promise<PaginatedResult<T>>;

  /** Query all pages. Use sparingly. */
  queryAll<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
  ): Promise<T[]>;

  /** Update an item with an update expression. */
  update<T extends Record<string, unknown> = Record<string, unknown>>(
    key: CompositeKey,
    params: {
      updateExpression: string;
      expressionAttributeNames?: Record<string, string>;
      expressionAttributeValues?: Record<string, unknown>;
      conditionExpression?: string;
      returnValues?: 'ALL_NEW' | 'ALL_OLD' | 'UPDATED_NEW' | 'UPDATED_OLD' | 'NONE';
    },
  ): Promise<T | null>;

  /** Batch write up to 25 items (put or delete). */
  batchWrite(
    operations: Array<
      | { type: 'put'; item: Record<string, unknown> & CompositeKey }
      | { type: 'delete'; key: CompositeKey }
    >,
  ): Promise<void>;

  /** Scan with a filter expression. Use sparingly. */
  scan<T extends Record<string, unknown> = Record<string, unknown>>(
    params: {
      filterExpression: string;
      expressionAttributeValues: Record<string, unknown>;
      expressionAttributeNames?: Record<string, string>;
      projectionExpression?: string;
      limit?: number;
    },
  ): Promise<T[]>;
}
