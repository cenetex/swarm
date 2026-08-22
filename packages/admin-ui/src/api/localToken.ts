const TOKEN_QUERY_PARAM = 'swarmLocalToken';
const TOKEN_STORAGE_KEY = 'swarm.localApiToken';

function isLocalApiUrl(input: URL): boolean {
  return input.origin === window.location.origin && input.pathname.startsWith('/api');
}

function readLocalApiToken(): string {
  if (typeof window === 'undefined') return '';

  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get(TOKEN_QUERY_PARAM)?.trim() ?? '';
  if (fromQuery) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromQuery);
    url.searchParams.delete(TOKEN_QUERY_PARAM);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return fromQuery;
  }

  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? '';
}

export function installLocalApiTokenFetch(): void {
  if (typeof window === 'undefined') return;
  const token = readLocalApiToken();
  if (!token || (window as typeof window & { __swarmLocalTokenFetch?: boolean }).__swarmLocalTokenFetch) {
    return;
  }

  const originalFetch = window.fetch.bind(window);
  (window as typeof window & { __swarmLocalTokenFetch?: boolean }).__swarmLocalTokenFetch = true;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), window.location.href);
    if (!isLocalApiUrl(url)) {
      return originalFetch(input, init);
    }

    if (request) {
      const headers = new Headers(init?.headers ?? request.headers);
      headers.set('x-swarm-local-token', token);
      return originalFetch(new Request(request, { ...init, headers }));
    }

    const headers = new Headers(init?.headers);
    headers.set('x-swarm-local-token', token);
    return originalFetch(input, { ...init, headers });
  };
}
