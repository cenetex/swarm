import { describe, it, expect } from 'bun:test';
import type { HttpRequest } from 'aws-lambda';

import { authenticateRequest } from './request-auth.js';

function makeEvent(partial: Partial<HttpRequest>): HttpRequest {
  return {
    version: '2.0',
    routeKey: 'GET /test',
    rawPath: '/test',
    rawQueryString: '',
    headers: {},
    requestContext: {} as HttpRequest['requestContext'],
    isBase64Encoded: false,
    ...partial,
  } as HttpRequest;
}

describe('request auth', () => {
  it('does not allow origin/referer fallback when no token is provided', async () => {
    const event = makeEvent({
      headers: {
        origin: 'https://swarm.rati.chat',
        referer: 'https://swarm.rati.chat/',
      },
    });

    await expect(authenticateRequest(event)).rejects.toThrow('No authentication token provided');
  });

  it('allows INTERNAL_TEST_KEY bypass (for local/internal testing)', async () => {
    const prevInternalTestKey = process.env.INTERNAL_TEST_KEY;
    const prevEnvironment = process.env.ENVIRONMENT;
    try {
      process.env.INTERNAL_TEST_KEY = 'test-key';
      process.env.ENVIRONMENT = 'staging';

      const event = makeEvent({
        headers: {
          'x-internal-test-key': 'test-key',
        },
      });

      const session = await authenticateRequest(event);
      expect(session.isAdmin).toBe(true);
      expect(session.userId).toBe('internal-test-user');
    } finally {
      process.env.INTERNAL_TEST_KEY = prevInternalTestKey;
      process.env.ENVIRONMENT = prevEnvironment;
    }
  });
});
