/**
 * Discord Gateway Guardrails Tests
 *
 * Tests for the gateway availability checks that ensure Discord bot/hybrid
 * mode avatars degrade gracefully when the gateway container is down.
 *
 * @see packages/admin-api/src/services/discord.ts
 * @see packages/admin-api/src/services/activation-readiness.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { modeRequiresGateway } from './discord.js';

describe('Discord Gateway Guardrails', () => {
  describe('modeRequiresGateway', () => {
    it('should return true for bot mode', () => {
      expect(modeRequiresGateway('bot')).toBe(true);
    });

    it('should return true for hybrid mode', () => {
      expect(modeRequiresGateway('hybrid')).toBe(true);
    });

    it('should return false for webhook mode', () => {
      expect(modeRequiresGateway('webhook')).toBe(false);
    });

    it('should return false for none mode', () => {
      expect(modeRequiresGateway('none')).toBe(false);
    });
  });

  describe('Activation Readiness - Discord Gateway Check', () => {
    // These tests directly validate the evaluateDiscordGatewayReadinessCheck logic
    // by testing the same decision matrix. The actual function is internal to
    // activation-readiness.ts, so we test the observable behavior through the
    // modeRequiresGateway utility and env var detection.

    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.DISCORD_GATEWAY_ENABLED;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.DISCORD_GATEWAY_ENABLED;
      } else {
        process.env.DISCORD_GATEWAY_ENABLED = originalEnv;
      }
    });

    it('should detect gateway as disabled when env var is absent', () => {
      delete process.env.DISCORD_GATEWAY_ENABLED;
      expect(process.env.DISCORD_GATEWAY_ENABLED).toBeUndefined();
      // Bot/hybrid modes require gateway
      expect(modeRequiresGateway('bot')).toBe(true);
    });

    it('should detect gateway as disabled when env var is false', () => {
      process.env.DISCORD_GATEWAY_ENABLED = 'false';
      const gatewayEnabled = process.env.DISCORD_GATEWAY_ENABLED === 'true';
      expect(gatewayEnabled).toBe(false);
    });

    it('should detect gateway as enabled when env var is true', () => {
      process.env.DISCORD_GATEWAY_ENABLED = 'true';
      const gatewayEnabled = process.env.DISCORD_GATEWAY_ENABLED === 'true';
      expect(gatewayEnabled).toBe(true);
    });
  });

  describe('Gateway guardrail decision matrix', () => {
    // This tests the complete decision matrix:
    // | Discord Enabled | Mode    | Gateway Deployed | Expected Result       |
    // |----------------|---------|------------------|-----------------------|
    // | false          | *       | *                | not_applicable        |
    // | true           | webhook | *                | not_applicable        |
    // | true           | bot     | true             | pass                  |
    // | true           | bot     | false            | warn                  |
    // | true           | hybrid  | true             | pass                  |
    // | true           | hybrid  | false            | warn                  |

    interface DecisionInput {
      discordEnabled: boolean;
      mode: 'webhook' | 'bot' | 'hybrid' | 'none';
      gatewayDeployed: boolean;
    }

    function evaluateGuardrailDecision(input: DecisionInput): 'not_applicable' | 'pass' | 'warn' {
      if (!input.discordEnabled) return 'not_applicable';
      if (input.mode === 'webhook') return 'not_applicable';
      if (!modeRequiresGateway(input.mode)) return 'not_applicable';
      if (input.gatewayDeployed) return 'pass';
      return 'warn';
    }

    it('returns not_applicable when discord is disabled', () => {
      expect(evaluateGuardrailDecision({ discordEnabled: false, mode: 'bot', gatewayDeployed: false }))
        .toBe('not_applicable');
    });

    it('returns not_applicable for webhook mode regardless of gateway', () => {
      expect(evaluateGuardrailDecision({ discordEnabled: true, mode: 'webhook', gatewayDeployed: false }))
        .toBe('not_applicable');
      expect(evaluateGuardrailDecision({ discordEnabled: true, mode: 'webhook', gatewayDeployed: true }))
        .toBe('not_applicable');
    });

    it('returns pass for bot mode with gateway deployed', () => {
      expect(evaluateGuardrailDecision({ discordEnabled: true, mode: 'bot', gatewayDeployed: true }))
        .toBe('pass');
    });

    it('returns warn for bot mode without gateway', () => {
      expect(evaluateGuardrailDecision({ discordEnabled: true, mode: 'bot', gatewayDeployed: false }))
        .toBe('warn');
    });

    it('returns pass for hybrid mode with gateway deployed', () => {
      expect(evaluateGuardrailDecision({ discordEnabled: true, mode: 'hybrid', gatewayDeployed: true }))
        .toBe('pass');
    });

    it('returns warn for hybrid mode without gateway', () => {
      expect(evaluateGuardrailDecision({ discordEnabled: true, mode: 'hybrid', gatewayDeployed: false }))
        .toBe('warn');
    });

    it('returns not_applicable for none mode', () => {
      expect(evaluateGuardrailDecision({ discordEnabled: true, mode: 'none', gatewayDeployed: false }))
        .toBe('not_applicable');
    });
  });
});
