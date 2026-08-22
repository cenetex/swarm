import type { HttpRequest } from "@swarm/core";
import { RequestValidationError } from '../middleware/validate.js';

interface ParseJsonBodyOptions {
  requireBody?: boolean;
}

/**
 * Parse request JSON body and throw RequestValidationError for malformed JSON.
 * This keeps invalid-body handling consistent (HTTP 400) across handlers.
 */
export function parseJsonBody<T = Record<string, unknown>>(
  event: Pick<HttpRequest, 'body'>,
  options: ParseJsonBodyOptions = {}
): T {
  const raw = event.body;

  if (raw === undefined || raw === null || raw === '') {
    if (options.requireBody) {
      throw new RequestValidationError('Request body required');
    }
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new RequestValidationError('Invalid JSON body', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
