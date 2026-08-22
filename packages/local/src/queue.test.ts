/**
 * InMemoryQueue tests.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { InMemoryQueue } from './queue.js';

describe('InMemoryQueue', () => {
  let queue: InMemoryQueue;

  beforeEach(() => {
    queue = new InMemoryQueue({ visibilityTimeoutMs: 100 });
  });

  describe('send / receive / delete', () => {
    it('sends and receives a single message', async () => {
      await queue.send('test-q', { hello: 'world' });
      const msgs = await queue.receive('test-q');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].body).toEqual({ hello: 'world' });
      expect(msgs[0].receiptHandle).toBeTruthy();
    });

    it('receives empty array when queue is empty', async () => {
      const msgs = await queue.receive('empty-q');
      expect(msgs).toHaveLength(0);
    });

    it('deletes a message after processing', async () => {
      await queue.send('test-q', { id: 1 });
      const msgs = await queue.receive('test-q');
      await queue.delete('test-q', msgs[0].receiptHandle);
      expect(await queue.receive('test-q')).toHaveLength(0);
    });

    it('receives multiple messages', async () => {
      for (let i = 0; i < 5; i++) {
        await queue.send('test-q', { idx: i });
      }
      const msgs = await queue.receive('test-q', 10);
      expect(msgs).toHaveLength(5);
    });

    it('respects maxMessages parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await queue.send('test-q', { idx: i });
      }
      const msgs = await queue.receive('test-q', 2);
      expect(msgs).toHaveLength(2);
    });
  });

  describe('visibility timeout', () => {
    it('message becomes invisible after receive', async () => {
      await queue.send('test-q', { val: 1 });
      const first = await queue.receive('test-q');
      expect(first).toHaveLength(1);

      // Immediate second receive should not return the same message
      const second = await queue.receive('test-q');
      expect(second).toHaveLength(0);
    });

    it('message becomes visible again after timeout', async () => {
      const q = new InMemoryQueue({ visibilityTimeoutMs: 10 });
      await q.send('test-q', { val: 1 });
      await q.receive('test-q');

      // Wait for visibility timeout
      await new Promise((r) => setTimeout(r, 20));

      const msgs = await q.receive('test-q');
      expect(msgs).toHaveLength(1);
    });
  });

  describe('approximate count', () => {
    it('returns correct count', async () => {
      await queue.send('test-q', { a: 1 });
      await queue.send('test-q', { b: 2 });
      expect(await queue.getApproximateCount('test-q')).toBe(2);
    });

    it('returns 0 for empty queue', async () => {
      expect(await queue.getApproximateCount('test-q')).toBe(0);
    });

    it('excludes invisible messages from count', async () => {
      await queue.send('test-q', { a: 1 });
      await queue.send('test-q', { b: 2 });
      await queue.receive('test-q', 1);
      expect(await queue.getApproximateCount('test-q')).toBe(1);
    });
  });

  describe('polling', () => {
    it('processes messages via poll', async () => {
      const received: unknown[] = [];
      const stopPromise = new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });

      await queue.send('test-q', { msg: 'hello' });
      await queue.send('test-q', { msg: 'world' });

      await queue.poll('test-q', async (body) => {
        received.push(body);
      }, stopPromise, 10);

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual({ msg: 'hello' });
      expect(received[1]).toEqual({ msg: 'world' });
    });
  });
});
