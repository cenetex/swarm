/**
 * DynamoDB Repository Abstraction
 *
 * Lightweight base class that encapsulates recurring DynamoDB access patterns:
 * - get / put / delete by composite key
 * - query by partition key with optional sort-key prefix
 * - conditional put (idempotent insert)
 * - paginated query
 * - TTL helpers
 *
 * Services extend or compose this class instead of passing docClient and
 * tableName through every function call.
 *
 * @module dynamo-repository
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  BatchWriteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  GetCommandInput,
  PutCommandInput,
  DeleteCommandInput,
  QueryCommandInput,
  UpdateCommandInput,
  BatchWriteCommandInput,
  ScanCommandInput,
  QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';

// ============================================================================
// Types
// ============================================================================

/** Composite key used by all DynamoDB tables in this project. */
export interface CompositeKey {
  pk: string;
  sk: string;
}

/** Options for conditional put operations. */
export interface ConditionalPutOptions {
  /** Only write if the item does not already exist (uses attribute_not_exists(pk)). */
  onlyIfNotExists?: boolean;
  /** Custom condition expression (overrides onlyIfNotExists). */
  conditionExpression?: string;
  /** Expression attribute names for the condition. */
  expressionAttributeNames?: Record<string, string>;
  /** Expression attribute values for the condition. */
  expressionAttributeValues?: Record<string, unknown>;
}

/** Options for query operations. */
export interface QueryOptions {
  /** Sort key condition: 'begins_with', 'between', or exact match. */
  skCondition?: {
    type: 'begins_with' | 'eq';
    value: string;
  };
  /** Maximum number of items to return. */
  limit?: number;
  /** Scan forward (ascending sort key order). Defaults to true. */
  scanForward?: boolean;
  /** Index name for GSI queries. */
  indexName?: string;
  /** Projection expression to limit returned attributes. */
  projectionExpression?: string;
  /** Filter expression applied after the query. */
  filterExpression?: string;
  /** Expression attribute names. */
  expressionAttributeNames?: Record<string, string>;
  /** Expression attribute values (merged with auto-generated ones). */
  expressionAttributeValues?: Record<string, unknown>;
}

/** Result of a paginated query. */
export interface PaginatedResult<T> {
  items: T[];
  lastEvaluatedKey?: Record<string, unknown>;
}

// ============================================================================
// DynamoRepository
// ============================================================================

/**
 * Lightweight DynamoDB repository base class.
 *
 * Encapsulates the document client and table name, and provides typed
 * wrappers around the most common access patterns. Services can extend
 * this class or use it via composition.
 *
 * ```ts
 * class MyRepo extends DynamoRepository {
 *   async getWidget(id: string) {
 *     return this.get<Widget>({ pk: `WIDGET#${id}`, sk: 'META' });
 *   }
 * }
 * ```
 */
export class DynamoRepository {
  protected readonly docClient: DynamoDBDocumentClient;
  protected readonly tableName: string;

  constructor(tableName: string, docClient?: DynamoDBDocumentClient) {
    if (docClient) {
      this.docClient = docClient;
    } else {
      const client = new DynamoDBClient({ region: 'us-east-1' });
      this.docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    this.tableName = tableName;
  }

  // --------------------------------------------------------------------------
  // Core CRUD
  // --------------------------------------------------------------------------

  /**
   * Get a single item by composite key.
   * Returns `null` when the item does not exist.
   */
  async get<T extends Record<string, unknown> = Record<string, unknown>>(
    key: CompositeKey,
    opts?: { projectionExpression?: string; expressionAttributeNames?: Record<string, string> },
  ): Promise<T | null> {
    const input: GetCommandInput = {
      TableName: this.tableName,
      Key: key,
    };
    if (opts?.projectionExpression) {
      input.ProjectionExpression = opts.projectionExpression;
      if (opts.expressionAttributeNames) {
        input.ExpressionAttributeNames = opts.expressionAttributeNames;
      }
    }

    const result = await this.docClient.send(new GetCommand(input));
    return (result.Item as T) ?? null;
  }

  /**
   * Put (upsert) an item. Supports optional conditional writes.
   *
   * @returns `true` if the write succeeded, `false` if a condition check failed.
   */
  async put(
    item: Record<string, unknown> & CompositeKey,
    options?: ConditionalPutOptions,
  ): Promise<boolean> {
    const input: PutCommandInput = {
      TableName: this.tableName,
      Item: item,
    };

    if (options?.conditionExpression) {
      input.ConditionExpression = options.conditionExpression;
      if (options.expressionAttributeNames) {
        input.ExpressionAttributeNames = options.expressionAttributeNames;
      }
      if (options.expressionAttributeValues) {
        input.ExpressionAttributeValues = options.expressionAttributeValues;
      }
    } else if (options?.onlyIfNotExists) {
      input.ConditionExpression = 'attribute_not_exists(pk)';
    }

    try {
      await this.docClient.send(new PutCommand(input));
      return true;
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete an item by composite key.
   */
  async delete(key: CompositeKey): Promise<void> {
    const input: DeleteCommandInput = {
      TableName: this.tableName,
      Key: key,
    };
    await this.docClient.send(new DeleteCommand(input));
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  /**
   * Query items by partition key with optional sort key condition.
   * Returns all matching items (no pagination token).
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
  ): Promise<T[]> {
    const result = await this.queryPage<T>(pk, options);
    return result.items;
  }

  /**
   * Query a single page of items, returning the pagination token.
   */
  async queryPage<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
    exclusiveStartKey?: Record<string, unknown>,
  ): Promise<PaginatedResult<T>> {
    const pkName = options?.indexName ? 'gsi1pk' : 'pk';
    let keyCondition = `${pkName} = :pk`;
    const expressionValues: Record<string, unknown> = {
      ':pk': pk,
      ...options?.expressionAttributeValues,
    };
    const expressionNames: Record<string, string> = {
      ...options?.expressionAttributeNames,
    };

    if (options?.skCondition) {
      const skName = options?.indexName ? 'gsi1sk' : 'sk';
      if (options.skCondition.type === 'begins_with') {
        keyCondition += ` AND begins_with(${skName}, :skPrefix)`;
        expressionValues[':skPrefix'] = options.skCondition.value;
      } else {
        keyCondition += ` AND ${skName} = :skValue`;
        expressionValues[':skValue'] = options.skCondition.value;
      }
    }

    const input: QueryCommandInput = {
      TableName: this.tableName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: options?.scanForward ?? true,
    };

    if (options?.indexName) input.IndexName = options.indexName;
    if (options?.limit) input.Limit = options.limit;
    if (options?.projectionExpression) input.ProjectionExpression = options.projectionExpression;
    if (options?.filterExpression) input.FilterExpression = options.filterExpression;
    if (Object.keys(expressionNames).length > 0) input.ExpressionAttributeNames = expressionNames;
    if (exclusiveStartKey) input.ExclusiveStartKey = exclusiveStartKey as QueryCommandOutput['LastEvaluatedKey'];

    const result = await this.docClient.send(new QueryCommand(input));

    return {
      items: (result.Items as T[]) ?? [],
      lastEvaluatedKey: result.LastEvaluatedKey as Record<string, unknown> | undefined,
    };
  }

  /**
   * Query all pages, automatically following pagination tokens.
   * Use with care on large result sets.
   */
  async queryAll<T extends Record<string, unknown> = Record<string, unknown>>(
    pk: string,
    options?: QueryOptions,
  ): Promise<T[]> {
    const allItems: T[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const page = await this.queryPage<T>(pk, options, lastKey);
      allItems.push(...page.items);
      lastKey = page.lastEvaluatedKey;
    } while (lastKey);

    return allItems;
  }

  // --------------------------------------------------------------------------
  // Update
  // --------------------------------------------------------------------------

  /**
   * Update an item using an UpdateExpression. Returns the updated attributes
   * when `returnValues` is specified.
   */
  async update<T extends Record<string, unknown> = Record<string, unknown>>(
    key: CompositeKey,
    params: {
      updateExpression: string;
      expressionAttributeNames?: Record<string, string>;
      expressionAttributeValues?: Record<string, unknown>;
      conditionExpression?: string;
      returnValues?: 'ALL_NEW' | 'ALL_OLD' | 'UPDATED_NEW' | 'UPDATED_OLD' | 'NONE';
    },
  ): Promise<T | null> {
    const input: UpdateCommandInput = {
      TableName: this.tableName,
      Key: key,
      UpdateExpression: params.updateExpression,
      ReturnValues: params.returnValues ?? 'NONE',
    };

    if (params.expressionAttributeNames) input.ExpressionAttributeNames = params.expressionAttributeNames;
    if (params.expressionAttributeValues) input.ExpressionAttributeValues = params.expressionAttributeValues;
    if (params.conditionExpression) input.ConditionExpression = params.conditionExpression;

    const result = await this.docClient.send(new UpdateCommand(input));
    return (result.Attributes as T) ?? null;
  }

  // --------------------------------------------------------------------------
  // Batch
  // --------------------------------------------------------------------------

  /**
   * Batch write up to 25 items (put or delete).
   * Automatically retries unprocessed items once.
   */
  async batchWrite(
    operations: Array<
      | { type: 'put'; item: Record<string, unknown> & CompositeKey }
      | { type: 'delete'; key: CompositeKey }
    >,
  ): Promise<void> {
    if (operations.length === 0) return;
    if (operations.length > 25) {
      throw new Error(`batchWrite supports at most 25 operations, got ${operations.length}`);
    }

    const writeRequests = operations.map((op) => {
      if (op.type === 'put') {
        return { PutRequest: { Item: op.item } };
      }
      return { DeleteRequest: { Key: op.key } };
    });

    const input: BatchWriteCommandInput = {
      RequestItems: {
        [this.tableName]: writeRequests,
      },
    };

    const result = await this.docClient.send(new BatchWriteCommand(input));

    // Simple single retry for unprocessed items
    const unprocessed = result.UnprocessedItems?.[this.tableName];
    if (unprocessed && unprocessed.length > 0) {
      await this.docClient.send(new BatchWriteCommand({
        RequestItems: { [this.tableName]: unprocessed },
      }));
    }
  }

  // --------------------------------------------------------------------------
  // Scan (use sparingly)
  // --------------------------------------------------------------------------

  /**
   * Scan with a filter expression. Use sparingly -- prefer queries.
   */
  async scan<T extends Record<string, unknown> = Record<string, unknown>>(
    params: {
      filterExpression: string;
      expressionAttributeValues: Record<string, unknown>;
      expressionAttributeNames?: Record<string, string>;
      projectionExpression?: string;
      limit?: number;
    },
  ): Promise<T[]> {
    const input: ScanCommandInput = {
      TableName: this.tableName,
      FilterExpression: params.filterExpression,
      ExpressionAttributeValues: params.expressionAttributeValues,
    };

    if (params.expressionAttributeNames) input.ExpressionAttributeNames = params.expressionAttributeNames;
    if (params.projectionExpression) input.ProjectionExpression = params.projectionExpression;
    if (params.limit) input.Limit = params.limit;

    const result = await this.docClient.send(new ScanCommand(input));
    return (result.Items as T[]) ?? [];
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Compute a TTL epoch-seconds value from a duration in seconds from now.
   */
  static ttlFromNow(durationSeconds: number): number {
    return Math.floor(Date.now() / 1000) + durationSeconds;
  }

  /**
   * Check if a TTL value has expired.
   */
  static isTtlExpired(ttl: number | undefined): boolean {
    if (ttl === undefined) return false;
    return Date.now() / 1000 > ttl;
  }
}
