import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { MetricsLogger, createMetricsLogger, emitMetric } from './metrics.js';

describe('MetricsLogger', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('putMetric', () => {
    it('should accumulate metrics and emit EMF on flush', () => {
      const logger = new MetricsLogger('TestSubsystem');
      logger.putMetric('Latency', 42, 'Milliseconds');
      logger.putMetric('Count', 1, 'Count');
      logger.flush();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);

      expect(emitted._aws).toBeDefined();
      expect(emitted._aws.CloudWatchMetrics).toHaveLength(1);
      expect(emitted._aws.CloudWatchMetrics[0].Namespace).toBe('Swarm');
      expect(emitted._aws.CloudWatchMetrics[0].Metrics).toHaveLength(2);
      expect(emitted.Subsystem).toBe('TestSubsystem');
      expect(emitted.Latency).toBe(42);
      expect(emitted.Count).toBe(1);
    });

    it('should not emit anything when no metrics are recorded', () => {
      const logger = new MetricsLogger('Empty');
      logger.flush();
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('trackDuration', () => {
    it('should record a duration metric from a start time', () => {
      const logger = new MetricsLogger('TimingTest');
      const start = Date.now() - 100; // 100ms ago
      logger.trackDuration('ProcessingTime', start);
      logger.flush();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(emitted.ProcessingTime).toBeGreaterThanOrEqual(90); // Allow for timing variance
      expect(emitted._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Milliseconds');
    });
  });

  describe('incrementCounter', () => {
    it('should default to incrementing by 1', () => {
      const logger = new MetricsLogger('CounterTest');
      logger.incrementCounter('Processed');
      logger.flush();

      const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(emitted.Processed).toBe(1);
      expect(emitted._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Count');
    });

    it('should accept a custom increment', () => {
      const logger = new MetricsLogger('CounterTest');
      logger.incrementCounter('BatchSize', 10);
      logger.flush();

      const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(emitted.BatchSize).toBe(10);
    });
  });

  describe('setProperty', () => {
    it('should include properties in the EMF output', () => {
      const logger = new MetricsLogger('PropTest');
      logger.setProperty('avatarId', 'test-avatar');
      logger.putMetric('Test', 1, 'Count');
      logger.flush();

      const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(emitted.avatarId).toBe('test-avatar');
    });
  });

  describe('dimensions', () => {
    it('should include custom dimensions', () => {
      const logger = new MetricsLogger('DimTest', {
        dimensions: { Environment: 'staging', Platform: 'telegram' },
      });
      logger.putMetric('Test', 1, 'Count');
      logger.flush();

      const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(emitted.Subsystem).toBe('DimTest');
      expect(emitted.Environment).toBe('staging');
      expect(emitted.Platform).toBe('telegram');
      expect(emitted._aws.CloudWatchMetrics[0].Dimensions[0]).toContain('Subsystem');
      expect(emitted._aws.CloudWatchMetrics[0].Dimensions[0]).toContain('Environment');
      expect(emitted._aws.CloudWatchMetrics[0].Dimensions[0]).toContain('Platform');
    });
  });

  describe('flush reset', () => {
    it('should reset metrics after flush for batch reuse', () => {
      const logger = new MetricsLogger('ResetTest');
      logger.putMetric('First', 1, 'Count');
      logger.flush();

      // Second flush should be a no-op
      logger.flush();
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      // New metric after reset
      logger.putMetric('Second', 2, 'Count');
      logger.flush();
      expect(consoleSpy).toHaveBeenCalledTimes(2);

      const secondEmitted = JSON.parse(consoleSpy.mock.calls[1][0] as string);
      expect(secondEmitted.Second).toBe(2);
      expect(secondEmitted.First).toBeUndefined();
    });
  });
});

describe('createMetricsLogger', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should create a logger with the given subsystem', () => {
    const logger = createMetricsLogger('TestFactory');
    logger.putMetric('Test', 1, 'Count');
    logger.flush();

    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(emitted.Subsystem).toBe('TestFactory');
  });

  it('should pass through custom dimensions', () => {
    const logger = createMetricsLogger('TestFactory', { Platform: 'discord' });
    logger.putMetric('Test', 1, 'Count');
    logger.flush();

    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(emitted.Platform).toBe('discord');
  });
});

describe('emitMetric', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should emit a one-shot metric', () => {
    emitMetric('OneShot', 'TestMetric', 42, 'Milliseconds');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(emitted.Subsystem).toBe('OneShot');
    expect(emitted.TestMetric).toBe(42);
    expect(emitted._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Milliseconds');
  });

  it('should accept optional dimensions', () => {
    emitMetric('OneShot', 'TestMetric', 1, 'Count', { AvatarId: 'test-123' });

    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(emitted.AvatarId).toBe('test-123');
  });
});
