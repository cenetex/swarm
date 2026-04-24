/**
 * Anomaly Detector Tests
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import * as anomalyDetector from './anomaly-detector.js';

// Mock dynamo client
mock.module('./dynamo-client.js', () => ({
  getDynamoClient: () => mockDynamoClient,
}));

// Mock logger
mock.module('@swarm/core', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const mockDynamoClient = {
  send: mock(async () => ({ Item: { messages: [] } })),
};

describe('anomaly-detector', () => {
  beforeEach(() => {
    mockDynamoClient.send.mock.calls.length = 0;
  });

  it('initializes with empty message history', async () => {
    mockDynamoClient.send.mock.implementation(async () => ({
      Item: { messages: [] },
    }));

    const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1', 'hello');
    expect(result.paused).toBe(false);
    expect(result.metrics.messageCount).toBe(1);
    expect(result.metrics.duplicateCount).toBe(1);
  });

  it('pauses on message rate threshold', async () => {
    const messages = Array.from({ length: 11 }, (_, i) => ({
      timestamp: Date.now() - (i * 1000),
      hash: 'hash' + i,
    }));

    mockDynamoClient.send.mock.implementation(async (command: any) => {
      if (command.constructor.name === 'GetCommand') {
        return { Item: { messages } };
      }
      return {};
    });

    const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1', 'hello');
    expect(result.paused).toBe(true);
    expect(result.metrics.messageCount).toBe(12);
    expect(result.reason).toContain('Too many messages');
  });

  it('triggers warning at threshold 8', async () => {
    const messages = Array.from({ length: 7 }, (_, i) => ({
      timestamp: Date.now() - (i * 1000),
      hash: 'hash' + i,
    }));

    mockDynamoClient.send.mock.implementation(async (command: any) => {
      if (command.constructor.name === 'GetCommand') {
        return { Item: { messages } };
      }
      return {};
    });

    const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1', 'hello');
    expect(result.paused).toBe(false);
    expect(result.metrics.messageCount).toBe(8);
  });

  it('fails open on error', async () => {
    mockDynamoClient.send.mock.implementation(async () => {
      throw new Error('DynamoDB error');
    });

    const result = await anomalyDetector.shouldPauseAvatar('avatar1', 'channel1', 'hello');
    expect(result.paused).toBe(false);
    expect(result.metrics.messageCount).toBe(0);
  });

  it('resets anomaly state', async () => {
    mockDynamoClient.send.mock.implementation(async () => ({}));

    await anomalyDetector.resetAnomalyState('avatar1', 'channel1');
    expect(mockDynamoClient.send.mock.calls.length).toBeGreaterThan(0);
  });
});
