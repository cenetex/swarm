import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { createConsolidationMetrics } from './memory-consolidation.js';

describe('createConsolidationMetrics', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    process.env.ENVIRONMENT = 'staging';
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    process.env.ENVIRONMENT = originalEnv.ENVIRONMENT;
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  });

  it('should use AwsSwarm/MemoryConsolidation namespace', () => {
    const metrics = createConsolidationMetrics();
    metrics.putMetric('AvatarsDiscovered', 5, 'Count');
    metrics.flush();

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(emitted._aws.CloudWatchMetrics[0].Namespace).toBe('AwsSwarm/MemoryConsolidation');
  });

  it('should include Environment and Subsystem dimensions', () => {
    const metrics = createConsolidationMetrics();
    metrics.putMetric('AvatarsProcessed', 3, 'Count');
    metrics.flush();

    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(emitted.Subsystem).toBe('MemoryConsolidation');
    expect(emitted.Environment).toBe('staging');
    expect(emitted._aws.CloudWatchMetrics[0].Dimensions[0]).toContain('Subsystem');
    expect(emitted._aws.CloudWatchMetrics[0].Dimensions[0]).toContain('Environment');
  });

  it('should fall back to NODE_ENV for Environment dimension', () => {
    delete process.env.ENVIRONMENT;
    process.env.NODE_ENV = 'production';

    const metrics = createConsolidationMetrics();
    metrics.putMetric('AvatarsDiscovered', 1, 'Count');
    metrics.flush();

    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(emitted.Environment).toBe('production');
  });

  it('should emit discovery metric with correct unit', () => {
    const metrics = createConsolidationMetrics();
    metrics.putMetric('AvatarsDiscovered', 10, 'Count');
    metrics.flush();

    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(emitted.AvatarsDiscovered).toBe(10);
    const metricDef = emitted._aws.CloudWatchMetrics[0].Metrics.find(
      (m: { Name: string }) => m.Name === 'AvatarsDiscovered'
    );
    expect(metricDef.Unit).toBe('Count');
  });

  it('should emit batch-completion metrics in a single EMF line', () => {
    const metrics = createConsolidationMetrics();
    metrics.putMetric('AvatarsProcessed', 8, 'Count');
    metrics.putMetric('AvatarsSkipped', 2, 'Count');
    metrics.putMetric('AvatarsFailed', 1, 'Count');
    metrics.putMetric('ConsolidationDurationMs', 4500, 'Milliseconds');
    metrics.setProperty('totalAvatars', 11);
    metrics.setProperty('succeeded', 7);
    metrics.flush();

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);

    expect(emitted.AvatarsProcessed).toBe(8);
    expect(emitted.AvatarsSkipped).toBe(2);
    expect(emitted.AvatarsFailed).toBe(1);
    expect(emitted.ConsolidationDurationMs).toBe(4500);
    expect(emitted.totalAvatars).toBe(11);
    expect(emitted.succeeded).toBe(7);

    const metricNames = emitted._aws.CloudWatchMetrics[0].Metrics.map(
      (m: { Name: string }) => m.Name
    );
    expect(metricNames).toContain('AvatarsProcessed');
    expect(metricNames).toContain('AvatarsSkipped');
    expect(metricNames).toContain('AvatarsFailed');
    expect(metricNames).toContain('ConsolidationDurationMs');

    const durationMetric = emitted._aws.CloudWatchMetrics[0].Metrics.find(
      (m: { Name: string }) => m.Name === 'ConsolidationDurationMs'
    );
    expect(durationMetric.Unit).toBe('Milliseconds');
  });

  it('should not use avatarId as a dimension (low cardinality only)', () => {
    const metrics = createConsolidationMetrics();
    metrics.putMetric('AvatarsProcessed', 1, 'Count');
    metrics.flush();

    const emitted = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    const dimensionKeys = emitted._aws.CloudWatchMetrics[0].Dimensions[0];
    expect(dimensionKeys).not.toContain('avatarId');
    expect(dimensionKeys).not.toContain('AvatarId');
  });

  it('should reset after flush for separate discovery and completion emissions', () => {
    const metrics = createConsolidationMetrics();

    // Discovery emission
    metrics.putMetric('AvatarsDiscovered', 5, 'Count');
    metrics.flush();

    // Completion emission
    metrics.putMetric('AvatarsProcessed', 3, 'Count');
    metrics.putMetric('AvatarsFailed', 0, 'Count');
    metrics.flush();

    expect(consoleSpy).toHaveBeenCalledTimes(2);

    const discovery = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(discovery.AvatarsDiscovered).toBe(5);
    expect(discovery.AvatarsProcessed).toBeUndefined();

    const completion = JSON.parse(consoleSpy.mock.calls[1][0] as string);
    expect(completion.AvatarsProcessed).toBe(3);
    expect(completion.AvatarsDiscovered).toBeUndefined();
  });
});
