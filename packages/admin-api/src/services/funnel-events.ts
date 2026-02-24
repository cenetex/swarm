/**
 * GTM Funnel Events Service
 *
 * Records and queries funnel checkpoint events for the GTM activation
 * and conversion pipeline (F0 through F6).
 *
 * Funnel stages:
 *   F0 - Qualified visitor/session
 *   F1 - Authenticated account
 *   F2 - Avatar created
 *   F3 - First live response delivered
 *   F4 - Day-7 active avatar
 *   F5 - Paid conversion
 *   F6 - Expansion event (2+ active avatars or team usage)
 *
 * Schema:
 *   pk: FUNNEL#<userId>
 *   sk: STAGE#<stage>#<timestamp>#<id>
 *   gsi1pk: FUNNEL_STAGE#<stage>  (for cross-user stage queries)
 *   gsi1sk: <timestamp>
 *
 * TTL: 365 days (funnel data retained longer than operational logs).
 */
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from './dynamo-client.js';

// Funnel TTL: 365 days
const FUNNEL_TTL_SECONDS = 365 * 24 * 60 * 60;

// ============================================================================
// Types
// ============================================================================

export type FunnelStage = 'F0' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';

export const FUNNEL_STAGE_LABELS: Record<FunnelStage, string> = {
  F0: 'Qualified visitor/session',
  F1: 'Authenticated account',
  F2: 'Avatar created',
  F3: 'First live response delivered',
  F4: 'Day-7 active avatar',
  F5: 'Paid conversion',
  F6: 'Expansion event',
};

export interface FunnelEvent {
  id: string;
  stage: FunnelStage;
  timestamp: number;
  userId: string;
  avatarId?: string;
  metadata: Record<string, unknown>;
  failureReason?: string;
}

export interface RecordFunnelEventParams {
  stage: FunnelStage;
  userId: string;
  avatarId?: string;
  metadata?: Record<string, unknown>;
  failureReason?: string;
}

export interface ListFunnelEventsOptions {
  stage?: FunnelStage;
  limit?: number;
  since?: number; // timestamp ms
}

/** Dependencies that can be injected for testing. */
export interface FunnelEventsDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
}

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
  return `funnel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Default production deps (lazy-initialized)
// ============================================================================

let _defaultDeps: FunnelEventsDeps | null = null;

function getDefaultDeps(): FunnelEventsDeps {
  if (!_defaultDeps) {
    _defaultDeps = {
      dynamoClient: getDynamoClient(),
      tableName: process.env.ADMIN_TABLE || 'swarm-admin',
    };
  }
  return _defaultDeps;
}

// ============================================================================
// Core functions (accept explicit deps)
// ============================================================================

/**
 * Record a funnel checkpoint event.
 */
export async function recordFunnelEventWith(
  deps: FunnelEventsDeps,
  params: RecordFunnelEventParams,
): Promise<FunnelEvent> {
  const now = Date.now();
  const id = generateId();

  const event: FunnelEvent = {
    id,
    stage: params.stage,
    timestamp: now,
    userId: params.userId,
    avatarId: params.avatarId,
    metadata: params.metadata ?? {},
    failureReason: params.failureReason,
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk: `FUNNEL#${params.userId}`,
        sk: `STAGE#${params.stage}#${now}#${id}`,
        gsi1pk: `FUNNEL_STAGE#${params.stage}`,
        gsi1sk: now,
        ttl: Math.floor(now / 1000) + FUNNEL_TTL_SECONDS,
        ...event,
      },
    }),
  );

  return event;
}

/**
 * List funnel events for a specific user, newest first.
 */
export async function listFunnelEventsForUserWith(
  deps: FunnelEventsDeps,
  userId: string,
  options: ListFunnelEventsOptions = {},
): Promise<FunnelEvent[]> {
  const limit = Math.min(options.limit || 50, 500);
  const since = options.since || 0;

  let keyCondition = 'pk = :pk';
  const exprValues: Record<string, unknown> = {
    ':pk': `FUNNEL#${userId}`,
  };

  if (options.stage) {
    keyCondition += ' AND begins_with(sk, :skPrefix)';
    exprValues[':skPrefix'] = `STAGE#${options.stage}#`;
  } else if (since > 0) {
    keyCondition += ' AND sk >= :skSince';
    exprValues[':skSince'] = `STAGE#`;
  }

  const filterParts: string[] = [];
  if (since > 0) {
    filterParts.push('#ts >= :since');
    exprValues[':since'] = since;
  }

  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: keyCondition,
      FilterExpression: filterParts.length
        ? filterParts.join(' AND ')
        : undefined,
      ExpressionAttributeNames: filterParts.length
        ? { '#ts': 'timestamp' }
        : undefined,
      ExpressionAttributeValues: exprValues,
      Limit: limit,
      ScanIndexForward: false, // newest first
    }),
  );

  return (result.Items || []) as FunnelEvent[];
}

/**
 * List funnel events for a specific stage across all users (GSI query).
 * Used for weekly KPI reporting.
 */
export async function listFunnelEventsByStageWith(
  deps: FunnelEventsDeps,
  stage: FunnelStage,
  options: { since?: number; limit?: number } = {},
): Promise<FunnelEvent[]> {
  const limit = Math.min(options.limit || 1000, 5000);
  const since = options.since || Date.now() - 7 * 24 * 60 * 60 * 1000; // Default: 7 days

  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :since',
      ExpressionAttributeValues: {
        ':gsi1pk': `FUNNEL_STAGE#${stage}`,
        ':since': since,
      },
      Limit: limit,
      ScanIndexForward: false, // newest first
    }),
  );

  return (result.Items || []) as FunnelEvent[];
}

// ============================================================================
// Public API (uses default production deps)
// ============================================================================

export async function recordFunnelEvent(
  params: RecordFunnelEventParams,
): Promise<FunnelEvent> {
  return recordFunnelEventWith(getDefaultDeps(), params);
}

export async function listFunnelEventsForUser(
  userId: string,
  options?: ListFunnelEventsOptions,
): Promise<FunnelEvent[]> {
  return listFunnelEventsForUserWith(getDefaultDeps(), userId, options);
}

export async function listFunnelEventsByStage(
  stage: FunnelStage,
  options?: { since?: number; limit?: number },
): Promise<FunnelEvent[]> {
  return listFunnelEventsByStageWith(getDefaultDeps(), stage, options);
}
