/**
 * SQS Payload Offload Service
 *
 * Transparently offloads large SQS messages to S3 when they exceed the 256KB limit.
 * The consumer retrieves the payload from S3 and cleans up after processing.
 *
 * Message format when offloaded:
 * {
 *   __offloaded: true,
 *   bucket: "swarm-staging-media",
 *   key: "sqs-offload/<uuid>.json",
 *   originalSizeBytes: 300000
 * }
 *
 * Usage:
 *   // Producer side (webhook handler):
 *   const offloader = createSqsOffloadService({ bucket: 'my-bucket' });
 *   const { body, offloaded } = await offloader.maybeOffload(payload);
 *   await sqs.send(new SendMessageCommand({ ...cmd, MessageBody: body }));
 *
 *   // Consumer side (message processor):
 *   const offloader = createSqsOffloadService({ bucket: 'my-bucket' });
 *   const payload = await offloader.maybeRetrieve(record.body);
 *   // ... process payload
 *   await offloader.cleanup(record.body); // delete S3 object if offloaded
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

// SQS message size limit is 256KB (262,144 bytes).
// We use a slightly lower threshold to account for message attributes and SQS overhead.
const SQS_MAX_PAYLOAD_BYTES = 256 * 1024; // 262,144 bytes
const DEFAULT_OFFLOAD_THRESHOLD_BYTES = 200 * 1024; // 200KB - conservative to leave room for attributes
const OFFLOAD_PREFIX = 'sqs-offload/';

/**
 * Marker interface for an offloaded SQS message body
 */
export interface OffloadedMessageRef {
  __offloaded: true;
  bucket: string;
  key: string;
  originalSizeBytes: number;
}

/**
 * Result of a maybeOffload call
 */
export interface OffloadResult {
  /** The message body to send to SQS (either original or offload reference) */
  body: string;
  /** Whether the payload was offloaded to S3 */
  offloaded: boolean;
  /** Original payload size in bytes */
  originalSizeBytes: number;
}

export interface SqsOffloadConfig {
  /** S3 bucket for offloaded payloads */
  bucket: string;
  /** S3 key prefix for offloaded payloads (default: 'sqs-offload/') */
  prefix?: string;
  /** Byte threshold above which payloads are offloaded (default: 200KB) */
  thresholdBytes?: number;
  /** S3 client instance (for dependency injection in tests) */
  s3Client?: S3Client;
}

export interface SqsOffloadService {
  /**
   * Check if a payload exceeds the threshold and offload to S3 if needed.
   * Returns the body string to use for SQS SendMessage.
   */
  maybeOffload(payload: unknown): Promise<OffloadResult>;

  /**
   * Given a raw SQS record body, check if it's an offload reference and
   * retrieve the original payload from S3 if so. Otherwise return the parsed body.
   */
  maybeRetrieve(rawBody: string): Promise<unknown>;

  /**
   * If the body was an offload reference, delete the S3 object.
   * Safe to call on non-offloaded bodies (no-op).
   */
  cleanup(rawBody: string): Promise<void>;

  /**
   * Check if a raw body is an offload reference without parsing the full payload.
   */
  isOffloaded(rawBody: string): boolean;
}

/**
 * Check if a parsed object is an offload reference
 */
function isOffloadRef(obj: unknown): obj is OffloadedMessageRef {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).__offloaded === true &&
    typeof (obj as Record<string, unknown>).bucket === 'string' &&
    typeof (obj as Record<string, unknown>).key === 'string'
  );
}

/**
 * Create the SQS offload service.
 */
export function createSqsOffloadService(config: SqsOffloadConfig): SqsOffloadService {
  const {
    bucket,
    prefix = OFFLOAD_PREFIX,
    thresholdBytes = DEFAULT_OFFLOAD_THRESHOLD_BYTES,
  } = config;
  const s3 = config.s3Client || new S3Client({});

  const service: SqsOffloadService = {
    async maybeOffload(payload: unknown): Promise<OffloadResult> {
      const body = JSON.stringify(payload);
      const sizeBytes = Buffer.byteLength(body, 'utf-8');

      if (sizeBytes <= thresholdBytes) {
        return { body, offloaded: false, originalSizeBytes: sizeBytes };
      }

      // Payload exceeds threshold - offload to S3
      const key = `${prefix}${randomUUID()}.json`;

      logger.info('Offloading large SQS payload to S3', {
        event: 'sqs_offload_upload',
        subsystem: 'sqs-offload',
        bucket,
        key,
        originalSizeBytes: sizeBytes,
        thresholdBytes,
      });

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        // Auto-expire offloaded payloads after 24 hours as a safety net.
        // Normal flow deletes them after processing via cleanup().
        Expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }));

      const ref: OffloadedMessageRef = {
        __offloaded: true,
        bucket,
        key,
        originalSizeBytes: sizeBytes,
      };

      return {
        body: JSON.stringify(ref),
        offloaded: true,
        originalSizeBytes: sizeBytes,
      };
    },

    async maybeRetrieve(rawBody: string): Promise<unknown> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        // Not valid JSON - throw for the caller to handle
        throw new Error('Failed to parse SQS message body as JSON');
      }

      if (!isOffloadRef(parsed)) {
        // Not an offloaded message, return as-is
        return parsed;
      }

      // Retrieve from S3
      const ref = parsed;

      logger.info('Retrieving offloaded SQS payload from S3', {
        event: 'sqs_offload_retrieve',
        subsystem: 'sqs-offload',
        bucket: ref.bucket,
        key: ref.key,
        originalSizeBytes: ref.originalSizeBytes,
      });

      const response = await s3.send(new GetObjectCommand({
        Bucket: ref.bucket,
        Key: ref.key,
      }));

      if (!response.Body) {
        throw new Error(`Empty S3 response for offloaded payload: s3://${ref.bucket}/${ref.key}`);
      }

      const bodyStr = await response.Body.transformToString('utf-8');
      return JSON.parse(bodyStr);
    },

    async cleanup(rawBody: string): Promise<void> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        // Not valid JSON - nothing to clean up
        return;
      }

      if (!isOffloadRef(parsed)) {
        return;
      }

      const ref = parsed;

      logger.info('Cleaning up offloaded SQS payload from S3', {
        event: 'sqs_offload_cleanup',
        subsystem: 'sqs-offload',
        bucket: ref.bucket,
        key: ref.key,
      });

      try {
        await s3.send(new DeleteObjectCommand({
          Bucket: ref.bucket,
          Key: ref.key,
        }));
      } catch (error) {
        // Log but don't throw - cleanup failure shouldn't break message processing.
        // The S3 lifecycle/expiry will clean up eventually.
        logger.warn('Failed to delete offloaded SQS payload from S3', {
          event: 'sqs_offload_cleanup_failed',
          subsystem: 'sqs-offload',
          bucket: ref.bucket,
          key: ref.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    isOffloaded(rawBody: string): boolean {
      try {
        const parsed = JSON.parse(rawBody);
        return isOffloadRef(parsed);
      } catch {
        return false;
      }
    },
  };

  return service;
}

/**
 * Try to create an offload service from environment variables.
 * Uses SQS_OFFLOAD_BUCKET if set, otherwise falls back to MEDIA_BUCKET.
 * Returns null if neither is configured.
 */
export function createSqsOffloadServiceFromEnv(): SqsOffloadService | null {
  const bucket = process.env.SQS_OFFLOAD_BUCKET || process.env.MEDIA_BUCKET;
  if (!bucket) {
    return null;
  }

  return createSqsOffloadService({
    bucket,
    prefix: process.env.SQS_OFFLOAD_PREFIX || OFFLOAD_PREFIX,
    thresholdBytes: process.env.SQS_OFFLOAD_THRESHOLD_BYTES
      ? parseInt(process.env.SQS_OFFLOAD_THRESHOLD_BYTES, 10)
      : DEFAULT_OFFLOAD_THRESHOLD_BYTES,
  });
}

/**
 * Constants exported for tests and documentation
 */
export const SQS_OFFLOAD_CONSTANTS = {
  SQS_MAX_PAYLOAD_BYTES,
  DEFAULT_OFFLOAD_THRESHOLD_BYTES,
  OFFLOAD_PREFIX,
} as const;
