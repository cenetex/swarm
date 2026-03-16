import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDreamContext } from './dream-context.js';
import { _setDynamoClient } from './dynamo-client.js';

function createMockClient(sendFn: (...args: unknown[]) => Promise<unknown>) {
  return { send: sendFn } as any;
}

describe('dream-context', () => {
  beforeEach(() => {
    _setDynamoClient(null);
  });

  describe('getDreamContext', () => {
    it('returns null when STATE_TABLE is not configured', async () => {
      const result = await getDreamContext('avatar-1', { stateTable: undefined });
      expect(result).toBeNull();
    });

    it('returns null when no dream record exists', async () => {
      const send = vi.fn().mockResolvedValueOnce({ Item: undefined });
      _setDynamoClient(createMockClient(send));

      const result = await getDreamContext('avatar-1', { stateTable: 'test-state' });

      expect(result).toBeNull();
      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0][0];
      expect(command.input.Key).toEqual({
        pk: 'AVATAR#avatar-1',
        sk: 'DREAM#current',
      });
    });

    it('returns dream context when record exists and is fresh', async () => {
      const send = vi.fn().mockResolvedValueOnce({
        Item: {
          dream: 'Floating through neon-lit corridors of code',
          previousDream: 'Walking in a field of binary flowers',
          generatedAt: Date.now() - 3600 * 1000, // 1 hour ago
          iteration: 5,
        },
      });

      _setDynamoClient(createMockClient(send));

      const result = await getDreamContext('avatar-1', { stateTable: 'test-state' });

      expect(result).not.toBeNull();
      expect(result!.dream).toBe('Floating through neon-lit corridors of code');
      expect(result!.previousDream).toBe('Walking in a field of binary flowers');
      expect(result!.iteration).toBe(5);
    });

    it('returns null when dream is stale (older than 24 hours)', async () => {
      const send = vi.fn().mockResolvedValueOnce({
        Item: {
          dream: 'An old dream',
          generatedAt: Date.now() - 25 * 3600 * 1000, // 25 hours ago
          iteration: 3,
        },
      });

      _setDynamoClient(createMockClient(send));

      const result = await getDreamContext('avatar-1', { stateTable: 'test-state' });

      expect(result).toBeNull();
    });

    it('handles DynamoDB errors gracefully', async () => {
      const send = vi.fn().mockRejectedValueOnce(new Error('Connection timeout'));
      _setDynamoClient(createMockClient(send));

      const result = await getDreamContext('avatar-1', { stateTable: 'test-state' });

      expect(result).toBeNull();
    });

    it('defaults iteration to 1 when not set', async () => {
      const send = vi.fn().mockResolvedValueOnce({
        Item: {
          dream: 'A simple dream',
          generatedAt: Date.now() - 1000,
        },
      });

      _setDynamoClient(createMockClient(send));

      const result = await getDreamContext('avatar-1', { stateTable: 'test-state' });

      expect(result).not.toBeNull();
      expect(result!.iteration).toBe(1);
    });
  });
});
