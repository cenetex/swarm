import { routeLocalApi, shouldInstallLocalWebApi } from '../local-web-api';
import { getLocalApiToken, isLocalApiUrl } from './localToken';

function toUrl(input: RequestInfo | URL): URL | null {
  if (typeof window === 'undefined') return null;
  if (input instanceof Request) return new URL(input.url, window.location.href);
  return new URL(String(input), window.location.href);
}

function withLocalToken(input: RequestInfo | URL, url: URL, init?: RequestInit): Request {
  const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
  const token = getLocalApiToken();
  if (!token) return request;

  const headers = new Headers(request.headers);
  headers.set('x-swarm-local-token', token);
  return new Request(request, { headers });
}

/**
 * Explicit boundary for calls to Swarm APIs.
 *
 * Browser-local requests are routed to the in-page adapter. Other requests use
 * the browser transport and receive the local server capability token when
 * appropriate. This intentionally does not replace the global fetch function.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = toUrl(input);
  if (url && isLocalApiUrl(url)) {
    const request = withLocalToken(input, url, init);
    if (shouldInstallLocalWebApi()) {
      const localResponse = routeLocalApi(request);
      if (localResponse) return localResponse;
    }
    return fetch(request);
  }

  return fetch(input, init);
}
