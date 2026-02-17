/**
 * Structured Metrics Emission Utilities
 *
 * Emits metrics in CloudWatch Embedded Metric Format (EMF) so they appear
 * as both queryable log entries AND as CloudWatch custom metrics — without
 * needing a PutMetricData API call.
 *
 * Usage:
 *   const m = createMetricsLogger('MessageProcessor');
 *   m.trackDuration('ProcessingLatency', startTime);
 *   m.incrementCounter('MessagesProcessed');
 *   m.flush();
 *
 * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
 */

const METRIC_NAMESPACE = 'Swarm';

export type MetricUnit =
  | 'Milliseconds'
  | 'Seconds'
  | 'Count'
  | 'Bytes'
  | 'None';

export interface MetricDatum {
  name: string;
  value: number;
  unit: MetricUnit;
}

export interface MetricsLoggerOptions {
  /** CloudWatch metric namespace. Defaults to 'Swarm'. */
  namespace?: string;
  /** Static dimensions applied to every metric in this logger instance. */
  dimensions?: Record<string, string>;
}

/**
 * Lightweight EMF metrics logger.
 *
 * Accumulates metric values during a handler invocation and emits a single
 * EMF-formatted log line on `flush()`.
 */
export class MetricsLogger {
  private readonly namespace: string;
  private readonly dimensions: Record<string, string>;
  private readonly metrics: MetricDatum[] = [];
  private readonly properties: Record<string, unknown> = {};

  constructor(subsystem: string, options?: MetricsLoggerOptions) {
    this.namespace = options?.namespace ?? METRIC_NAMESPACE;
    this.dimensions = {
      Subsystem: subsystem,
      ...(options?.dimensions ?? {}),
    };
  }

  /**
   * Record an arbitrary metric value.
   */
  putMetric(name: string, value: number, unit: MetricUnit = 'None'): void {
    this.metrics.push({ name, value, unit });
  }

  /**
   * Record a duration metric from a start timestamp (ms since epoch).
   */
  trackDuration(name: string, startTimeMs: number): void {
    this.putMetric(name, Date.now() - startTimeMs, 'Milliseconds');
  }

  /**
   * Convenience: increment a counter by 1 (or a custom amount).
   */
  incrementCounter(name: string, count = 1): void {
    this.putMetric(name, count, 'Count');
  }

  /**
   * Attach a non-metric property to the EMF log line (for filtering/searching).
   */
  setProperty(key: string, value: unknown): void {
    this.properties[key] = value;
  }

  /**
   * Emit the accumulated metrics as a single EMF-formatted log line.
   * Safe to call even when no metrics have been recorded (no-op).
   */
  flush(): void {
    if (this.metrics.length === 0) return;

    const metricDefinitions = this.metrics.map((m) => ({
      Name: m.name,
      Unit: m.unit,
    }));

    // Build the EMF envelope
    const emf: Record<string, unknown> = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: this.namespace,
            Dimensions: [Object.keys(this.dimensions)],
            Metrics: metricDefinitions,
          },
        ],
      },
      // Dimension values
      ...this.dimensions,
      // Metric values
      ...Object.fromEntries(this.metrics.map((m) => [m.name, m.value])),
      // Extra properties for search/filter
      ...this.properties,
    };

    // EMF requires the line to be valid JSON on stdout
    console.log(JSON.stringify(emf));

    // Reset for reuse within the same invocation (e.g., batch processing)
    this.metrics.length = 0;
  }
}

/**
 * Factory: create a MetricsLogger scoped to a subsystem.
 *
 * @param subsystem - logical component name (e.g., 'MessageProcessor', 'ResponseSender')
 * @param dimensions - additional static dimensions (e.g., { Environment: 'staging' })
 */
export function createMetricsLogger(
  subsystem: string,
  dimensions?: Record<string, string>,
): MetricsLogger {
  return new MetricsLogger(subsystem, { dimensions });
}

/**
 * Convenience: emit a single one-shot metric without managing a logger.
 */
export function emitMetric(
  subsystem: string,
  name: string,
  value: number,
  unit: MetricUnit = 'None',
  dimensions?: Record<string, string>,
): void {
  const m = createMetricsLogger(subsystem, dimensions);
  m.putMetric(name, value, unit);
  m.flush();
}
