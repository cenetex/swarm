/**
 * Raticross Health Check Handler
 *
 * Responds to health probes from peer bridge systems.
 * Also supports GET for simple liveness checks.
 */
import type { HttpRequest, HttpResponse } from "@swarm/core";
import {
  RATICROSS_PROTOCOL_VERSION,
  logger,
  type RaticrossHealthResponse,
} from '@swarm/core';

const RATICROSS_INBOUND_KEY = process.env.RATICROSS_INBOUND_KEY;
const START_TIME = Date.now();

function json(statusCode: number, body: unknown): HttpResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(event: HttpRequest): Promise<HttpResponse> {
  logger.setContext({ subsystem: 'raticross-health' });

  // Auth check (same key as inbound relay)
  if (RATICROSS_INBOUND_KEY) {
    const providedKey = event.headers?.['x-raticross-key'];
    if (providedKey !== RATICROSS_INBOUND_KEY) {
      return json(401, { error: 'Unauthorized' });
    }
  }

  const response: RaticrossHealthResponse = {
    ok: true,
    system: 'swarm',
    protocol: RATICROSS_PROTOCOL_VERSION,
    timestamp: Date.now(),
    uptime: Date.now() - START_TIME,
  };

  logger.info('Raticross health check responded', {
    event: 'health_check_ok',
    subsystem: 'raticross-health',
  });

  return json(200, response);
}
