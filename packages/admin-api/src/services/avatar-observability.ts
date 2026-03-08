/**
 * Avatar Observability Service
 *
 * Unified module for avatar observability data stored in DynamoDB:
 * - Logs: Fast structured log storage (24h TTL, immutable)
 * - Events: Avatar-reported issues and feedback (30d TTL, mutable status)
 *
 * CloudWatch Logs remains the source of truth for long-term audit.
 *
 * Shared DynamoDB Schema (ADMIN_TABLE):
 *   Logs:
 *     pk: AVATAR#<avatarId>
 *     sk: LOG#<timestamp>#<random>
 *     gsi1pk: LOGS#<level>  (cross-avatar error queries)
 *     gsi1sk: <timestamp>
 *
 *   Events:
 *     pk: AVATAR#<avatarId>
 *     sk: EVENT#<timestamp>#<type>
 *     gsi1pk: EVENTS#<type>  (cross-avatar queries)
 *     gsi1sk: <timestamp>
 */
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { redactLogData, redactString } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin';

// ============================================================================
// Constants
// ============================================================================

/** Log TTL: 24 hours (logs are for real-time debugging) */
const LOG_TTL_SECONDS = 24 * 60 * 60;

/** Event TTL: 30 days */
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Max items per DynamoDB BatchWriteCommand (service limit) */
const MAX_BATCH_SIZE = 25;

/** Max retries for UnprocessedItems */
const MAX_UNPROCESSED_RETRIES = 3;

/** Base delay (ms) for exponential backoff on UnprocessedItems retries */
const BACKOFF_BASE_MS = 100;

// ============================================================================
// Log Types
// ============================================================================

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface AvatarLogEntry {
  id: string;
  timestamp: number;
  avatarId: string;
  level: LogLevel;
  subsystem: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  requestId?: string;
  platform?: string;
}

export interface LogQueryOptions {
  level?: LogLevel;
  subsystem?: string;
  since?: number; // timestamp ms
  limit?: number;
  query?: string; // text search
}

export interface LogCountOptions {
  since?: number;
  maxPages?: number;
}

// ============================================================================
// Event Types
// ============================================================================

export type EventType = 'issue' | 'feedback';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueCategory =
  | 'ui_glitch'
  | 'missing_data'
  | 'timing_issue'
  | 'tool_failure'
  | 'user_experience'
  | 'unexpected_behavior'
  | 'performance'
  | 'other';
export type IssueStatus = 'open' | 'acknowledged' | 'resolved' | 'wont_fix';
export type FeedbackSentiment = 'positive' | 'negative' | 'neutral';

export interface AvatarIssueEvent {
  id: string;
  type: 'issue';
  timestamp: number;
  avatarId: string;
  platform: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  description: string;
  userMessage?: string;
  context?: {
    toolName?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    reproSteps?: string[];
  };
  status: IssueStatus;
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface AvatarFeedbackEvent {
  id: string;
  type: 'feedback';
  timestamp: number;
  avatarId: string;
  platform: string;
  sentiment: FeedbackSentiment;
  feature: string;
  feedback: string;
}

export type AvatarEvent = AvatarIssueEvent | AvatarFeedbackEvent;

export interface ListEventsOptions {
  type?: EventType;
  limit?: number;
  since?: number; // timestamp
  severity?: IssueSeverity; // for issues only
  sentiment?: FeedbackSentiment; // for feedback only
  status?: IssueStatus; // for issues only
}

// ============================================================================
// Log Write Operations
// ============================================================================

/**
 * Record a structured log entry
 */
export async function recordLog(params: {
  avatarId: string;
  level: LogLevel;
  subsystem: string;
  event: string;
  message?: string;
  data?: Record<string, unknown>;
  requestId?: string;
  platform?: string;
}): Promise<AvatarLogEntry> {
  const now = Date.now();
  const id = `log-${now}-${Math.random().toString(36).slice(2, 8)}`;

  // Redact PII at the write boundary. Structured metadata fields (avatarId,
  // level, subsystem, event, platform, requestId, timestamp) are preserved
  // because they contain system-generated identifiers needed for querying and
  // debugging. Free-form content fields (message, data) are redacted because
  // they may contain user-supplied PII (emails, wallet addresses, API keys).
  const redactedMessage = params.message
    ? redactString(params.message)
    : params.event;
  const redactedData = redactLogData(params.data);

  const entry: AvatarLogEntry = {
    id,
    timestamp: now,
    avatarId: params.avatarId,
    level: params.level,
    subsystem: params.subsystem,
    event: params.event,
    message: redactedMessage,
    data: redactedData,
    requestId: params.requestId,
    platform: params.platform,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: `AVATAR#${params.avatarId}`,
      sk: `LOG#${now}#${id.slice(-6)}`,
      gsi1pk: `LOGS#${params.level}`,
      gsi1sk: now,
      ttl: Math.floor(now / 1000) + LOG_TTL_SECONDS,
      ...entry,
    },
  }));

  return entry;
}

/** Dependency bag for recordLogBatch (enables testing without real DynamoDB) */
export interface RecordLogBatchDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  /** Override for testing — replaces setTimeout-based delay */
  delay?: (ms: number) => Promise<void>;
}

/**
 * Default delay function using setTimeout.
 */
function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Record multiple log entries in batch (injectable variant for testing).
 *
 * Chunks input into groups of 25 (DynamoDB BatchWriteItem limit) and retries
 * any UnprocessedItems with bounded exponential backoff.
 */
export async function recordLogBatchWith(
  deps: RecordLogBatchDeps,
  entries: Array<Omit<Parameters<typeof recordLog>[0], 'timestamp'>>
): Promise<{ totalEntries: number; writtenCount: number; droppedCount: number }> {
  if (entries.length === 0) {
    return { totalEntries: 0, writtenCount: 0, droppedCount: 0 };
  }

  const delay = deps.delay ?? defaultDelay;
  const now = Date.now();

  // Build all DynamoDB put-request items up front.
  // Redact free-form content (message, data) at the write boundary; structured
  // metadata (avatarId, level, subsystem, event, platform, requestId) is
  // preserved for queryability.
  const allItems = entries.map((params, idx) => {
    const id = `log-${now}-${idx}-${Math.random().toString(36).slice(2, 8)}`;
    const redactedMessage = params.message
      ? redactString(params.message)
      : params.event;
    const redactedData = redactLogData(params.data);
    return {
      PutRequest: {
        Item: {
          pk: `AVATAR#${params.avatarId}`,
          sk: `LOG#${now + idx}#${id.slice(-6)}`,
          gsi1pk: `LOGS#${params.level}`,
          gsi1sk: now + idx,
          ttl: Math.floor(now / 1000) + LOG_TTL_SECONDS,
          id,
          timestamp: now + idx,
          avatarId: params.avatarId,
          level: params.level,
          subsystem: params.subsystem,
          event: params.event,
          message: redactedMessage,
          data: redactedData,
          requestId: params.requestId,
          platform: params.platform,
        },
      },
    };
  });

  // Chunk into groups of MAX_BATCH_SIZE (25)
  const chunks: Array<typeof allItems> = [];
  for (let i = 0; i < allItems.length; i += MAX_BATCH_SIZE) {
    chunks.push(allItems.slice(i, i + MAX_BATCH_SIZE));
  }

  let totalDropped = 0;

  for (const chunk of chunks) {
    let pending = chunk;
    let attempt = 0;

    while (pending.length > 0 && attempt <= MAX_UNPROCESSED_RETRIES) {
      if (attempt > 0) {
        const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        await delay(backoffMs);
      }

      const result = await deps.dynamoClient.send(new BatchWriteCommand({
        RequestItems: {
          [deps.tableName]: pending,
        },
      }));

      const unprocessed = result?.UnprocessedItems?.[deps.tableName];
      if (!unprocessed || unprocessed.length === 0) {
        pending = [];
        break;
      }

      pending = unprocessed as typeof chunk;
      attempt++;
    }

    if (pending.length > 0) {
      totalDropped += pending.length;
      // eslint-disable-next-line no-console -- intentional operational warning for CloudWatch
      console.warn(
        `[avatar-observability] recordLogBatch: ${pending.length} items dropped after ${MAX_UNPROCESSED_RETRIES} retries`
      );
    }
  }

  const writtenCount = entries.length - totalDropped;
  return { totalEntries: entries.length, writtenCount, droppedCount: totalDropped };
}

/**
 * Record multiple log entries in batch.
 *
 * Processes all input entries (no truncation) by chunking into groups of 25.
 * Retries UnprocessedItems with exponential backoff. Logs a warning if any
 * items are dropped after retries are exhausted.
 */
export async function recordLogBatch(
  entries: Array<Omit<Parameters<typeof recordLog>[0], 'timestamp'>>
): Promise<void> {
  const result = await recordLogBatchWith(
    { dynamoClient, tableName: ADMIN_TABLE },
    entries,
  );

  if (result.droppedCount > 0) {
    // eslint-disable-next-line no-console -- intentional operational warning for CloudWatch
    console.warn(
      `[avatar-observability] recordLogBatch completed with ${result.droppedCount}/${result.totalEntries} items dropped`
    );
  }
}

// ============================================================================
// Log Read Operations
// ============================================================================

/**
 * List logs for a specific avatar (fast)
 */
export async function listAvatarLogs(
  avatarId: string,
  options: LogQueryOptions = {}
): Promise<{ logs: AvatarLogEntry[]; hasMore: boolean }> {
  const limit = Math.min(options.limit || 200, 500);
  const since = options.since || (Date.now() - 24 * 60 * 60 * 1000); // Default: 24h

  // Build filter expression
  const filterParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {
    ':pk': `AVATAR#${avatarId}`,
    ':skPrefix': `LOG#${since}`,
  };

  if (options.level) {
    filterParts.push('#level = :level');
    exprNames['#level'] = 'level';
    exprValues[':level'] = options.level;
  }

  if (options.subsystem) {
    filterParts.push('subsystem = :subsystem');
    exprValues[':subsystem'] = options.subsystem;
  }

  if (options.query) {
    // Simple text search in message
    filterParts.push('contains(message, :query)');
    exprValues[':query'] = options.query;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk >= :skPrefix',
    FilterExpression: filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
    ExpressionAttributeValues: exprValues,
    Limit: limit + 1, // Fetch one extra to detect hasMore
    ScanIndexForward: false, // Newest first
  }));

  const items = (result.Items || []) as AvatarLogEntry[];
  const hasMore = items.length > limit;

  return {
    logs: items.slice(0, limit),
    hasMore,
  };
}

/**
 * List logs by level across all avatars (for error dashboard)
 */
export async function listLogsByLevel(
  level: LogLevel,
  options: Omit<LogQueryOptions, 'level'> = {}
): Promise<{ logs: AvatarLogEntry[]; hasMore: boolean }> {
  const limit = Math.min(options.limit || 100, 500);
  const since = options.since || (Date.now() - 24 * 60 * 60 * 1000);

  const filterParts: string[] = [];
  const exprValues: Record<string, unknown> = {
    ':gsi1pk': `LOGS#${level}`,
    ':since': since,
  };

  if (options.subsystem) {
    filterParts.push('subsystem = :subsystem');
    exprValues[':subsystem'] = options.subsystem;
  }

  if (options.query) {
    filterParts.push('contains(message, :query)');
    exprValues[':query'] = options.query;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :since',
    FilterExpression: filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeValues: exprValues,
    Limit: limit + 1,
    ScanIndexForward: false,
  }));

  const items = (result.Items || []) as AvatarLogEntry[];
  const hasMore = items.length > limit;

  return {
    logs: items.slice(0, limit),
    hasMore,
  };
}

/**
 * Count logs by level across all avatars (for dashboards)
 */
export async function countLogsByLevel(
  level: LogLevel,
  options: LogCountOptions = {}
): Promise<{ count: number; truncated: boolean }> {
  const since = options.since || (Date.now() - 24 * 60 * 60 * 1000);
  const maxPages = options.maxPages ?? 3;

  let count = 0;
  let truncated = false;
  let lastKey: Record<string, unknown> | undefined;
  let pages = 0;

  do {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :since',
      ExpressionAttributeValues: {
        ':gsi1pk': `LOGS#${level}`,
        ':since': since,
      },
      Select: 'COUNT',
      ExclusiveStartKey: lastKey,
    }));

    count += result.Count || 0;
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;

    if (lastKey && pages >= maxPages) {
      truncated = true;
      break;
    }
  } while (lastKey);

  return { count, truncated };
}

/**
 * Get log counts by level for an avatar (for dashboard badges)
 */
export async function getAvatarLogCounts(
  avatarId: string,
  since?: number
): Promise<{ ERROR: number; WARN: number; INFO: number; DEBUG: number }> {
  const sincetime = since || (Date.now() - 60 * 60 * 1000); // Default: 1 hour
  const { logs } = await listAvatarLogs(avatarId, { since: sincetime, limit: 500 });

  const counts = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0 };
  for (const log of logs) {
    counts[log.level]++;
  }

  return counts;
}

/**
 * Parse a structured log JSON string and store it
 * Call this from handlers that want fast log access
 */
export async function parseAndStorelog(
  avatarId: string,
  jsonString: string,
  platform?: string
): Promise<AvatarLogEntry | null> {
  try {
    const parsed = JSON.parse(jsonString);
    if (!parsed.level || !parsed.subsystem || !parsed.event) {
      return null; // Not a structured log
    }

    return await recordLog({
      avatarId,
      level: (parsed.level?.toUpperCase() || 'INFO') as LogLevel,
      subsystem: parsed.subsystem,
      event: parsed.event,
      message: parsed.message || parsed.event,
      data: parsed,
      requestId: parsed.requestId,
      platform: platform || parsed.platform,
    });
  } catch {
    return null;
  }
}

// ============================================================================
// Event Write Operations
// ============================================================================

/**
 * Record an avatar-reported issue
 */
export async function recordIssue(params: {
  avatarId: string;
  platform: string;
  severity: IssueSeverity;
  category: IssueCategory;
  title: string;
  description: string;
  userMessage?: string;
  context?: AvatarIssueEvent['context'];
}): Promise<AvatarIssueEvent> {
  const now = Date.now();
  const id = `issue-${now}-${Math.random().toString(36).slice(2, 8)}`;

  // Redact PII from free-form content fields (title, description, userMessage,
  // context) at the write boundary. Structured metadata (avatarId, platform,
  // severity, category, type, status, timestamp) is preserved for querying.
  const event: AvatarIssueEvent = {
    id,
    type: 'issue',
    timestamp: now,
    avatarId: params.avatarId,
    platform: params.platform,
    severity: params.severity,
    category: params.category,
    title: redactString(params.title),
    description: redactString(params.description),
    userMessage: params.userMessage ? redactString(params.userMessage) : undefined,
    context: params.context
      ? redactLogData(params.context as unknown as Record<string, unknown>) as unknown as AvatarIssueEvent['context']
      : undefined,
    status: 'open',
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: `AVATAR#${params.avatarId}`,
      sk: `EVENT#${now}#issue`,
      gsi1pk: 'EVENTS#issue',
      gsi1sk: now,
      ttl: Math.floor(now / 1000) + EVENT_TTL_SECONDS,
      ...event,
    },
  }));

  return event;
}

/**
 * Record avatar-reported feedback
 */
export async function recordFeedback(params: {
  avatarId: string;
  platform: string;
  sentiment: FeedbackSentiment;
  feature: string;
  feedback: string;
}): Promise<AvatarFeedbackEvent> {
  const now = Date.now();
  const id = `feedback-${now}-${Math.random().toString(36).slice(2, 8)}`;

  // Redact PII from free-form content (feedback text) at the write boundary.
  // Structured metadata (avatarId, platform, sentiment, feature, type,
  // timestamp) is preserved for querying.
  const event: AvatarFeedbackEvent = {
    id,
    type: 'feedback',
    timestamp: now,
    avatarId: params.avatarId,
    platform: params.platform,
    sentiment: params.sentiment,
    feature: params.feature,
    feedback: redactString(params.feedback),
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: `AVATAR#${params.avatarId}`,
      sk: `EVENT#${now}#feedback`,
      gsi1pk: 'EVENTS#feedback',
      gsi1sk: now,
      ttl: Math.floor(now / 1000) + EVENT_TTL_SECONDS,
      ...event,
    },
  }));

  return event;
}

// ============================================================================
// Event Read Operations
// ============================================================================

/**
 * List events for a specific avatar
 */
export async function listAvatarEvents(
  avatarId: string,
  options: ListEventsOptions = {}
): Promise<AvatarEvent[]> {
  const limit = Math.min(options.limit || 100, 500);
  const since = options.since || (Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: 7 days

  // Build filter expression
  const filterParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {
    ':pk': `AVATAR#${avatarId}`,
    ':skPrefix': `EVENT#${since}`,
  };

  if (options.type) {
    filterParts.push('#type = :type');
    exprNames['#type'] = 'type';
    exprValues[':type'] = options.type;
  }

  if (options.severity) {
    filterParts.push('severity = :severity');
    exprValues[':severity'] = options.severity;
  }

  if (options.sentiment) {
    filterParts.push('sentiment = :sentiment');
    exprValues[':sentiment'] = options.sentiment;
  }

  if (options.status) {
    filterParts.push('#status = :status');
    exprNames['#status'] = 'status';
    exprValues[':status'] = options.status;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk >= :skPrefix',
    FilterExpression: filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
    ExpressionAttributeValues: exprValues,
    Limit: limit,
    ScanIndexForward: false, // newest first
  }));

  return (result.Items || []) as AvatarEvent[];
}

/**
 * List all events across avatars (admin view)
 */
export async function listAllEvents(
  type: EventType,
  options: Omit<ListEventsOptions, 'type'> = {}
): Promise<AvatarEvent[]> {
  const limit = Math.min(options.limit || 100, 500);
  const since = options.since || (Date.now() - 7 * 24 * 60 * 60 * 1000);

  const filterParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {
    ':gsi1pk': `EVENTS#${type}`,
    ':since': since,
  };

  if (options.severity) {
    filterParts.push('severity = :severity');
    exprValues[':severity'] = options.severity;
  }

  if (options.sentiment) {
    filterParts.push('sentiment = :sentiment');
    exprValues[':sentiment'] = options.sentiment;
  }

  if (options.status) {
    filterParts.push('#status = :status');
    exprNames['#status'] = 'status';
    exprValues[':status'] = options.status;
  }

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :since',
    FilterExpression: filterParts.length ? filterParts.join(' AND ') : undefined,
    ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
    ExpressionAttributeValues: exprValues,
    Limit: limit,
    ScanIndexForward: false,
  }));

  return (result.Items || []) as AvatarEvent[];
}

/**
 * Get event counts for an avatar (for dashboard)
 */
export async function getAvatarEventCounts(avatarId: string): Promise<{
  openIssues: number;
  recentFeedback: { positive: number; negative: number; neutral: number };
}> {
  const since = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
  const events = await listAvatarEvents(avatarId, { since, limit: 500 });

  let openIssues = 0;
  const feedback = { positive: 0, negative: 0, neutral: 0 };

  for (const event of events) {
    if (event.type === 'issue' && event.status === 'open') {
      openIssues++;
    } else if (event.type === 'feedback') {
      feedback[event.sentiment]++;
    }
  }

  return { openIssues, recentFeedback: feedback };
}

// ============================================================================
// Event Update Operations
// ============================================================================

/**
 * Update issue status
 */
export async function updateIssueStatus(
  avatarId: string,
  issueId: string,
  status: IssueStatus,
  resolvedBy?: string
): Promise<void> {
  // Find the issue by ID
  const events = await listAvatarEvents(avatarId, { type: 'issue', limit: 500 });
  const issue = events.find(e => e.id === issueId) as AvatarIssueEvent | undefined;

  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  const updates: Record<string, unknown> = {
    ':status': status,
  };
  const exprParts = ['#status = :status'];
  const exprNames: Record<string, string> = { '#status': 'status' };

  if (status === 'resolved' || status === 'wont_fix') {
    updates[':resolvedAt'] = Date.now();
    exprParts.push('resolvedAt = :resolvedAt');
    if (resolvedBy) {
      updates[':resolvedBy'] = resolvedBy;
      exprParts.push('resolvedBy = :resolvedBy');
    }
  }

  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `EVENT#${issue.timestamp}#issue`,
    },
    UpdateExpression: `SET ${exprParts.join(', ')}`,
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: updates,
  }));
}
