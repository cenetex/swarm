import {
  SendMessageCommand,
  type ContinuationMessageBase,
  type MediaFailedContinuation,
  type MediaGeneratedContinuation,
} from '@swarm/core';
import type { MediaJob } from '../../types.js';
import { getSQSClient } from '../aws-clients.js';
import { resolveJobDeliveryIntent } from './delivery-intent.js';

type ContinuationPlatform = ContinuationMessageBase['platform'];

function getContinuationPlatform(job: MediaJob): ContinuationPlatform {
  switch (job.platform) {
    case 'telegram':
    case 'discord':
    case 'twitter':
    case 'admin-ui':
    case 'api':
      return job.platform;
    default:
      return resolveJobDeliveryIntent(job)?.platform ?? 'api';
  }
}

export function buildMediaGeneratedContinuation(
  job: MediaJob,
  mediaUrl: string,
  timestamp = Date.now(),
): MediaGeneratedContinuation | undefined {
  const deliveryIntent = resolveJobDeliveryIntent(job);
  if (!deliveryIntent) return undefined;

  return {
    type: 'media_generated',
    avatarId: job.avatarId,
    platform: getContinuationPlatform(job),
    conversationId: job.conversationId,
    replyToMessageId: job.replyToMessageId,
    jobId: job.jobId,
    timestamp,
    data: {
      mediaType: job.type,
      mediaUrl,
      prompt: job.prompt,
      purpose: job.purpose,
      deliveryIntent,
    },
  };
}

export function buildMediaFailedContinuation(
  job: MediaJob,
  error: string,
  timestamp = Date.now(),
): MediaFailedContinuation | undefined {
  const deliveryIntent = resolveJobDeliveryIntent(job);
  if (!deliveryIntent) return undefined;

  return {
    type: 'media_failed',
    avatarId: job.avatarId,
    platform: getContinuationPlatform(job),
    conversationId: job.conversationId,
    replyToMessageId: job.replyToMessageId,
    jobId: job.jobId,
    timestamp,
    data: {
      mediaType: job.type,
      error,
      prompt: job.prompt,
      deliveryIntent,
    },
  };
}

async function publishMediaContinuation(
  continuation: MediaGeneratedContinuation | MediaFailedContinuation | undefined,
): Promise<boolean> {
  const queueUrl = process.env.RESPONSE_QUEUE_URL;
  if (!queueUrl || !continuation) return false;

  await getSQSClient().send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(continuation),
  }));
  return true;
}

export function publishMediaGeneratedContinuation(
  job: MediaJob,
  mediaUrl: string,
): Promise<boolean> {
  return publishMediaContinuation(buildMediaGeneratedContinuation(job, mediaUrl));
}

export function publishMediaFailedContinuation(
  job: MediaJob,
  error: string,
): Promise<boolean> {
  return publishMediaContinuation(buildMediaFailedContinuation(job, error));
}
