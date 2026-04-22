/**
 * Dream Jobs Service
 *
 * Manages async dream generation jobs with system-wide rate limiting.
 * Dreams are processed by a dedicated worker with concurrency=1 to ensure
 * only one dream generates at a time across the entire system.
 *
 * Key features:
 * - System-wide daily limit (default: 10 dreams/day)
 * - Atomic counter increment to prevent race conditions
 * - Job tracking for observability
 */
import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuid } from 'uuid';
import type { DreamJob, DailyCounter } from '../types.js';
import { getDynamoClient } from './dynamo-client.js';
import { createSystemLogger } from './structured-logger.js';

const log = createSystemLogger('dream-jobs');

const dynamoClient = getDynamoClient();

const sqsClient = new SQSClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const DREAM_QUEUE_URL = process.env.DREAM_QUEUE_URL;

// Configuration
const JOB_TTL_SECONDS = 24 * 60 * 60; // 24 hours for dream job records
const COUNTER_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days for daily counters
const DAILY_DREAM_LIMIT = 10; // System-wide max dreams per day

type ReserveDreamSlotResult =
  | { reserved: true; alreadyReserved: false }
  | { reserved: true; alreadyReserved: true }
  | { reserved: false; reason: 'daily_limit_reached' };

/**
 * Get today's date in YYYY-MM-DD format (UTC)
 */
function getTodayDateKey(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Generate a unique job ID
 */
export function createDreamJobId(): string {
  return uuid();
}

/**
 * Get the current daily dream count
 */
export async function getDailyDreamCount(): Promise<{ count: number; limit: number; remaining: number }> {
  const dateKey = getTodayDateKey();

  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'SYSTEM#dreams',
      sk: `DAILY#${dateKey}`,
    },
  }));

  const counter = result.Item as DailyCounter | undefined;
  const count = counter?.count || 0;
  const limit = DAILY_DREAM_LIMIT;

  return {
    count,
    limit,
    remaining: Math.max(0, limit - count),
  };
}

/**
 * Atomically increment the daily dream counter
 * Returns the new count, or null if limit would be exceeded
 */
async function incrementDailyCounter(): Promise<{ newCount: number } | null> {
  const dateKey = getTodayDateKey();
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + COUNTER_TTL_SECONDS;

  try {
    // Atomic increment with condition to not exceed limit
    const result = await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: 'SYSTEM#dreams',
        sk: `DAILY#${dateKey}`,
      },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, #limit = :limit, #date = :date, updatedAt = :now, #feature = :feature, #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: {
        '#count': 'count',
        '#limit': 'limit',
        '#date': 'date',
        '#feature': 'feature',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':limit': DAILY_DREAM_LIMIT,
        ':date': dateKey,
        ':now': now,
        ':feature': 'dreams',
        ':ttl': ttl,
      },
      ReturnValues: 'ALL_NEW',
    }));

    return { newCount: (result.Attributes as DailyCounter).count };
  } catch (error) {
    // ConditionalCheckFailedException means limit was reached
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return null;
    }
    throw error;
  }
}

/**
 * Reserve a dream slot for a specific job.
 *
 * IMPORTANT:
 * This must be atomic to avoid double-counting if the worker crashes
 * after incrementing the counter but before marking the job.
 */
export async function reserveDreamSlotForJob(jobId: string): Promise<ReserveDreamSlotResult> {
  const job = await getDreamJob(jobId);
  if (!job) {
    throw new Error(`Dream job not found: ${jobId}`);
  }

  if (job.slotReserved) {
    return { reserved: true, alreadyReserved: true };
  }

  const now = Date.now();
  const dateKey = getTodayDateKey();
  const ttl = Math.floor(now / 1000) + COUNTER_TTL_SECONDS;

  try {
    await dynamoClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: ADMIN_TABLE,
            Key: {
              pk: `DREAMJOB#${jobId}`,
              sk: 'STATUS',
            },
            // Only allow this once per job
            ConditionExpression: 'attribute_not_exists(slotReserved)',
            UpdateExpression: 'SET slotReserved = :true, updatedAt = :now',
            ExpressionAttributeValues: {
              ':true': true,
              ':now': now,
            },
          },
        },
        {
          Update: {
            TableName: ADMIN_TABLE,
            Key: {
              pk: 'SYSTEM#dreams',
              sk: `DAILY#${dateKey}`,
            },
            UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, #limit = :limit, #date = :date, updatedAt = :now, #feature = :feature, #ttl = :ttl',
            ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
            ExpressionAttributeNames: {
              '#count': 'count',
              '#limit': 'limit',
              '#date': 'date',
              '#feature': 'feature',
              '#ttl': 'ttl',
            },
            ExpressionAttributeValues: {
              ':zero': 0,
              ':one': 1,
              ':limit': DAILY_DREAM_LIMIT,
              ':date': dateKey,
              ':now': now,
              ':feature': 'dreams',
              ':ttl': ttl,
            },
          },
        },
      ],
    }));

    return { reserved: true, alreadyReserved: false };
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      // Determine whether this was already reserved vs limit reached.
      const refreshed = await getDreamJob(jobId);
      if (refreshed?.slotReserved) {
        return { reserved: true, alreadyReserved: true };
      }
      return { reserved: false, reason: 'daily_limit_reached' };
    }
    throw error;
  }
}

/**
 * Create a new dream job
 */
export async function createDreamJob(
  params: {
    jobId: string;
    avatarId: string;
    persona: string;
    previousDream?: string;
    previousIteration: number;
  }
): Promise<DreamJob> {
  const now = Date.now();
  const dreamJob: DreamJob = {
    pk: `DREAMJOB#${params.jobId}`,
    sk: 'STATUS',
    jobId: params.jobId,
    avatarId: params.avatarId,
    type: 'dream',
    status: 'pending',
    persona: params.persona,
    previousDream: params.previousDream,
    previousIteration: params.previousIteration,
    createdAt: now,
    updatedAt: now,
    ttl: Math.floor(now / 1000) + JOB_TTL_SECONDS,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: dreamJob,
  }));

  return dreamJob;
}

/**
 * Get a dream job by ID
 */
export async function getDreamJob(jobId: string): Promise<DreamJob | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `DREAMJOB#${jobId}`,
      sk: 'STATUS',
    },
  }));

  return (result.Item as DreamJob) || null;
}

/**
 * Update dream job status
 */
export async function updateDreamJobStatus(
  jobId: string,
  status: DreamJob['status'],
  updates?: Partial<Pick<DreamJob, 'error' | 'result' | 'skippedReason'>>
): Promise<DreamJob | null> {
  const now = Date.now();

  const updateExpressions: string[] = ['#status = :status', 'updatedAt = :now'];
  const expressionValues: Record<string, unknown> = {
    ':status': status,
    ':now': now,
  };
  const expressionNames: Record<string, string> = {
    '#status': 'status',
  };

  if (status === 'completed' || status === 'failed' || status === 'skipped') {
    updateExpressions.push('completedAt = :completedAt');
    expressionValues[':completedAt'] = now;
  }

  if (updates?.error) {
    updateExpressions.push('#error = :error');
    expressionValues[':error'] = updates.error;
    expressionNames['#error'] = 'error';
  }

  if (updates?.result) {
    updateExpressions.push('#result = :result');
    expressionValues[':result'] = updates.result;
    expressionNames['#result'] = 'result';
  }

  if (updates?.skippedReason) {
    updateExpressions.push('skippedReason = :skippedReason');
    expressionValues[':skippedReason'] = updates.skippedReason;
  }

  const result = await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `DREAMJOB#${jobId}`,
      sk: 'STATUS',
    },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeValues: expressionValues,
    ExpressionAttributeNames: expressionNames,
    ReturnValues: 'ALL_NEW',
  }));

  return (result.Attributes as DreamJob) || null;
}

/**
 * Enqueue a dream job for processing
 *
 * This is the main entry point for triggering dream generation.
 * It checks the daily limit, creates a job record, and sends to SQS.
 *
 * @returns The job ID if enqueued, or null if daily limit reached
 */
export async function enqueueDreamJob(
  avatarId: string,
  persona: string,
  previousDream?: string,
  previousIteration: number = 0
): Promise<{ jobId: string } | { skipped: true; reason: string }> {
  // Check if queue is configured
  if (!DREAM_QUEUE_URL) {
    log.warn('enqueue', 'dream_queue_url_not_configured');
    return { skipped: true, reason: 'queue_not_configured' };
  }

  // Check daily limit before creating job
  const { remaining } = await getDailyDreamCount();
  if (remaining <= 0) {
    log.info('enqueue', 'daily_limit_reached', { avatarId });
    return { skipped: true, reason: 'daily_limit_reached' };
  }

  // Create job record
  const jobId = createDreamJobId();
  await createDreamJob({
    jobId,
    avatarId,
    persona,
    previousDream,
    previousIteration,
  });

  // Send to SQS FIFO queue
  // MessageGroupId ensures ordering per avatar (though with concurrency=1 it's moot)
  // MessageDeduplicationId prevents duplicate processing if the same job is somehow enqueued twice
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: DREAM_QUEUE_URL,
    MessageBody: JSON.stringify({ jobId, avatarId }),
    MessageGroupId: 'dreams', // Single group = strict FIFO ordering
    MessageDeduplicationId: jobId,
  }));

  log.info('enqueue', 'job_enqueued', { jobId, avatarId });
  return { jobId };
}

/**
 * Reserve a dream slot (atomically increment counter)
 * Called by the worker before actually generating to prevent over-generation
 *
 * @returns true if slot reserved, false if limit reached
 */
export async function reserveDreamSlot(): Promise<boolean> {
  const result = await incrementDailyCounter();
  if (result === null) {
    log.info('slot', 'reserve_failed_daily_limit_reached');
    return false;
  }
  log.info('slot', 'slot_reserved', { dailyCount: result.newCount });
  return true;
}

/**
 * Mark a job's slot as reserved (for idempotency on retries)
 * This prevents the daily counter from being incremented multiple times
 * if the worker retries after a failure.
 */
export async function markSlotReserved(jobId: string): Promise<void> {
  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `DREAMJOB#${jobId}`,
      sk: 'STATUS',
    },
    UpdateExpression: 'SET slotReserved = :true, updatedAt = :now',
    ExpressionAttributeValues: {
      ':true': true,
      ':now': Date.now(),
    },
  }));
}
