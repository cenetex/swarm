/**
 * Anomaly Detector Tests
 * Tests for global anomaly circuit breaker loop detection
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as anomalyDetector from './anomaly-detector.js';
import { getDynamoClient } from './dynamo-client.js';

// Mock the DynamoDB client
vi.mock('./dynamo-client.js');

const mockDynamo = vi.mocked(getDynamoClient());

describe('Anomaly Detector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('shouldPauseAvatar', () => {
    it('should not pause when below thresholds', async () => {
      mockDynamo.send.mockResolvedValue({
        Item: {
          messages: [
            { timestamp: Date.now(), contentHash: 'hash1' },
            { timestamp: Date.now(), contentHash: 'hash2' },
          ],
        },
      });

      const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1');

      expect(result.paused).toBe(false);
    });

    it('should pause when message rate exceeds 12 in 15 min', async () => {
      const now = Date.now();
      const messages = Array.from({ length: 13 }, (_, i) => ({
        timestamp: now - i * 1000,
        contentHash: `hash${i}`,
      }));

      mockDynamo.send.mockResolvedValue({ Item: { messages } });

      const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1');

      expect(result.paused).toBe(true);
      expect(result.reason).toBe('excessive_message_rate');
      expect(result.metrics?.messageCount).toBe(13);
    });

    it('should pause when duplicate content detected (5+ same hash in 10 min)', async () => {
      const now = Date.now();
      const messages = Array.from({ length: 15 }, (_, i) => ({
        timestamp: now - i * 1000,
        // First 5 have same hash (duplicates), rest have unique hashes
        contentHash: i < 5 ? 'duplicate-hash' : `unique-hash-${i}`,
      }));

      mockDynamo.send.mockResolvedValue({ Item: { messages } });

      const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1');

      expect(result.paused).toBe(true);
      expect(result.reason).toBe('excessive_content_duplication');
      expect(result.metrics?.duplicateCount).toBeGreaterThanOrEqual(5);
    });

    it('should fail open on DynamoDB error', async () => {
      mockDynamo.send.mockRejectedValue(new Error('DynamoDB Error'));

      const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1');

      expect(result.paused).toBe(false);
    });

    it('should return empty metrics when no anomaly', async () => {
      mockDynamo.send.mockResolvedValue({
        Item: {
          messages: [{ timestamp: Date.now(), contentHash: 'hash1' }],
        },
      });

      const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1');

      expect(result.paused).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it('should filter old messages outside 15 min window', async () => {
      const now = Date.now();
      const windowMs = 15 * 60 * 1000;
      const messages = [
        { timestamp: now, contentHash: 'recent-1' },
        { timestamp: now, contentHash: 'recent-2' },
        { timestamp: now - windowMs - 1000, contentHash: 'old' }, // Outside window
      ];

      mockDynamo.send.mockResolvedValue({ Item: { messages } });

      const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1');

      expect(result.paused).toBe(false);
      expect(result.metrics?.messageCount).toBeLessThanOrEqual(2);
    });

    it('should handle missing messages gracefully', async () => {
      mockDynamo.send.mockResolvedValue({ Item: {} });

      const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1');

      expect(result.paused).toBe(false);
    });
  });

  describe('recordResponse', () => {
    it('should record message with content hash', async () => {
      mockDynamo.send.mockResolvedValue({});

      await anomalyDetector.recordResponse('avatar1', 'channel1', 'Hello world');

      expect(mockDynamo.send).toHaveBeenCalled();
    });

    it('should handle recording errors gracefully', async () => {
      mockDynamo.send.mockRejectedValue(new Error('Record failed'));

      // Should not throw
      await expect(
        anomalyDetector.recordResponse('avatar1', 'channel1', 'Test message')
      ).resolves.toBeUndefined();
    });
  });

  describe('resetAnomalyState', () => {
    it('should clear loop records for specific channel', async () => {
      mockDynamo.send.mockResolvedValue({});

      await anomalyDetector.resetAnomalyState('avatar1', 'channel1');

      expect(mockDynamo.send).toHaveBeenCalled();
    });

    it('should handle reset errors gracefully', async () => {
      mockDynamo.send.mockRejectedValue(new Error('Reset failed'));

      await expect(
        anomalyDetector.resetAnomalyState('avatar1', 'channel1')
      ).resolves.toBeUndefined();
    });
  });

  describe('Content hash function', () => {
    it('should generate consistent hashes for same prefix', () => {
      const text1 = 'Hello, this is a long message';
      const text2 = 'Hello, this is a different message later';

      // Both start with 'hello, this is a' so should have same prefix hash
      const hash1 = hashContentPrefix(text1, 15);
      const hash2 = hashContentPrefix(text2, 15);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different prefixes', () => {
      const text1 = 'Hello world';
      const text2 = 'Goodbye world';

      const hash1 = hashContentPrefix(text1, 5);
      const hash2 = hashContentPrefix(text2, 5);

      expect(hash1).not.toBe(hash2);
    });
  });
});

// Helper function from anomaly-detector (for testing purposes)
function hashContentPrefix(text: string, prefixLength: number = 20): string {
  const prefix = text.slice(0, prefixLength).toLowerCase();
  let hash = 0;
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}
