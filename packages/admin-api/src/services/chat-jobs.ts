/**
 * Chat Jobs Service
 * Tracks async admin chat jobs so /chat can return immediately and the UI can poll.
 */
import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from '@swarm/core';
import { v4 as uuid } from 'uuid';
import type { ChatJob } from '../types.js';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// TTL: 2 hours for chat job records (enough for long runs + debugging)
const JOB_TTL_SECONDS = 2 * 60 * 60;
const buildAvatarStatusKey = (status: ChatJob['status'], timestamp: number) => `${status}#${timestamp}`;

export function createJobId(): string {
  return uuid();
}

export async function createChatJob(
  job: Omit<ChatJob, 'pk' | 'sk' | 'status' | 'createdAt' | 'updatedAt' | 'ttl'>
): Promise<ChatJob> {
  const now = Date.now();
  const chatJob: ChatJob & { gsi2pk: string; gsi2sk: string } = {
    pk: `CHATJOB#${job.jobId}`,
    sk: 'STATUS',
    ...job,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ttl: Math.floor(now / 1000) + JOB_TTL_SECONDS,
    gsi2pk: `AVATAR#${job.avatarId}`,
    gsi2sk: buildAvatarStatusKey('pending', now),
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: chatJob,
  }));

  return chatJob;
}

export async function getChatJob(jobId: string): Promise<ChatJob | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `CHATJOB#${jobId}`,
      sk: 'STATUS',
    },
  }));

  return (result.Item as ChatJob) || null;
}

export async function updateChatJobStatus(
  jobId: string,
  status: ChatJob['status'],
  updates?: Partial<Pick<ChatJob, 'error' | 'result'>>
): Promise<ChatJob | null> {
  const now = Date.now();

  const updateExpressions: string[] = ['#status = :status', 'updatedAt = :now', 'gsi2sk = :gsi2sk'];
  const expressionValues: Record<string, unknown> = {
    ':status': status,
    ':now': now,
    ':gsi2sk': buildAvatarStatusKey(status, now),
  };
  const expressionNames: Record<string, string> = {
    '#status': 'status',
  };

  if (status === 'completed' || status === 'failed') {
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

  const result = await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `CHATJOB#${jobId}`,
      sk: 'STATUS',
    },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeValues: expressionValues,
    ExpressionAttributeNames: expressionNames,
    ReturnValues: 'ALL_NEW',
  }));

  return (result.Attributes as ChatJob) || null;
}

/**
 * Get pending chat jobs for an avatar.
 * Uses GSI2 if present; falls back to a bounded scan.
 */
export async function getPendingChatJobs(avatarId: string): Promise<ChatJob[]> {
  const scanPendingJobs = async (): Promise<ChatJob[]> => {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'begins_with(pk, :jobPrefix) AND avatarId = :avatarId AND (#status = :pending OR #status = :processing)',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':jobPrefix': 'CHATJOB#',
        ':avatarId': avatarId,
        ':pending': 'pending',
        ':processing': 'processing',
      },
    }));

    return (result.Items || []) as ChatJob[];
  };

  try {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :avatarKey',
      FilterExpression: 'begins_with(gsi2sk, :pendingPrefix) OR begins_with(gsi2sk, :processingPrefix)',
      ExpressionAttributeValues: {
        ':avatarKey': `AVATAR#${avatarId}`,
        ':pendingPrefix': 'pending#',
        ':processingPrefix': 'processing#',
      },
    }));

    return (result.Items || []) as ChatJob[];
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('specified index: GSI2')) {
      throw error;
    }
  }

  return scanPendingJobs();
}
