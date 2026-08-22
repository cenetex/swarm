import { SendMessageCommand, SQSClient } from '../commands/index.js';
/**
 * Post Queue Service
 *
 * Utility for enqueueing posts to POST_QUEUE for decoupled Twitter posting.
 */
import type { PostQueueMessage } from '../types/content-store.js';

let sqsClient: SQSClient | null = null;

function getSQSClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/**
 * Enqueue a post to POST_QUEUE for the tweet-sender to process
 */
export async function enqueuePost(
  queueUrl: string,
  avatarId: string,
  postId: string,
  scheduledAt?: number
): Promise<void> {
  const message: PostQueueMessage = {
    avatarId,
    postId,
    scheduledAt,
    attempts: 0,
    enqueuedAt: Date.now(),
  };

  const client = getSQSClient();

  await client.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message),
    // FIFO queue requires MessageGroupId and MessageDeduplicationId
    MessageGroupId: avatarId,
    MessageDeduplicationId: postId,
  }));
}

/**
 * Check if POST_QUEUE is configured
 */
export function isPostQueueConfigured(): boolean {
  return Boolean(process.env.POST_QUEUE_URL);
}

/**
 * Get POST_QUEUE URL from environment
 */
export function getPostQueueUrl(): string | undefined {
  return process.env.POST_QUEUE_URL || undefined;
}
