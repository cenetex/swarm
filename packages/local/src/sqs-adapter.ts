import { LocalAdapter } from './adapter-base.js';
import { InMemoryQueue } from './queue.js';

export class LocalSQSAdapter extends LocalAdapter {
  constructor(private queue: InMemoryQueue) { super(); }

  protected async dispatch(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name.startsWith('SendMessageCommand')) {
      const queueUrl = input.QueueUrl as string;
      const body = input.MessageBody as string;
      const queueName = queueNameFromUrl(queueUrl);
      await this.queue.send(queueName, { body, queueUrl });
      return { $metadata: { httpStatusCode: 200 }, MessageId: `local-${Date.now()}` };
    }
    if (name.startsWith('ReceiveMessageCommand')) {
      const queueUrl = input.QueueUrl as string;
      const maxMessages = (input.MaxNumberOfMessages as number) ?? 1;
      const queueName = queueNameFromUrl(queueUrl);
      const msgs = await this.queue.receive(queueName, maxMessages);
      return {
        $metadata: { httpStatusCode: 200 },
        Messages: msgs.map((m) => ({
          MessageId: m.id,
          ReceiptHandle: m.receiptHandle,
          Body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
        })),
      };
    }
    if (name.startsWith('DeleteMessageCommand')) {
      const queueUrl = input.QueueUrl as string;
      const receiptHandle = input.ReceiptHandle as string;
      await this.queue.delete(queueNameFromUrl(queueUrl), receiptHandle);
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (name.startsWith('GetQueueAttributesCommand')) {
      const count = await this.queue.getApproximateCount(queueNameFromUrl(input.QueueUrl as string));
      return {
        $metadata: { httpStatusCode: 200 },
        Attributes: {
          ApproximateNumberOfMessages: String(count),
          ApproximateNumberOfMessagesNotVisible: '0',
        },
      };
    }
    throw new Error(`LocalSQSAdapter: unsupported command "${name}"`);
  }
}

function queueNameFromUrl(url: string): string {
  // Extract the last non-empty path segment as the queue name.
  // Handles trailing slashes (e.g. "https://.../queue-name/").
  const parts = url.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? url;
}
