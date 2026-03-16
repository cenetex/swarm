/**
 * Raticross Bridge Client Tests
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { createRaticrossBridgeClient, type RaticrossBridgeClient } from './raticross-client.js';
import { RATICROSS_PROTOCOL_VERSION } from '../types/raticross.js';

/**
 * Create a mock fetch that returns a configurable response.
 */
function mockFetch(
  status: number,
  body: unknown = { ok: true },
): { fetch: typeof globalThis.fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init || {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

/**
 * Create a mock fetch that throws a network error.
 */
function mockFetchError(message: string): typeof globalThis.fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof globalThis.fetch;
}

describe('createRaticrossBridgeClient', () => {
  let client: RaticrossBridgeClient;
  let mock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    mock = mockFetch(200, { ok: true });
    client = createRaticrossBridgeClient(
      {
        relayUrl: 'https://relay.example.com',
        relayKey: 'test-key',
        localSystem: 'swarm',
        remoteSystem: 'kyro',
        timeoutMs: 5000,
      },
      mock.fetch,
    );
  });

  describe('getConfig', () => {
    it('returns a copy of the configuration', () => {
      const config = client.getConfig();
      expect(config.relayUrl).toBe('https://relay.example.com');
      expect(config.relayKey).toBe('test-key');
      expect(config.localSystem).toBe('swarm');
      expect(config.remoteSystem).toBe('kyro');
    });
  });

  describe('send', () => {
    it('sends a message envelope to the relay endpoint', async () => {
      const result = await client.send({
        fromAgentId: 'avatar-1',
        toAgentId: 'kyro-main',
        conversationId: 'conv-123',
        content: 'Hello from Swarm!',
      });

      expect(result.ok).toBe(true);
      expect(result.id).toBeTruthy();
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].url).toBe('https://relay.example.com/raticross/inbound');

      const sentBody = JSON.parse(mock.calls[0].init.body as string);
      expect(sentBody.from.system).toBe('swarm');
      expect(sentBody.from.agentId).toBe('avatar-1');
      expect(sentBody.to.system).toBe('kyro');
      expect(sentBody.to.agentId).toBe('kyro-main');
      expect(sentBody.type).toBe('message');
      expect(sentBody.content).toBe('Hello from Swarm!');
      expect(sentBody.protocol).toBe(RATICROSS_PROTOCOL_VERSION);
      expect(sentBody.conversationId).toBe('conv-123');
    });

    it('includes the auth key header', async () => {
      await client.send({
        fromAgentId: 'avatar-1',
        toAgentId: 'kyro-main',
        conversationId: 'conv-123',
        content: 'test',
      });

      const headers = mock.calls[0].init.headers as Record<string, string>;
      expect(headers['x-raticross-key']).toBe('test-key');
    });

    it('supports custom envelope type and context', async () => {
      await client.send({
        fromAgentId: 'avatar-1',
        toAgentId: 'kyro-main',
        conversationId: 'conv-123',
        content: 'do the task',
        type: 'task',
        context: { summary: 'User wants X', toolHints: ['search'] },
        meta: { priority: 'high', tags: ['urgent'] },
      });

      const sentBody = JSON.parse(mock.calls[0].init.body as string);
      expect(sentBody.type).toBe('task');
      expect(sentBody.context.summary).toBe('User wants X');
      expect(sentBody.context.toolHints).toEqual(['search']);
      expect(sentBody.meta.priority).toBe('high');
    });

    it('returns error when relay rejects the message', async () => {
      const badMock = mockFetch(500, { error: 'Internal Server Error' });
      const badClient = createRaticrossBridgeClient(
        { relayUrl: 'https://relay.example.com' },
        badMock.fetch,
      );

      const result = await badClient.send({
        fromAgentId: 'avatar-1',
        toAgentId: 'kyro-main',
        conversationId: 'conv-123',
        content: 'test',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('500');
    });

    it('returns error on network failure', async () => {
      const errorClient = createRaticrossBridgeClient(
        { relayUrl: 'https://relay.example.com' },
        mockFetchError('Connection refused'),
      );

      const result = await errorClient.send({
        fromAgentId: 'avatar-1',
        toAgentId: 'kyro-main',
        conversationId: 'conv-123',
        content: 'test',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Connection refused');
    });

    it('strips trailing slashes from relay URL', async () => {
      const c = createRaticrossBridgeClient(
        { relayUrl: 'https://relay.example.com///' },
        mock.fetch,
      );
      await c.send({
        fromAgentId: 'a',
        toAgentId: 'b',
        conversationId: 'c',
        content: 'x',
      });
      expect(mock.calls[0].url).toBe('https://relay.example.com/raticross/inbound');
    });

    it('omits auth header when no key is configured', async () => {
      const noKeyClient = createRaticrossBridgeClient(
        { relayUrl: 'https://relay.example.com' },
        mock.fetch,
      );
      await noKeyClient.send({
        fromAgentId: 'a',
        toAgentId: 'b',
        conversationId: 'c',
        content: 'x',
      });
      const headers = mock.calls[0].init.headers as Record<string, string>;
      expect(headers['x-raticross-key']).toBeUndefined();
    });
  });

  describe('healthCheck', () => {
    it('sends a health probe and returns the response', async () => {
      const healthMock = mockFetch(200, {
        ok: true,
        system: 'kyro',
        protocol: '0.1',
        timestamp: 1234567890,
        uptime: 60000,
        agents: ['kyro-main'],
      });
      const c = createRaticrossBridgeClient(
        { relayUrl: 'https://relay.example.com', relayKey: 'key' },
        healthMock.fetch,
      );

      const result = await c.healthCheck('avatar-1');

      expect(result.ok).toBe(true);
      expect(result.system).toBe('kyro');
      expect(result.protocol).toBe('0.1');
      expect(result.uptime).toBe(60000);
      expect(result.agents).toEqual(['kyro-main']);
      expect(healthMock.calls[0].url).toBe('https://relay.example.com/raticross/health');
    });

    it('returns ok=false when the endpoint is unreachable', async () => {
      const c = createRaticrossBridgeClient(
        { relayUrl: 'https://relay.example.com' },
        mockFetchError('ECONNREFUSED'),
      );

      const result = await c.healthCheck();

      expect(result.ok).toBe(false);
      expect(result.system).toBe('kyro');
    });

    it('returns ok=false when endpoint returns non-200', async () => {
      const badMock = mockFetch(503, { error: 'Service Unavailable' });
      const c = createRaticrossBridgeClient(
        { relayUrl: 'https://relay.example.com' },
        badMock.fetch,
      );

      const result = await c.healthCheck();

      expect(result.ok).toBe(false);
    });

    it('uses default fromAgentId when not specified', async () => {
      const healthMock = mockFetch(200, { ok: true, system: 'kyro', protocol: '0.1', timestamp: 0 });
      const c = createRaticrossBridgeClient(
        { relayUrl: 'https://relay.example.com' },
        healthMock.fetch,
      );

      await c.healthCheck();

      const sentBody = JSON.parse(healthMock.calls[0].init.body as string);
      expect(sentBody.from.agentId).toBe('health-probe');
    });
  });
});
