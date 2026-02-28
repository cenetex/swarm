import { describe, expect, it } from 'vitest';
import type { TelegramDiagnosis } from './telegram-admin.js';
import { computeTelegramRepairPlan } from './telegram-admin.js';

function baseDiagnosis(overrides: Partial<TelegramDiagnosis> = {}): TelegramDiagnosis {
  return {
    avatarId: 'avatar-1',
    platformEnabled: true,
    tokenPresent: true,
    webhookSecretPresent: true,
    webhook: {
      expectedUrl: 'https://staging-swarm.rati.chat/webhook/telegram/avatar-1',
      actualUrl: 'https://staging-swarm.rati.chat/webhook/telegram/avatar-1',
      isCorrectUrl: true,
      pendingUpdateCount: 0,
    },
    issues: [],
    ...overrides,
  };
}

describe('computeTelegramRepairPlan', () => {
  it('skips when Telegram disabled by default', () => {
    const diagnosis = baseDiagnosis({ platformEnabled: false });
    const plan = computeTelegramRepairPlan(diagnosis);
    expect(plan.action).toBe('skip');
  });

  it('repairs when webhook_url_mismatch issue present', () => {
    const diagnosis = baseDiagnosis({
      webhook: {
        expectedUrl: 'https://staging-swarm.rati.chat/webhook/telegram/avatar-1',
        actualUrl: 'https://abcd.execute-api.us-east-1.amazonaws.com/webhook/telegram/avatar-1',
        isCorrectUrl: false,
      },
      issues: [
        {
          code: 'webhook_url_mismatch',
          message: 'mismatch',
        },
      ],
    });

    const plan = computeTelegramRepairPlan(diagnosis);
    expect(plan.action).toBe('repair');
  });

  it('skips when already correct (default safe behavior)', () => {
    const diagnosis = baseDiagnosis();
    const plan = computeTelegramRepairPlan(diagnosis);
    expect(plan).toEqual({ action: 'skip', reason: 'Webhook already matches expected URL' });
  });

  it('repairs when forced, even if already correct', () => {
    const diagnosis = baseDiagnosis();
    const plan = computeTelegramRepairPlan(diagnosis, { force: true });
    expect(plan.action).toBe('repair');
  });

  it('repairs disabled avatars when includeDisabled=true and mismatch exists', () => {
    const diagnosis = baseDiagnosis({
      platformEnabled: false,
      issues: [{ code: 'webhook_url_mismatch', message: 'mismatch' }],
    });

    const plan = computeTelegramRepairPlan(diagnosis, { includeDisabled: true });
    expect(plan.action).toBe('repair');
  });

  it('repairs on pending updates only when enabled', () => {
    const diagnosis = baseDiagnosis({
      webhook: {
        expectedUrl: 'https://staging-swarm.rati.chat/webhook/telegram/avatar-1',
        actualUrl: 'https://staging-swarm.rati.chat/webhook/telegram/avatar-1',
        isCorrectUrl: true,
        pendingUpdateCount: 3,
      },
      issues: [{ code: 'webhook_pending_updates', message: 'pending' }],
    });

    const planDefault = computeTelegramRepairPlan(diagnosis);
    expect(planDefault.action).toBe('skip');

    const plan = computeTelegramRepairPlan(diagnosis, { repairOnPendingUpdates: true });
    expect(plan.action).toBe('repair');
  });

  it('repairs on last error only when enabled', () => {
    const diagnosis = baseDiagnosis({
      webhook: {
        expectedUrl: 'https://staging-swarm.rati.chat/webhook/telegram/avatar-1',
        actualUrl: 'https://staging-swarm.rati.chat/webhook/telegram/avatar-1',
        isCorrectUrl: true,
        lastErrorMessage: 'Service unavailable',
      },
      issues: [{ code: 'webhook_last_error', message: 'last error' }],
    });

    const planDefault = computeTelegramRepairPlan(diagnosis);
    expect(planDefault.action).toBe('skip');

    const plan = computeTelegramRepairPlan(diagnosis, { repairOnLastError: true });
    expect(plan.action).toBe('repair');
  });
});
