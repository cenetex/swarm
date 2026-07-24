import type { CompositeKey } from '../services/key-value-store.js';
import { z } from 'zod';

export type SwarmRunMode = 'local' | 'hosted';

export type HostedPlatformKind = 'local' | 'cloudflare' | 'aws' | 'external';

export type HostedPlatformCapability =
  | 'state'
  | 'blobs'
  | 'queues'
  | 'cron'
  | 'workflows'
  | 'coordination'
  | 'realtime'
  | 'managed-runtime'
  | 'container-pool'
  | 'encrypted-user-secrets'
  | 'platform-secrets'
  | 'sandbox-compute';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type HostedStateEntry<T extends JsonObject = JsonObject> = {
  key: CompositeKey;
  value: T;
  updatedAt: number;
  expiresAt?: number;
};

export type HostedStatePutOptions = {
  onlyIfNotExists?: boolean;
  ttlSeconds?: number;
};

export interface HostedStateStore {
  get<T extends JsonObject = JsonObject>(key: CompositeKey): Promise<HostedStateEntry<T> | null>;
  put<T extends JsonObject = JsonObject>(key: CompositeKey, value: T, options?: HostedStatePutOptions): Promise<void>;
  delete(key: CompositeKey): Promise<void>;
  query<T extends JsonObject = JsonObject>(
    pk: string,
    options?: { skPrefix?: string; limit?: number; scanForward?: boolean },
  ): Promise<Array<HostedStateEntry<T>>>;
}

export type HostedBlob = {
  key: string;
  body: ArrayBuffer;
  contentType?: string;
  metadata?: Record<string, string>;
};

export type HostedBlobPutOptions = {
  contentType?: string;
  metadata?: Record<string, string>;
};

export interface HostedBlobStore {
  get(key: string): Promise<HostedBlob | null>;
  put(key: string, body: string | ArrayBuffer | Uint8Array, options?: HostedBlobPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export type HostedQueueMessage<T extends JsonObject = JsonObject> = {
  type: string;
  payload: T;
  enqueuedAt: number;
  delaySeconds?: number;
};

export interface HostedQueueService {
  send<T extends JsonObject = JsonObject>(
    queueName: string,
    message: Omit<HostedQueueMessage<T>, 'enqueuedAt'>,
  ): Promise<void>;
}

export type HostedScheduledJob<T extends JsonObject = JsonObject> = {
  id: string;
  type: string;
  payload: T;
  runAt: number;
  createdAt: number;
};

export interface HostedScheduler {
  schedule<T extends JsonObject = JsonObject>(
    job: Omit<HostedScheduledJob<T>, 'createdAt'>,
  ): Promise<void>;
  claimDueJobs(now: number, limit: number): Promise<Array<HostedScheduledJob>>;
}

export interface HostedCoordinator {
  withAvatarLock<T>(avatarId: string, work: () => Promise<T>): Promise<T>;
  publishAvatarEvent(avatarId: string, event: JsonObject): Promise<void>;
}

export interface HostedSecretStore {
  getPlatformSecret(name: string): Promise<string>;
  getUserSecret(accountId: string, name: string): Promise<string | null>;
  putUserSecret(accountId: string, name: string, value: string): Promise<void>;
  deleteUserSecret(accountId: string, name: string): Promise<void>;
}

export type HostedPlatformDescriptor = {
  kind: HostedPlatformKind;
  mode: SwarmRunMode;
  displayName: string;
  capabilities: HostedPlatformCapability[];
};

export type ManagedSwarmHostingPlan = {
  id: 'starter';
  label: string;
  priceUsdMonthly: number;
  provider: 'aws';
  architecture: 'aws-managed-ec2-pool';
  detail: string;
};

export type ManagedSwarmInstanceStatus =
  | 'requested'
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'error';

export type ManagedSwarmInstance = {
  provider: 'aws';
  architecture: 'aws-managed-ec2-pool';
  planId: ManagedSwarmHostingPlan['id'];
  status: ManagedSwarmInstanceStatus;
  requestedAt: number;
  updatedAt: number;
  region?: string;
  tenantId?: string;
  instanceId?: string;
  endpoint?: string;
  error?: string;
};

export const HostingStatusSchema = z.object({
  mode: z.enum(['local', 'hosted']),
  local: z.object({
    available: z.boolean(),
    running: z.boolean(),
    label: z.string(),
    detail: z.string(),
  }),
  hosted: z.object({
    available: z.boolean(),
    configured: z.boolean(),
    label: z.string(),
    priceUsdMonthly: z.number().nonnegative(),
    provider: z.enum(['aws', 'cloudflare', 'external']),
    architecture: z.string(),
    status: z.enum([
      'not-configured',
      'available',
      'requested',
      'provisioning',
      'active',
      'stopped',
      'error',
    ]),
    entitlement: z.enum(['none', 'checkout-pending', 'active']),
    detail: z.string(),
    plan: z.object({
      id: z.string(),
      label: z.string(),
      priceUsdMonthly: z.number().nonnegative(),
      provider: z.enum(['aws', 'cloudflare', 'external']),
      architecture: z.string(),
      detail: z.string(),
    }).optional(),
    instance: z.object({
      provider: z.literal('aws'),
      architecture: z.literal('aws-managed-ec2-pool'),
      planId: z.literal('starter'),
      status: z.enum(['requested', 'provisioning', 'running', 'stopped', 'error']),
      requestedAt: z.number(),
      updatedAt: z.number(),
      region: z.string().optional(),
      tenantId: z.string().optional(),
      instanceId: z.string().optional(),
      endpoint: z.string().url().optional(),
      error: z.string().optional(),
    }).optional(),
  }),
});

export type HostingStatus = z.infer<typeof HostingStatusSchema>;

export function parseHostingStatus(value: unknown): HostingStatus {
  return HostingStatusSchema.parse(value);
}

export const AWS_MANAGED_SWARM_STARTER_PLAN: ManagedSwarmHostingPlan = {
  id: 'starter',
  label: 'Hosted 24/7',
  priceUsdMonthly: 9,
  provider: 'aws',
  architecture: 'aws-managed-ec2-pool',
  detail: 'Managed hosted Swarm runtime.',
};

export function createAwsManagedSwarmDescriptor(): HostedPlatformDescriptor {
  return {
    kind: 'aws',
    mode: 'hosted',
    displayName: 'AWS Managed Swarm',
    capabilities: [
      'state',
      'blobs',
      'queues',
      'cron',
      'workflows',
      'coordination',
      'realtime',
      'managed-runtime',
      'container-pool',
      'encrypted-user-secrets',
      'platform-secrets',
      'sandbox-compute',
    ],
  };
}

export interface HostedPlatform {
  descriptor: HostedPlatformDescriptor;
  state: HostedStateStore;
  blobs: HostedBlobStore;
  queues: HostedQueueService;
  scheduler: HostedScheduler;
  coordinator: HostedCoordinator;
  secrets: HostedSecretStore;
}

export function hasHostedCapability(
  descriptor: HostedPlatformDescriptor,
  capability: HostedPlatformCapability,
): boolean {
  return descriptor.capabilities.includes(capability);
}
