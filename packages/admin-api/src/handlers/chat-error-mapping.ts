import { isAuthError } from '../auth/errors.js';
import { isRequestValidationError } from '../middleware/validate.js';
import { LlmCreditsExhaustedError } from './chat-llm.js';

export function parseOpenRouterStatusFromError(message: string): number | null {

  const match = message.match(/OpenRouter API error:\s*(\d{3})\b/);
  if (!match) return null;
  const code = Number.parseInt(match[1]!, 10);
  return Number.isFinite(code) ? code : null;
}

export function isTimeoutLikeError(error: unknown): boolean {

  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  // Node 18+ AbortSignal.timeout often throws TimeoutError or AbortError.
  if (name === 'TimeoutError' || name === 'AbortError') return true;

  // Cover common text forms.
  if (lowered.includes('timeout') || lowered.includes('timed out')) return true;
  if (lowered.includes('aborted') && lowered.includes('timeout')) return true;

  return false;
}

export function mapAdminChatHandlerError(error: unknown): {
  statusCode: number;
  publicError: string;
  errorMessage: string;
} {
  if (isRequestValidationError(error)) {
    return {
      statusCode: error.statusCode,
      publicError: error.message,
      errorMessage: error.message,
    };
  }

  if (isAuthError(error)) {
    return {
      statusCode: error.statusCode,
      publicError: error.message,
      errorMessage: error.message,
    };
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const upstreamStatus = parseOpenRouterStatusFromError(errorMessage);
  const isCreditError = error instanceof LlmCreditsExhaustedError;
  const isCircuitOpen = /circuit breaker open/i.test(errorMessage);
  const isTimeout = isTimeoutLikeError(error);

  const statusCode = isTimeout
    ? 504
    : isCreditError || upstreamStatus === 402
      ? 402
      : upstreamStatus === 429
        ? 429
        : isCircuitOpen
          ? 503
          : 500;

  const publicError = statusCode === 402
    ? "Unable to respond — the AI provider's credit balance has been exhausted. Please contact your administrator to add credits."
    : statusCode === 429
      ? 'LLM rate limited'
      : statusCode === 503
        ? 'LLM temporarily unavailable'
        : statusCode === 504
          ? 'Request timed out'
          : 'Internal server error';

  return { statusCode, publicError, errorMessage };
}
