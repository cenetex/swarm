/**
 * Consent Handler
 *
 * API endpoints for recording and querying privacy-policy consent.
 *
 * Routes:
 *   POST /consent  — record consent acceptance (body: { policyVersion })
 *   GET  /consent  — check current consent status (query: ?policyVersion=1.1)
 *   POST /consent/revoke — revoke consent (body: { policyVersion })
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { z } from 'zod';
import { authenticateRequest } from '../auth/request-auth.js';
import { getCorsHeaders } from '../http/cors.js';
import {
  recordConsent,
  getConsentStatus,
  revokeConsent,
} from '../services/consent.js';

// ============================================================================
// Schemas
// ============================================================================

const RecordConsentSchema = z.object({
  policyVersion: z.string().min(1),
});

const RevokeConsentSchema = z.object({
  policyVersion: z.string().min(1),
});

// ============================================================================
// Helpers
// ============================================================================

function normalizePath(rawPath: string): string {
  if (rawPath === '/api') return '/';
  if (rawPath.startsWith('/api/')) return rawPath.slice('/api'.length);
  return rawPath;
}

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function readBody(event: APIGatewayProxyEventV2): string {
  const body = event.body || '';
  if (!body) return '';
  if (event.isBase64Encoded) {
    return Buffer.from(body, 'base64').toString('utf8');
  }
  return body;
}

function safeParseJson(raw: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(raw || '{}') };
  } catch {
    return { ok: false };
  }
}

// ============================================================================
// Route handlers
// ============================================================================

async function handleRecordConsent(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const session = await authenticateRequest(event);

  const rawBody = readBody(event);
  const jsonResult = safeParseJson(rawBody);
  if (!jsonResult.ok) {
    return jsonResponse(400, { error: 'Invalid JSON in request body' }, corsHeaders);
  }

  const parsed = RecordConsentSchema.safeParse(jsonResult.data);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, corsHeaders);
  }

  const record = await recordConsent({
    userId: session.userId,
    policyVersion: parsed.data.policyVersion,
  });

  return jsonResponse(200, {
    consent: {
      policyVersion: record.policyVersion,
      acceptedAt: record.acceptedAt,
      status: record.status,
    },
  }, corsHeaders);
}

async function handleGetConsent(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const session = await authenticateRequest(event);

  const policyVersion = event.queryStringParameters?.policyVersion;
  if (!policyVersion) {
    return jsonResponse(400, { error: 'Missing required query parameter: policyVersion' }, corsHeaders);
  }

  const record = await getConsentStatus({
    userId: session.userId,
    policyVersion,
  });

  if (!record || record.status !== 'active') {
    return jsonResponse(200, { consented: false, consent: null }, corsHeaders);
  }

  return jsonResponse(200, {
    consented: true,
    consent: {
      policyVersion: record.policyVersion,
      acceptedAt: record.acceptedAt,
      status: record.status,
    },
  }, corsHeaders);
}

async function handleRevokeConsent(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>,
): Promise<APIGatewayProxyResultV2> {
  const session = await authenticateRequest(event);

  const rawBody = readBody(event);
  const jsonResult = safeParseJson(rawBody);
  if (!jsonResult.ok) {
    return jsonResponse(400, { error: 'Invalid JSON in request body' }, corsHeaders);
  }

  const parsed = RevokeConsentSchema.safeParse(jsonResult.data);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'Invalid request', details: parsed.error.issues }, corsHeaders);
  }

  const revoked = await revokeConsent({
    userId: session.userId,
    policyVersion: parsed.data.policyVersion,
  });

  if (!revoked) {
    return jsonResponse(404, { error: 'Consent record not found' }, corsHeaders);
  }

  return jsonResponse(200, { revoked: true }, corsHeaders);
}

// ============================================================================
// Main handler
// ============================================================================

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);
  const method = event.requestContext.http.method;
  const path = normalizePath(event.rawPath);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    if (path === '/consent' && method === 'POST') {
      return handleRecordConsent(event, corsHeaders);
    }

    if (path === '/consent' && method === 'GET') {
      return handleGetConsent(event, corsHeaders);
    }

    if (path === '/consent/revoke' && method === 'POST') {
      return handleRevokeConsent(event, corsHeaders);
    }

    return jsonResponse(404, { error: 'Not found' }, corsHeaders);
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const authErr = error as { statusCode: number; message: string };
      return jsonResponse(authErr.statusCode, { error: authErr.message }, corsHeaders);
    }
    // eslint-disable-next-line no-console -- error logging before structured logger is wired
    console.error('[Consent] Handler error:', error instanceof Error ? error.message : String(error));
    return jsonResponse(500, {
      error: 'Internal server error',
    }, corsHeaders);
  }
}
