/**
 * Replicate Webhook Handler
 * Handles async media generation (image/video) completion callbacks from Replicate
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuid } from 'uuid';
import * as mediaJobs from '../services/media-jobs.js';
import * as gallery from '../services/gallery.js';
import { recordError } from '../services/auto-issues.js';
import { logger } from '@swarm/core';
import type { MediaJob } from '../types.js';

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const RESPONSE_QUEUE_URL = process.env.RESPONSE_QUEUE_URL;

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | { uri?: string };
  error?: string;
  metrics?: {
    predict_time?: number;
  };
}

/**
 * Get the output URL from different Replicate output formats
 */
function extractOutputUrl(output: ReplicatePrediction['output']): string | undefined {
  if (Array.isArray(output)) {
    return output[0];
  } else if (typeof output === 'string') {
    return output;
  } else if (output && typeof output === 'object' && 'uri' in output) {
    return output.uri;
  }
  return undefined;
}

/**
 * Get file extension and content type based on job type
 */
function getMediaTypeInfo(jobType: MediaJob['type']): { extension: string; contentType: string; folder: string } {
  switch (jobType) {
    case 'image':
      return { extension: 'png', contentType: 'image/png', folder: 'images' };
    case 'video':
      return { extension: 'mp4', contentType: 'video/mp4', folder: 'videos' };
    case 'sticker':
      return { extension: 'webp', contentType: 'image/webp', folder: 'stickers' };
    default:
      return { extension: 'bin', contentType: 'application/octet-stream', folder: 'media' };
  }
}

/**
 * Lambda handler for Replicate webhook callbacks
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  logger.setContext({ subsystem: 'replicate' });
  logger.info('Replicate webhook received', { body: event.body });

  try {
    // Get job ID from query string
    const jobId = event.queryStringParameters?.jobId;
    if (!jobId) {
      logger.error('No jobId in query string');
      return { statusCode: 400, body: 'Missing jobId' };
    }

    // Parse webhook payload
    const prediction: ReplicatePrediction = JSON.parse(event.body || '{}');
    logger.info('Processing webhook', { jobId, predictionId: prediction.id, status: prediction.status });

    // Get the job record
    const job = await mediaJobs.getJob(jobId);
    if (!job) {
      logger.error('Job not found', undefined, { jobId });
      return { statusCode: 404, body: 'Job not found' };
    }

    // Handle completion
    if (prediction.status === 'succeeded' && prediction.output) {
      // Get the output URL (handle different Replicate output formats)
      const outputUrl = extractOutputUrl(prediction.output);

      if (!outputUrl) {
        await mediaJobs.updateJobStatus(jobId, 'failed', {
          error: 'No output URL in prediction response',
        });
        return { statusCode: 200, body: 'Processed (no output)' };
      }

      // Get media type info based on job type
      const { extension, contentType, folder } = getMediaTypeInfo(job.type);

      // Download the media and store in S3
      const response = await fetch(outputUrl);
      if (!response.ok) {
        await mediaJobs.updateJobStatus(jobId, 'failed', {
          error: `Failed to download ${job.type}: ${response.statusText}`,
        });
        return { statusCode: 200, body: 'Processed (download failed)' };
      }

      const mediaBuffer = Buffer.from(await response.arrayBuffer());
      const mediaId = uuid();
      const s3Key = `agents/${job.agentId}/${folder}/${mediaId}.${extension}`;

      logger.info('Uploading media to S3', { type: job.type, s3Key, bytes: mediaBuffer.length });

      await s3Client.send(new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: s3Key,
        Body: mediaBuffer,
        ContentType: contentType,
      }));

      const publicUrl = CDN_URL ? `${CDN_URL}/${s3Key}` : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

      // Update job status
      await mediaJobs.updateJobStatus(jobId, 'completed', {
        resultUrl: publicUrl,
        resultS3Key: s3Key,
      });

      // Add to gallery
      await gallery.addToGallery(job.agentId, {
        id: mediaId,
        type: job.type,
        url: publicUrl,
        s3Key,
        prompt: job.prompt,
        model: `replicate-${job.type}`,
        platform: job.platform,
        metadata: {
          jobId,
          predictionId: prediction.id,
          predictTime: prediction.metrics?.predict_time,
        },
      });

      // Send callback message to response queue if configured
      // Allow sending when we have conversationId (will post to chat) or replyToMessageId (will reply to specific message)
      if (RESPONSE_QUEUE_URL && (job.conversationId || job.replyToMessageId)) {
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: RESPONSE_QUEUE_URL,
          MessageBody: JSON.stringify({
            type: `${job.type}_complete`,
            agentId: job.agentId,
            platform: job.platform,
            conversationId: job.conversationId,
            replyToMessageId: job.replyToMessageId,
            result: {
              success: true,
              mediaUrl: publicUrl,
              mediaType: job.type,
              prompt: job.prompt,
            },
          }),
        }));
      }

      logger.info('Media generation complete', { type: job.type, url: publicUrl });
      return { statusCode: 200, body: 'Success' };
    }

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      const errorMessage = prediction.error || `Prediction ${prediction.status}`;

      await mediaJobs.updateJobStatus(jobId, 'failed', {
        error: errorMessage,
      });

      // Send failure callback
      if (RESPONSE_QUEUE_URL && job.replyToMessageId) {
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: RESPONSE_QUEUE_URL,
          MessageBody: JSON.stringify({
            type: `${job.type}_failed`,
            agentId: job.agentId,
            platform: job.platform,
            conversationId: job.conversationId,
            replyToMessageId: job.replyToMessageId,
            result: {
              success: false,
              error: errorMessage,
              prompt: job.prompt,
            },
          }),
        }));
      }

      logger.warn('Media generation failed', { type: job.type, error: errorMessage });
      return { statusCode: 200, body: 'Processed failure' };
    }

    // Still processing - update status
    if (prediction.status === 'processing') {
      await mediaJobs.updateJobStatus(jobId, 'processing');
    }

    return { statusCode: 200, body: 'Acknowledged' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('Webhook processing error', error);

    // Record error in auto-issues system
    recordError({
      error: errorMessage,
      stack: errorStack,
      subsystem: 'replicate',
      category: 'webhook_error',
    }).catch(() => {
      // Ignore recording failures
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: errorMessage,
      }),
    };
  }
}
