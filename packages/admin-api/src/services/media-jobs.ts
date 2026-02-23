/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Media Jobs Service
 * Tracks async media generation jobs (video, long-running operations)
 */
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import type { MediaJob } from '../types.js';
import * as gallery from './gallery.js';
import { getDynamoClient } from './dynamo-client.js';
import { buildMediaUrl } from '../utils/media-url.js';

const dynamoClient = getDynamoClient();
const s3Client = new S3Client({});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';

// TTL: 24 hours for job records
const JOB_TTL_SECONDS = 24 * 60 * 60;
const buildAvatarStatusKey = (status: MediaJob['status'], timestamp: number) => `${status}#${timestamp}`;

/**
 * Create a new media job
 */
export async function createJob(
  job: Omit<MediaJob, 'pk' | 'sk' | 'status' | 'createdAt' | 'updatedAt' | 'ttl'>
): Promise<MediaJob> {
  const now = Date.now();
  const mediaJob: MediaJob & {
    gsi2pk: string;
    gsi2sk: string;
  } = {
    pk: `MEDIAJOB#${job.jobId}`,
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
    Item: mediaJob,
  }));

  return mediaJob;
}

/**
 * Get a job by ID
 */
export async function getJob(jobId: string): Promise<MediaJob | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `MEDIAJOB#${jobId}`,
      sk: 'STATUS',
    },
  }));

  return (result.Item as MediaJob) || null;
}

/**
 * Update job status
 */
export async function updateJobStatus(
  jobId: string,
  status: MediaJob['status'],
  updates?: Partial<Pick<MediaJob, 'resultUrl' | 'resultS3Key' | 'error' | 'externalId'>>
): Promise<MediaJob | null> {
  const now = Date.now();

  const updateExpressions = ['#status = :status', 'updatedAt = :now', 'gsi2sk = :gsi2sk'];
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

  if (updates?.resultUrl) {
    updateExpressions.push('resultUrl = :resultUrl');
    expressionValues[':resultUrl'] = updates.resultUrl;
  }

  if (updates?.resultS3Key) {
    updateExpressions.push('resultS3Key = :resultS3Key');
    expressionValues[':resultS3Key'] = updates.resultS3Key;
  }

  if (updates?.error) {
    updateExpressions.push('#error = :error');
    expressionValues[':error'] = updates.error;
    expressionNames['#error'] = 'error';
  }

  if (updates?.externalId) {
    updateExpressions.push('externalId = :externalId');
    expressionValues[':externalId'] = updates.externalId;
  }

  if (updates?.externalId) {
    const ttl = Math.floor(now / 1000) + JOB_TTL_SECONDS;
    await dynamoClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: ADMIN_TABLE,
            Key: {
              pk: `MEDIAJOB#${jobId}`,
              sk: 'STATUS',
            },
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeValues: expressionValues,
            ExpressionAttributeNames: expressionNames,
          },
        },
        {
          Put: {
            TableName: ADMIN_TABLE,
            Item: {
              pk: `MEDIAJOB_EXTERNAL#${updates.externalId}`,
              sk: 'JOB',
              jobId,
              ttl,
            },
          },
        },
      ],
    }));
    return await getJob(jobId);
  }

  const result = await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `MEDIAJOB#${jobId}`,
      sk: 'STATUS',
    },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeValues: expressionValues,
    ExpressionAttributeNames: expressionNames,
    ReturnValues: 'ALL_NEW',
  }));

  return (result.Attributes as MediaJob) || null;
}

/**
 * Get pending jobs for an avatar (for status checking)
 * Uses Scan with filter since jobs have 24h TTL (bounded scan)
 */
export async function getPendingJobs(avatarId: string): Promise<MediaJob[]> {
  const scanPendingJobs = async (): Promise<MediaJob[]> => {
    // Scan for jobs belonging to this avatar that are pending or processing
    // This is efficient because jobs have TTL (24h) so the table stays small
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'begins_with(pk, :jobPrefix) AND avatarId = :avatarId AND (#status = :pending OR #status = :processing)',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':jobPrefix': 'MEDIAJOB#',
        ':avatarId': avatarId,
        ':pending': 'pending',
        ':processing': 'processing',
      },
    }));

    return (result.Items || []) as MediaJob[];
  };

  try {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :avatarey',
      FilterExpression: 'begins_with(gsi2sk, :pendingPrefix) OR begins_with(gsi2sk, :processingPrefix)',
      ExpressionAttributeValues: {
        ':avatarey': `AVATAR#${avatarId}`,
        ':pendingPrefix': 'pending#',
        ':processingPrefix': 'processing#',
      },
    }));

    return (result.Items || []) as MediaJob[];
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('specified index: GSI2')) {
      throw error;
    }
  }

  return scanPendingJobs();
}

/**
 * Find job by external ID (e.g., Replicate prediction ID)
 */
export async function findByExternalId(externalId: string): Promise<MediaJob | null> {
  const mapping = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `MEDIAJOB_EXTERNAL#${externalId}`,
      sk: 'JOB',
    },
  }));

  const jobId = (mapping.Item as { jobId?: string })?.jobId;
  if (!jobId) {
    return null;
  }

  return getJob(jobId);
}

// === REPLICATE POLLING FALLBACK ===
// Used when webhooks don't work or aren't configured

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | { uri?: string };
  error?: string;
  metrics?: { predict_time?: number };
}

function extractOutputUrl(output: ReplicatePrediction['output']): string | undefined {
  if (Array.isArray(output)) return output[0];
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'uri' in output) return output.uri;
  return undefined;
}

function getMediaTypeInfo(jobType: MediaJob['type']): { extension: string; contentType: string; folder: string } {
  switch (jobType) {
    case 'image': return { extension: 'png', contentType: 'image/png', folder: 'images' };
    case 'video': return { extension: 'mp4', contentType: 'video/mp4', folder: 'videos' };
    case 'sticker': return { extension: 'webp', contentType: 'image/webp', folder: 'stickers' };
    default: return { extension: 'bin', contentType: 'application/octet-stream', folder: 'media' };
  }
}

/**
 * Poll Replicate for job status and complete if done
 * Fallback for when webhooks don't work
 */
export async function pollAndCompleteJob(
  jobId: string,
  replicateApiKey: string
): Promise<MediaJob | null> {
  const job = await getJob(jobId);
  if (!job) return null;

  // Only poll jobs still processing
  if (job.status !== 'processing' && job.status !== 'pending') {
    return job;
  }

  if (!job.externalId) {
    console.warn(`[MediaJobs] No external ID for job ${jobId}`);
    return job;
  }

  console.log(`[MediaJobs] Polling Replicate for job ${jobId} (prediction ${job.externalId})`);

  try {
    const response = await fetch(`${REPLICATE_ENDPOINT}/${job.externalId}`, {
      headers: {
        'Authorization': `Token ${replicateApiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[MediaJobs] Replicate poll failed: ${response.status}`);
      return job;
    }

    const prediction = await response.json() as ReplicatePrediction;
    console.log(`[MediaJobs] Replicate status for ${jobId}: ${prediction.status}`);

    if (prediction.status === 'succeeded' && prediction.output) {
      const outputUrl = extractOutputUrl(prediction.output);
      if (!outputUrl) {
        await updateJobStatus(jobId, 'failed', { error: 'No output URL' });
        return await getJob(jobId);
      }

      const { extension, contentType, folder } = getMediaTypeInfo(job.type);

      // Download and store in S3
      const mediaResponse = await fetch(outputUrl);
      if (!mediaResponse.ok) {
        await updateJobStatus(jobId, 'failed', { error: `Download failed: ${mediaResponse.statusText}` });
        return await getJob(jobId);
      }

      const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());
      const mediaId = uuid();
      const s3Key = `avatars/${job.avatarId}/${folder}/${mediaId}.${extension}`;

      console.log(`[MediaJobs] Uploading to S3: ${s3Key} (${mediaBuffer.length} bytes)`);

      await s3Client.send(new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: s3Key,
        Body: mediaBuffer,
        ContentType: contentType,
      }));

      const publicUrl = buildMediaUrl(s3Key, MEDIA_BUCKET, CDN_URL);

      await updateJobStatus(jobId, 'completed', { resultUrl: publicUrl, resultS3Key: s3Key });

      await gallery.addToGallery(job.avatarId, {
        id: mediaId,
        type: job.type,
        url: publicUrl,
        s3Key,
        prompt: job.prompt,
        model: `replicate-${job.type}`,
        platform: job.platform,
        metadata: { jobId, predictionId: prediction.id, polled: true },
      });

      console.log(`[MediaJobs] Job ${jobId} completed via polling: ${publicUrl}`);
      return await getJob(jobId);
    }

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      await updateJobStatus(jobId, 'failed', { error: prediction.error || `Prediction ${prediction.status}` });
      return await getJob(jobId);
    }

    return job;
  } catch (error) {
    console.error(`[MediaJobs] Poll error for ${jobId}:`, error instanceof Error ? error.message : String(error));
    return job;
  }
}
