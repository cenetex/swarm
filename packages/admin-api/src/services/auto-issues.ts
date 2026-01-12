/**
 * Auto-Issue Tracking Service
 * 
 * Automatically creates and updates issues based on errors encountered.
 * Groups similar errors together to avoid flooding with duplicates.
 * 
 * Schema:
 * - pk: ISSUE#{issueId}
 * - sk: META
 * - Additional records: ISSUE#{issueId} / OCCURRENCE#{timestamp}
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Issue TTL: 30 days
const ISSUE_TTL_SECONDS = 30 * 24 * 60 * 60;
// Occurrence TTL: 7 days
const OCCURRENCE_TTL_SECONDS = 7 * 24 * 60 * 60;

export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'wontfix';

export interface AutoIssue {
  issueId: string;
  fingerprint: string;
  title: string;
  description: string;
  severity: IssueSeverity;
  status: IssueStatus;
  category: string;
  subsystem: string;
  agentId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  sampleError?: string;
  sampleStack?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorOccurrence {
  issueId: string;
  timestamp: number;
  agentId?: string;
  requestId?: string;
  error: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/**
 * Generate a fingerprint for an error to group similar errors together.
 * Uses error message pattern + stack trace location.
 */
function generateFingerprint(
  error: string,
  stack?: string,
  subsystem?: string
): string {
  // Normalize the error message by removing variable parts
  const normalized = error
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // Remove numbers that look like IDs
    .replace(/\b\d{10,}\b/g, '<ID>')
    // Remove timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '<TIMESTAMP>')
    // Remove specific file paths
    .replace(/\/var\/task\/[^\s]+/g, '<PATH>')
    // Remove agent IDs
    .replace(/agent-[\w-]+/g, '<AGENT>');

  // Extract first meaningful stack frame if available
  let stackLocation = '';
  if (stack) {
    const lines = stack.split('\n');
    for (const line of lines) {
      if (line.includes('at ') && !line.includes('node_modules') && !line.includes('node:')) {
        // Extract function/file location
        const match = line.match(/at (\S+)/);
        if (match) {
          stackLocation = match[1];
          break;
        }
      }
    }
  }

  const fingerprint = `${subsystem || 'unknown'}:${normalized}:${stackLocation}`;
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}

/**
 * Generate a human-readable title from an error message
 */
function generateTitle(error: string, subsystem: string): string {
  // Truncate and clean up
  let title = error.slice(0, 100);
  
  // Remove common prefixes
  title = title
    .replace(/^Error:\s*/i, '')
    .replace(/^TypeError:\s*/i, '')
    .replace(/^ReferenceError:\s*/i, '');
  
  // Add subsystem prefix
  return `[${subsystem}] ${title}${error.length > 100 ? '...' : ''}`;
}

/**
 * Determine severity based on error characteristics
 */
function determineSeverity(error: string, category: string): IssueSeverity {
  const lowerError = error.toLowerCase();
  
  // Critical: auth failures, data corruption, complete service failures
  if (
    lowerError.includes('authentication') ||
    lowerError.includes('authorization') ||
    lowerError.includes('permission denied') ||
    lowerError.includes('data corruption') ||
    lowerError.includes('database connection')
  ) {
    return 'critical';
  }
  
  // High: API errors, timeout, rate limits
  if (
    lowerError.includes('timeout') ||
    lowerError.includes('rate limit') ||
    lowerError.includes('api error') ||
    lowerError.includes('500') ||
    category === 'webhook_error'
  ) {
    return 'high';
  }
  
  // Medium: validation errors, not found
  if (
    lowerError.includes('validation') ||
    lowerError.includes('not found') ||
    lowerError.includes('invalid')
  ) {
    return 'medium';
  }
  
  return 'low';
}

/**
 * Record an error and create/update an issue
 */
export async function recordError(params: {
  error: string;
  stack?: string;
  subsystem: string;
  category?: string;
  agentId?: string;
  requestId?: string;
  context?: Record<string, unknown>;
}): Promise<{ issueId: string; isNew: boolean; occurrenceCount: number }> {
  const {
    error,
    stack,
    subsystem,
    category = 'error',
    agentId,
    requestId,
    context,
  } = params;

  const now = Date.now();
  const fingerprint = generateFingerprint(error, stack, subsystem);
  const issueId = `issue-${fingerprint}`;

  // Check if issue exists
  const existingResult = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `ISSUE#${issueId}`,
      sk: 'META',
    },
  }));

  const existing = existingResult.Item as AutoIssue | undefined;
  const isNew = !existing;

  if (isNew) {
    // Create new issue
    const issue: AutoIssue & { pk: string; sk: string; ttl: number } = {
      pk: `ISSUE#${issueId}`,
      sk: 'META',
      issueId,
      fingerprint,
      title: generateTitle(error, subsystem),
      description: error,
      severity: determineSeverity(error, category),
      status: 'open',
      category,
      subsystem,
      agentId,
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
      sampleError: error,
      sampleStack: stack?.slice(0, 2000),
      metadata: context,
      ttl: Math.floor(now / 1000) + ISSUE_TTL_SECONDS,
    };

    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: issue,
    }));

    console.log(JSON.stringify({
      level: 'INFO',
      subsystem: 'auto-issues',
      event: 'issue_created',
      issueId,
      title: issue.title,
      severity: issue.severity,
      fingerprint,
    }));
  } else {
    // Update existing issue
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `ISSUE#${issueId}`,
        sk: 'META',
      },
      UpdateExpression: 'SET lastSeenAt = :now, occurrenceCount = occurrenceCount + :one, #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':now': now,
        ':one': 1,
        ':ttl': Math.floor(now / 1000) + ISSUE_TTL_SECONDS,
      },
    }));
  }

  // Record occurrence (for detailed history)
  const occurrence: ErrorOccurrence & { pk: string; sk: string; ttl: number } = {
    pk: `ISSUE#${issueId}`,
    sk: `OCCURRENCE#${now}`,
    issueId,
    timestamp: now,
    agentId,
    requestId,
    error: error.slice(0, 1000),
    stack: stack?.slice(0, 2000),
    context,
    ttl: Math.floor(now / 1000) + OCCURRENCE_TTL_SECONDS,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: occurrence,
  }));

  return {
    issueId,
    isNew,
    occurrenceCount: isNew ? 1 : (existing?.occurrenceCount || 0) + 1,
  };
}

/**
 * List all open issues
 */
export async function listIssues(options: {
  status?: IssueStatus;
  severity?: IssueSeverity;
  subsystem?: string;
  limit?: number;
} = {}): Promise<AutoIssue[]> {
  // For simplicity, scan with filters. In production, use GSI.
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :pk',
    FilterExpression: options.status ? '#status = :status' : undefined,
    ExpressionAttributeNames: options.status ? { '#status': 'status' } : undefined,
    ExpressionAttributeValues: {
      ':pk': 'ISSUES',
      ...(options.status && { ':status': options.status }),
    },
    Limit: options.limit || 100,
    ScanIndexForward: false,
  }));

  // Return results from GSI query
  // Note: If no GSI exists yet, this will return empty.
  // A future enhancement could use Scan with begins_with filter on pk.

  return (result.Items || []) as AutoIssue[];
}

/**
 * Get issue details with recent occurrences
 */
export async function getIssue(issueId: string): Promise<{
  issue: AutoIssue | null;
  occurrences: ErrorOccurrence[];
}> {
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': `ISSUE#${issueId}`,
    },
    Limit: 51, // 1 META + up to 50 occurrences
    ScanIndexForward: false,
  }));

  const items = result.Items || [];
  const meta = items.find(i => i.sk === 'META') as AutoIssue | undefined;
  const occurrences = items
    .filter(i => i.sk?.startsWith('OCCURRENCE#'))
    .slice(0, 50) as ErrorOccurrence[];

  return {
    issue: meta || null,
    occurrences,
  };
}

/**
 * Update issue status
 */
export async function updateIssueStatus(
  issueId: string,
  status: IssueStatus
): Promise<void> {
  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `ISSUE#${issueId}`,
      sk: 'META',
    },
    UpdateExpression: 'SET #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': status },
  }));
}

/**
 * Helper to wrap error logging with auto-issue creation
 */
export function createErrorRecorder(defaultContext: {
  subsystem: string;
  agentId?: string;
}) {
  return async function recordErrorWithContext(
    error: Error | string,
    category?: string,
    extraContext?: Record<string, unknown>
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : error;
    const stack = error instanceof Error ? error.stack : undefined;

    try {
      await recordError({
        error: errorMessage,
        stack,
        subsystem: defaultContext.subsystem,
        category,
        agentId: defaultContext.agentId,
        context: extraContext,
      });
    } catch (recordingError) {
      // Don't fail the main flow if issue recording fails
      console.error('Failed to record error to auto-issues:', recordingError);
    }
  };
}
