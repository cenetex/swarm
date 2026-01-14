import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock AWS SDK
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = vi.fn();
  return {
    DynamoDBDocumentClient: {
      from: vi.fn(() => ({
        send: mockSend
      }))
    },
    GetCommand: vi.fn(x => x),
    PutCommand: vi.fn(x => x),
  };
});

const mocked = <T>(value: T) => (typeof (vi as any).mocked === 'function' ? (vi as any).mocked(value) : value as any);

describe('UsageMeteringService', () => {
  let service: import('./usage.js').DynamoDBUsageMeteringService;
  let DynamoDBUsageMeteringService: typeof import('./usage.js').DynamoDBUsageMeteringService;
  let DynamoDBDocumentClient: typeof import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  let mockDocClient: ReturnType<typeof mocked>;
  const tableName = 'test-table';
  const agentId = 'test-agent';
  const toolId = 'image_gen';
  const config = {
    maxCredits: 3,
    rechargeAmount: 1,
    rechargeIntervalMs: 24 * 60 * 60 * 1000 // 1 day
  };

  beforeAll(async () => {
    ({ DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb'));
    ({ DynamoDBUsageMeteringService } = await import('./usage.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DynamoDBUsageMeteringService(tableName);
    mockDocClient = mocked(DynamoDBDocumentClient.from(null as any));
  });

  describe('getCredits', () => {
    it('returns max credits if no record exists', async () => {
      mockDocClient.send.mockResolvedValueOnce({ Item: undefined });

      const result = await service.getCredits(agentId, toolId, config);

      expect(result.credits).toBe(config.maxCredits);
      expect(mockDocClient.send).toHaveBeenCalledWith(expect.any(Object));
    });

    it('calculates recharged credits correctly', async () => {
      const lastRecharge = Date.now() - (1.5 * 24 * 60 * 60 * 1000); // 1.5 days ago
      mockDocClient.send.mockResolvedValueOnce({
        Item: {
          credits: 1,
          lastRecharge
        }
      });

      const result = await service.getCredits(agentId, toolId, config);

      // 1 existing + 1 recharged (1.5 days = 1 interval)
      expect(result.credits).toBe(2);
    });

    it('caps credits at maxCredits', async () => {
      const lastRecharge = Date.now() - (10 * 24 * 60 * 60 * 1000); // 10 days ago
      mockDocClient.send.mockResolvedValueOnce({
        Item: {
          credits: 1,
          lastRecharge
        }
      });

      const result = await service.getCredits(agentId, toolId, config);

      expect(result.credits).toBe(config.maxCredits);
    });
  });

  describe('canUseTool', () => {
    it('returns true if credits > 0', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 1, lastRecharge: Date.now() }
      });

      const result = await service.canUseTool(agentId, toolId, config);
      expect(result).toBe(true);
    });

    it('returns false if credits == 0', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 0, lastRecharge: Date.now() }
      });

      const result = await service.canUseTool(agentId, toolId, config);
      expect(result).toBe(false);
    });
  });

  describe('consumeCredit', () => {
    it('decrements credits and saves to DynamoDB', async () => {
      const now = Date.now();
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 2, lastRecharge: now }
      });
      mockDocClient.send.mockResolvedValueOnce({}); // PutCommand response

      const result = await service.consumeCredit(agentId, toolId, config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
      
      expect(mockDocClient.send).toHaveBeenCalledTimes(2);
      const putCall = mocked(mockDocClient.send).mock.calls[1][0] as any;
      expect(putCall.Item.credits).toBe(1);
      expect(putCall.Item.pk).toBe(`AGENT#${agentId}`);
      expect(putCall.Item.sk).toBe(`USAGE#${toolId}`);
    });

    it('denies consumption if no credits available', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 0, lastRecharge: Date.now() }
      });

      const result = await service.consumeCredit(agentId, toolId, config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(mockDocClient.send).toHaveBeenCalledTimes(1); // Only GetCommand
    });

    it('updates lastRecharge when credits are recharged during consumption', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - (2.5 * interval); // 2.5 intervals ago
      
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 0, lastRecharge }
      });
      mockDocClient.send.mockResolvedValueOnce({}); // PutCommand

      const result = await service.consumeCredit(agentId, toolId, config);

      expect(result.allowed).toBe(true);
      // 0 + 2 (recharge) - 1 (consume) = 1
      expect(result.remaining).toBe(1);

      const putCall = mocked(mockDocClient.send).mock.calls[1][0] as any;
      // Should have moved lastRecharge forward by 2 full intervals
      expect(putCall.Item.lastRecharge).toBe(lastRecharge + (2 * interval));
    });
  });

  /**
   * Usage Metering: canUseTool denies when credits exhausted
   */
  describe('canUseTool denies when credits exhausted', () => {
    it('denies tool use when credits are zero', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 0, lastRecharge: Date.now() }
      });

      const result = await service.canUseTool(agentId, toolId, config);
      expect(result).toBe(false);
    });

    it('denies tool use when credits are negative (edge case)', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: -1, lastRecharge: Date.now() }
      });

      const result = await service.canUseTool(agentId, toolId, config);
      expect(result).toBe(false);
    });

    it('returns false on DynamoDB error (fail closed for safety)', async () => {
      mockDocClient.send.mockRejectedValueOnce(new Error('DynamoDB timeout'));

      const result = await service.canUseTool(agentId, toolId, config);
      // Fails with 0 credits on error, so canUseTool returns false
      expect(result).toBe(false);
    });
  });

  /**
   * Usage Metering: consumeCredit decrements and enforces limits
   */
  describe('consumeCredit decrements and enforces limits', () => {
    it('decrements from maxCredits to maxCredits-1', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: config.maxCredits, lastRecharge: Date.now() }
      });
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await service.consumeCredit(agentId, toolId, config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.maxCredits - 1);
    });

    it('decrements from 1 to 0', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 1, lastRecharge: Date.now() }
      });
      mockDocClient.send.mockResolvedValueOnce({});

      const result = await service.consumeCredit(agentId, toolId, config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('enforces limit by denying when at zero', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 0, lastRecharge: Date.now() }
      });

      const result = await service.consumeCredit(agentId, toolId, config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('returns original credits on DynamoDB write failure', async () => {
      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 2, lastRecharge: Date.now() }
      });
      mockDocClient.send.mockRejectedValueOnce(new Error('Write failed'));

      const result = await service.consumeCredit(agentId, toolId, config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(2);
    });
  });

  /**
   * Usage Metering: daily recharge restores tool credits
   */
  describe('daily recharge restores tool credits', () => {
    it('restores 1 credit after 1 recharge interval', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - interval; // Exactly 1 interval ago

      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 0, lastRecharge }
      });

      const result = await service.getCredits(agentId, toolId, config);

      // 0 + 1 (1 interval * rechargeAmount) = 1
      expect(result.credits).toBe(config.rechargeAmount);
    });

    it('restores multiple credits after multiple intervals', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - (3 * interval); // 3 intervals ago

      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 0, lastRecharge }
      });

      const result = await service.getCredits(agentId, toolId, config);

      // 0 + 3 (3 intervals * rechargeAmount) = 3, capped at maxCredits
      expect(result.credits).toBe(Math.min(3 * config.rechargeAmount, config.maxCredits));
    });

    it('caps recharged credits at maxCredits', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - (100 * interval); // Long time ago

      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 1, lastRecharge }
      });

      const result = await service.getCredits(agentId, toolId, config);

      expect(result.credits).toBe(config.maxCredits);
    });

    it('does not recharge before interval elapsed', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - (interval / 2); // Half interval ago

      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 1, lastRecharge }
      });

      const result = await service.getCredits(agentId, toolId, config);

      // No recharge yet
      expect(result.credits).toBe(1);
    });

    it('adds recharge amount to existing credits', async () => {
      const interval = config.rechargeIntervalMs;
      const lastRecharge = Date.now() - interval; // 1 interval ago

      mockDocClient.send.mockResolvedValueOnce({
        Item: { credits: 1, lastRecharge }
      });

      const result = await service.getCredits(agentId, toolId, config);

      // 1 existing + 1 recharged = 2
      expect(result.credits).toBe(1 + config.rechargeAmount);
    });
  });
});
