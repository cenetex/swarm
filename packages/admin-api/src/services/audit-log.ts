/**
 * Audit Log Service
 *
 * Records and retrieves audit events for avatar state transitions
 * (activation, deactivation, entitlement changes) in DynamoDB.
 *
 * Schema:
 *   pk: AUDIT#<avatarId>
 *   sk: EVENT#<timestamp>#<uuid>
 *   gsi1pk: AUDIT_TYPE#<eventType>  (for cross-avatar queries)
 *   gsi1sk: <timestamp>
 *
 * TTL: 365 days (audit events have longer retention than operational logs).
 */
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from './dynamo-client.js';

// Audit TTL: 365 days (configurable via environment variable).
// Extended from 90 days to meet GDPR compliance evidence retention requirements.
// Audit events record state transitions (activation, entitlement changes) and
// contain actorId + eventType but no message content or user PII.
const AUDIT_TTL_SECONDS = parseInt(
  process.env.AUDIT_TTL_DAYS || '365',
  10
) * 24 * 60 * 60;

// ============================================================================
// Types
// ============================================================================

export type AuditEventType =
  | 'activated'
  | 'deactivated'
  | 'entitlement_changed'
  | 'avatar_created'
  | 'avatar_updated'
  | 'avatar_deleted'
  | 'avatar_reassigned'
  | 'avatar_ownership_denied'
  | 'secret_set'
  | 'wallet_swept'
  | 'wallet_key_deleted';

export type ActorType = 'admin' | 'owner';

export interface AuditEvent {
  id: string;
  avatarId: string;
  eventType: AuditEventType;
  actorId: string;
  actorType: ActorType;
  details: Record<string, unknown>;
  timestamp: number;
}

export interface ListAuditEventsOptions {
  eventType?: AuditEventType;
  limit?: number;
  since?: number; // timestamp ms
}

/** Dependencies that can be injected for testing. */
export interface AuditLogDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
}

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
  return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Default production deps (lazy-initialized)
// ============================================================================

let _defaultDeps: AuditLogDeps | null = null;

function getDefaultDeps(): AuditLogDeps {
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
 * Record an audit event for an avatar state transition.
 */
export async function recordAuditEventWith(
  deps: AuditLogDeps,
  params: {
    avatarId: string;
    eventType: AuditEventType;
    actorId: string;
    actorType: ActorType;
    details: Record<string, unknown>;
  },
): Promise<AuditEvent> {
  const now = Date.now();
  const id = generateId();

  const event: AuditEvent = {
    id,
    avatarId: params.avatarId,
    eventType: params.eventType,
    actorId: params.actorId,
    actorType: params.actorType,
    details: params.details,
    timestamp: now,
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk: `AUDIT#${params.avatarId}`,
        sk: `EVENT#${now}#${id}`,
        gsi1pk: `AUDIT_TYPE#${params.eventType}`,
        gsi1sk: now,
        ttl: Math.floor(now / 1000) + AUDIT_TTL_SECONDS,
        ...event,
      },
    }),
  );

  return event;
}

/**
 * List audit events for a specific avatar, newest first.
 */
export async function listAuditEventsWith(
  deps: AuditLogDeps,
  avatarId: string,
  options: ListAuditEventsOptions = {},
): Promise<AuditEvent[]> {
  const limit = Math.min(options.limit || 50, 500);
  const since = options.since || Date.now() - 90 * 24 * 60 * 60 * 1000; // Default: 90 days

  const filterParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {
    ':pk': `AUDIT#${avatarId}`,
    ':skPrefix': `EVENT#${since}`,
  };

  if (options.eventType) {
    filterParts.push('eventType = :eventType');
    exprValues[':eventType'] = options.eventType;
  }

  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND sk >= :skPrefix',
      FilterExpression: filterParts.length
        ? filterParts.join(' AND ')
        : undefined,
      ExpressionAttributeNames: Object.keys(exprNames).length
        ? exprNames
        : undefined,
      ExpressionAttributeValues: exprValues,
      Limit: limit,
      ScanIndexForward: false, // newest first
    }),
  );

  return (result.Items || []) as AuditEvent[];
}

// ============================================================================
// Public API (uses default production deps)
// ============================================================================

export async function recordAuditEvent(
  params: Parameters<typeof recordAuditEventWith>[1],
): Promise<AuditEvent> {
  return recordAuditEventWith(getDefaultDeps(), params);
}

export async function listAuditEvents(
  avatarId: string,
  options?: ListAuditEventsOptions,
): Promise<AuditEvent[]> {
  return listAuditEventsWith(getDefaultDeps(), avatarId, options);
}
