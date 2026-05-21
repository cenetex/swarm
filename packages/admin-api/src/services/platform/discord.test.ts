/**
 * Discord Service Tests
 *
 * Tests for the Discord gateway runtime health check.
 * The getConnectionStatus function is tested indirectly through
 * activation-readiness tests (which use DI to inject the status)
 * since it has hard dependencies on secrets.ts / fetch.
 *
 * These tests cover the pure isGatewayRuntimeAvailable function.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../secrets.js', () => ({
  _getSecretValueInternal: vi.fn(),
}));

import * as secrets from '../secrets.js';
import { isGatewayRuntimeAvailable, sendMediaToChannel, type DiscordServiceDeps } from './discord.js';

const getSecretValue = secrets._getSecretValueInternal as unknown as ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

describe('isGatewayRuntimeAvailable', () => {
  const originalEnv = process.env.DISCORD_GATEWAY_ENABLED;

  beforeEach(() => {
    getSecretValue.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DISCORD_GATEWAY_ENABLED;
    } else {
      process.env.DISCORD_GATEWAY_ENABLED = originalEnv;
    }
    globalThis.fetch = originalFetch;
  });

  it('returns gatewayEnabled=true when env var is "true"', () => {
    process.env.DISCORD_GATEWAY_ENABLED = 'true';
    const result = isGatewayRuntimeAvailable();
    expect(result.gatewayEnabled).toBe(true);
    expect(result.reason).toBe('gateway_deployed');
  });

  it('returns gatewayEnabled=false when env var is "false"', () => {
    process.env.DISCORD_GATEWAY_ENABLED = 'false';
    const result = isGatewayRuntimeAvailable();
    expect(result.gatewayEnabled).toBe(false);
    expect(result.reason).toBe('gateway_not_deployed');
  });

  it('returns gatewayEnabled=false when env var is absent', () => {
    delete process.env.DISCORD_GATEWAY_ENABLED;
    const result = isGatewayRuntimeAvailable();
    expect(result.gatewayEnabled).toBe(false);
    expect(result.reason).toBe('gateway_not_deployed');
  });

  it('returns gatewayEnabled=false for empty string env var', () => {
    process.env.DISCORD_GATEWAY_ENABLED = '';
    const result = isGatewayRuntimeAvailable();
    expect(result.gatewayEnabled).toBe(false);
    expect(result.reason).toBe('gateway_not_deployed');
  });

  it('respects deps.isGatewayEnabled override (true)', () => {
    process.env.DISCORD_GATEWAY_ENABLED = 'false';
    const deps: DiscordServiceDeps = { isGatewayEnabled: () => true };
    const result = isGatewayRuntimeAvailable(deps);
    expect(result.gatewayEnabled).toBe(true);
    expect(result.reason).toBe('gateway_deployed');
  });

  it('respects deps.isGatewayEnabled override (false)', () => {
    process.env.DISCORD_GATEWAY_ENABLED = 'true';
    const deps: DiscordServiceDeps = { isGatewayEnabled: () => false };
    const result = isGatewayRuntimeAvailable(deps);
    expect(result.gatewayEnabled).toBe(false);
    expect(result.reason).toBe('gateway_not_deployed');
  });
});

describe('sendMediaToChannel', () => {
  beforeEach(() => {
    getSecretValue.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends image media as a Discord embed with caption and reply reference', async () => {
    getSecretValue.mockResolvedValue('bot-token');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'message-1' }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendMediaToChannel(
      'avatar-1',
      'channel-1',
      'https://cdn.example.com/img.png',
      { mediaType: 'image', caption: 'caption', replyToMessageId: 'reply-1' },
    );

    const [, request] = fetchMock.mock.calls[0];
    expect(getSecretValue).toHaveBeenCalledWith('avatar-1', 'discord_bot_token', 'default');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/channel-1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bot bot-token',
          'Content-Type': 'application/json',
        },
      }),
    );
    expect(JSON.parse(request.body)).toEqual({
      content: 'caption',
      message_reference: { message_id: 'reply-1' },
      embeds: [{ image: { url: 'https://cdn.example.com/img.png' } }],
    });
    expect(result).toEqual({ messageId: 'message-1' });
  });

  it('sends video media as a message containing the URL', async () => {
    getSecretValue.mockResolvedValue('bot-token');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'message-2' }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendMediaToChannel(
      'avatar-1',
      'channel-1',
      'https://cdn.example.com/video.mp4',
      { mediaType: 'video', caption: 'watch this' },
    );

    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(request.body)).toEqual({
      content: 'watch this\nhttps://cdn.example.com/video.mp4',
    });
    expect(result).toEqual({ messageId: 'message-2' });
  });
});
