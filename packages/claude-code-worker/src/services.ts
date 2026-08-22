import { SendMessageCommand, SQSClient } from '@swarm/core';
/**
 * Claude Code Services
 *
 * Service implementation for Claude Code tools.
 * Used by message handlers to enqueue tasks and check job status.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@swarm/core';
import type {
  ClaudeCodeQueueMessage,
  ClaudeCodeJobRecord,
  ClaudeCodeResponseRecord,
  ClaudeCodeJobStatus,
} from './types.js';

const JOB_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Claude Code job info (returned by service methods)
 */
export interface ClaudeCodeJob {
  jobId: string;
  avatarId: string;
  conversationId?: string;
  status: ClaudeCodeJobStatus;
  task: string;
  workingDir: string;
  sessionId?: string;
  result?: string;
  error?: string;
  pendingQuestion?: {
    text: string;
    options: Array<{ label: string; description: string }>;
  };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/**
 * Claude Code services interface
 */
export interface ClaudeCodeServices {
  enqueueTask: (params: {
    avatarId: string;
    conversationId?: string;
    replyToMessageId?: string;
    task: string;
    workingDir?: string;
    maxTurns?: number;
    sessionId?: string;
    allowedTools?: string[];
  }) => Promise<{ jobId: string }>;

  respondToQuestion: (params: {
    avatarId: string;
    jobId: string;
    sessionId: string;
    response: string;
  }) => Promise<void>;

  getJob: (avatarId: string, jobId: string) => Promise<ClaudeCodeJob | null>;

  getActiveJobs: (avatarId: string) => Promise<ClaudeCodeJob[]>;

  cancelJob?: (avatarId: string, jobId: string) => Promise<boolean>;
}

/**
 * Create Claude Code services for Lambda handlers
 */
export function createClaudeCodeServices(config: {
  stateTable: string;
  queueUrl: string;
  responseQueueUrl: string;
}): ClaudeCodeServices {
  const sqs = new SQSClient({});
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    async enqueueTask(params) {
      const jobId = `cc-${params.avatarId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Create job record in DynamoDB
      const jobRecord: ClaudeCodeJobRecord = {
        pk: `AVATAR#${params.avatarId}`,
        sk: `CLAUDE_CODE#${jobId}`,
        jobId,
        avatarId: params.avatarId,
        conversationId: params.conversationId,
        replyToMessageId: params.replyToMessageId,
        status: 'pending',
        task: params.task,
        workingDir: params.workingDir || '/workspace',
        sessionId: params.sessionId,
        maxTurns: params.maxTurns || 30,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS,
      };

      await ddb.send(
        new PutCommand({
          TableName: config.stateTable,
          Item: jobRecord,
        })
      );

      // Send to SQS queue
      const queueMessage: ClaudeCodeQueueMessage = {
        type: 'task',
        jobId,
        avatarId: params.avatarId,
        conversationId: params.conversationId,
        replyToMessageId: params.replyToMessageId,
        task: params.task,
        workingDir: params.workingDir,
        maxTurns: params.maxTurns,
        sessionId: params.sessionId,
        allowedTools: params.allowedTools,
        callbackQueueUrl: config.responseQueueUrl,
      };

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: JSON.stringify(queueMessage),
          MessageGroupId: params.avatarId, // FIFO ordering per avatar
          MessageDeduplicationId: jobId,
        })
      );

      return { jobId };
    },

    async respondToQuestion(params) {
      // Send response to queue for worker to pick up
      const queueMessage: ClaudeCodeQueueMessage = {
        type: 'response',
        jobId: params.jobId,
        avatarId: params.avatarId,
        sessionId: params.sessionId,
        response: params.response,
        callbackQueueUrl: config.responseQueueUrl,
      };

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: JSON.stringify(queueMessage),
          MessageGroupId: params.avatarId,
          MessageDeduplicationId: `${params.jobId}-resp-${Date.now()}`,
        })
      );

      // Also store directly in DynamoDB for faster pickup
      const responseRecord: ClaudeCodeResponseRecord = {
        pk: `AVATAR#${params.avatarId}`,
        sk: `CLAUDE_CODE_RESPONSE#${params.jobId}`,
        response: params.response,
        timestamp: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 300, // 5 min TTL
      };

      await ddb.send(
        new PutCommand({
          TableName: config.stateTable,
          Item: responseRecord,
        })
      );
    },

    async getJob(avatarId, jobId): Promise<ClaudeCodeJob | null> {
      const result = await ddb.send(
        new GetCommand({
          TableName: config.stateTable,
          Key: {
            pk: `AVATAR#${avatarId}`,
            sk: `CLAUDE_CODE#${jobId}`,
          },
        })
      );

      if (!result.Item) return null;

      const record = result.Item as ClaudeCodeJobRecord;
      return {
        jobId: record.jobId,
        avatarId: record.avatarId,
        conversationId: record.conversationId,
        status: record.status,
        task: record.task,
        workingDir: record.workingDir,
        sessionId: record.sessionId,
        result: record.result,
        error: record.error,
        pendingQuestion: record.pendingQuestion,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        completedAt: record.completedAt,
      };
    },

    async getActiveJobs(avatarId): Promise<ClaudeCodeJob[]> {
      const result = await ddb.send(
        new QueryCommand({
          TableName: config.stateTable,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          FilterExpression: '#status IN (:pending, :processing, :waiting)',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':pk': `AVATAR#${avatarId}`,
            ':prefix': 'CLAUDE_CODE#',
            ':pending': 'pending',
            ':processing': 'processing',
            ':waiting': 'waiting_input',
          },
        })
      );

      return (result.Items || []).map((item) => {
        const record = item as ClaudeCodeJobRecord;
        return {
          jobId: record.jobId,
          avatarId: record.avatarId,
          conversationId: record.conversationId,
          status: record.status,
          task: record.task,
          workingDir: record.workingDir,
          sessionId: record.sessionId,
          result: record.result,
          error: record.error,
          pendingQuestion: record.pendingQuestion,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          completedAt: record.completedAt,
        };
      });
    },

    async cancelJob(avatarId, jobId): Promise<boolean> {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: config.stateTable,
            Key: {
              pk: `AVATAR#${avatarId}`,
              sk: `CLAUDE_CODE#${jobId}`,
            },
            UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
            ConditionExpression: '#status IN (:pending, :processing, :waiting)',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':status': 'failed',
              ':updatedAt': Date.now(),
              ':pending': 'pending',
              ':processing': 'processing',
              ':waiting': 'waiting_input',
            },
          })
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

export default createClaudeCodeServices;
