import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DynamoDBUsageMeteringService } from './usage.js';
import type { DynamoDBDocumentClient } from '@swarm/core';

describe('UsageMeteringService', () => {
  let service: DynamoDBUsageMeteringService;
  let mockSend: ReturnType<typeof vi.fn>;

  const tableName = 'test-table';
  const avatarId = 'test-avatar';
  const toolId = 'image_gen';
  const config = {
    maxCredits: 3,
    rechargeAmount: 1,
    rechargeIntervalMs: 24 * 60 * 60 * 1000 // 1 day
  };

  beforeEach(() => {
    mockSend = vi.fn(() => Promise.resolve({ Item: undefined }));
    const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
    service = new DynamoDBUsageMeteringService(tableName, mockDocClient);
  });

  describe('getCredits', () => {
    it('returns max credits if no record exists', async () => {
      mockSend.mockImplementation(() => Promise.resolve({ Item: undefined }));

      const result = await service.getCredits(avatarId, toolId, config);

      expect(result.credits).toBe(config.maxCredits);
      expect(mockSend).toHaveBeenCalled();
    });

    it('calculates recharged credits correctly', async () => {
      const lastRecharge = Date.now() - (1.5 * 24 * 60 * 60 * 1000); // 1.5 days ago
      mockSend.mockImplementation(() => Promise.resolve({
        Item: {
          credits: 1,
          lastRecharge
        }
      }));

      const result = await service.getCredits(avatarId, toolId, config);

      // 1 existing + 1 recharged (1.5 days = 1 interval)
      expect(result.credits).toBe(2);
    });

    it('caps credits at maxCredits', async () => {
      const lastRecharge = Date.now() - (10 * 24 * 60 * 60 * 1000); // 10 days ago
      mockSend.mockImplementation(() => Promise.resolve({
        Item: {
          credits: 1,
          lastRecharge
        }
      }));

      const result = await service.getCredits(avatarId, toolId, config);

      expect(result.credits).toBe(config.maxCredits);
    });
  });

  describe('canUseTool', () => {
    it('returns true if credits > 0', async () => {
      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 1, lastRecharge: Date.now() }
      }));

      const result = await service.canUseTool(avatarId, toolId, config);
      expect(result).toBe(true);
    });

    it('returns false if credits == 0', async () => {
      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 0, lastRecharge: Date.now() }
      }));

      const result = await service.canUseTool(avatarId, toolId, config);
      expect(result).toBe(false);
    });
  });

  describe('consumeCredit', () => {
    it('decrements credits and saves to DynamoDB', async () => {
      const now = Date.now();
      let callCount = 0;
      mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ Item: { credits: 2, lastRecharge: now } });
        }
        return Promise.resolve({}); // PutCommand response
      });

      const result = await service.consumeCredit(avatarId, toolId, config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
      expect(mockSend).toHaveBeenCalledTimes(2);

      // Check the PutCommand call
      const putCall = mockSend.mock.calls[1][0] as any;
      expect(putCall.input.Item.credits).toBe(1);
      expect(putCall.input.Item.pk).toBe(`AVATAR#${avatarId}`);
      expect(putCall.input.Item.sk).toBe(`USAGE#${toolId}`);
    });

    it('denies consumption if no credits available', async () => {
      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 0, lastRecharge: Date.now() }
      }));

      const result = await service.consumeCredit(avatarId, toolId, config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(mockSend).toHaveBeenCalledTimes(1); // Only GetCommand
    });

    it('updates lastRecharge when credits are recharged during consumption', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - (2.5 * interval); // 2.5 intervals ago

      let callCount = 0;
      mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ Item: { credits: 0, lastRecharge } });
        }
        return Promise.resolve({}); // PutCommand
      });

      const result = await service.consumeCredit(avatarId, toolId, config);

      expect(result.allowed).toBe(true);
      // 0 + 2 (recharge) - 1 (consume) = 1
      expect(result.remaining).toBe(1);

      const putCall = mockSend.mock.calls[1][0] as any;
      // Should have moved lastRecharge forward by 2 full intervals
      expect(putCall.input.Item.lastRecharge).toBe(lastRecharge + (2 * interval));
    });
  });

  describe('canUseTool denies when credits exhausted', () => {
    it('denies tool use when credits are zero', async () => {
      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 0, lastRecharge: Date.now() }
      }));

      const result = await service.canUseTool(avatarId, toolId, config);
      expect(result).toBe(false);
    });

    it('denies tool use when credits are negative (edge case)', async () => {
      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: -1, lastRecharge: Date.now() }
      }));

      const result = await service.canUseTool(avatarId, toolId, config);
      expect(result).toBe(false);
    });

    it('returns false on DynamoDB error (fail closed for safety)', async () => {
      mockSend.mockImplementation(() => Promise.reject(new Error('DynamoDB timeout')));

      const result = await service.canUseTool(avatarId, toolId, config);
      // Fails with 0 credits on error, so canUseTool returns false
      expect(result).toBe(false);
    });
  });

  describe('consumeCredit decrements and enforces limits', () => {
    it('decrements from maxCredits to maxCredits-1', async () => {
      let callCount = 0;
      mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ Item: { credits: config.maxCredits, lastRecharge: Date.now() } });
        }
        return Promise.resolve({});
      });

      const result = await service.consumeCredit(avatarId, toolId, config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.maxCredits - 1);
    });

    it('decrements from 1 to 0', async () => {
      let callCount = 0;
      mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ Item: { credits: 1, lastRecharge: Date.now() } });
        }
        return Promise.resolve({});
      });

      const result = await service.consumeCredit(avatarId, toolId, config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('enforces limit by denying when at zero', async () => {
      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 0, lastRecharge: Date.now() }
      }));

      const result = await service.consumeCredit(avatarId, toolId, config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('returns original credits on DynamoDB write failure', async () => {
      let callCount = 0;
      mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ Item: { credits: 2, lastRecharge: Date.now() } });
        }
        return Promise.reject(new Error('Write failed'));
      });

      const result = await service.consumeCredit(avatarId, toolId, config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(2);
    });
  });

  describe('daily recharge restores tool credits', () => {
    it('restores 1 credit after 1 recharge interval', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - interval; // Exactly 1 interval ago

      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 0, lastRecharge }
      }));

      const result = await service.getCredits(avatarId, toolId, config);

      // 0 + 1 (1 interval * rechargeAmount) = 1
      expect(result.credits).toBe(config.rechargeAmount);
    });

    it('restores multiple credits after multiple intervals', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - (3 * interval); // 3 intervals ago

      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 0, lastRecharge }
      }));

      const result = await service.getCredits(avatarId, toolId, config);

      // 0 + 3 (3 intervals * rechargeAmount) = 3, capped at maxCredits
      expect(result.credits).toBe(Math.min(3 * config.rechargeAmount, config.maxCredits));
    });

    it('caps recharged credits at maxCredits', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - (100 * interval); // Long time ago

      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 1, lastRecharge }
      }));

      const result = await service.getCredits(avatarId, toolId, config);

      expect(result.credits).toBe(config.maxCredits);
    });

    it('does not recharge before interval elapsed', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - (interval / 2); // Half interval ago

      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 1, lastRecharge }
      }));

      const result = await service.getCredits(avatarId, toolId, config);

      // No recharge yet
      expect(result.credits).toBe(1);
    });

    it('adds recharge amount to existing credits', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - interval; // 1 interval ago

      mockSend.mockImplementation(() => Promise.resolve({
        Item: { credits: 1, lastRecharge }
      }));

      const result = await service.getCredits(avatarId, toolId, config);

      // 1 existing + 1 recharged = 2
      expect(result.credits).toBe(1 + config.rechargeAmount);
    });
  });
});
