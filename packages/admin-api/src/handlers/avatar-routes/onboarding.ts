import type {
  HttpRequest,
  HttpResponse,
} from "@swarm/core";
import {
  executeOnboardingStep,
  getOnboardingStatus,
  restartOnboarding,
  skipOptionalOnboardingStep,
} from '../../services/onboarding/index.js';

export interface HandleOnboardingAvatarRoutesParams {
  event: HttpRequest;
  method: string;
  path: string;
  corsHeaders: Record<string, string>;
  effectiveIsAdmin: boolean;
  walletAddress: string | null;
}

function jsonResponse(
  corsHeaders: Record<string, string>,
  statusCode: number,
  body: unknown
): HttpResponse {
  return {
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getHeaderValue(event: HttpRequest, headerName: string): string | null {
  const headers = event.headers || {};
  const target = headerName.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value !== 'string') return null;
    return value;
  }

  return null;
}

export async function handleOnboardingAvatarRoutes(
  params: HandleOnboardingAvatarRoutesParams
): Promise<HttpResponse | null> {
  const { event, method, path, corsHeaders, effectiveIsAdmin, walletAddress } = params;
  const requestId = event.requestContext.requestId || 'unknown-request';

  const statusMatch = path.match(/^\/onboarding\/([^/]+)$/);
  if (method === 'GET' && statusMatch) {
    const avatarId = decodePathPart(statusMatch[1]);
    const result = await getOnboardingStatus({
      avatarId,
      requestId,
      method,
      path,
      effectiveIsAdmin,
      walletAddress,
    });

    return jsonResponse(corsHeaders, result.statusCode, result.envelope);
  }

  const executeMatch = path.match(/^\/onboarding\/([^/]+)\/steps\/([^/]+)\/execute$/);
  if (method === 'POST' && executeMatch) {
    const avatarId = decodePathPart(executeMatch[1]);
    const stepId = decodePathPart(executeMatch[2]);
    const idempotencyKey = getHeaderValue(event, 'Idempotency-Key');

    const result = await executeOnboardingStep({
      avatarId,
      stepId,
      requestId,
      method,
      path,
      effectiveIsAdmin,
      walletAddress,
      idempotencyKey,
      rawBody: event.body ?? undefined,
    });

    return jsonResponse(corsHeaders, result.statusCode, result.envelope);
  }

  const restartMatch = path.match(/^\/onboarding\/([^/]+)\/restart$/);
  if (method === 'POST' && restartMatch) {
    const avatarId = decodePathPart(restartMatch[1]);
    const idempotencyKey = getHeaderValue(event, 'Idempotency-Key');

    const result = await restartOnboarding({
      avatarId,
      stepId: null,
      requestId,
      method,
      path,
      effectiveIsAdmin,
      walletAddress,
      idempotencyKey,
      rawBody: event.body ?? undefined,
    });

    return jsonResponse(corsHeaders, result.statusCode, result.envelope);
  }

  const skipMatch = path.match(/^\/onboarding\/([^/]+)\/steps\/([^/]+)\/skip-optional$/);
  if (method === 'POST' && skipMatch) {
    const avatarId = decodePathPart(skipMatch[1]);
    const stepId = decodePathPart(skipMatch[2]);
    const idempotencyKey = getHeaderValue(event, 'Idempotency-Key');

    const result = await skipOptionalOnboardingStep({
      avatarId,
      stepId,
      requestId,
      method,
      path,
      effectiveIsAdmin,
      walletAddress,
      idempotencyKey,
      rawBody: event.body ?? undefined,
    });

    return jsonResponse(corsHeaders, result.statusCode, result.envelope);
  }

  return null;
}
