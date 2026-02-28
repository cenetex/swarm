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
import { describe, it, expect, afterEach } from 'vitest';
import { isGatewayRuntimeAvailable, type DiscordServiceDeps } from './discord.js';

describe('isGatewayRuntimeAvailable', () => {
  const originalEnv = process.env.DISCORD_GATEWAY_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DISCORD_GATEWAY_ENABLED;
    } else {
      process.env.DISCORD_GATEWAY_ENABLED = originalEnv;
    }
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
