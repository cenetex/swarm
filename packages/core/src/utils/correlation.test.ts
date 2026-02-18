import { describe, it, expect } from 'bun:test';
import {
  CORRELATION_ID_ATTR,
  TRACE_ID_ATTR,
  generateCorrelationId,
  generateTraceId,
  extractCorrelationIdFromApiEvent,
  extractTraceIdFromApiEvent,
  extractCorrelationIdFromSqsRecord,
  extractTraceIdFromSqsRecord,
  buildTraceMessageAttributes,
  createTraceContext,
} from './correlation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('correlation', () => {
  describe('CORRELATION_ID_ATTR', () => {
    it('should export the correlation ID attribute name', () => {
      expect(CORRELATION_ID_ATTR).toBe('correlationId');
    });
  });

  describe('TRACE_ID_ATTR', () => {
    it('should export the trace ID attribute name', () => {
      expect(TRACE_ID_ATTR).toBe('traceId');
    });
  });

  describe('generateCorrelationId', () => {
    it('should use requestId when provided', () => {
      const requestId = 'test-request-123';
      expect(generateCorrelationId(requestId)).toBe(requestId);
    });

    it('should generate a new UUID when requestId is not provided', () => {
      const id = generateCorrelationId();
      expect(id).toMatch(UUID_RE);
    });

    it('should generate a new UUID when requestId is undefined', () => {
      const id = generateCorrelationId(undefined);
      expect(id).toMatch(UUID_RE);
    });

    it('should generate different UUIDs on consecutive calls', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateTraceId', () => {
    it('should generate a UUID', () => {
      expect(generateTraceId()).toMatch(UUID_RE);
    });

    it('should generate unique values', () => {
      const a = generateTraceId();
      const b = generateTraceId();
      expect(a).not.toBe(b);
    });
  });

  describe('extractCorrelationIdFromApiEvent', () => {
    it('should extract from x-correlation-id header', () => {
      const event = {
        headers: { 'x-correlation-id': 'header-correlation-123' },
        requestContext: { requestId: 'request-456' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('header-correlation-123');
    });

    it('should handle case-insensitive header names', () => {
      const event = {
        headers: { 'X-Correlation-ID': 'header-correlation-123' },
        requestContext: { requestId: 'request-456' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('header-correlation-123');
    });

    it('should fall back to requestContext.requestId when header is not present', () => {
      const event = {
        headers: {},
        requestContext: { requestId: 'request-789' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('request-789');
    });

    it('should fall back to requestContext.requestId when headers is undefined', () => {
      const event = {
        requestContext: { requestId: 'request-abc' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('request-abc');
    });

    it('should generate a new UUID when neither header nor requestId are present', () => {
      const event = {
        headers: {},
        requestContext: {},
      };
      const id = extractCorrelationIdFromApiEvent(event);
      expect(id).toMatch(UUID_RE);
    });

    it('should generate a new UUID when event is empty', () => {
      const event = {};
      const id = extractCorrelationIdFromApiEvent(event);
      expect(id).toMatch(UUID_RE);
    });

    it('should handle headers with undefined values', () => {
      const event = {
        headers: { 'some-header': undefined, 'x-correlation-id': 'test-123' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('test-123');
    });

    it('should prioritize header over requestId', () => {
      const event = {
        headers: { 'x-correlation-id': 'from-header' },
        requestContext: { requestId: 'from-request-context' },
      };
      expect(extractCorrelationIdFromApiEvent(event)).toBe('from-header');
    });
  });

  describe('extractTraceIdFromApiEvent', () => {
    it('should extract from x-trace-id header', () => {
      const event = { headers: { 'x-trace-id': 'trace-abc' } };
      expect(extractTraceIdFromApiEvent(event)).toBe('trace-abc');
    });

    it('should handle case-insensitive header', () => {
      const event = { headers: { 'X-Trace-ID': 'trace-abc' } };
      expect(extractTraceIdFromApiEvent(event)).toBe('trace-abc');
    });

    it('should generate a UUID when header is missing', () => {
      expect(extractTraceIdFromApiEvent({ headers: {} })).toMatch(UUID_RE);
    });

    it('should generate a UUID when headers is undefined', () => {
      expect(extractTraceIdFromApiEvent({})).toMatch(UUID_RE);
    });
  });

  describe('extractCorrelationIdFromSqsRecord', () => {
    it('should extract from message attributes', () => {
      const record = {
        messageAttributes: {
          correlationId: { stringValue: 'sqs-correlation-123' },
        },
      };
      expect(extractCorrelationIdFromSqsRecord(record)).toBe('sqs-correlation-123');
    });

    it('should generate a new UUID when messageAttributes is undefined', () => {
      const record = {};
      const id = extractCorrelationIdFromSqsRecord(record);
      expect(id).toMatch(UUID_RE);
    });

    it('should generate a new UUID when messageAttributes is empty', () => {
      const record = {
        messageAttributes: {},
      };
      const id = extractCorrelationIdFromSqsRecord(record);
      expect(id).toMatch(UUID_RE);
    });

    it('should generate a new UUID when correlationId attribute is missing', () => {
      const record = {
        messageAttributes: {
          otherAttribute: { stringValue: 'other-value' },
        },
      };
      const id = extractCorrelationIdFromSqsRecord(record);
      expect(id).toMatch(UUID_RE);
    });

    it('should generate a new UUID when stringValue is undefined', () => {
      const record = {
        messageAttributes: {
          correlationId: {},
        },
      };
      const id = extractCorrelationIdFromSqsRecord(record);
      expect(id).toMatch(UUID_RE);
    });
  });

  describe('extractTraceIdFromSqsRecord', () => {
    it('should extract from message attributes', () => {
      const record = {
        messageAttributes: {
          traceId: { stringValue: 'sqs-trace-xyz' },
        },
      };
      expect(extractTraceIdFromSqsRecord(record)).toBe('sqs-trace-xyz');
    });

    it('should generate a new UUID when attribute is missing', () => {
      expect(extractTraceIdFromSqsRecord({})).toMatch(UUID_RE);
    });
  });

  describe('buildTraceMessageAttributes', () => {
    it('should build SQS message attributes with both IDs', () => {
      const attrs = buildTraceMessageAttributes('corr-123', 'trace-456');
      expect(attrs.correlationId).toEqual({
        DataType: 'String',
        StringValue: 'corr-123',
      });
      expect(attrs.traceId).toEqual({
        DataType: 'String',
        StringValue: 'trace-456',
      });
    });
  });

  describe('createTraceContext', () => {
    it('should create context with provided values', () => {
      const ctx = createTraceContext({
        correlationId: 'c-1',
        traceId: 't-1',
        parentSpan: 'p-1',
      });
      expect(ctx.correlationId).toBe('c-1');
      expect(ctx.traceId).toBe('t-1');
      expect(ctx.parentSpan).toBe('p-1');
    });

    it('should generate IDs when not provided', () => {
      const ctx = createTraceContext({});
      expect(ctx.correlationId).toMatch(UUID_RE);
      expect(ctx.traceId).toMatch(UUID_RE);
      expect(ctx.parentSpan).toBeUndefined();
    });
  });
});
