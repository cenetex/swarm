/**
 * Discord Activation Readiness Tests
 *
 * Tests that the activation-readiness Discord health check correctly
 * distinguishes credential validity from gateway runtime availability,
 * and fails bot/hybrid mode avatars when the runtime is down.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateActivationReadiness,
  type ActivationReadinessContext,
  type ActivationReadinessDeps,
} from './activation-readiness.js';
import type { AvatarRecord } from '../types.js';
import type { DiscordConnectionStatus } from './discord.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAvatar(overrides: Partial<AvatarRecord> = {}): AvatarRecord {
  return {
    pk: 'AVATAR#test-avatar',
    sk: 'CONFIG',
    avatarId: 'test-avatar',
    name: 'Test Avatar',
    persona: 'A helpful test bot.',
    platforms: {
      discord: { enabled: true, mode: 'bot' },
    },
    llmConfig: {
      provider: 'openrouter',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 1000,
      useGlobalKey: true,
    },
    status: 'active',
    createdAt: Date.now(),
    createdBy: 'test',
    updatedAt: Date.now(),
    updatedBy: 'test',
    ...overrides,
  };
}

const baseContext: ActivationReadinessContext = {
  effectiveIsAdmin: true,
  walletAddress: null,
  accountId: null,
};

function makeBaseDeps(discordStatus: DiscordConnectionStatus): ActivationReadinessDeps {
  return {
    now: () => Date.now(),
    secretExists: async () => true,
    diagnoseTelegram: async () => ({ healthy: true, issues: [] }) as never,
    getTwitterConnectionStatus: async () => ({ connected: false, mode: 'none' }) as never,
    getDiscordConnectionStatus: async () => discordStatus,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateActivationReadiness — Discord health check', () => {
  it('passes when credentials valid and runtime healthy (bot mode)', async () => {
    const avatar = makeAvatar({ platforms: { discord: { enabled: true, mode: 'bot' } } });
    const deps = makeBaseDeps({
      connected: true,
      credentialsValid: true,
      runtimeHealthy: true,
      mode: 'bot',
      runtimeDetail: { gatewayEnabled: true, reason: 'gateway_deployed' },
    });

    const report = await evaluateActivationReadiness(avatar, baseContext, deps);
    const discordCheck = report.checks.find((c) => c.id === 'integration.discord.connection_healthy');

    expect(discordCheck).toBeDefined();
    expect(discordCheck!.status).toBe('pass');
    expect(discordCheck!.reasonCode).toBe('DISCORD_CONNECTED');
    expect(discordCheck!.evidence?.credentialsValid).toBe(true);
    expect(discordCheck!.evidence?.runtimeHealthy).toBe(true);
  });

  it('fails with DISCORD_RUNTIME_UNAVAILABLE when credentials valid but gateway down (bot mode)', async () => {
    const avatar = makeAvatar({ platforms: { discord: { enabled: true, mode: 'bot' } } });
    const deps = makeBaseDeps({
      connected: false,
      credentialsValid: true,
      runtimeHealthy: false,
      mode: 'bot',
      runtimeDetail: { gatewayEnabled: false, reason: 'gateway_not_deployed' },
    });

    const report = await evaluateActivationReadiness(avatar, baseContext, deps);
    const discordCheck = report.checks.find((c) => c.id === 'integration.discord.connection_healthy');

    expect(discordCheck).toBeDefined();
    expect(discordCheck!.status).toBe('fail');
    expect(discordCheck!.reasonCode).toBe('DISCORD_RUNTIME_UNAVAILABLE');
    expect(discordCheck!.evidence?.credentialsValid).toBe(true);
    expect(discordCheck!.evidence?.runtimeHealthy).toBe(false);
    expect(discordCheck!.evidence?.runtimeReason).toBe('gateway_not_deployed');
    expect(discordCheck!.message).toContain('gateway runtime is unavailable');
  });

  it('fails with DISCORD_RUNTIME_UNAVAILABLE for hybrid mode when gateway down', async () => {
    const avatar = makeAvatar({ platforms: { discord: { enabled: true, mode: 'hybrid' } } });
    const deps = makeBaseDeps({
      connected: false,
      credentialsValid: true,
      runtimeHealthy: false,
      mode: 'hybrid',
      runtimeDetail: { gatewayEnabled: false, reason: 'gateway_not_deployed' },
    });

    const report = await evaluateActivationReadiness(avatar, baseContext, deps);
    const discordCheck = report.checks.find((c) => c.id === 'integration.discord.connection_healthy');

    expect(discordCheck!.status).toBe('fail');
    expect(discordCheck!.reasonCode).toBe('DISCORD_RUNTIME_UNAVAILABLE');
  });

  it('passes for webhook mode even when gateway is disabled', async () => {
    const avatar = makeAvatar({ platforms: { discord: { enabled: true, mode: 'webhook' } } });
    const deps = makeBaseDeps({
      connected: true,
      credentialsValid: true,
      runtimeHealthy: true,
      mode: 'webhook',
      runtimeDetail: { gatewayEnabled: false, reason: 'runtime_not_required' },
    });

    const report = await evaluateActivationReadiness(avatar, baseContext, deps);
    const discordCheck = report.checks.find((c) => c.id === 'integration.discord.connection_healthy');

    expect(discordCheck!.status).toBe('pass');
    expect(discordCheck!.reasonCode).toBe('DISCORD_CONNECTED');
  });

  it('fails with DISCORD_CONNECTION_UNHEALTHY when credentials are invalid', async () => {
    const avatar = makeAvatar({ platforms: { discord: { enabled: true, mode: 'bot' } } });
    const deps = makeBaseDeps({
      connected: false,
      credentialsValid: false,
      runtimeHealthy: true,
      mode: 'bot',
    });

    const report = await evaluateActivationReadiness(avatar, baseContext, deps);
    const discordCheck = report.checks.find((c) => c.id === 'integration.discord.connection_healthy');

    expect(discordCheck!.status).toBe('fail');
    expect(discordCheck!.reasonCode).toBe('DISCORD_CONNECTION_UNHEALTHY');
  });

  it('returns not_applicable when discord is not enabled', async () => {
    const avatar = makeAvatar({ platforms: { discord: { enabled: false } } });
    const deps = makeBaseDeps({
      connected: false,
      credentialsValid: false,
      runtimeHealthy: false,
      mode: 'none',
    });

    const report = await evaluateActivationReadiness(avatar, baseContext, deps);
    const discordCheck = report.checks.find((c) => c.id === 'integration.discord.connection_healthy');

    expect(discordCheck!.status).toBe('not_applicable');
    expect(discordCheck!.reasonCode).toBe('DISCORD_NOT_ENABLED');
  });

  it('includes remediation metadata for runtime-unavailable case', async () => {
    const avatar = makeAvatar({ platforms: { discord: { enabled: true, mode: 'bot' } } });
    const deps = makeBaseDeps({
      connected: false,
      credentialsValid: true,
      runtimeHealthy: false,
      mode: 'bot',
      runtimeDetail: { gatewayEnabled: false, reason: 'gateway_not_deployed' },
    });

    const report = await evaluateActivationReadiness(avatar, baseContext, deps);
    const discordCheck = report.checks.find((c) => c.id === 'integration.discord.connection_healthy');

    expect(discordCheck!.remediation.length).toBeGreaterThan(0);
    const contactAction = discordCheck!.remediation.find((r) => r.kind === 'contact_support');
    expect(contactAction).toBeDefined();
    expect(contactAction!.supportHint?.reasonCode).toBe('DISCORD_RUNTIME_UNAVAILABLE');
  });
});
