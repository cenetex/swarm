import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from 'aws-lambda';

let statusResponse: { statusCode: number; envelope: Record<string, unknown> };
let executeResponse: { statusCode: number; envelope: Record<string, unknown> };
let restartResponse: { statusCode: number; envelope: Record<string, unknown> };
let skipResponse: { statusCode: number; envelope: Record<string, unknown> };

let statusRequest: Record<string, unknown> | null = null;
let executeRequest: Record<string, unknown> | null = null;
let restartRequest: Record<string, unknown> | null = null;
let skipRequest: Record<string, unknown> | null = null;

vi.mock('../../services/onboarding/index.js', () => ({
  getOnboardingStatus: async (request: Record<string, unknown>) => {
    statusRequest = request;
    return statusResponse;
  },
  executeOnboardingStep: async (request: Record<string, unknown>) => {
    executeRequest = request;
    return executeResponse;
  },
  restartOnboarding: async (request: Record<string, unknown>) => {
    restartRequest = request;
    return restartResponse;
  },
  skipOptionalOnboardingStep: async (request: Record<string, unknown>) => {
    skipRequest = request;
    return skipResponse;
  },
}));

import { handleOnboardingAvatarRoutes } from './onboarding.js';

function makeEvent(method: string, path: string, headers?: Record<string, string>): HttpRequest {
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: headers ?? {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.test.com',
      domainPrefix: 'api',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
    body: undefined,
  } as unknown as HttpRequest;
}

function parseBody(result: { body?: string }): unknown {
  return result.body ? JSON.parse(result.body) : undefined;
}

beforeEach(() => {
  statusRequest = null;
  executeRequest = null;
  restartRequest = null;
  skipRequest = null;

  statusResponse = {
    statusCode: 200,
    envelope: {
      contractVersion: 'onboarding_contract_v1',
      avatarId: 'avatar-1',
      onboarding: { state: 'not_started', steps: [], allowedActions: [] },
    },
  };
  executeResponse = { ...statusResponse };
  restartResponse = { ...statusResponse };
  skipResponse = { ...statusResponse };
});

describe('onboarding avatar routes', () => {
  it('GET /onboarding/{avatarId} returns canonical onboarding status', async () => {
    const result = await handleOnboardingAvatarRoutes({
      event: makeEvent('GET', '/onboarding/avatar-1'),
      method: 'GET',
      path: '/onboarding/avatar-1',
      corsHeaders: { 'Access-Control-Allow-Origin': '*' },
      effectiveIsAdmin: true,
      walletAddress: null,
    });

    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    expect((statusRequest as { avatarId: string }).avatarId).toBe('avatar-1');
    expect(parseBody(result!) as Record<string, unknown>).toEqual(statusResponse.envelope);
  });

  it('POST /onboarding/{avatarId}/steps/{stepId}/execute forwards idempotency key', async () => {
    const event = makeEvent(
      'POST',
      '/onboarding/avatar-1/steps/connect_wallet/execute',
      { 'idempotency-key': 'idem-execute-1' }
    );

    const result = await handleOnboardingAvatarRoutes({
      event,
      method: 'POST',
      path: '/onboarding/avatar-1/steps/connect_wallet/execute',
      corsHeaders: { 'Access-Control-Allow-Origin': '*' },
      effectiveIsAdmin: true,
      walletAddress: null,
    });

    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    expect((executeRequest as { stepId: string }).stepId).toBe('connect_wallet');
    expect((executeRequest as { idempotencyKey: string }).idempotencyKey).toBe('idem-execute-1');
  });

  it('POST /onboarding/{avatarId}/restart forwards idempotency key', async () => {
    const event = makeEvent('POST', '/onboarding/avatar-1/restart', { 'Idempotency-Key': 'idem-restart-1' });
    const result = await handleOnboardingAvatarRoutes({
      event,
      method: 'POST',
      path: '/onboarding/avatar-1/restart',
      corsHeaders: { 'Access-Control-Allow-Origin': '*' },
      effectiveIsAdmin: true,
      walletAddress: null,
    });

    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    expect((restartRequest as { idempotencyKey: string }).idempotencyKey).toBe('idem-restart-1');
  });

  it('POST /onboarding/{avatarId}/steps/{stepId}/skip-optional handles optional skip', async () => {
    const event = makeEvent(
      'POST',
      '/onboarding/avatar-1/steps/connect_discord/skip-optional',
      { 'Idempotency-Key': 'idem-skip-1' }
    );
    const result = await handleOnboardingAvatarRoutes({
      event,
      method: 'POST',
      path: '/onboarding/avatar-1/steps/connect_discord/skip-optional',
      corsHeaders: { 'Access-Control-Allow-Origin': '*' },
      effectiveIsAdmin: true,
      walletAddress: null,
    });

    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    expect((skipRequest as { stepId: string }).stepId).toBe('connect_discord');
    expect((skipRequest as { idempotencyKey: string }).idempotencyKey).toBe('idem-skip-1');
  });

  it('returns null for unmatched routes', async () => {
    const result = await handleOnboardingAvatarRoutes({
      event: makeEvent('GET', '/onboarding/avatar-1/unknown'),
      method: 'GET',
      path: '/onboarding/avatar-1/unknown',
      corsHeaders: { 'Access-Control-Allow-Origin': '*' },
      effectiveIsAdmin: true,
      walletAddress: null,
    });
    expect(result).toBeNull();
  });
});

