const TOKEN_QUERY_PARAM = 'swarmLocalToken';
const TOKEN_STORAGE_KEY = 'swarm.localApiToken';
let cachedToken: string | null = null;

export function isLocalApiUrl(input: URL): boolean {
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

export function initializeLocalApiToken(): void {
  if (typeof window === 'undefined') return;
  cachedToken = readLocalApiToken();
}

export function getLocalApiToken(): string {
  if (typeof window === 'undefined') return '';
  if (cachedToken === null) cachedToken = readLocalApiToken();
  return cachedToken;
}
