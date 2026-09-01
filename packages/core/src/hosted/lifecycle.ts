import { z } from 'zod';

export const HOSTED_RUNTIME_HEALTH_TTL_MS = 5 * 60 * 1000;

export const HostedBillingStatusSchema = z.enum([
  'eligible',
  'checkout-pending',
  'paid',
  'cancellation-pending',
  'cancelled',
  'failed',
]);

export type HostedBillingStatus = z.infer<typeof HostedBillingStatusSchema>;

export const HostedRuntimeStatusSchema = z.enum([
  'requested',
  'provisioning',
  'health-checking',
  'active',
  'stopped',
  'cancelled',
  'failed',
]);

export type HostedRuntimeStatus = z.infer<typeof HostedRuntimeStatusSchema>;

export const HostedProviderEvidenceSchema = z.object({
  provider: z.string().trim().min(1),
  eventId: z.string().trim().min(1),
  occurredAt: z.number().int().nonnegative(),
});

export type HostedProviderEvidence = z.infer<typeof HostedProviderEvidenceSchema>;

export const HostedBillingStateSchema = z.object({
  status: HostedBillingStatusSchema,
  planId: z.string().trim().min(1).optional(),
  providerCustomerId: z.string().trim().min(1).optional(),
  providerSubscriptionId: z.string().trim().min(1).optional(),
  evidence: HostedProviderEvidenceSchema.optional(),
  updatedAt: z.number().int().nonnegative(),
  detail: z.string().optional(),
});

export type HostedBillingState = z.infer<typeof HostedBillingStateSchema>;

export const HostedRuntimeHealthSchema = z.object({
  status: z.enum(['healthy', 'unhealthy']),
  checkedAt: z.number().int().nonnegative(),
  detail: z.string().optional(),
});

export const HostedRuntimeStateSchema = z.object({
  status: HostedRuntimeStatusSchema,
  provider: z.string().trim().min(1).optional(),
  planId: z.string().trim().min(1).optional(),
  runtimeId: z.string().trim().min(1).optional(),
  endpoint: z.string().url().optional(),
  requestedAt: z.number().int().nonnegative().optional(),
  provisionedAt: z.number().int().nonnegative().optional(),
  health: HostedRuntimeHealthSchema.optional(),
  evidence: HostedProviderEvidenceSchema.optional(),
  updatedAt: z.number().int().nonnegative(),
  error: z.string().optional(),
});

export type HostedRuntimeState = z.infer<typeof HostedRuntimeStateSchema>;

export const HostedLifecycleSchema = z.object({
  billing: HostedBillingStateSchema,
  runtime: HostedRuntimeStateSchema,
});

export type HostedLifecycle = z.infer<typeof HostedLifecycleSchema>;

export type HostedBillingProviderEvent = HostedProviderEvidence & {
  type: 'subscription.paid' | 'subscription.cancellation-pending' | 'subscription.cancelled' | 'payment.failed';
  planId?: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  detail?: string;
};

export type HostedRuntimeProviderEvent = HostedProviderEvidence & {
  type:
    | 'provision.started'
    | 'provision.succeeded'
    | 'provision.failed'
    | 'health.healthy'
    | 'health.unhealthy'
    | 'runtime.stopped'
    | 'runtime.cancelled';
  planId?: string;
  runtimeId?: string;
  endpoint?: string;
  provisionedAt?: number;
  detail?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function cleanTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function initialHostedBillingState(now = Date.now()): HostedBillingState {
  return { status: 'eligible', updatedAt: now };
}

export function initialHostedRuntimeState(now = Date.now()): HostedRuntimeState {
  return { status: 'stopped', updatedAt: now };
}

export function isHostedHealthFresh(
  health: HostedRuntimeState['health'],
  now = Date.now(),
  maxAgeMs = HOSTED_RUNTIME_HEALTH_TTL_MS,
): boolean {
  return Boolean(
    health
      && health.status === 'healthy'
      && health.checkedAt <= now + 60_000
      && now - health.checkedAt <= maxAgeMs,
  );
}

export function isAuthoritativelyPaid(billing: HostedBillingState): boolean {
  return billing.status === 'paid' && Boolean(billing.evidence?.provider && billing.evidence.eventId);
}

export function isHostedRuntimeActive(
  runtime: HostedRuntimeState,
  now = Date.now(),
  maxAgeMs = HOSTED_RUNTIME_HEALTH_TTL_MS,
): boolean {
  return runtime.status === 'active'
    && Boolean(runtime.provider && runtime.runtimeId && runtime.provisionedAt !== undefined && runtime.evidence)
    && isHostedHealthFresh(runtime.health, now, maxAgeMs);
}

export function canPerformHostedModelWork(
  lifecycle: HostedLifecycle,
  now = Date.now(),
  maxAgeMs = HOSTED_RUNTIME_HEALTH_TTL_MS,
): boolean {
  return isAuthoritativelyPaid(lifecycle.billing) && isHostedRuntimeActive(lifecycle.runtime, now, maxAgeMs);
}

function normalizeEvidence(value: unknown): HostedProviderEvidence | undefined {
  const parsed = HostedProviderEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeHostedBillingState(value: unknown, now = Date.now()): HostedBillingState {
  if (!isRecord(value)) return initialHostedBillingState(now);
  const parsedStatus = HostedBillingStatusSchema.safeParse(value.status);
  const status = parsedStatus.success ? parsedStatus.data : 'eligible';
  const evidence = normalizeEvidence(value.evidence);
  const updatedAt = cleanTime(value.updatedAt) ?? now;
  const base = {
    ...(cleanString(value.planId) ? { planId: cleanString(value.planId) } : {}),
    ...(cleanString(value.providerCustomerId) ? { providerCustomerId: cleanString(value.providerCustomerId) } : {}),
    ...(cleanString(value.providerSubscriptionId) ? { providerSubscriptionId: cleanString(value.providerSubscriptionId) } : {}),
    ...(cleanString(value.detail) ? { detail: cleanString(value.detail) } : {}),
    updatedAt,
  };

  // Old `active`/`subscribed` placeholders and paid rows without provider evidence
  // are deliberately treated as eligible. A local value must never mint access.
  if (status === 'paid' && !evidence) return { ...base, status: 'eligible' };
  return { ...base, status, ...(evidence ? { evidence } : {}) };
}

export function normalizeHostedRuntimeState(value: unknown, now = Date.now()): HostedRuntimeState {
  if (!isRecord(value)) return initialHostedRuntimeState(now);
  const parsedStatus = HostedRuntimeStatusSchema.safeParse(value.status);
  const status = parsedStatus.success ? parsedStatus.data : 'stopped';
  const evidence = normalizeEvidence(value.evidence);
  const healthResult = HostedRuntimeHealthSchema.safeParse(value.health);
  const health = healthResult.success ? healthResult.data : undefined;
  const runtimeId = cleanString(value.runtimeId);
  const provider = cleanString(value.provider);
  const provisionedAt = cleanTime(value.provisionedAt);
  const updatedAt = cleanTime(value.updatedAt) ?? now;
  const base: Omit<HostedRuntimeState, 'status'> = {
    ...(provider ? { provider } : {}),
    ...(cleanString(value.planId) ? { planId: cleanString(value.planId) } : {}),
    ...(runtimeId ? { runtimeId } : {}),
    ...(cleanString(value.endpoint) ? { endpoint: cleanString(value.endpoint) } : {}),
    ...(cleanTime(value.requestedAt) === undefined ? {} : { requestedAt: cleanTime(value.requestedAt) }),
    ...(provisionedAt === undefined ? {} : { provisionedAt }),
    ...(health ? { health } : {}),
    ...(evidence ? { evidence } : {}),
    ...(cleanString(value.error) ? { error: cleanString(value.error) } : {}),
    updatedAt,
  };

  if (base.endpoint && !z.string().url().safeParse(base.endpoint).success) delete base.endpoint;
  if (status === 'active' && (!provider || !runtimeId || !provisionedAt || !evidence)) {
    return { ...base, status: 'stopped' };
  }
  if (status === 'active' && !isHostedHealthFresh(health, now)) {
    return { ...base, status: 'health-checking' };
  }
  return { ...base, status };
}

export function normalizeHostedLifecycle(value: unknown, now = Date.now()): HostedLifecycle {
  const record = isRecord(value) ? value : {};
  return {
    billing: normalizeHostedBillingState(record.billing, now),
    runtime: normalizeHostedRuntimeState(record.runtime, now),
  };
}

export function markHostedCheckoutPending(
  current: HostedBillingState,
  now = Date.now(),
): HostedBillingState {
  if (current.status === 'paid' || current.status === 'cancellation-pending') return current;
  return { ...current, status: 'checkout-pending', updatedAt: now };
}

export function applyHostedBillingEvent(
  currentValue: unknown,
  event: HostedBillingProviderEvent,
  now = Date.now(),
): HostedBillingState {
  const current = normalizeHostedBillingState(currentValue, now);
  const previousEventAt = current.evidence?.occurredAt ?? -1;
  if (event.occurredAt < previousEventAt || event.eventId === current.evidence?.eventId) return current;
  if (
    event.occurredAt === previousEventAt
    && event.type === 'subscription.paid'
    && (current.status === 'cancelled' || current.status === 'failed')
  ) return current;
  const status: HostedBillingStatus = event.type === 'subscription.paid'
    ? 'paid'
    : event.type === 'subscription.cancellation-pending'
      ? 'cancellation-pending'
      : event.type === 'subscription.cancelled'
        ? 'cancelled'
        : 'failed';
  return {
    status,
    ...(event.planId ?? current.planId ? { planId: event.planId ?? current.planId } : {}),
    ...(event.providerCustomerId ?? current.providerCustomerId
      ? { providerCustomerId: event.providerCustomerId ?? current.providerCustomerId }
      : {}),
    ...(event.providerSubscriptionId ?? current.providerSubscriptionId
      ? { providerSubscriptionId: event.providerSubscriptionId ?? current.providerSubscriptionId }
      : {}),
    evidence: { provider: event.provider, eventId: event.eventId, occurredAt: event.occurredAt },
    updatedAt: now,
    ...(event.detail ? { detail: event.detail } : {}),
  };
}

export function requestHostedRuntime(
  billingValue: unknown,
  currentValue: unknown,
  now = Date.now(),
): HostedRuntimeState {
  const billing = normalizeHostedBillingState(billingValue, now);
  const current = normalizeHostedRuntimeState(currentValue, now);
  if (!isAuthoritativelyPaid(billing)) return current;
  if (current.status === 'active' || current.status === 'provisioning' || current.status === 'health-checking') {
    return current;
  }
  return {
    status: 'requested',
    planId: billing.planId,
    requestedAt: now,
    updatedAt: now,
  };
}

export function applyHostedRuntimeEvent(
  currentValue: unknown,
  event: HostedRuntimeProviderEvent,
  now = Date.now(),
): HostedRuntimeState {
  const current = normalizeHostedRuntimeState(currentValue, now);
  const previousEventAt = current.evidence?.occurredAt ?? -1;
  if (event.occurredAt < previousEventAt || event.eventId === current.evidence?.eventId) return current;
  if (
    event.occurredAt === previousEventAt
    && (event.type === 'health.healthy' || event.type === 'provision.succeeded')
    && (current.status === 'cancelled' || current.status === 'failed')
  ) return current;
  const evidence = { provider: event.provider, eventId: event.eventId, occurredAt: event.occurredAt };
  const common = {
    ...current,
    provider: event.provider,
    ...(event.planId ?? current.planId ? { planId: event.planId ?? current.planId } : {}),
    ...(event.runtimeId ?? current.runtimeId ? { runtimeId: event.runtimeId ?? current.runtimeId } : {}),
    ...(event.endpoint ?? current.endpoint ? { endpoint: event.endpoint ?? current.endpoint } : {}),
    evidence,
    updatedAt: now,
  };
  switch (event.type) {
    case 'provision.started':
      return { ...common, status: 'provisioning' };
    case 'provision.succeeded':
      if (!(event.runtimeId ?? current.runtimeId)) {
        return { ...common, status: 'failed', error: 'Provisioning succeeded without a runtime id.' };
      }
      return {
        ...common,
        status: 'health-checking',
        provisionedAt: event.provisionedAt ?? event.occurredAt,
        health: undefined,
        error: undefined,
      };
    case 'health.healthy': {
      const runtimeId = event.runtimeId ?? current.runtimeId;
      const provisionedAt = event.provisionedAt ?? current.provisionedAt;
      if (!runtimeId || !provisionedAt) {
        return { ...common, status: 'failed', error: 'Health evidence has no provisioned runtime.' };
      }
      return {
        ...common,
        runtimeId,
        provisionedAt,
        status: 'active',
        health: { status: 'healthy', checkedAt: event.occurredAt, ...(event.detail ? { detail: event.detail } : {}) },
        error: undefined,
      };
    }
    case 'health.unhealthy':
      return {
        ...common,
        status: 'failed',
        health: { status: 'unhealthy', checkedAt: event.occurredAt, ...(event.detail ? { detail: event.detail } : {}) },
        error: event.detail ?? 'Runtime health check failed.',
      };
    case 'runtime.stopped':
      return { ...common, status: 'stopped', ...(event.detail ? { error: event.detail } : {}) };
    case 'runtime.cancelled':
      return { ...common, status: 'cancelled', ...(event.detail ? { error: event.detail } : {}) };
    case 'provision.failed':
      return { ...common, status: 'failed', error: event.detail ?? 'Runtime provisioning failed.' };
  }
}

export function reconcileHostedLifecycle(
  value: unknown,
  now = Date.now(),
  maxAgeMs = HOSTED_RUNTIME_HEALTH_TTL_MS,
): HostedLifecycle {
  const lifecycle = normalizeHostedLifecycle(value, now);
  if (!isAuthoritativelyPaid(lifecycle.billing)) {
    if (lifecycle.runtime.status === 'active'
      || lifecycle.runtime.status === 'requested'
      || lifecycle.runtime.status === 'provisioning'
      || lifecycle.runtime.status === 'health-checking') {
      return {
        ...lifecycle,
        runtime: {
          ...lifecycle.runtime,
          status: lifecycle.billing.status === 'cancelled' ? 'cancelled' : 'stopped',
          health: undefined,
          updatedAt: now,
          error: `Billing state ${lifecycle.billing.status} does not permit model work.`,
        },
      };
    }
    return lifecycle;
  }
  if (lifecycle.runtime.status === 'active' && !isHostedHealthFresh(lifecycle.runtime.health, now, maxAgeMs)) {
    return {
      ...lifecycle,
      runtime: {
        ...lifecycle.runtime,
        status: 'health-checking',
        updatedAt: now,
        error: 'Runtime health evidence is stale.',
      },
    };
  }
  return lifecycle;
}
