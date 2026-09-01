import { describe, expect, it } from 'bun:test';
import {
  applyHostedBillingEvent,
  applyHostedRuntimeEvent,
  canPerformHostedModelWork,
  initialHostedBillingState,
  initialHostedRuntimeState,
  markHostedCheckoutPending,
  normalizeHostedLifecycle,
  reconcileHostedLifecycle,
  requestHostedRuntime,
} from './lifecycle.js';

const NOW = 2_000_000;

describe('hosted lifecycle', () => {
  it('never treats checkout as payment', () => {
    const billing = markHostedCheckoutPending(initialHostedBillingState(NOW), NOW + 1);
    expect(billing.status).toBe('checkout-pending');
    expect(canPerformHostedModelWork({ billing, runtime: initialHostedRuntimeState(NOW) }, NOW + 1)).toBe(false);
  });

  it('only accepts paid state from ordered provider evidence', () => {
    const pending = markHostedCheckoutPending(initialHostedBillingState(NOW), NOW);
    const paid = applyHostedBillingEvent(pending, {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'event-paid',
      occurredAt: NOW + 20,
      planId: 'starter',
    }, NOW + 20);
    const cancelled = applyHostedBillingEvent(paid, {
      type: 'subscription.cancelled',
      provider: 'billing-provider',
      eventId: 'event-cancelled',
      occurredAt: NOW + 40,
    }, NOW + 40);
    const delayedPaid = applyHostedBillingEvent(cancelled, {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'event-old-paid',
      occurredAt: NOW + 30,
    }, NOW + 50);

    expect(paid.status).toBe('paid');
    expect(cancelled.status).toBe('cancelled');
    expect(delayedPaid).toEqual(cancelled);
  });

  it('requires provisioning and a fresh successful health check before active', () => {
    const billing = applyHostedBillingEvent(initialHostedBillingState(NOW), {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'bill-1',
      occurredAt: NOW,
    }, NOW);
    const requested = requestHostedRuntime(billing, initialHostedRuntimeState(NOW), NOW + 1);
    const provisioned = applyHostedRuntimeEvent(requested, {
      type: 'provision.succeeded',
      provider: 'runtime-provider',
      eventId: 'runtime-1',
      occurredAt: NOW + 2,
      runtimeId: 'host-1',
      endpoint: 'https://host-1.example',
    }, NOW + 2);

    expect(requested.status).toBe('requested');
    expect(provisioned.status).toBe('health-checking');
    expect(canPerformHostedModelWork({ billing, runtime: provisioned }, NOW + 2)).toBe(false);

    const active = applyHostedRuntimeEvent(provisioned, {
      type: 'health.healthy',
      provider: 'runtime-provider',
      eventId: 'health-1',
      occurredAt: NOW + 3,
    }, NOW + 3);
    expect(active.status).toBe('active');
    expect(canPerformHostedModelWork({ billing, runtime: active }, NOW + 3)).toBe(true);
  });

  it('blocks failed, cancelled, unhealthy, and stale lifecycle states', () => {
    const billing = applyHostedBillingEvent(initialHostedBillingState(NOW), {
      type: 'subscription.paid',
      provider: 'billing-provider',
      eventId: 'bill-1',
      occurredAt: NOW,
    }, NOW);
    const active = applyHostedRuntimeEvent({
      status: 'health-checking',
      provider: 'runtime-provider',
      runtimeId: 'host-1',
      provisionedAt: NOW,
      evidence: { provider: 'runtime-provider', eventId: 'runtime-1', occurredAt: NOW },
      updatedAt: NOW,
    }, {
      type: 'health.healthy',
      provider: 'runtime-provider',
      eventId: 'health-1',
      occurredAt: NOW + 1,
    }, NOW + 1);
    const unhealthy = applyHostedRuntimeEvent(active, {
      type: 'health.unhealthy',
      provider: 'runtime-provider',
      eventId: 'health-2',
      occurredAt: NOW + 2,
    }, NOW + 2);
    const cancelled = applyHostedBillingEvent(billing, {
      type: 'subscription.cancelled',
      provider: 'billing-provider',
      eventId: 'bill-2',
      occurredAt: NOW + 2,
    }, NOW + 2);

    expect(canPerformHostedModelWork({ billing, runtime: unhealthy }, NOW + 2)).toBe(false);
    expect(canPerformHostedModelWork({ billing: cancelled, runtime: active }, NOW + 2)).toBe(false);
    expect(reconcileHostedLifecycle({ billing, runtime: active }, NOW + 600_000).runtime.status)
      .toBe('health-checking');
  });

  it('normalizes old placeholders and unknown records to safe states', () => {
    const normalized = normalizeHostedLifecycle({
      billing: { status: 'active', updatedAt: NOW },
      runtime: {
        status: 'active',
        provider: 'aws',
        runtimeId: 'placeholder',
        endpoint: 'https://placeholder.example',
        updatedAt: NOW,
      },
    }, NOW);
    expect(normalized.billing.status).toBe('eligible');
    expect(normalized.runtime.status).toBe('stopped');
    expect(canPerformHostedModelWork(normalized, NOW)).toBe(false);
  });

  it('reconciliation stops active runtime when billing fails', () => {
    const lifecycle = normalizeHostedLifecycle({
      billing: {
        status: 'failed',
        evidence: { provider: 'billing-provider', eventId: 'failure-1', occurredAt: NOW },
        updatedAt: NOW,
      },
      runtime: {
        status: 'active',
        provider: 'runtime-provider',
        runtimeId: 'host-1',
        provisionedAt: NOW - 1,
        health: { status: 'healthy', checkedAt: NOW },
        evidence: { provider: 'runtime-provider', eventId: 'health-1', occurredAt: NOW },
        updatedAt: NOW,
      },
    }, NOW);
    const reconciled = reconcileHostedLifecycle(lifecycle, NOW);
    expect(reconciled.runtime.status).toBe('stopped');
    expect(canPerformHostedModelWork(reconciled, NOW)).toBe(false);
  });
});
