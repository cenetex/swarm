/**
 * Correlation ID utilities for distributed tracing across webhook -> SQS -> handlers.
 *
 * A correlationId ties together all log entries for a single inbound request
 * as it flows from the webhook handler, through SQS, and into downstream
 * processors (message-processor, response-sender, continuation-processor).
 *
 * A traceId groups related operations across multiple requests (e.g., a
 * conversation turn that spawns tool calls, media generation, and responses).
 */
import { randomUUID } from 'crypto';

/**
 * SQS message attribute name used to propagate the correlation ID.
 */
export const CORRELATION_ID_ATTR = 'correlationId';

/**
 * SQS message attribute name used to propagate the trace ID.
 */
export const TRACE_ID_ATTR = 'traceId';

/**
 * Generate a new correlation ID.
 * Uses the API Gateway requestId when available (preserving the original
 * request identity), otherwise falls back to a new UUID.
 */
export function generateCorrelationId(requestId?: string): string {
  return requestId || randomUUID();
}

/**
 * Generate a new trace ID (always a fresh UUID).
 */
export function generateTraceId(): string {
  return randomUUID();
}

/**
 * Extract a correlation ID from an API Gateway v2 event.
 * Checks:
 *   1. `x-correlation-id` header (in case an upstream proxy injected one)
 *   2. `requestContext.requestId` (API Gateway's own request ID)
 *   3. Falls back to generating a new UUID
 */
export function extractCorrelationIdFromApiEvent(event: {
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
}): string {
  const headers = event.headers || {};

  // Normalise header lookup to lowercase
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      lowerHeaders[k.toLowerCase()] = v;
    }
  }

  return (
    lowerHeaders['x-correlation-id'] ||
    event.requestContext?.requestId ||
    randomUUID()
  );
}

/**
 * Extract a trace ID from an API Gateway v2 event.
 * Checks the `x-trace-id` header, then falls back to a new UUID.
 */
export function extractTraceIdFromApiEvent(event: {
  headers?: Record<string, string | undefined>;
}): string {
  const headers = event.headers || {};
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      lowerHeaders[k.toLowerCase()] = v;
    }
  }
  return lowerHeaders['x-trace-id'] || randomUUID();
}

/**
 * Extract a correlation ID from an SQS record's message attributes.
 * Falls back to generating a new UUID if not present.
 */
export function extractCorrelationIdFromSqsRecord(record: {
  messageAttributes?: Record<string, { stringValue?: string }>;
}): string {
  return (
    record.messageAttributes?.[CORRELATION_ID_ATTR]?.stringValue ||
    randomUUID()
  );
}

/**
 * Extract a trace ID from an SQS record's message attributes.
 * Falls back to generating a new UUID if not present.
 */
export function extractTraceIdFromSqsRecord(record: {
  messageAttributes?: Record<string, { stringValue?: string }>;
}): string {
  return (
    record.messageAttributes?.[TRACE_ID_ATTR]?.stringValue ||
    randomUUID()
  );
}

/**
 * Build SQS message attributes for propagating trace context.
 * Returns the attributes dict ready to pass to SendMessageCommand.
 */
export function buildTraceMessageAttributes(
  correlationId: string,
  traceId: string,
): Record<string, { DataType: string; StringValue: string }> {
  return {
    [CORRELATION_ID_ATTR]: { DataType: 'String', StringValue: correlationId },
    [TRACE_ID_ATTR]: { DataType: 'String', StringValue: traceId },
  };
}

/**
 * Immutable trace context object for passing through handler pipelines.
 */
export interface TraceContext {
  readonly correlationId: string;
  readonly traceId: string;
  readonly parentSpan?: string;
}

/**
 * Create a TraceContext from the available identifiers.
 */
export function createTraceContext(opts: {
  correlationId?: string;
  traceId?: string;
  parentSpan?: string;
}): TraceContext {
  return {
    correlationId: opts.correlationId || randomUUID(),
    traceId: opts.traceId || randomUUID(),
    parentSpan: opts.parentSpan,
  };
}
