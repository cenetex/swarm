/**
 * InMemoryQueue — local replacement for SQS.
 *
 * Provides at-least-once delivery with visibility timeout semantics.
 * Used for inter-component message passing in local/containerized deployments.
 *
 * Each queue is identified by a name (e.g. "message-queue", "response-queue").
 * Messages are JSON-serializable objects.
 */
import { EventEmitter } from 'events';

interface QueueMessage {
  id: string;
  body: unknown;
  enqueuedAt: number;
  visibleAt: number;
  receiveCount: number;
}

export interface QueueOptions {
  /** Visibility timeout in ms. Defaults to 30_000 (30s). */
  visibilityTimeoutMs?: number;
}

export class InMemoryQueue {
  private messages: Map<string, QueueMessage[]> = new Map();
  private events: EventEmitter = new EventEmitter();
  private visibilityTimeoutMs: number;
  private _idCounter: number = 0;

  constructor(options: QueueOptions = {}) {
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000;
  }

  /** Send a message to a queue. */
  async send(queueName: string, body: unknown): Promise<void> {
    const queue = this._getOrCreate(queueName);
    const message: QueueMessage = {
      id: `msg_${++this._idCounter}_${Date.now()}`,
      body,
      enqueuedAt: Date.now(),
      visibleAt: Date.now(),
      receiveCount: 0,
    };
    queue.push(message);
    this.events.emit(`queue:${queueName}`);
  }

  /**
   * Receive up to `maxMessages` from a queue.
   * Messages become invisible for `visibilityTimeoutMs` after receiving.
   * Returns empty array if no messages are available.
   */
  async receive(queueName: string, maxMessages: number = 1): Promise<Array<{ id: string; body: unknown; receiptHandle: string }>> {
    const queue = this._getOrCreate(queueName);
    const now = Date.now();
    const results: Array<{ id: string; body: unknown; receiptHandle: string }> = [];

    for (const msg of queue) {
      if (msg.visibleAt <= now) {
        msg.visibleAt = now + this.visibilityTimeoutMs;
        msg.receiveCount++;
        results.push({
          id: msg.id,
          body: msg.body,
          receiptHandle: msg.id,
        });
        if (results.length >= maxMessages) break;
      }
    }

    return results;
  }

  /** Delete a message from the queue (acknowledge successful processing). */
  async delete(queueName: string, receiptHandle: string): Promise<void> {
    const queue = this.messages.get(queueName);
    if (!queue) return;
    const idx = queue.findIndex((m) => m.id === receiptHandle);
    if (idx !== -1) queue.splice(idx, 1);
  }

  /** Return approximate message count for a queue. */
  async getApproximateCount(queueName: string): Promise<number> {
    const queue = this.messages.get(queueName);
    if (!queue) return 0;
    const now = Date.now();
    return queue.filter((m) => m.visibleAt <= now).length;
  }

  /**
   * Poll a queue, calling the handler for each received message.
   * Returns only when `stopSignal` resolves.
   */
  async poll(
    queueName: string,
    handler: (body: unknown) => Promise<void>,
    stopSignal: Promise<void>,
    pollIntervalMs: number = 1000,
  ): Promise<void> {
    let stopped = false;
    stopSignal.then(() => { stopped = true; });

    while (!stopped) {
      const messages = await this.receive(queueName, 10);
      for (const msg of messages) {
        try {
          await handler(msg.body);
          await this.delete(queueName, msg.receiptHandle);
        } catch {
          // Message will become visible again after timeout
        }
      }

      if (!stopped) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, pollIntervalMs);
          stopSignal.then(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    }
  }

  private _getOrCreate(name: string): QueueMessage[] {
    let queue = this.messages.get(name);
    if (!queue) {
      queue = [];
      this.messages.set(name, queue);
    }
    return queue;
  }
}
