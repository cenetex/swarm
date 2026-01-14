/**
 * Admin Tools Tests
 */
import { describe, it, expect } from 'vitest';
import { createAdminTools } from './admin.js';

describe('Admin tools - request_feature_toggle', () => {
  it('exposes a manual tool for admin-ui platform', () => {
    const tools = createAdminTools({});
    const tool = tools.find(candidate => candidate.name === 'request_feature_toggle');
    expect(tool).toBeTruthy();
    expect(tool?.execute).toBe(false);
    expect(tool?.platforms).toEqual(['admin-ui']);
  });

  it('validates feature + label in input schema', () => {
    const tools = createAdminTools({});
    const tool = tools.find(candidate => candidate.name === 'request_feature_toggle');
    expect(tool).toBeTruthy();

    const ok = tool!.inputSchema.safeParse({
      feature: 'media',
      label: 'Media Generation',
    });
    const bad = tool!.inputSchema.safeParse({ feature: 'media' });

    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
});

describe('Admin tools - request_twitter_connection', () => {
  it('exposes a manual tool for admin-ui platform', () => {
    const tools = createAdminTools({});
    const tool = tools.find(candidate => candidate.name === 'request_twitter_connection');
    expect(tool).toBeTruthy();
    expect(tool?.execute).toBe(false);
    expect(tool?.platforms).toEqual(['admin-ui']);
  });

  it('accepts optional message for UI', () => {
    const tools = createAdminTools({});
    const tool = tools.find(candidate => candidate.name === 'request_twitter_connection');
    expect(tool).toBeTruthy();

    const ok = tool!.inputSchema.safeParse({ message: 'Connect X for posting.' });
    expect(ok.success).toBe(true);
  });
});

describe('Admin tools - get_twitter_connection_status', () => {
  it('returns connected status with username when connected', async () => {
    const tools = createAdminTools({
      twitter: {
        getConnectionStatus: async () => ({
          connected: true,
          username: 'swarm',
          userId: '123',
          connectedAt: 1234567890,
        }),
      },
    });
    const tool = tools.find(candidate => candidate.name === 'get_twitter_connection_status');
    expect(tool).toBeTruthy();
    expect(tool?.execute).not.toBe(false);

    const result = await (tool!.execute as any)({}, {
      agentId: 'agent-1',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      connected: true,
      username: 'swarm',
    });
  });

  it('returns not connected message when disconnected', async () => {
    const tools = createAdminTools({
      twitter: {
        getConnectionStatus: async () => ({
          connected: false,
        }),
      },
    });
    const tool = tools.find(candidate => candidate.name === 'get_twitter_connection_status');
    expect(tool).toBeTruthy();

    const result = await (tool!.execute as any)({}, {
      agentId: 'agent-1',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      connected: false,
    });
  });

  it('returns error when twitter service is unavailable', async () => {
    const tools = createAdminTools({});
    const tool = tools.find(candidate => candidate.name === 'get_twitter_connection_status');
    expect(tool).toBeTruthy();

    const result = await (tool!.execute as any)({}, {
      agentId: 'agent-1',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Twitter service is not configured.');
  });
});
