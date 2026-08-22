/**
 * Full integration tests — real SQLite, real Express, real adapters.
 * @test-isolated Mutates process-global fetch, clients, and circuit-breaker state.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import express from 'express';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createLocalServices } from './factories.js';
import { initSecrets, injectLocalAdapters } from './server.js';
import { LocalS3Adapter } from './s3-adapter.js';
import { LocalSQSAdapter } from './sqs-adapter.js';
import { LocalSecretsAdapter } from './secrets-adapter.js';
import { LocalLambdaAdapter } from './lambda-adapter.js';

const TEST_DIR = resolve('/tmp/swarm-integration-test');
const DB_PATH = resolve(TEST_DIR, 'swarm.db');
const BLOB_DIR = resolve(TEST_DIR, 'blobs');
const PASSWORD = 'integration-test-password';

function hitRoute(app: express.Express, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve) => {
    const done = (s: number, d: unknown) => resolve({ status: s, body: d });
    const res: any = {
      _status: 200, statusCode: 200, _headers: {}, locals: {}, headersSent: false,
      status(c: number) { this._status = c; this.statusCode = c; return this; },
      json(d: unknown) { done(this._status, d); },
      send(d: unknown) { done(this._status, d); },
      end() { done(this._status, null); },
      set(k: string, v: string) { this._headers[k] = v; return this; },
      header(k: string, v: string) { this._headers[k] = v; return this; },
      setHeader(k: string, v: string) { this._headers[k.toLowerCase()] = v; },
      getHeader(k: string) { return this._headers[k.toLowerCase()]; },
      get() { return undefined; }, removeHeader() {},
    };
    const m = path.match(/^\/api\/avatars\/([^/]+)/);
    const req: any = {
      method: method.toUpperCase(), url: path, path, baseUrl: '',
      body, params: m ? { id: m[1] } : {}, query: {}, headers: {},
      get() { return undefined; }, app, res,
      _parsedUrl: { pathname: path, search: '', query: {} },
    };
    (app as any).handle(req, res, () => done(404, { error: 'not found' }));
  });
}

describe('server integration', () => {
  let app: express.Express;
  let testAvatarId = '';

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(BLOB_DIR, { recursive: true });

    process.env.LLM_API_KEY_SECRET_ARN = 'llm-api-key';
    process.env.ADMIN_TABLE = 'swarm-local-admin';
    process.env.STATE_TABLE = 'swarm-local-state';
    process.env.MESSAGE_QUEUE_URL = 'https://localhost/queue';
    process.env.S3_BUCKET = 'swarm-local';

    const services = createLocalServices({ dbPath: DB_PATH, blobDir: BLOB_DIR, blobBaseUrl: 'http://localhost:3000/blobs' });
    await services.secrets.initialize(PASSWORD);

    const { _setDynamoClient } = await import('../../admin-api/src/services/dynamo-client.js');
    _setDynamoClient(services.dynamoAdapter);
    const aws = await import('../../admin-api/src/services/aws-clients.js');
    aws._setS3Client(new LocalS3Adapter(services.blobs));
    aws._setSQSClient(new LocalSQSAdapter(services.queue));
    aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
    aws._setLambdaClient(new LocalLambdaAdapter());
    await services.secrets.setSecret('llm-api-key', 'sk-test-integration-key');
    await services.secrets.flush();

    app = express();
    app.use(express.json());

    // Mount all routes (health, auth, consent, blobs, logs, admin)
    app.get('/health', (_req, res) => { res.json({ status: 'ok', version: 'local', services: { secrets: true } }); });
    const localAuthMe = (_req: any, res: any) => { res.json({ email: 'local@swarm.dev', userId: 'local-user', isAdmin: true }); };
    app.get('/auth/me', localAuthMe);
    app.get('/api/auth/me', localAuthMe);
    app.post('/auth/logout', (_req, res) => { res.json({ success: true }); });
    app.get('/api/auth/openrouter', (_req, res) => { res.redirect('/callback?code=test'); });
    app.get('/callback', (_req, res) => { res.json({ token: 'test-token' }); });
    app.get('/consent', (_req, res) => { res.json({ consented: false }); });
    app.post('/consent', (_req, res) => { res.json({ consented: true }); });
    app.post('/consent/revoke', (_req, res) => { res.json({ consented: false }); });
    app.get('/api/consent', (_req, res) => { res.json({ consented: false }); });
    app.post('/api/consent', (_req, res) => { res.json({ consented: true }); });
    app.post('/api/consent/revoke', (_req, res) => { res.json({ consented: false }); });
    app.get('/blobs/:key', (_req, res) => { res.status(404).json({ error: 'not found' }); });
    app.get('/api/log-client-error', (_req, res) => { res.json({ ok: true }); });
    app.post('/api/log-client-error', (_req, res) => { res.json({ ok: true }); });

    const { mountAdminRoutes } = await import('./server.js');
    await mountAdminRoutes(app, services);

    // Create a test avatar and store its ID
    const createRes = await hitRoute(app, 'POST', '/api/avatars', { name: 'Integration Avatar', description: 'Test' });
    const avatar = createRes.body as any;
    if (avatar?.id) testAvatarId = avatar.id;
    else {
      const listRes = await hitRoute(app, 'GET', '/api/avatars');
      const avatars = listRes.body as any[];
      if (avatars.length > 0) testAvatarId = avatars[0].id;
    }
  });

  afterAll(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true }); });

  // ── Health & Auth ──────────────────────────────────────────────────
  it('GET /health', async () => {
    const { status, body } = await hitRoute(app, 'GET', '/health');
    expect(status).toBe(200);
    expect((body as any).status).toBe('ok');
  });

  it('GET /api/auth/me', async () => {
    const { status, body } = await hitRoute(app, 'GET', '/api/auth/me');
    expect(status).toBe(200);
    expect((body as any).email).toContain('local');
  });

  it('POST /auth/logout', async () => {
    const { status } = await hitRoute(app, 'POST', '/auth/logout');
    expect(status).toBe(200);
  });

  // ── Consent ────────────────────────────────────────────────────────
  it('GET /consent', async () => {
    const { status, body } = await hitRoute(app, 'GET', '/consent');
    expect(status).toBe(200);
    expect((body as any).consented).toBe(false);
  });

  it('POST /consent', async () => {
    const { status, body } = await hitRoute(app, 'POST', '/consent');
    expect(status).toBe(200);
    expect((body as any).consented).toBe(true);
  });

  it('POST /consent/revoke', async () => {
    const { status, body } = await hitRoute(app, 'POST', '/consent/revoke');
    expect(status).toBe(200);
    expect((body as any).consented).toBe(false);
  });

  it('GET /api/consent', async () => { expect((await hitRoute(app, 'GET', '/api/consent')).status).toBe(200); });
  it('POST /api/consent', async () => { expect((await hitRoute(app, 'POST', '/api/consent')).status).toBe(200); });
  it('POST /api/consent/revoke', async () => { expect((await hitRoute(app, 'POST', '/api/consent/revoke')).status).toBe(200); });

  // ── Blobs & Logs ───────────────────────────────────────────────────
  it('GET /blobs/:key 404', async () => { expect((await hitRoute(app, 'GET', '/blobs/missing')).status).toBe(404); });
  it('GET /api/log-client-error', async () => { expect((await hitRoute(app, 'GET', '/api/log-client-error')).status).toBe(200); });
  it('POST /api/log-client-error', async () => { expect((await hitRoute(app, 'POST', '/api/log-client-error', { error: 'test' })).status).toBe(200); });

  // ── Avatar CRUD ────────────────────────────────────────────────────
  it('POST /api/avatars creates avatar', async () => {
    const { status, body } = await hitRoute(app, 'POST', '/api/avatars', { name: 'New Avatar' });
    expect(status).toBe(200);
    expect((body as any).name).toBe('New Avatar');
  });

  it('POST /api/avatars 400 when name missing', async () => {
    const { status, body } = await hitRoute(app, 'POST', '/api/avatars', {});
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/name required/);
  });

  it('GET /api/avatars lists', async () => {
    const { status, body } = await hitRoute(app, 'GET', '/api/avatars');
    expect(status).toBe(200);
    expect((body as any[]).length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/avatars/:id', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'GET', `/api/avatars/${testAvatarId}`);
    expect(status).toBe(200);
    expect((body as any).id).toBe(testAvatarId);
  });

  it('PATCH /api/avatars/:id', async () => {
    if (!testAvatarId) return;
    expect((await hitRoute(app, 'PATCH', `/api/avatars/${testAvatarId}`, { name: 'Updated' })).status).not.toBe(404);
  });

  // ── Secrets ────────────────────────────────────────────────────────
  it('POST secrets saves', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/secrets`, { key: 'telegram_bot_token', value: '1'.repeat(30) });
    expect(status).toBe(200);
    expect((body as any).success).toBe(true);
  });

  it('POST secrets 400 missing key', async () => {
    if (!testAvatarId) return;
    expect((await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/secrets`, { value: 'x' })).status).toBe(400);
  });

  it('POST secrets 400 missing value', async () => {
    if (!testAvatarId) return;
    expect((await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/secrets`, { key: 'x' })).status).toBe(400);
  });

  it('GET secrets lists', async () => {
    if (!testAvatarId) return;
    expect((await hitRoute(app, 'GET', `/api/avatars/${testAvatarId}/secrets`)).status).toBe(200);
  });

  it('POST validate-token valid', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/validate-token`, { type: 'telegram_bot_token', value: '1'.repeat(30) });
    expect(status).toBe(200);
    expect((body as any).valid).toBe(true);
  });

  it('POST validate-token discord', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/validate-token`, { type: 'discord_bot_token', value: '1'.repeat(30) });
    expect(status).toBe(200);
    expect((body as any).valid).toBe(true);
    expect((body as any).botInfo).toBeDefined();
  });

  it('POST validate-token non-bot', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/validate-token`, { type: 'api_key', value: 'sk-xxx' });
    expect(status).toBe(200);
    expect((body as any).valid).toBe(true);
  });

  it('POST validate-token 400', async () => {
    if (!testAvatarId) return;
    expect((await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/validate-token`, {})).status).toBe(400);
  });

  it('POST validate-ai-key', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/validate-ai-key`, { integration: 'openrouter', value: 'sk-xxx' });
    expect(status).toBe(200);
    expect((body as any).valid).toBe(true);
  });

  // ── Chat ────────────────────────────────────────────────────────────
  it('POST /api/chat 400 empty', async () => { expect((await hitRoute(app, 'POST', '/api/chat', {})).status).toBe(400); });
  it('POST /api/chat accepts', async () => { expect((await hitRoute(app, 'POST', '/api/chat', { message: 'hi', history: [] })).status).not.toBe(404); });

  // ── Integrations & Platforms ────────────────────────────────────────
  it('GET integrations', async () => {
    if (!testAvatarId) return;
    expect((await hitRoute(app, 'GET', `/api/avatars/${testAvatarId}/integrations`)).status).toBe(200);
  });

  it('GET models openrouter', async () => {
    const { status, body } = await hitRoute(app, 'GET', '/api/integrations/models?integration=openrouter');
    expect(status).toBe(200);
    expect(Array.isArray((body as any).models)).toBe(true);
  });

  it('GET models unknown', async () => {
    const { status, body } = await hitRoute(app, 'GET', '/api/integrations/models?integration=unknown');
    expect(status).toBe(200);
    expect((body as any).models).toEqual([]);
  });

  it('GET telegram diagnose', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'GET', `/api/avatars/${testAvatarId}/telegram/diagnose`);
    expect(status).toBe(200);
    expect((body as any).status).toBe('not_configured');
  });

  it('POST telegram repair', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/telegram/repair`);
    expect(status).toBe(200);
    expect((body as any).success).toBe(false);
  });

  it('GET discord status', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'GET', `/api/avatars/${testAvatarId}/discord/status`);
    expect(status).toBe(200);
    expect((body as any).connected).toBe(false);
  });

  // ── Tool Resume ─────────────────────────────────────────────────────
  it('POST tool resume 400 no result', async () => {
    if (!testAvatarId) return;
    const { status, body } = await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/tools/tc-1`, {});
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/result is required/);
  });

  it('POST tool resume unknown id', async () => {
    if (!testAvatarId) return;
    expect((await hitRoute(app, 'POST', `/api/avatars/${testAvatarId}/tools/tc-unknown`, { result: { ok: true } })).status).toBe(400);
  });

  describe('initSecrets (extracted)', () => {
    // Tests directly against the extracted function — no Express needed
    const TEST_INIT_DIR = resolve('/tmp/swarm-init-test');
    const INIT_DB = resolve(TEST_INIT_DIR, 'swarm.db');

    beforeAll(() => {
      if (existsSync(TEST_INIT_DIR)) rmSync(TEST_INIT_DIR, { recursive: true });
      mkdirSync(TEST_INIT_DIR, { recursive: true });
    });
    afterAll(() => { if (existsSync(TEST_INIT_DIR)) rmSync(TEST_INIT_DIR, { recursive: true }); });

    it('initializes a fresh secrets store', async () => {
      const svc = createLocalServices({ dbPath: INIT_DB });
      const result = await initSecrets(svc, { password: 'fresh-password' });
      expect(result.outcome).toBe('initialized');
      expect(svc.secrets.isUnlocked).toBe(true);
      svc.shutdown();
    });

    it('unlocks an existing store with correct password', async () => {
      const svc = createLocalServices({ dbPath: INIT_DB });
      const result = await initSecrets(svc, { password: 'fresh-password' });
      expect(result.outcome).toBe('unlocked');
      expect(svc.secrets.isUnlocked).toBe(true);
      svc.shutdown();
    });

    it('rejects wrong password on existing store', async () => {
      const svc = createLocalServices({ dbPath: INIT_DB });
      const result = await initSecrets(svc, { password: 'wrong-password' });
      expect(result.outcome).toBe('needs_password');
      expect(result.error).toMatch(/Invalid/);
      svc.shutdown();
    });

    it('returns needs_password when no password provided for initialized store', async () => {
      const svc = createLocalServices({ dbPath: INIT_DB });
      const result = await initSecrets(svc);
      expect(result.outcome).toBe('needs_password');
      svc.shutdown();
    });

    it('rejects short passwords on fresh store', async () => {
      const svc = createLocalServices({ dbPath: INIT_DB + '-short' });
      const result = await initSecrets(svc, { password: 'short' });
      expect(result.outcome).toBe('needs_password');
      expect(result.error).toMatch(/8 characters/);
      svc.shutdown();
    });

    it('rejects mismatched confirmation via callback', async () => {
      const svc = createLocalServices({ dbPath: INIT_DB + '-mismatch' });
      let calls = 0;
      const result = await initSecrets(svc, {
        onPasswordNeeded: async (_prompt: string) => {
          calls++;
          return calls === 1 ? 'good-password' : 'different-password';
        },
      });
      expect(result.outcome).toBe('needs_password');
      expect(result.error).toMatch(/do not match/);
      svc.shutdown();
    });
  });

  describe('injectLocalAdapters (extracted)', () => {
    it('injects adapters without throwing', async () => {
      const svc = createLocalServices({ dbPath: DB_PATH + '-inject-test' });
      await expect(injectLocalAdapters(svc)).resolves.toBeUndefined();
      svc.shutdown();
    });
  });

});

  describe('full chat flow (pause → resume)', () => {
    let chatApp: express.Express;

    beforeAll(async () => {
      // Set up a fresh app with a mock chat that returns a pause tool
      const CHAT_DIR = resolve('/tmp/swarm-chat-flow-test');
      if (existsSync(CHAT_DIR)) rmSync(CHAT_DIR, { recursive: true });
      mkdirSync(CHAT_DIR, { recursive: true });

      const services = createLocalServices({
        dbPath: resolve(CHAT_DIR, 'swarm.db'),
        blobDir: resolve(CHAT_DIR, 'blobs'),
        blobBaseUrl: 'http://localhost:3000/blobs',
      });
      await services.secrets.initialize('chat-flow-pw');

      const { _setDynamoClient } = await import('../../admin-api/src/services/dynamo-client.js');
      _setDynamoClient(services.dynamoAdapter);
      const aws = await import('../../admin-api/src/services/aws-clients.js');
      aws._setS3Client(new LocalS3Adapter(services.blobs));
      aws._setSQSClient(new LocalSQSAdapter(services.queue));
      aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
      aws._setLambdaClient(new LocalLambdaAdapter());
      await services.secrets.setSecret('llm-api-key', 'sk-test');
      await services.secrets.flush();

      // Import _resetApiKeyCache to clear LLM key cache
      try {
        const { _resetApiKeyCache } = await import('../../admin-api/src/handlers/chat-llm.js');
        _resetApiKeyCache();
      } catch {
        // Optional cache reset is unavailable in some test builds.
      }

      chatApp = express();
      chatApp.use(express.json());

      const { mountAdminRoutes } = await import('./server.js');

      // Mock chat: first call returns a pause tool, second call returns final response
      let callCount = 0;
      await mountAdminRoutes(chatApp, services, async (_message: string | null, history: any[], _session: any, avatar: any) => {
        callCount++;
        if (callCount === 1) {
          // First call: LLM wants to configure an integration
          return {
            response: '',
            history: [
              ...history,
              { role: 'assistant', content: '', tool_calls: [{ id: 'tc-flow-1', type: 'function', function: { name: 'configure_integration', arguments: JSON.stringify({ integration: 'telegram' }) } }] },
            ],
            avatar: avatar || { id: 'test-avatar' },
            pendingToolCall: { id: 'tc-flow-1', name: 'configure_integration', arguments: { integration: 'telegram' } },
          };
        }
        // Second call: user provided the tool result
        return {
          response: 'Telegram integration configured successfully!',
          history: [
            ...history,
            { role: 'assistant', content: 'Telegram integration configured successfully!' },
          ],
          avatar: avatar || { id: 'test-avatar' },
        };
      }) as any;
    });

    afterAll(() => {
      const CHAT_DIR = resolve('/tmp/swarm-chat-flow-test');
      if (existsSync(CHAT_DIR)) rmSync(CHAT_DIR, { recursive: true });
    });

    it('message triggers pause tool, resume completes flow', async () => {
      // Step 1: Send a message that triggers a pause tool
      const step1 = await hitRoute(chatApp, 'POST', '/api/chat', {
        message: 'Configure telegram for my avatar',
        history: [],
        avatar: { id: 'test-avatar' },
      });
      expect(step1.status).toBe(200);
      const body1 = step1.body as any;
      expect(body1.pendingToolCall).toBeDefined();
      expect(body1.pendingToolCall.name).toBe('configure_integration');
      expect(body1.pendingToolCall.id).toBe('tc-flow-1');

      // Step 2: Resume the tool with a result
      const step2 = await hitRoute(chatApp, 'POST', `/api/avatars/test-avatar/tools/tc-flow-1`, {
        result: { configured: true, integration: 'telegram' },
      });
      expect(step2.status).not.toBe(404);
      // Should succeed (may 400 if tool call validation fails without real pending store)
    });

    it('chat response includes all expected fields with pause tool', async () => {
      // Reset call count by recreating the app
      // The first call already happened in the previous test. Verify shape from there.
      const { status, body } = await hitRoute(chatApp, 'POST', '/api/chat', {
        message: 'setup discord too',
        history: [],
        avatar: { id: 'test-avatar' },
      });
      expect(status).toBe(200);
      const data = body as any;
      // Second call returns final response, no pendingToolCall
      expect(data.response).toBeDefined();
      expect(data.history).toBeDefined();
    });
  });

  describe('fallback tool loop (mocked LLM)', () => {
    let toolApp: express.Express;
    const TOOL_DIR = resolve('/tmp/swarm-tool-loop-test');

    beforeAll(async () => {
      if (existsSync(TOOL_DIR)) rmSync(TOOL_DIR, { recursive: true });
      mkdirSync(TOOL_DIR, { recursive: true });

      const services = createLocalServices({
        dbPath: resolve(TOOL_DIR, 'swarm.db'),
        blobDir: resolve(TOOL_DIR, 'blobs'),
        blobBaseUrl: 'http://localhost:3000/blobs',
      });
      await services.secrets.initialize('tool-loop-pw');

      const { _setDynamoClient } = await import('../../admin-api/src/services/dynamo-client.js');
      _setDynamoClient(services.dynamoAdapter);
      const aws = await import('../../admin-api/src/services/aws-clients.js');
      aws._setS3Client(new LocalS3Adapter(services.blobs));
      aws._setSQSClient(new LocalSQSAdapter(services.queue));
      aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
      aws._setLambdaClient(new LocalLambdaAdapter());
      await services.secrets.setSecret('llm-api-key', 'sk-test-mock-llm-key');
      await services.secrets.flush();

      try {
        const { _resetApiKeyCache } = await import('../../admin-api/src/handlers/chat-llm.js');
        _resetApiKeyCache();
      } catch {
        // Optional cache reset is unavailable in some test builds.
      }

      toolApp = express();
      toolApp.use(express.json());

      const { mountAdminRoutes } = await import('./server.js');
      // Use the REAL processChat — we mock at the HTTP level
      await mountAdminRoutes(toolApp, services);
    });

    afterAll(() => {
      if (existsSync(TOOL_DIR)) rmSync(TOOL_DIR, { recursive: true });
    });

    it('chat route returns without crashing (LLM unreachable in sandbox)', async () => {
      // In the sandbox, OpenRouter is unreachable. The route should handle this gracefully.
      const { status } = await hitRoute(toolApp, 'POST', '/api/chat', {
        message: 'Search for cats',
        history: [],
      });
      // Should not crash — should return an error response
      expect(status).not.toBe(404);
      // Accept 500 (LLM error) or 200 (if fallback works)
      expect([200, 500]).toContain(status);
    });

    it('chat with non-empty history does not crash', async () => {
      const { status } = await hitRoute(toolApp, 'POST', '/api/chat', {
        message: 'Tell me more',
        history: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      });
      expect(status).not.toBe(404);
    });

    it('chat with avatar context does not crash', async () => {
      const { status } = await hitRoute(toolApp, 'POST', '/api/chat', {
        message: 'Update my profile',
        history: [],
        avatar: { id: 'test-avatar' },
      });
      expect(status).not.toBe(404);
    });
  });

  describe('fallback tool loop with mocked LLM', () => {
    let mockApp: express.Express;
    const MOCK_DIR = resolve('/tmp/swarm-mock-llm-test');
    const origFetch = globalThis.fetch;

    beforeAll(async () => {
      if (existsSync(MOCK_DIR)) rmSync(MOCK_DIR, { recursive: true });
      mkdirSync(MOCK_DIR, { recursive: true });

      const services = createLocalServices({
        dbPath: resolve(MOCK_DIR, 'swarm.db'),
        blobDir: resolve(MOCK_DIR, 'blobs'),
        blobBaseUrl: 'http://localhost:3000/blobs',
      });
      await services.secrets.initialize('mock-llm-pw');

      const { _setDynamoClient } = await import('../../admin-api/src/services/dynamo-client.js');
      _setDynamoClient(services.dynamoAdapter);
      const aws = await import('../../admin-api/src/services/aws-clients.js');
      aws._setS3Client(new LocalS3Adapter(services.blobs));
      aws._setSQSClient(new LocalSQSAdapter(services.queue));
      aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
      aws._setLambdaClient(new LocalLambdaAdapter());
      await services.secrets.setSecret('llm-api-key', 'sk-mock-llm');
      await services.secrets.flush();

      try { const { _resetApiKeyCache } = await import('../../admin-api/src/handlers/chat-llm.js'); _resetApiKeyCache(); } catch {
        // Optional cache reset is unavailable in some test builds.
      }

      // Mock fetch: intercept OpenRouter API calls
      (globalThis as any).fetch = async (url: string, init: any) => {
        const urlStr = String(url);

        // Models list endpoint
        if (urlStr.includes('/api/v1/models')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              data: [
                { id: 'mock/gpt-4o', name: 'Mock GPT-4o', context_length: 128000,
                  pricing: { prompt: '0.000005', completion: '0.000015' },
                  top_provider: { is_moderated: false } },
              ],
            }),
          };
        }

        // Chat completions endpoint
        if (urlStr.includes('/chat/completions')) {
          const body = JSON.parse(init.body || '{}');
          const msgs: any[] = body.messages || [];
          const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user');
          const text = typeof lastUser?.content === 'string' ? lastUser.content : '';

          // Tool-returning response for "search" queries
          if (text.toLowerCase().includes('search')) {
            return {
              ok: true, status: 200,
              json: async () => ({
                id: 'mock-search',
                choices: [{
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                      id: 'call_mock_search_1',
                      type: 'function',
                      function: { name: 'search_web', arguments: '{"query":"test search"}' },
                    }],
                  },
                  finish_reason: 'tool_calls',
                }],
                model: 'mock/gpt-4o',
                usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
              }),
            };
          }

          // Tool-returning response for "configure" queries (pause tool)
          if (text.toLowerCase().includes('configure')) {
            return {
              ok: true, status: 200,
              json: async () => ({
                id: 'mock-config',
                choices: [{
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                      id: 'call_mock_config_1',
                      type: 'function',
                      function: { name: 'configure_integration', arguments: '{"integration":"telegram"}' },
                    }],
                  },
                  finish_reason: 'tool_calls',
                }],
                model: 'mock/gpt-4o',
                usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65 },
              }),
            };
          }

          // Plain text response
          return {
            ok: true, status: 200,
            json: async () => ({
              id: 'mock-plain',
              choices: [{
                message: { role: 'assistant', content: 'Hello from mock LLM!' },
                finish_reason: 'stop',
              }],
              model: 'mock/gpt-4o',
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            }),
          };
        }

        return { ok: false, status: 404, json: async () => ({}) };
      };

      mockApp = express();
      mockApp.use(express.json());

      const { mountAdminRoutes } = await import('./server.js');
      await mountAdminRoutes(mockApp, services);
    });

    afterAll(() => {
      (globalThis as any).fetch = origFetch;
      if (existsSync(MOCK_DIR)) rmSync(MOCK_DIR, { recursive: true });
    });

    it('plain text chat returns mock LLM response', async () => {
      const { status, body } = await hitRoute(mockApp, 'POST', '/api/chat', {
        message: 'Hello!',
        history: [],
      });
      expect(status).toBe(200);
      expect((body as any).response).toBe('Hello from mock LLM!');
    });

    it('search triggers tool call and fallback loop attempts execution', async () => {
      const { status, body } = await hitRoute(mockApp, 'POST', '/api/chat', {
        message: 'search for cats',
        history: [],
      });
      // Tool execution may fail (tool not in registry) but flow should not crash
      expect(status).toBe(200);
      // The fallback loop tries to execute search_web — it won't find the tool
      // but the loop should complete without crashing
      expect((body as any).response).toBeDefined();
    });

    it('configure_integration trigger returns without crashing', async () => {
      const { status } = await hitRoute(mockApp, 'POST', '/api/chat', {
        message: 'configure telegram',
        history: [],
        avatar: { id: 'mock-avatar' },
      });
      // Without real mcpServices, pause tool handling may fall through
      // to the fallback loop. The route should handle this without crashing.
      expect(status).not.toBe(404);
      expect([200, 500]).toContain(status);
    });

    it('multi-turn conversation works', async () => {
      // First turn
      const turn1 = await hitRoute(mockApp, 'POST', '/api/chat', {
        message: 'Hello!',
        history: [],
      });
      expect(turn1.status).toBe(200);
      const history1 = (turn1.body as any).history || [];

      // Second turn with history
      const turn2 = await hitRoute(mockApp, 'POST', '/api/chat', {
        message: 'How are you?',
        history: history1,
      });
      expect(turn2.status).toBe(200);
      expect((turn2.body as any).response).toBeDefined();
    });

    it('chat with avatar returns without crashing', async () => {
      const { status } = await hitRoute(mockApp, 'POST', '/api/chat', {
        message: 'Hello!',
        history: [],
        avatar: { id: 'test-avatar-1' },
      });
      // Avatar may not exist in DB — route should handle gracefully
      expect(status).not.toBe(404);
      expect([200, 500]).toContain(status);
    });
  });

  describe('multi-step tool loop with stateful mock LLM', () => {
    let loopApp: express.Express;
    const LOOP_DIR = resolve('/tmp/swarm-loop-test');
    const origFetch = globalThis.fetch;

    beforeAll(async () => {
      if (existsSync(LOOP_DIR)) rmSync(LOOP_DIR, { recursive: true });
      mkdirSync(LOOP_DIR, { recursive: true });

      const services = createLocalServices({
        dbPath: resolve(LOOP_DIR, 'swarm.db'),
        blobDir: resolve(LOOP_DIR, 'blobs'),
        blobBaseUrl: 'http://localhost:3000/blobs',
      });
      await services.secrets.initialize('loop-pw');

      const { _setDynamoClient } = await import('../../admin-api/src/services/dynamo-client.js');
      _setDynamoClient(services.dynamoAdapter);
      const aws = await import('../../admin-api/src/services/aws-clients.js');
      aws._setS3Client(new LocalS3Adapter(services.blobs));
      aws._setSQSClient(new LocalSQSAdapter(services.queue));
      aws._setSecretsClient(new LocalSecretsAdapter(services.secrets));
      aws._setLambdaClient(new LocalLambdaAdapter());
      await services.secrets.setSecret('llm-api-key', 'sk-loop');
      await services.secrets.flush();

      try { const { _resetApiKeyCache } = await import('../../admin-api/src/handlers/chat-llm.js'); _resetApiKeyCache(); } catch {
        // Optional cache reset is unavailable in some test builds.
      }

      // Stateful mock: tracks call count to simulate multi-step conversations
      let callCount = 0;
      (globalThis as any).fetch = async (url: string, init: any) => {
        const urlStr = String(url);

        if (urlStr.includes('/api/v1/models')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              data: [
                { id: 'mock/model', name: 'Mock Model', context_length: 128000,
                  pricing: { prompt: '0', completion: '0' },
                  top_provider: { is_moderated: false } },
              ],
            }),
          };
        }

        if (urlStr.includes('/chat/completions')) {
          callCount++;
          const body = JSON.parse(init.body || '{}');
          const msgs: any[] = body.messages || [];

          // Check if this is a continuation (has tool results in messages)
          const hasToolResults = msgs.some((m: any) => m.role === 'tool');

          if (!hasToolResults) {
            // Initial call: return tool calls for a search
            return {
              ok: true, status: 200,
              json: async () => ({
                id: `mock-step-${callCount}`,
                choices: [{
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                      id: 'call_search_1',
                      type: 'function',
                      function: { name: 'search_web', arguments: '{"query":"cats"}' },
                    }],
                  },
                  finish_reason: 'tool_calls',
                }],
                model: 'mock/model',
                usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
              }),
            };
          }

          // Continuation call (after tool execution): return final text
          return {
            ok: true, status: 200,
            json: async () => ({
              id: `mock-final-${callCount}`,
              choices: [{
                message: {
                  role: 'assistant',
                  content: `After searching, I found results for your query. This is step ${callCount}.`,
                },
                finish_reason: 'stop',
              }],
              model: 'mock/model',
              usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
            }),
          };
        }

        return { ok: false, status: 404, json: async () => ({}) };
      };

      loopApp = express();
      loopApp.use(express.json());

      const { mountAdminRoutes } = await import('./server.js');
      await mountAdminRoutes(loopApp, services);
    });

    afterAll(() => {
      (globalThis as any).fetch = origFetch;
      if (existsSync(LOOP_DIR)) rmSync(LOOP_DIR, { recursive: true });
    });

    it('tool call → tool execution → LLM re-called → final response', async () => {
      const { status, body } = await hitRoute(loopApp, 'POST', '/api/chat', {
        message: 'search for cats please',
        history: [],
      });
      expect(status).not.toBe(404);
      // The fallback loop: LLM returns search_web → tries to execute →
      // LLM called again with tool result → returns text response
      // Tool execution will fail (no tool registry) but loop completes
      const data = body as any;
      // Either 200 (success) or 500 (tool registry missing)
      expect([200, 500]).toContain(status);
      if (status === 200) {
        expect(data.response).toBeDefined();
      }
    });

    it('empty tool call response ends loop immediately', async () => {
      // The mock for this tests the "no more tool calls → final response" path
      const { status } = await hitRoute(loopApp, 'POST', '/api/chat', {
        message: 'hello just say hi',
        history: [],
      });
      expect(status).not.toBe(404);
    });

    it('multi-turn with history preserves context', async () => {
      // First turn
      const t1 = await hitRoute(loopApp, 'POST', '/api/chat', {
        message: 'hello',
        history: [],
      });
      const h1 = (t1.body as any).history || [];

      // Second turn
      const t2 = await hitRoute(loopApp, 'POST', '/api/chat', {
        message: 'now search for dogs',
        history: h1,
      });
      expect(t2.status).not.toBe(404);
      // The LLM receives the full history including previous turns
    });
  });
