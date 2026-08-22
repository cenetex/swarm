/**
 * LocalSQSAdapter tests.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { LocalSQSAdapter } from './sqs-adapter.js';
import { InMemoryQueue } from './queue.js';

function makeCmd(name: string, input: Record<string, unknown>) {
  return { constructor: { name }, input };
}

const Q_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue';

describe('LocalSQSAdapter', () => {
  let queue: InMemoryQueue;
  let sqs: LocalSQSAdapter;

  beforeEach(() => {
    queue = new InMemoryQueue({ visibilityTimeoutMs: 100 });
    sqs = new LocalSQSAdapter(queue);
  });

  describe('SendMessageCommand', () => {
    it('sends a message and returns MessageId', async () => {
      const result = await sqs.send(makeCmd('SendMessageCommand', {
        QueueUrl: Q_URL,
        MessageBody: JSON.stringify({ hello: 'world' }),
      }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(typeof result.MessageId).toBe('string');
      expect((result.MessageId as string)).toStartWith('local-');
    });

    it('enqueues message for later receive', async () => {
      await sqs.send(makeCmd('SendMessageCommand', {
        QueueUrl: Q_URL,
        MessageBody: 'raw text',
      }));
      const msgs = await queue.receive('test-queue', 10);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].body).toEqual({ body: 'raw text', queueUrl: Q_URL });
    });
  });

  describe('ReceiveMessageCommand', () => {
    it('receives previously sent messages', async () => {
      await queue.send('test-queue', { body: 'msg1', queueUrl: Q_URL });
      await queue.send('test-queue', { body: 'msg2', queueUrl: Q_URL });

      const result = await sqs.send(makeCmd('ReceiveMessageCommand', {
        QueueUrl: Q_URL,
        MaxNumberOfMessages: 10,
      }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      const messages = result.Messages as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(2);
      expect(messages[0].Body).toBeString();
      expect(messages[0].ReceiptHandle).toBeString();
    });

    it('returns empty Messages when queue is empty', async () => {
      const result = await sqs.send(makeCmd('ReceiveMessageCommand', { QueueUrl: Q_URL }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      expect(result.Messages).toEqual([]);
    });

    it('respects MaxNumberOfMessages', async () => {
      for (let i = 0; i < 5; i++) {
        await queue.send('test-queue', { body: `msg${i}`, queueUrl: Q_URL });
      }
      const result = await sqs.send(makeCmd('ReceiveMessageCommand', {
        QueueUrl: Q_URL,
        MaxNumberOfMessages: 2,
      }));
      expect((result.Messages as Array<unknown>)).toHaveLength(2);
    });
  });

  describe('DeleteMessageCommand', () => {
    it('deletes a message by receipt handle', async () => {
      await queue.send('test-queue', { body: 'delete-me', queueUrl: Q_URL });
      const received = await queue.receive('test-queue', 1);
      expect(received).toHaveLength(1);

      const result = await sqs.send(makeCmd('DeleteMessageCommand', {
        QueueUrl: Q_URL,
        ReceiptHandle: received[0].receiptHandle,
      }));
      expect(result.$metadata.httpStatusCode).toBe(200);

      const remaining = await queue.receive('test-queue', 1);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('GetQueueAttributesCommand', () => {
    it('returns approximate message count', async () => {
      await queue.send('test-queue', { body: 'a', queueUrl: Q_URL });
      await queue.send('test-queue', { body: 'b', queueUrl: Q_URL });

      const result = await sqs.send(makeCmd('GetQueueAttributesCommand', { QueueUrl: Q_URL }));
      expect(result.$metadata.httpStatusCode).toBe(200);
      const attrs = result.Attributes as Record<string, string>;
      expect(attrs.ApproximateNumberOfMessages).toBe('2');
      expect(attrs.ApproximateNumberOfMessagesNotVisible).toBe('0');
    });

    it('returns zero for empty queue', async () => {
      const result = await sqs.send(makeCmd('GetQueueAttributesCommand', {
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/empty-queue',
      }));
      const attrs = result.Attributes as Record<string, string>;
      expect(attrs.ApproximateNumberOfMessages).toBe('0');
    });
  });

  describe('unsupported command', () => {
    it('throws for unknown commands', async () => {
      try {
        await sqs.send(makeCmd('PurgeQueueCommand', {}));
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).toMatch(/unsupported command/);
      }
    });
  });

  describe('name matching edge cases', () => {
    it('matches prefixed command names like Bun-compiled variants', async () => {
      await queue.send('test-queue', { body: 'edge', queueUrl: Q_URL });
      const result = await sqs.send(makeCmd('ReceiveMessageCommand_Bun', {
        QueueUrl: Q_URL,
        MaxNumberOfMessages: 1,
      }));
      expect(result.$metadata.httpStatusCode).toBe(200);
    });

    it('empty constructor name throws unsupported', async () => {
      try {
        await sqs.send({ input: {} } as any);
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).toMatch(/unsupported/);
      }
    });
  });

  describe('queue name extraction', () => {
    it('handles trailing slash in queue URL', async () => {
      const urlWithSlash = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue/';
      await sqs.send(makeCmd('SendMessageCommand', {
        QueueUrl: urlWithSlash,
        MessageBody: 'trailing-slash',
      }));
      const msgs = await queue.receive('test-queue', 10);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].body).toEqual({ body: 'trailing-slash', queueUrl: urlWithSlash });
    });
  });
});
