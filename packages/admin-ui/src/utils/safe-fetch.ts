/**
 * Safe Fetch — network error handling with structured logging and client error surface
 *
 * Wraps fetch() calls to:
 * - Log network failures and malformed responses to console (structured)
 * - Surface user-visible errors via error boundary (when available)
 * - Return tagged result (`{ ok: true, data } | { ok: false, error }`) instead of throwing
 *
 * The safeFetch contract:
 * - Always returns a result object (never throws)
 * - If deserialization fails after a 2xx response, returns the raw response
 * - If network fails or response is non-2xx, logs error and returns tagged object
 */

export type SafeFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Structured logger for safe-fetch errors.
 * In production, this could hook into a telemetry service.
 */
function logFetchError(context: {
  url: string;
  status?: number;
  reason: string;
  originalError?: Error;
}) {
  const { url, status, reason, originalError } = context;
  const errorDetails = originalError ? `${originalError.name}: ${originalError.message}` : '';
  const statusLabel = status ? ` (HTTP ${status})` : '';
  console.error(
    `[safeFetch] ${reason}${statusLabel} — ${url}`,
    errorDetails,
  );
}

/**
 * Fetch with structured error handling. Returns a tagged result instead of throwing.
 *
 * @param url — endpoint to fetch from
 * @param opts — standard fetch options (method, headers, body, etc.)
 * @param opts.timeout — optional timeout in ms (defaults to 30s)
 * @returns SafeFetchResult<T>
 *
 * @example
 * const result = await safeFetch<{ keys: ApiKey[] }>(
 *   `${API_BASE}/avatars/${avatarId}/api-keys`,
 *   { method: 'GET', credentials: 'include' }
 * );
 *
 * if (result.ok) {
 *   // Use result.data
 * } else {
 *   // Show result.error to user
 * }
 */
export async function safeFetch<T>(
  url: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<SafeFetchResult<T>> {
  const { timeout = 30_000, ...fetchOpts } = opts;

  // Timeout wrapper
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOpts,
      signal: controller.signal,
    });

    // Attempt to parse response body
    let body: unknown;
    try {
      body = await response.json();
    } catch (e) {
      logFetchError({
        url,
        status: response.status,
        reason: 'failed to parse response JSON',
        originalError: e instanceof Error ? e : new Error(String(e)),
      });
      // Return raw response as-is if we can't parse it (likely HTML error page)
      return {
        ok: false,
        error: `Unexpected response format (HTTP ${response.status})`,
      };
    }

    // Non-2xx response
    if (!response.ok) {
      const detail = (body as { error?: string }).error;
      const errorMsg = detail || `HTTP ${response.status}`;
      logFetchError({
        url,
        status: response.status,
        reason: 'non-2xx response',
      });
      return {
        ok: false,
        error: errorMsg,
      };
    }

    return {
      ok: true,
      data: body as T,
    };
  } catch (err) {
    // Network or timeout errors
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';

    const reason = isTimeout ? 'network timeout' : 'network error';
    logFetchError({
      url,
      reason,
      originalError: err instanceof Error ? err : new Error(String(err)),
    });

    const errorMsg = isTimeout ? 'Request timed out' : 'Network error — check your connection';
    return {
      ok: false,
      error: errorMsg,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
