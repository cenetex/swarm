import { describe, expect, it } from 'bun:test';
import {
  AWS_MANAGED_SWARM_STARTER_PLAN,
  CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN,
  createAwsManagedSwarmDescriptor,
  hasHostedCapability,
  parseHostingStatus,
  type HostedPlatformDescriptor,
} from './platform.js';
import { initialHostedBillingState, initialHostedRuntimeState } from './lifecycle.js';

describe('hosted platform contract', () => {
  it('checks capabilities without implying provider details', () => {
    const descriptor: HostedPlatformDescriptor = {
      kind: 'cloudflare',
      mode: 'hosted',
      displayName: 'Hosted Swarm',
      capabilities: ['state', 'blobs', 'queues'],
    };

    expect(hasHostedCapability(descriptor, 'state')).toBe(true);
    expect(hasHostedCapability(descriptor, 'sandbox-compute')).toBe(false);
  });

  it('describes the AWS managed EC2 pool product tier', () => {
    const descriptor = createAwsManagedSwarmDescriptor();

    expect(descriptor.kind).toBe('aws');
    expect(descriptor.displayName).toBe('AWS Managed Swarm');
    expect(hasHostedCapability(descriptor, 'managed-runtime')).toBe(true);
    expect(hasHostedCapability(descriptor, 'container-pool')).toBe(true);
    expect(AWS_MANAGED_SWARM_STARTER_PLAN.priceUsdMonthly).toBe(9);
    expect(AWS_MANAGED_SWARM_STARTER_PLAN.architecture).toBe('aws-managed-ec2-pool');
  });

  it('describes the provider-neutral Cloudflare hosted tier', () => {
    expect(CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN.provider).toBe('cloudflare');
    expect(CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN.priceUsdMonthly).toBe(9);
    expect(CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN.architecture).toBe('cloudflare-hybrid-shared-runtime');
  });

  it('validates provider-neutral hosting status responses', () => {
    const now = Date.now();
    const status = parseHostingStatus({
      mode: 'local',
      local: {
        available: true,
        running: true,
        label: 'This device',
        detail: 'Local runtime',
      },
      hosted: {
        available: false,
        configured: false,
        label: 'Hosted 24/7',
        priceUsdMonthly: 9,
        provider: 'cloudflare',
        architecture: 'cloudflare-worker-scaffold',
        status: 'not-configured',
        entitlement: 'none',
        billing: initialHostedBillingState(now),
        runtime: initialHostedRuntimeState(now),
        modelWorkAllowed: false,
        detail: 'Provisioning is not connected.',
      },
    });

    expect(status.hosted.provider).toBe('cloudflare');
    expect(status.hosted.entitlement).toBe('none');
    const falseActive = parseHostingStatus({
      ...status,
      mode: 'hosted',
      hosted: { ...status.hosted, status: 'active', entitlement: 'active', modelWorkAllowed: true },
    }, now);
    expect(falseActive.mode).toBe('local');
    expect(falseActive.hosted.status).not.toBe('active');
    expect(falseActive.hosted.entitlement).toBe('none');
    const oldPlaceholder = { ...status, hosted: { ...status.hosted } } as Record<string, unknown>;
    const oldHosted = oldPlaceholder.hosted as Record<string, unknown>;
    delete oldHosted.billing;
    delete oldHosted.runtime;
    delete oldHosted.modelWorkAllowed;
    oldHosted.status = 'active';
    oldHosted.entitlement = 'active';
    const normalizedOld = parseHostingStatus(oldPlaceholder, now);
    expect(normalizedOld.mode).toBe('local');
    expect(normalizedOld.hosted.billing.status).toBe('eligible');
    expect(normalizedOld.hosted.runtime.status).toBe('stopped');
    expect(() =>
      parseHostingStatus({
        ...status,
        hosted: { ...status.hosted, entitlement: 'subscribed' },
      }),
    ).toThrow();
  });

  it('accepts a Cloudflare managed runtime instance', () => {
    const now = Date.now();
    const status = parseHostingStatus({
      mode: 'hosted',
      local: {
        available: true,
        running: false,
        label: 'This device',
        detail: 'Local runtime',
      },
      hosted: {
        available: true,
        configured: true,
        label: 'Hosted 24/7',
        priceUsdMonthly: 9,
        provider: 'cloudflare',
        architecture: 'cloudflare-hybrid-shared-runtime',
        status: 'active',
        entitlement: 'active',
        billing: {
          status: 'paid',
          planId: 'starter',
          evidence: { provider: 'billing-test', eventId: 'bill-1', occurredAt: now - 2_000 },
          updatedAt: now - 2_000,
        },
        runtime: {
          status: 'active',
          provider: 'runtime-test',
          planId: 'starter',
          runtimeId: 'runtime-1',
          endpoint: 'https://tenant-1.example',
          requestedAt: now - 2_000,
          provisionedAt: now - 1_000,
          health: { status: 'healthy', checkedAt: now },
          evidence: { provider: 'runtime-test', eventId: 'health-1', occurredAt: now },
          updatedAt: now,
        },
        modelWorkAllowed: true,
        detail: 'Hosted runtime active.',
        plan: CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN,
        instance: {
          provider: 'cloudflare',
          architecture: 'cloudflare-hybrid-shared-runtime',
          planId: 'starter',
          status: 'running',
          requestedAt: now,
          updatedAt: now,
          tenantId: 'tenant-1',
        },
      },
    }, now);

    expect(status.hosted.instance?.provider).toBe('cloudflare');
    expect(status.hosted.modelWorkAllowed).toBe(true);
  });
});
