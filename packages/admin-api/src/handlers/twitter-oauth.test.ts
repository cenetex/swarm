/**
 * Twitter OAuth Handler Tests
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock services
vi.mock('../services/twitter-oauth.js', () => ({
  isConfigured: vi.fn(),
  startOAuthFlow: vi.fn(),
  completeOAuthFlow: vi.fn(),
  getConnectionStatus: vi.fn(),
  disconnectTwitter: vi.fn(),
}));

vi.mock('../services/agents.js', () => ({
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock('../auth/cloudflare-access.js', () => ({
  authenticateRequest: vi.fn(),
  requireAdmin: vi.fn(),
}));

const mocked = <T>(value: T) => (typeof (vi as any).mocked === 'function' ? (vi as any).mocked(value) : value as any);

let handler: typeof import('./twitter-oauth.js').handler;
let twitterOAuth: typeof import('../services/twitter-oauth.js');
let agentService: typeof import('../services/agents.js');
let authenticateRequest: typeof import('../auth/cloudflare-access.js').authenticateRequest;
let requireAdmin: typeof import('../auth/cloudflare-access.js').requireAdmin;

beforeAll(async () => {
  twitterOAuth = await import('../services/twitter-oauth.js');
  agentService = await import('../services/agents.js');
  ({ authenticateRequest, requireAdmin } = await import('../auth/cloudflare-access.js'));
  ({ handler } = await import('./twitter-oauth.js'));
});

function buildEvent(method: string, path: string, queryParams: any = {}, body: any = null): any {
  return {
    requestContext: { http: { method } },
    rawPath: path,
    queryStringParameters: queryParams,
    body: body ? JSON.stringify(body) : null,
    headers: { origin: 'http://localhost:5173' }
  };
}

describe('Twitter OAuth Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked(authenticateRequest).mockResolvedValue({ email: 'admin@example.com' } as any);
    mocked(requireAdmin).mockReturnValue(true);
  });

  describe('Start Flow', () => {
    it('returns 400 when agentId query param is missing', async () => {
      const event = buildEvent('GET', '/oauth/twitter/start');
      const result = await handler(event) as any;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).error).toContain('agentId');
    });

    it('returns 404 when agent does not exist', async () => {
      mocked(agentService.getAgent).mockResolvedValue(null);
      const event = buildEvent('GET', '/oauth/twitter/start', { agentId: 'missing' });
      const result = await handler(event) as any;
      expect(result.statusCode).toBe(404);
    });

    it('returns 503 when Twitter OAuth is not configured', async () => {
      mocked(agentService.getAgent).mockResolvedValue({ agentId: 'a1' } as any);
      mocked(twitterOAuth.isConfigured).mockResolvedValue(false);
      
      const event = buildEvent('GET', '/oauth/twitter/start', { agentId: 'a1' });
      const result = await handler(event) as any;
      expect(result.statusCode).toBe(503);
    });

    it('returns authorizationUrl when configured', async () => {
      mocked(agentService.getAgent).mockResolvedValue({ agentId: 'a1' } as any);
      mocked(twitterOAuth.isConfigured).mockResolvedValue(true);
      mocked(twitterOAuth.startOAuthFlow).mockResolvedValue({ authorizationUrl: 'https://twitter.com/auth' } as any);

      const event = buildEvent('GET', '/oauth/twitter/start', { agentId: 'a1' });
      const result = await handler(event) as any;
      
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string).authorizationUrl).toBe('https://twitter.com/auth');
    });
  });

  describe('Callback', () => {
    it('calls completeOAuthFlow service', async () => {
      const event = buildEvent('GET', '/oauth/twitter/callback', { oauth_token: 't', oauth_verifier: 'v' });
      mocked(twitterOAuth.completeOAuthFlow).mockResolvedValue('https://admin.ui/success' as any);

      const result = await handler(event) as any;
      expect(result.statusCode).toBe(302);
    });
  });

  describe('Status', () => {
    it('returns connection status for agent', async () => {
      mocked(twitterOAuth.getConnectionStatus).mockResolvedValue({ connected: true, username: 'bot' });
      const event = buildEvent('GET', '/oauth/twitter/status/a1');
      
      const result = await handler(event) as any;
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string).connected).toBe(true);
    });
  });

  describe('Disconnect', () => {
    it('disconnects Twitter credentials', async () => {
      const event = buildEvent('DELETE', '/oauth/twitter/a1');
      const result = await handler(event) as any;
      
      expect(result.statusCode).toBe(200);
      expect(mocked(twitterOAuth.disconnectTwitter)).toHaveBeenCalledWith('a1', expect.any(Object));
    });
  });
});
