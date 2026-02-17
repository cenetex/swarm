/**
 * Logs Service Tests
 * Tests CloudWatch Logs query with dependency injection
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  queryAvatarLogs,
  clearLogGroupCache,
  getLogGroupCacheSize,
  type LogsServiceDeps,
} from './logs.js';

// Helper to create mock deps
function createMockDeps(overrides?: Partial<LogsServiceDeps>): LogsServiceDeps & { mockSend: ReturnType<typeof vi.fn> } {
  const mockSend = vi.fn(() => Promise.resolve({}));

  return {
    logsClient: {
      send: mockSend as unknown as LogsServiceDeps['logsClient']['send'],
    },
    logGroupPrefix: '/aws/lambda/',
    adminLogGroups: [],
    adminLogGroupPrefixes: [],
    ...overrides,
    mockSend,
  };
}

describe('logsService', () => {
  let mockDeps: LogsServiceDeps & { mockSend: ReturnType<typeof vi.fn> };
  const avatarId = 'test-avatar';

  beforeEach(() => {
    mockDeps = createMockDeps();
    clearLogGroupCache(); // ensure clean cache between tests
  });

  it('queries CloudWatch Insights with correct limits and filters', async () => {
    let callCount = 0;
    mockDeps.mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // DescribeLogGroups
        return Promise.resolve({
          logGroups: [{ logGroupName: '/aws/lambda/test-avatar-webhook' }],
        });
      }
      if (callCount === 2) {
        // StartQuery
        return Promise.resolve({ queryId: 'test-query-id' });
      }
      // GetQueryResults
      return Promise.resolve({
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2026-01-12T10:00:00Z' },
            { field: '@message', value: '{"level":"INFO","avatarId":"test-avatar","message":"hello"}' },
            { field: '@log', value: '/aws/lambda/test-avatar-webhook' },
          ],
        ],
      });
    });

    const result = await queryAvatarLogs(avatarId, { level: 'INFO', limit: 10 }, mockDeps);

    expect(result.avatarId).toBe(avatarId);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].message).toContain('hello');
    expect(result.filters.limit).toBe(10);
    expect(result.filters.level).toBe('INFO');

    // Verify StartQuery was called with correct arguments
    const calls = mockDeps.mockSend.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const startQueryCall = calls[1][0] as { input?: { queryString?: string; logGroupNames?: string[] } };
    const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string; logGroupNames?: string[] });
    expect(queryInput.logGroupNames).toContain('/aws/lambda/test-avatar-webhook');
    expect(queryInput.queryString).toContain('limit 10');
  });

  it('enforces and caps the limit at 500', async () => {
    let callCount = 0;
    mockDeps.mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
      if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
      return Promise.resolve({ status: 'Complete', results: [] });
    });

    const result = await queryAvatarLogs(avatarId, { limit: 1000 }, mockDeps);

    expect(result.filters.limit).toBe(500);
    const calls = mockDeps.mockSend.mock.calls;
    const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
    const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
    expect(queryInput.queryString).toContain('limit 500');
  });

  it('supports time-range filters', async () => {
    const startTime = Date.now() - 1000000;
    const endTime = Date.now() - 500000;

    let callCount = 0;
    mockDeps.mockSend.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
      if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
      return Promise.resolve({ status: 'Complete', results: [] });
    });

    await queryAvatarLogs(avatarId, { startTime, endTime }, mockDeps);

    const calls = mockDeps.mockSend.mock.calls;
    const startQueryCall = calls[1][0] as { input?: { startTime?: number; endTime?: number } };
    const queryInput = startQueryCall.input || (startQueryCall as unknown as { startTime?: number; endTime?: number });
    expect(queryInput.startTime).toBe(Math.floor(startTime / 1000));
    expect(queryInput.endTime).toBe(Math.floor(endTime / 1000));
  });

  describe('level/subsystem filters', () => {
    it('filters logs by level correctly', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      await queryAvatarLogs(avatarId, { level: 'error' }, mockDeps);

      const calls = mockDeps.mockSend.mock.calls;
      const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
      const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
      expect(queryInput.queryString).toContain('"level"');
      expect(queryInput.queryString).toMatch(/ERROR|error/);
    });

    it('filters logs by subsystem correctly', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      await queryAvatarLogs(avatarId, { subsystem: 'chat' }, mockDeps);

      const calls = mockDeps.mockSend.mock.calls;
      const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
      const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
      expect(queryInput.queryString).toContain('chat');
    });

    it('combines level and subsystem filters', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAvatarLogs(avatarId, { level: 'warn', subsystem: 'telegram' }, mockDeps);

      expect(result.filters.level).toBe('warn');
      expect(result.filters.subsystem).toBe('telegram');

      const calls = mockDeps.mockSend.mock.calls;
      const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
      const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
      expect(queryInput.queryString).toContain(' and ');
    });
  });

  describe('limit enforcement', () => {
    it('uses default limit of 200 when not specified', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAvatarLogs(avatarId, {}, mockDeps);

      expect(result.filters.limit).toBe(200);
    });

    it('clamps limit to minimum of 1', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAvatarLogs(avatarId, { limit: -10 }, mockDeps);

      expect(result.filters.limit).toBe(1);
    });

    it('accepts limit within valid range', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAvatarLogs(avatarId, { limit: 100 }, mockDeps);

      expect(result.filters.limit).toBe(100);
      const calls = mockDeps.mockSend.mock.calls;
      const startQueryCall = calls[1][0] as { input?: { queryString?: string } };
      const queryInput = startQueryCall.input || (startQueryCall as unknown as { queryString?: string });
      expect(queryInput.queryString).toContain('limit 100');
    });
  });

  describe('time-range filters', () => {
    it('respects explicit startTime and endTime', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const startTime = 1700000000000;
      const endTime = 1700003600000;

      const result = await queryAvatarLogs(avatarId, { startTime, endTime }, mockDeps);

      expect(result.startTime).toBe(startTime);
      expect(result.endTime).toBe(endTime);
    });
  });

  describe('invalid query parameters', () => {
    it('handles NaN limit by using default', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      const result = await queryAvatarLogs(avatarId, { limit: NaN }, mockDeps);

      expect(result.filters.limit).toBe(200);
    });

    it('handles empty log groups gracefully', async () => {
      mockDeps.mockSend.mockImplementation(() => Promise.resolve({ logGroups: [] }));

      const result = await queryAvatarLogs(avatarId, {}, mockDeps);

      expect(result.logGroups).toHaveLength(0);
      expect(result.events).toHaveLength(0);
    });

    it('handles query failure status', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Failed', results: [] });
      });

      const result = await queryAvatarLogs(avatarId, {}, mockDeps);

      expect(result.events).toHaveLength(0);
    });

    it('handles undefined query ID', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        return Promise.resolve({ queryId: undefined });
      });

      const result = await queryAvatarLogs(avatarId, {}, mockDeps);

      expect(result.events).toHaveLength(0);
    });

    it('returns result with filters even on error', async () => {
      let callCount = 0;
      mockDeps.mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ logGroups: [{ logGroupName: 'g1' }] });
        if (callCount === 2) return Promise.resolve({ queryId: 'q1' });
        return Promise.resolve({ status: 'Cancelled', results: [] });
      });

      const result = await queryAvatarLogs(avatarId, { level: 'error', limit: 50 }, mockDeps);

      expect(result.filters.level).toBe('error');
      expect(result.filters.limit).toBe(50);
      expect(result.events).toHaveLength(0);
    });
  });

  describe('log group caching', () => {
    it('caches DescribeLogGroups results across calls for the same avatarId', async () => {
      let describeCallCount = 0;
      mockDeps.mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'DescribeLogGroupsCommand') {
          describeCallCount++;
          return Promise.resolve({
            logGroups: [{ logGroupName: '/aws/lambda/test-avatar-webhook' }],
          });
        }
        if (name === 'StartQueryCommand') {
          return Promise.resolve({ queryId: 'q1' });
        }
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      // First call — cache miss, should call DescribeLogGroups
      await queryAvatarLogs(avatarId, {}, mockDeps);
      expect(describeCallCount).toBe(1);

      // Second call — cache hit, should NOT call DescribeLogGroups again
      await queryAvatarLogs(avatarId, {}, mockDeps);
      expect(describeCallCount).toBe(1);
    });

    it('uses separate cache entries for different avatarIds', async () => {
      let describeCallCount = 0;
      mockDeps.mockSend.mockImplementation((cmd: { constructor: { name: string }; input?: { logGroupNamePrefix?: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'DescribeLogGroupsCommand') {
          describeCallCount++;
          const prefix = cmd.input?.logGroupNamePrefix || '';
          return Promise.resolve({
            logGroups: [{ logGroupName: `${prefix}webhook` }],
          });
        }
        if (name === 'StartQueryCommand') {
          return Promise.resolve({ queryId: 'q1' });
        }
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      await queryAvatarLogs('avatar-a', {}, mockDeps);
      expect(describeCallCount).toBe(1);

      await queryAvatarLogs('avatar-b', {}, mockDeps);
      expect(describeCallCount).toBe(2);

      // Repeated calls should still be cached
      await queryAvatarLogs('avatar-a', {}, mockDeps);
      await queryAvatarLogs('avatar-b', {}, mockDeps);
      expect(describeCallCount).toBe(2);

      expect(getLogGroupCacheSize()).toBe(2);
    });

    it('refreshes cache after TTL expires', async () => {
      // Use a very short TTL for testing
      const shortTtlDeps = createMockDeps({ cacheTtlMs: 50 });
      let describeCallCount = 0;

      shortTtlDeps.mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'DescribeLogGroupsCommand') {
          describeCallCount++;
          return Promise.resolve({
            logGroups: [{ logGroupName: '/aws/lambda/test-avatar-webhook' }],
          });
        }
        if (name === 'StartQueryCommand') {
          return Promise.resolve({ queryId: 'q1' });
        }
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      // First call — populates cache
      await queryAvatarLogs(avatarId, {}, shortTtlDeps);
      expect(describeCallCount).toBe(1);

      // Immediate second call — cache hit
      await queryAvatarLogs(avatarId, {}, shortTtlDeps);
      expect(describeCallCount).toBe(1);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Third call — cache expired, should re-discover
      await queryAvatarLogs(avatarId, {}, shortTtlDeps);
      expect(describeCallCount).toBe(2);
    });

    it('skips cache when cacheTtlMs is 0', async () => {
      const noCacheDeps = createMockDeps({ cacheTtlMs: 0 });
      let describeCallCount = 0;

      noCacheDeps.mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'DescribeLogGroupsCommand') {
          describeCallCount++;
          return Promise.resolve({
            logGroups: [{ logGroupName: '/aws/lambda/test-avatar-webhook' }],
          });
        }
        if (name === 'StartQueryCommand') {
          return Promise.resolve({ queryId: 'q1' });
        }
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      await queryAvatarLogs(avatarId, {}, noCacheDeps);
      await queryAvatarLogs(avatarId, {}, noCacheDeps);

      // Should call DescribeLogGroups every time when cache is disabled
      expect(describeCallCount).toBe(2);
    });

    it('clearLogGroupCache() clears all entries', async () => {
      mockDeps.mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'DescribeLogGroupsCommand') {
          return Promise.resolve({
            logGroups: [{ logGroupName: 'g1' }],
          });
        }
        if (name === 'StartQueryCommand') {
          return Promise.resolve({ queryId: 'q1' });
        }
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      await queryAvatarLogs('avatar-a', {}, mockDeps);
      await queryAvatarLogs('avatar-b', {}, mockDeps);
      expect(getLogGroupCacheSize()).toBe(2);

      clearLogGroupCache();
      expect(getLogGroupCacheSize()).toBe(0);
    });

    it('clearLogGroupCache(avatarId) clears only that entry', async () => {
      mockDeps.mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'DescribeLogGroupsCommand') {
          return Promise.resolve({
            logGroups: [{ logGroupName: 'g1' }],
          });
        }
        if (name === 'StartQueryCommand') {
          return Promise.resolve({ queryId: 'q1' });
        }
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      await queryAvatarLogs('avatar-a', {}, mockDeps);
      await queryAvatarLogs('avatar-b', {}, mockDeps);
      expect(getLogGroupCacheSize()).toBe(2);

      clearLogGroupCache('avatar-a');
      expect(getLogGroupCacheSize()).toBe(1);
    });

    it('cache includes admin log groups and prefix-discovered groups', async () => {
      const depsWithAdmin = createMockDeps({
        adminLogGroups: ['/aws/lambda/admin-handler'],
        adminLogGroupPrefixes: ['/aws/lambda/shared-'],
      });

      let describeCallCount = 0;
      depsWithAdmin.mockSend.mockImplementation((cmd: { constructor: { name: string }; input?: { logGroupNamePrefix?: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'DescribeLogGroupsCommand') {
          describeCallCount++;
          const prefix = cmd.input?.logGroupNamePrefix || '';
          if (prefix.includes('shared-')) {
            return Promise.resolve({
              logGroups: [{ logGroupName: '/aws/lambda/shared-logs' }],
            });
          }
          return Promise.resolve({
            logGroups: [{ logGroupName: `${prefix}webhook` }],
          });
        }
        if (name === 'StartQueryCommand') {
          return Promise.resolve({ queryId: 'q1' });
        }
        return Promise.resolve({ status: 'Complete', results: [] });
      });

      // First call discovers avatar groups + admin prefix groups
      const result1 = await queryAvatarLogs(avatarId, {}, depsWithAdmin);
      expect(describeCallCount).toBe(2); // avatar prefix + admin prefix
      expect(result1.logGroups).toContain('/aws/lambda/admin-handler');
      expect(result1.logGroups).toContain('/aws/lambda/shared-logs');

      // Second call uses cache — no additional DescribeLogGroups calls
      const result2 = await queryAvatarLogs(avatarId, {}, depsWithAdmin);
      expect(describeCallCount).toBe(2); // unchanged
      expect(result2.logGroups).toEqual(result1.logGroups);
    });
  });
});
