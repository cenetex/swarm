import { RATICROSS_PROTOCOL_VERSION } from '@swarm/core';
/**
 * Raticross Health Check Handler Tests
 */
import { describe, it, expect } from 'bun:test';
import type { HttpRequest } from 'aws-lambda';

// Set env before importing handler
process.env.RATICROSS_INBOUND_KEY = 'test-health-key';

// Dynamic import to pick up env
const { handler } = await import('./raticross-health.js');

function makeEvent(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    version: '2.0',
    routeKey: 'POST /raticross/health',
    rawPath: '/raticross/health',
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      'x-raticross-key': 'test-health-key',
      ...overrides.headers,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/raticross/health',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'POST /raticross/health',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: overrides.body ?? JSON.stringify({
      type: 'health',
      timestamp: Date.now(),
      from: { system: 'kyro', agentId: 'probe' },
      protocol: RATICROSS_PROTOCOL_VERSION,
    }),
    isBase64Encoded: false,
    ...overrides,
  };
}

describe('raticross-health handler', () => {
  it('returns 200 with health response for valid request', async () => {
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.ok).toBe(true);
    expect(body.system).toBe('swarm');
    expect(body.protocol).toBe(RATICROSS_PROTOCOL_VERSION);
    expect(typeof body.timestamp).toBe('number');
    expect(typeof body.uptime).toBe('number');
  });

  it('returns 401 when auth key is missing', async () => {
    const result = await handler(makeEvent({
      headers: { 'content-type': 'application/json' },
    }));

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 when auth key is wrong', async () => {
    const result = await handler(makeEvent({
      headers: { 'content-type': 'application/json', 'x-raticross-key': 'wrong-key' },
    }));

    expect(result.statusCode).toBe(401);
  });
});
