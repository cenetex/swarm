import { describe, expect, it } from 'vitest';
import type { HttpRequest } from 'aws-lambda';
import { resolvePublicAvatarIdFromRequest } from './chat-public-access.js';

function makeEvent(headers: Record<string, string>): HttpRequest {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/chat',
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api-id.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'api-id',
      http: {
        method: 'POST',
        path: '/chat',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-id',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
    },
    isBase64Encoded: false,
  } as HttpRequest;
}

describe('resolvePublicAvatarIdFromRequest', () => {
  it('extracts avatar id from public subdomain origin', () => {
    const avatarId = resolvePublicAvatarIdFromRequest(makeEvent({
      origin: 'https://my-agent.rati.chat',
    }));

    expect(avatarId).toBe('my-agent');
  });

  it('rejects reserved subdomains', () => {
    const avatarId = resolvePublicAvatarIdFromRequest(makeEvent({
      origin: 'https://swarm.rati.chat',
    }));

    expect(avatarId).toBeNull();
  });

  it('prefers browser origin over untrusted forwarded host', () => {
    const avatarId = resolvePublicAvatarIdFromRequest(makeEvent({
      origin: 'https://safe-agent.rati.chat',
      'x-forwarded-host': 'malicious-agent.rati.chat',
    }));

    expect(avatarId).toBe('safe-agent');
  });

  it('returns null when no public host signal is present', () => {
    const avatarId = resolvePublicAvatarIdFromRequest(makeEvent({
      host: 'api-id.execute-api.us-east-1.amazonaws.com',
    }));

    expect(avatarId).toBeNull();
  });
});
