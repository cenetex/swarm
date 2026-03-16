/**
 * Raticross Protocol Types Tests
 *
 * Validates type contracts and protocol constants.
 */
import { describe, it, expect } from 'bun:test';
import {
  RATICROSS_PROTOCOL_VERSION,
  type RaticrossEnvelope,
  type RaticrossActor,
  type RaticrossHealthRequest,
  type RaticrossHealthResponse,
  type RaticrossBridgeConfig,
  type RaticrossSendResult,
} from './raticross.js';

describe('Raticross Protocol Types', () => {
  it('exports a protocol version string', () => {
    expect(RATICROSS_PROTOCOL_VERSION).toBe('0.1');
    expect(typeof RATICROSS_PROTOCOL_VERSION).toBe('string');
  });

  it('RaticrossEnvelope satisfies the wire format contract', () => {
    const envelope: RaticrossEnvelope = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      traceId: 'trace-1',
      protocol: '0.1',
      timestamp: Date.now(),
      from: { system: 'swarm', agentId: 'avatar-1' },
      to: { system: 'kyro', agentId: 'kyro-main' },
      type: 'message',
      conversationId: 'conv-abc',
      content: 'Hello from Swarm',
      context: {
        summary: 'Greeting exchange',
        constraints: 'Keep it brief',
        toolHints: ['search', 'memory'],
      },
      meta: {
        ttl: 60000,
        priority: 'high',
        tags: ['test'],
      },
    };

    expect(envelope.id).toBeTruthy();
    expect(envelope.from.system).toBe('swarm');
    expect(envelope.to.system).toBe('kyro');
    expect(envelope.type).toBe('message');
    expect(envelope.protocol).toBe('0.1');
    expect(envelope.context?.toolHints).toEqual(['search', 'memory']);
    expect(envelope.meta?.priority).toBe('high');
  });

  it('RaticrossEnvelope works with minimal fields', () => {
    const minimal: RaticrossEnvelope = {
      id: 'msg-1',
      timestamp: 1234567890,
      from: { system: 'swarm', agentId: 'a1' },
      to: { system: 'kyro', agentId: 'k1' },
      type: 'message',
      conversationId: 'conv-1',
      content: 'Hi',
    };

    expect(minimal.traceId).toBeUndefined();
    expect(minimal.context).toBeUndefined();
    expect(minimal.meta).toBeUndefined();
    expect(minimal.protocol).toBeUndefined();
  });

  it('supports all envelope types', () => {
    const types: RaticrossEnvelope['type'][] = ['message', 'task', 'result', 'status'];
    for (const t of types) {
      const env: RaticrossEnvelope = {
        id: `msg-${t}`,
        timestamp: Date.now(),
        from: { system: 'swarm', agentId: 'a' },
        to: { system: 'kyro', agentId: 'b' },
        type: t,
        conversationId: 'c',
        content: '',
      };
      expect(env.type).toBe(t);
    }
  });

  it('RaticrossActor supports optional pubkey', () => {
    const withKey: RaticrossActor = {
      system: 'swarm',
      agentId: 'avatar-1',
      pubkey: '0xabc123',
    };
    const withoutKey: RaticrossActor = {
      system: 'kyro',
      agentId: 'kyro-main',
    };

    expect(withKey.pubkey).toBe('0xabc123');
    expect(withoutKey.pubkey).toBeUndefined();
  });

  it('RaticrossHealthRequest has required fields', () => {
    const req: RaticrossHealthRequest = {
      type: 'health',
      timestamp: Date.now(),
      from: { system: 'swarm', agentId: 'probe' },
      protocol: '0.1',
    };

    expect(req.type).toBe('health');
    expect(req.protocol).toBe('0.1');
  });

  it('RaticrossHealthResponse represents healthy and unhealthy states', () => {
    const healthy: RaticrossHealthResponse = {
      ok: true,
      system: 'kyro',
      protocol: '0.1',
      timestamp: Date.now(),
      uptime: 3600000,
      agents: ['kyro-main', 'kyro-helper'],
    };

    const unhealthy: RaticrossHealthResponse = {
      ok: false,
      system: 'kyro',
      protocol: '0.1',
      timestamp: Date.now(),
    };

    expect(healthy.ok).toBe(true);
    expect(healthy.agents).toHaveLength(2);
    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.uptime).toBeUndefined();
  });

  it('RaticrossBridgeConfig has sensible defaults documented', () => {
    const config: RaticrossBridgeConfig = {
      relayUrl: 'https://relay.example.com',
    };

    expect(config.relayUrl).toBeTruthy();
    expect(config.relayKey).toBeUndefined();
    expect(config.localSystem).toBeUndefined();
    expect(config.remoteSystem).toBeUndefined();
    expect(config.timeoutMs).toBeUndefined();
  });

  it('RaticrossSendResult represents success and failure', () => {
    const success: RaticrossSendResult = { ok: true, id: 'msg-1' };
    const failure: RaticrossSendResult = { ok: false, id: 'msg-2', error: 'timeout' };

    expect(success.ok).toBe(true);
    expect(success.error).toBeUndefined();
    expect(failure.ok).toBe(false);
    expect(failure.error).toBe('timeout');
  });
});
