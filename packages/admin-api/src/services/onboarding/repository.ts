import { createHash } from 'crypto';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@swarm/core';
import { logger } from '@swarm/core';
import {
  ONBOARDING_CONTRACT_VERSION,
  type OnboardingActionType,
  type OnboardingStateRecord,
  type OnboardingStateSnapshot,
  type StoredOnboardingIdempotencyItem,
  type StoredOnboardingStateItem,
} from './types.js';
import {
  createInitialOnboardingState,
  normalizeOnboardingStateSnapshot,
} from './state-machine.js';
import { getDynamoClient } from '../dynamo-client.js';

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const STATE_SK = 'ONBOARDING#STATE' as const;
const IDEMPOTENCY_SK_PREFIX = 'ONBOARDING#IDEMPOTENCY';
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_IN_FLIGHT_MS = 30 * 1000;
const TRANSITION_LOCK_MS = 15 * 1000;

const dynamoClient = getDynamoClient();

function avatarPk(avatarId: string): string {
  return `AVATAR#${avatarId}`;
}

function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

function toStateRecord(item: Partial<StoredOnboardingStateItem> | undefined, now: number): OnboardingStateRecord {
  const snapshot = normalizeOnboardingStateSnapshot(item, now);
  return {
    snapshot,
    transitionLockRequestId: typeof item?.transitionLockRequestId === 'string'
      ? item.transitionLockRequestId
      : null,
    transitionLockActionType: item?.transitionLockActionType === 'status'
      || item?.transitionLockActionType === 'execute_step'
      || item?.transitionLockActionType === 'restart'
      || item?.transitionLockActionType === 'skip_optional'
      ? item.transitionLockActionType
      : null,
    transitionLockExpiresAt: typeof item?.transitionLockExpiresAt === 'number'
      ? item.transitionLockExpiresAt
      : null,
  };
}

function createStateItem(avatarId: string, snapshot: OnboardingStateSnapshot): StoredOnboardingStateItem {
  return {
    pk: avatarPk(avatarId),
    sk: STATE_SK,
    entityType: 'onboarding_state_v1',
    avatarId,
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    state: snapshot.state,
    currentStepId: snapshot.currentStepId,
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    steps: snapshot.steps,
  };
}

async function readStateItem(avatarId: string): Promise<Partial<StoredOnboardingStateItem> | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: avatarPk(avatarId),
      sk: STATE_SK,
    },
  }));

  return (result.Item as Partial<StoredOnboardingStateItem> | undefined) ?? null;
}

export async function getOrCreateOnboardingStateRecord(
  avatarId: string,
  now: number
): Promise<OnboardingStateRecord> {
  const existing = await readStateItem(avatarId);
  if (existing) {
    return toStateRecord(existing, now);
  }

  const initialSnapshot = createInitialOnboardingState(now);

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: createStateItem(avatarId, initialSnapshot),
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    }));

    return toStateRecord(createStateItem(avatarId, initialSnapshot), now);
  } catch (error) {
    if (!isConditionalCheckFailure(error)) {
      throw error;
    }

    const raced = await readStateItem(avatarId);
    return toStateRecord(raced ?? createStateItem(avatarId, initialSnapshot), now);
  }
}

export interface AcquireTransitionLockParams {
  avatarId: string;
  requestId: string;
  actionType: Exclude<OnboardingActionType, 'status'>;
  now: number;
}

export type AcquireTransitionLockResult =
  | {
      acquired: true;
      record: OnboardingStateRecord;
    }
  | {
      acquired: false;
      record: OnboardingStateRecord;
      retryAfterMs: number;
    };

export async function acquireTransitionLock(
  params: AcquireTransitionLockParams,
  attempt: number = 0
): Promise<AcquireTransitionLockResult> {
  await getOrCreateOnboardingStateRecord(params.avatarId, params.now);

  try {
    const result = await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: avatarPk(params.avatarId),
        sk: STATE_SK,
      },
      UpdateExpression: [
        'SET transitionLockRequestId = :requestId',
        'transitionLockActionType = :actionType',
        'transitionLockExpiresAt = :lockExpiresAt',
      ].join(', '),
      ConditionExpression: [
        'attribute_exists(pk) AND attribute_exists(sk)',
        'AND (attribute_not_exists(transitionLockExpiresAt)',
        'OR transitionLockExpiresAt <= :now',
        'OR transitionLockRequestId = :requestId)',
      ].join(' '),
      ExpressionAttributeValues: {
        ':requestId': params.requestId,
        ':actionType': params.actionType,
        ':lockExpiresAt': params.now + TRANSITION_LOCK_MS,
        ':now': params.now,
      },
      ReturnValues: 'ALL_NEW',
    }));

    return {
      acquired: true,
      record: toStateRecord(result.Attributes as Partial<StoredOnboardingStateItem> | undefined, params.now),
    };
  } catch (error) {
    if (!isConditionalCheckFailure(error)) {
      throw error;
    }

    const current = await getOrCreateOnboardingStateRecord(params.avatarId, params.now);
    const expiresAt = current.transitionLockExpiresAt ?? 0;

    if (expiresAt <= params.now && attempt < 1) {
      return acquireTransitionLock(params, attempt + 1);
    }

    return {
      acquired: false,
      record: current,
      retryAfterMs: Math.max(250, expiresAt - params.now),
    };
  }
}

export async function releaseTransitionLock(
  avatarId: string,
  requestId: string
): Promise<void> {
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: avatarPk(avatarId),
        sk: STATE_SK,
      },
      UpdateExpression: 'REMOVE transitionLockRequestId, transitionLockActionType, transitionLockExpiresAt',
      ConditionExpression: 'transitionLockRequestId = :requestId',
      ExpressionAttributeValues: {
        ':requestId': requestId,
      },
    }));
  } catch (error) {
    if (isConditionalCheckFailure(error)) {
      return;
    }

    logger.warn('Failed to release onboarding transition lock', {
      avatarId,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type SaveSnapshotResult =
  | {
      ok: true;
      record: OnboardingStateRecord;
    }
  | {
      ok: false;
      reason: 'revision_conflict' | 'busy';
      record: OnboardingStateRecord;
    };

export async function saveOnboardingSnapshot(params: {
  avatarId: string;
  requestId: string;
  expectedRevision: number;
  snapshot: OnboardingStateSnapshot;
  now: number;
}): Promise<SaveSnapshotResult> {
  try {
    const result = await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: avatarPk(params.avatarId),
        sk: STATE_SK,
      },
      UpdateExpression: [
        'SET #state = :state',
        'currentStepId = :currentStepId',
        '#revision = :revision',
        'updatedAt = :updatedAt',
        'steps = :steps',
        'contractVersion = :contractVersion',
      ].join(', '),
      ConditionExpression: '#revision = :expectedRevision AND transitionLockRequestId = :requestId',
      ExpressionAttributeNames: {
        '#state': 'state',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':state': params.snapshot.state,
        ':currentStepId': params.snapshot.currentStepId,
        ':revision': params.snapshot.revision,
        ':updatedAt': params.snapshot.updatedAt,
        ':steps': params.snapshot.steps,
        ':contractVersion': ONBOARDING_CONTRACT_VERSION,
        ':expectedRevision': params.expectedRevision,
        ':requestId': params.requestId,
      },
      ReturnValues: 'ALL_NEW',
    }));

    return {
      ok: true,
      record: toStateRecord(result.Attributes as Partial<StoredOnboardingStateItem> | undefined, params.now),
    };
  } catch (error) {
    if (!isConditionalCheckFailure(error)) {
      throw error;
    }

    const latest = await getOrCreateOnboardingStateRecord(params.avatarId, params.now);
    const isBusy = latest.transitionLockRequestId
      && latest.transitionLockRequestId !== params.requestId
      && (latest.transitionLockExpiresAt ?? 0) > params.now;

    return {
      ok: false,
      reason: isBusy ? 'busy' : 'revision_conflict',
      record: latest,
    };
  }
}

function idempotencySk(
  actionType: Exclude<OnboardingActionType, 'status'>,
  stepId: string | null,
  idempotencyKey: string
): string {
  const stepToken = stepId ? encodeURIComponent(stepId) : '-';
  const keyToken = encodeURIComponent(idempotencyKey);
  return `${IDEMPOTENCY_SK_PREFIX}#${actionType}#${stepToken}#${keyToken}`;
}

function normalizeIdempotencyItem(
  item: Partial<StoredOnboardingIdempotencyItem> | null,
): StoredOnboardingIdempotencyItem | null {
  if (!item) {
    return null;
  }

  if (item.status !== 'in_flight' && item.status !== 'finished') {
    return null;
  }

  if (typeof item.fingerprint !== 'string') {
    return null;
  }

  if (typeof item.idempotencyKey !== 'string' || typeof item.scope !== 'string') {
    return null;
  }

  if (item.actionType !== 'execute_step' && item.actionType !== 'restart' && item.actionType !== 'skip_optional') {
    return null;
  }

  return {
    pk: typeof item.pk === 'string' ? item.pk : '',
    sk: typeof item.sk === 'string' ? item.sk : '',
    entityType: 'onboarding_idempotency_v1',
    avatarId: typeof item.avatarId === 'string' ? item.avatarId : '',
    actionType: item.actionType,
    stepId: typeof item.stepId === 'string' ? item.stepId : null,
    idempotencyKey: item.idempotencyKey,
    scope: item.scope,
    fingerprint: item.fingerprint,
    status: item.status,
    inFlightUntil: typeof item.inFlightUntil === 'number' ? item.inFlightUntil : 0,
    requestMethod: typeof item.requestMethod === 'string' ? item.requestMethod : 'POST',
    requestPath: typeof item.requestPath === 'string' ? item.requestPath : '/',
    requestBodyHash: typeof item.requestBodyHash === 'string' ? item.requestBodyHash : '',
    responseStatusCode: typeof item.responseStatusCode === 'number' ? item.responseStatusCode : undefined,
    responseBody: typeof item.responseBody === 'string' ? item.responseBody : undefined,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    completedAt: typeof item.completedAt === 'number' ? item.completedAt : undefined,
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
    ttl: typeof item.ttl === 'number' ? item.ttl : 0,
  };
}

async function readIdempotencyItem(params: {
  avatarId: string;
  actionType: Exclude<OnboardingActionType, 'status'>;
  stepId: string | null;
  idempotencyKey: string;
}): Promise<StoredOnboardingIdempotencyItem | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: avatarPk(params.avatarId),
      sk: idempotencySk(params.actionType, params.stepId, params.idempotencyKey),
    },
  }));

  return normalizeIdempotencyItem(result.Item as Partial<StoredOnboardingIdempotencyItem> | null);
}

export interface AcquireIdempotencyParams {
  avatarId: string;
  actionType: Exclude<OnboardingActionType, 'status'>;
  stepId: string | null;
  idempotencyKey: string;
  scope: string;
  fingerprint: string;
  method: string;
  path: string;
  normalizedBody: string;
  now: number;
}

export type AcquireIdempotencyResult =
  | { type: 'acquired' }
  | { type: 'replay'; record: StoredOnboardingIdempotencyItem }
  | {
      type: 'conflict';
      code: 'idempotency_key_reused' | 'idempotency_in_flight';
      retryAfterMs: number | null;
    };

export async function acquireIdempotencyRecord(
  params: AcquireIdempotencyParams,
  attempt: number = 0
): Promise<AcquireIdempotencyResult> {
  const existing = await readIdempotencyItem(params);

  if (!existing) {
    const expiresAt = params.now + IDEMPOTENCY_RETENTION_MS;

    try {
      await dynamoClient.send(new PutCommand({
        TableName: ADMIN_TABLE,
        Item: {
          pk: avatarPk(params.avatarId),
          sk: idempotencySk(params.actionType, params.stepId, params.idempotencyKey),
          entityType: 'onboarding_idempotency_v1',
          avatarId: params.avatarId,
          actionType: params.actionType,
          stepId: params.stepId,
          idempotencyKey: params.idempotencyKey,
          scope: params.scope,
          fingerprint: params.fingerprint,
          status: 'in_flight',
          inFlightUntil: params.now + IDEMPOTENCY_IN_FLIGHT_MS,
          requestMethod: params.method,
          requestPath: params.path,
          requestBodyHash: createHash('sha256').update(params.normalizedBody).digest('hex'),
          createdAt: params.now,
          updatedAt: params.now,
          expiresAt,
          ttl: Math.floor(expiresAt / 1000),
        } satisfies StoredOnboardingIdempotencyItem,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }));

      return { type: 'acquired' };
    } catch (error) {
      if (!isConditionalCheckFailure(error) || attempt >= 1) {
        if (!isConditionalCheckFailure(error)) {
          throw error;
        }
      }
      return acquireIdempotencyRecord(params, attempt + 1);
    }
  }

  if (existing.fingerprint !== params.fingerprint) {
    return {
      type: 'conflict',
      code: 'idempotency_key_reused',
      retryAfterMs: null,
    };
  }

  if (existing.status === 'finished' && typeof existing.responseStatusCode === 'number' && typeof existing.responseBody === 'string') {
    return {
      type: 'replay',
      record: existing,
    };
  }

  if (existing.status === 'in_flight') {
    if (existing.inFlightUntil > params.now) {
      return {
        type: 'conflict',
        code: 'idempotency_in_flight',
        retryAfterMs: Math.max(250, existing.inFlightUntil - params.now),
      };
    }

    try {
      await dynamoClient.send(new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: {
          pk: avatarPk(params.avatarId),
          sk: idempotencySk(params.actionType, params.stepId, params.idempotencyKey),
        },
        UpdateExpression: 'SET #status = :status, inFlightUntil = :inFlightUntil, updatedAt = :updatedAt',
        ConditionExpression: '#status = :currentStatus AND fingerprint = :fingerprint AND inFlightUntil <= :now',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': 'in_flight',
          ':currentStatus': 'in_flight',
          ':inFlightUntil': params.now + IDEMPOTENCY_IN_FLIGHT_MS,
          ':updatedAt': params.now,
          ':fingerprint': params.fingerprint,
          ':now': params.now,
        },
      }));

      return { type: 'acquired' };
    } catch (error) {
      if (!isConditionalCheckFailure(error) || attempt >= 1) {
        if (!isConditionalCheckFailure(error)) {
          throw error;
        }
      }
      return acquireIdempotencyRecord(params, attempt + 1);
    }
  }

  return {
    type: 'conflict',
    code: 'idempotency_key_reused',
    retryAfterMs: null,
  };
}

export async function completeIdempotencyRecord(params: {
  avatarId: string;
  actionType: Exclude<OnboardingActionType, 'status'>;
  stepId: string | null;
  idempotencyKey: string;
  fingerprint: string;
  statusCode: number;
  responseBody: string;
  now: number;
}): Promise<void> {
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: avatarPk(params.avatarId),
        sk: idempotencySk(params.actionType, params.stepId, params.idempotencyKey),
      },
      UpdateExpression: [
        'SET #status = :status',
        'responseStatusCode = :responseStatusCode',
        'responseBody = :responseBody',
        'completedAt = :completedAt',
        'updatedAt = :updatedAt',
        'inFlightUntil = :inFlightUntil',
      ].join(', '),
      ConditionExpression: 'fingerprint = :fingerprint',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': 'finished',
        ':responseStatusCode': params.statusCode,
        ':responseBody': params.responseBody,
        ':completedAt': params.now,
        ':updatedAt': params.now,
        ':inFlightUntil': params.now,
        ':fingerprint': params.fingerprint,
      },
    }));
  } catch (error) {
    logger.warn('Failed to finalize onboarding idempotency record', {
      avatarId: params.avatarId,
      actionType: params.actionType,
      stepId: params.stepId,
      idempotencyKey: params.idempotencyKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
