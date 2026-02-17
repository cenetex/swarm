/**
 * SQS Send Helper with S3 Offload Support
 *
 * Wraps SQS SendMessage with transparent S3 offloading for large payloads.
 * All handlers should use sendSqsMessage() instead of directly calling sqs.send()
 * for message bodies that could exceed 256KB (e.g., envelopes with media attachments).
 */
import { SQSClient, SendMessageCommand, type SendMessageCommandInput } from '@aws-sdk/client-sqs';
import {
  createSqsOffloadServiceFromEnv,
  logger,
  type SqsOffloadService,
} from '@swarm/core';

let _sqsClient: SQSClient | null = null;
let _offloadService: SqsOffloadService | null | undefined;

function getSqsClient(): SQSClient {
  if (!_sqsClient) {
    _sqsClient = new SQSClient({});
  }
  return _sqsClient;
}

/**
 * Get or lazily create the offload service (singleton).
 * Returns null if offloading is not configured.
 */
export function getOffloadService(): SqsOffloadService | null {
  if (_offloadService === undefined) {
    _offloadService = createSqsOffloadServiceFromEnv();
    if (_offloadService) {
      logger.info('SQS offload service initialized', {
        event: 'sqs_offload_init',
        subsystem: 'sqs-offload',
        bucket: process.env.SQS_OFFLOAD_BUCKET || process.env.MEDIA_BUCKET,
      });
    }
  }
  return _offloadService;
}

/**
 * Reset the offload service singleton (for testing)
 */
export function _resetOffloadService(): void {
  _offloadService = undefined;
}

/**
 * Send an SQS message with automatic S3 offloading for large payloads.
 *
 * @param params - Standard SQS SendMessageCommandInput but MessageBody should contain
 *                 the raw payload object (not pre-stringified). If already a string,
 *                 pass it through the messagePayload param instead.
 * @param messagePayload - The payload object to serialize and send. Takes precedence
 *                         over params.MessageBody if provided.
 */
export async function sendSqsMessage(
  params: Omit<SendMessageCommandInput, 'MessageBody'> & { MessageBody?: string },
  messagePayload?: unknown,
): Promise<void> {
  const sqs = getSqsClient();
  const offloader = getOffloadService();

  if (messagePayload !== undefined && offloader) {
    // Use offload service for the payload
    const result = await offloader.maybeOffload(messagePayload);

    if (result.offloaded) {
      logger.info('SQS message offloaded to S3', {
        event: 'sqs_message_offloaded',
        subsystem: 'sqs-offload',
        originalSizeBytes: result.originalSizeBytes,
        queueUrl: params.QueueUrl,
      });
    }

    await sqs.send(new SendMessageCommand({
      ...params,
      MessageBody: result.body,
    }));
  } else if (messagePayload !== undefined) {
    // No offloader, just stringify directly
    await sqs.send(new SendMessageCommand({
      ...params,
      MessageBody: JSON.stringify(messagePayload),
    }));
  } else {
    // Pre-stringified body
    await sqs.send(new SendMessageCommand(params as SendMessageCommandInput));
  }
}

/**
 * Parse an SQS record body, automatically retrieving from S3 if offloaded.
 * Also returns the raw body for later cleanup.
 */
export async function parseSqsRecordBody(rawBody: string): Promise<{
  payload: unknown;
  rawBody: string;
  wasOffloaded: boolean;
}> {
  const offloader = getOffloadService();

  if (offloader) {
    const wasOffloaded = offloader.isOffloaded(rawBody);
    const payload = await offloader.maybeRetrieve(rawBody);
    return { payload, rawBody, wasOffloaded };
  }

  // No offloader - parse directly
  return {
    payload: JSON.parse(rawBody),
    rawBody,
    wasOffloaded: false,
  };
}

/**
 * Clean up an offloaded S3 object after processing (if applicable).
 */
export async function cleanupSqsRecord(rawBody: string): Promise<void> {
  const offloader = getOffloadService();
  if (offloader) {
    await offloader.cleanup(rawBody);
  }
}
