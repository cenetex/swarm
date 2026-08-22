import { describe, expect, it } from 'bun:test';
import {
  AWS_MANAGED_SWARM_STARTER_PLAN,
  CLOUDFLARE_HOSTED_SWARM_STARTER_PLAN,
  createAwsManagedSwarmDescriptor,
  hasHostedCapability,
  parseHostingStatus,
  type HostedPlatformDescriptor,
} from './platform.js';

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
        detail: 'Provisioning is not connected.',
      },
    });

    expect(status.hosted.provider).toBe('cloudflare');
    expect(status.hosted.entitlement).toBe('none');
    expect(() =>
      parseHostingStatus({
        ...status,
        hosted: { ...status.hosted, status: 'active' },
      }),
    ).not.toThrow();
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
    });

    expect(status.hosted.instance?.provider).toBe('cloudflare');
  });
});
