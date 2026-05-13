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
import type { MediaJob } from '../../types.js';
import * as gallery from './gallery.js';
import { getDynamoClient } from '../dynamo-client.js';
import { createSystemLogger } from '../structured-logger.js';
import { buildMediaUrl } from '../../utils/media-url.js';

const log = createSystemLogger('media-jobs');

const dynamoClient = getDynamoClient();
const s3Client = new S3Client({});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';
const OPENROUTER_VIDEOS_ENDPOINT = 'https://openrouter.ai/api/v1/videos';

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

function getContentTypeExtension(contentType: string | null | undefined, fallback: string): string {
  const normalized = (contentType || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('png')) return 'png';
  return fallback;
}

async function downloadMediaOutput(
  outputUrl: string,
  apiKey?: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const fetchOutput = (withAuth: boolean) => fetch(outputUrl, {
    headers: withAuth && apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });

  let mediaResponse = await fetchOutput(false);
  if (!mediaResponse.ok && apiKey) {
    mediaResponse = await fetchOutput(true);
  }
  if (!mediaResponse.ok) {
    throw new Error(`Download failed: ${mediaResponse.statusText}`);
  }

  return {
    buffer: Buffer.from(await mediaResponse.arrayBuffer()),
    contentType: mediaResponse.headers.get('content-type') || 'application/octet-stream',
  };
}

function extractOpenRouterVideoStatus(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const response = payload as {
    status?: string;
    data?: { status?: string };
  };
  return response.status || response.data?.status;
}

function extractOpenRouterVideoError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const response = payload as {
    error?: string | { message?: string };
    data?: { error?: string | { message?: string } };
  };
  const error = response.error || response.data?.error;
  if (typeof error === 'string') return error;
  return error?.message;
}

function extractOpenRouterVideoUrl(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  const response = payload as {
    url?: string;
    video_url?: string;
    video?: { url?: string };
    output?: unknown;
    outputs?: unknown;
    data?: {
      url?: string;
      video_url?: string;
      video?: { url?: string };
      output?: unknown;
      outputs?: unknown;
    };
  };

  const candidates: unknown[] = [
    response.url,
    response.video_url,
    response.video?.url,
    response.output,
    response.outputs,
    response.data?.url,
    response.data?.video_url,
    response.data?.video?.url,
    response.data?.output,
    response.data?.outputs,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const url = (entry as { url?: string; uri?: string }).url || (entry as { url?: string; uri?: string }).uri;
          if (url) return url;
        }
      }
    }
    if (candidate && typeof candidate === 'object') {
      const url = (candidate as { url?: string; uri?: string }).url || (candidate as { url?: string; uri?: string }).uri;
      if (url) return url;
    }
  }

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
    log.warn('poll', 'no_external_id', { jobId });
    return job;
  }

  log.info('poll', 'polling_started', {
    jobId,
    predictionId: job.externalId,
  });

  try {
    const response = await fetch(`${REPLICATE_ENDPOINT}/${job.externalId}`, {
      headers: {
        'Authorization': `Token ${replicateApiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      log.error('poll', 'poll_request_failed', { jobId, status: response.status });
      return job;
    }

    const prediction = await response.json() as ReplicatePrediction;
    log.info('poll', 'poll_status', { jobId, status: prediction.status });

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
      const mediaId = gallery.generateGalleryId();
      const s3Key = `avatars/${job.avatarId}/${folder}/${mediaId}.${extension}`;

      log.info('upload', 's3_upload_started', {
        jobId,
        s3Key,
        bytes: mediaBuffer.length,
      });

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

      log.info('poll', 'job_completed_via_poll', { jobId, publicUrl });
      return await getJob(jobId);
    }

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      await updateJobStatus(jobId, 'failed', { error: prediction.error || `Prediction ${prediction.status}` });
      return await getJob(jobId);
    }

    return job;
  } catch (error) {
    log.error('poll', 'poll_error', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return job;
  }
}

/**
 * Poll OpenRouter for async video job status and complete if done.
 */
export async function pollAndCompleteOpenRouterJob(
  jobId: string,
  openRouterApiKey: string
): Promise<MediaJob | null> {
  const job = await getJob(jobId);
  if (!job) return null;

  if (job.status !== 'processing' && job.status !== 'pending') {
    return job;
  }

  if (!job.externalId) {
    log.warn('poll', 'no_external_id', { jobId, provider: 'openrouter' });
    return job;
  }

  try {
    const response = await fetch(`${OPENROUTER_VIDEOS_ENDPOINT}/${job.externalId}`, {
      headers: {
        'Authorization': `Bearer ${openRouterApiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      log.error('poll', 'openrouter_poll_request_failed', { jobId, status: response.status });
      return job;
    }

    const payload = await response.json() as unknown;
    const status = extractOpenRouterVideoStatus(payload);
    log.info('poll', 'openrouter_poll_status', { jobId, status });

    if (status === 'completed' || status === 'succeeded' || (!status && extractOpenRouterVideoUrl(payload))) {
      const outputUrl = extractOpenRouterVideoUrl(payload);
      if (!outputUrl) {
        await updateJobStatus(jobId, 'failed', { error: 'No output URL' });
        return await getJob(jobId);
      }

      const { extension: fallbackExtension, folder } = getMediaTypeInfo(job.type);
      const { buffer, contentType } = await downloadMediaOutput(outputUrl, openRouterApiKey);
      const extension = getContentTypeExtension(contentType, fallbackExtension);
      const mediaId = gallery.generateGalleryId();
      const s3Key = `avatars/${job.avatarId}/${folder}/${mediaId}.${extension}`;

      await s3Client.send(new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: s3Key,
        Body: buffer,
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
        model: `openrouter-${job.type}`,
        platform: job.platform,
        metadata: { jobId, externalId: job.externalId, provider: 'openrouter', polled: true },
      });

      log.info('poll', 'openrouter_job_completed_via_poll', { jobId, publicUrl });
      return await getJob(jobId);
    }

    if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
      await updateJobStatus(jobId, 'failed', {
        error: extractOpenRouterVideoError(payload) || `OpenRouter video job ${status}`,
      });
      return await getJob(jobId);
    }

    return job;
  } catch (error) {
    log.error('poll', 'openrouter_poll_error', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return job;
  }
}
