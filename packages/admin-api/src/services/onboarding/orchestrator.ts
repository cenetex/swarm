import { createHash } from 'crypto';
import { logger } from '@swarm/core';
import * as avatarService from '../avatars.js';
import {
  acquireIdempotencyRecord,
  acquireTransitionLock,
  completeIdempotencyRecord,
  getOrCreateOnboardingStateRecord,
  releaseTransitionLock,
  saveOnboardingSnapshot,
} from './repository.js';
import {
  OnboardingTransitionError,
  createInitialOnboardingState,
  computeAllowedActions,
  executeStepTransition,
  restartTransition,
  skipOptionalStepTransition,
} from './state-machine.js';
import {
  ONBOARDING_CONTRACT_VERSION,
  type OnboardingActionType,
  type OnboardingErrorCode,
  type OnboardingErrorEnvelope,
  type OnboardingServiceResponse,
  type OnboardingStateSnapshot,
  type StoredOnboardingIdempotencyItem,
} from './types.js';

interface BaseRequestContext {
  avatarId: string;
  requestId: string;
  method: string;
  path: string;
  effectiveIsAdmin: boolean;
  walletAddress: string | null;
}

export type OnboardingStatusRequest = BaseRequestContext;

interface MutatingRequestContext extends BaseRequestContext {
  stepId: string | null;
  idempotencyKey: string | null;
  rawBody: string | undefined;
}

export interface OnboardingExecuteStepRequest extends MutatingRequestContext {
  stepId: string;
}

export type OnboardingRestartRequest = MutatingRequestContext;

export interface OnboardingSkipOptionalRequest extends MutatingRequestContext {
  stepId: string;
}

interface ParsedMutatingBody {
  expectedRevision: number | null;
  normalizedBody: Record<string, unknown>;
}

interface TransitionContext {
  actionType: OnboardingActionType;
  stepId: string | null;
}

function toIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForFingerprint);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));

    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      normalized[key] = normalizeForFingerprint(entryValue);
    }

    return normalized;
  }

  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForFingerprint(value));
}

function computeFingerprint(method: string, path: string, normalizedBody: string): string {
  return createHash('sha256')
    .update(method.toUpperCase())
    .update('|')
    .update(path)
    .update('|')
    .update(normalizedBody)
    .digest('hex');
}

function createError(params: {
  code: OnboardingErrorCode;
  category: OnboardingErrorEnvelope['category'];
  message: string;
  retryable: boolean;
  details?: Record<string, unknown> | null;
}): OnboardingErrorEnvelope {
  return {
    code: params.code,
    category: params.category,
    message: params.message,
    retryable: params.retryable,
    details: params.details ?? null,
  };
}

function buildOnboardingPayload(snapshot: OnboardingStateSnapshot) {
  return {
    state: snapshot.state,
    currentStepId: snapshot.currentStepId,
    revision: snapshot.revision,
    updatedAt: toIso(snapshot.updatedAt),
    steps: snapshot.steps.map(step => ({
      stepId: step.stepId,
      order: step.order,
      optional: step.optional,
      status: step.status,
      attemptCount: step.attemptCount,
      retryable: step.retryable,
      nextRetryAt: step.nextRetryAt ? toIso(step.nextRetryAt) : null,
      lastError: {
        code: step.lastError.code,
        category: step.lastError.category,
        message: step.lastError.message,
        retryable: step.lastError.retryable,
      },
    })),
    allowedActions: computeAllowedActions(snapshot),
  };
}

function buildEnvelope(params: {
  now: number;
  avatarId: string;
  requestId: string;
  actionType: OnboardingActionType;
  stepId: string | null;
  actionResult: 'applied' | 'no_op' | 'replayed' | 'rejected';
  reasonCode: string | null;
  idempotencyKey: string | null;
  idempotencyScope: string | null;
  idempotencyReplayed: boolean;
  idempotencyInFlight: boolean;
  snapshot: OnboardingStateSnapshot;
  error: OnboardingErrorEnvelope | null;
}) {
  return {
    contractVersion: ONBOARDING_CONTRACT_VERSION,
    requestId: params.requestId,
    timestamp: toIso(params.now),
    avatarId: params.avatarId,
    action: {
      type: params.actionType,
      stepId: params.stepId,
      result: params.actionResult,
      reasonCode: params.reasonCode,
    },
    idempotency: {
      key: params.idempotencyKey,
      scope: params.idempotencyScope,
      replayed: params.idempotencyReplayed,
      inFlight: params.idempotencyInFlight,
    },
    onboarding: buildOnboardingPayload(params.snapshot),
    error: params.error,
  };
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7E]+$/.test(value);
}

function validateIdempotencyKey(idempotencyKey: string | null):
  | { ok: true; key: string }
  | { ok: false; error: OnboardingErrorEnvelope } {
  if (!idempotencyKey) {
    return {
      ok: false,
      error: createError({
        code: 'idempotency_key_required',
        category: 'validation',
        message: 'Idempotency-Key header is required for mutating onboarding endpoints.',
        retryable: false,
      }),
    };
  }

  if (idempotencyKey.length > 128 || !isAscii(idempotencyKey)) {
    return {
      ok: false,
      error: createError({
        code: 'invalid_idempotency_key',
        category: 'validation',
        message: 'Idempotency-Key must be ASCII and at most 128 characters.',
        retryable: false,
        details: {
          maxLength: 128,
        },
      }),
    };
  }

  return { ok: true, key: idempotencyKey };
}

function parseBodyAsObject(rawBody: string | undefined):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: OnboardingErrorEnvelope } {
  if (!rawBody || rawBody.trim() === '') {
    return { ok: true, value: {} };
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error: createError({
          code: 'invalid_request_body',
          category: 'validation',
          message: 'Request body must be a JSON object.',
          retryable: false,
        }),
      };
    }

    return {
      ok: true,
      value: parsed as Record<string, unknown>,
    };
  } catch {
    return {
      ok: false,
      error: createError({
        code: 'invalid_json_body',
        category: 'validation',
        message: 'Malformed JSON body.',
        retryable: false,
      }),
    };
  }
}

function parseExecuteBody(rawBody: string | undefined):
  | { ok: true; parsed: ParsedMutatingBody }
  | { ok: false; error: OnboardingErrorEnvelope } {
  const parsed = parseBodyAsObject(rawBody);
  if (!parsed.ok) {
    return parsed;
  }

  const expectedRevisionRaw = parsed.value.expectedRevision;
  if (expectedRevisionRaw !== undefined) {
    if (
      typeof expectedRevisionRaw !== 'number'
      || !Number.isInteger(expectedRevisionRaw)
      || expectedRevisionRaw < 0
    ) {
      return {
        ok: false,
        error: createError({
          code: 'invalid_request_body',
          category: 'validation',
          message: 'expectedRevision must be a non-negative integer.',
          retryable: false,
        }),
      };
    }
  }

  const inputRaw = parsed.value.input;
  if (inputRaw !== undefined && (!inputRaw || typeof inputRaw !== 'object' || Array.isArray(inputRaw))) {
    return {
      ok: false,
      error: createError({
        code: 'invalid_request_body',
        category: 'validation',
        message: 'input must be a JSON object when provided.',
        retryable: false,
      }),
    };
  }

  return {
    ok: true,
    parsed: {
      expectedRevision: typeof expectedRevisionRaw === 'number' ? expectedRevisionRaw : null,
      normalizedBody: parsed.value,
    },
  };
}

function parseRestartBody(rawBody: string | undefined):
  | { ok: true; parsed: ParsedMutatingBody }
  | { ok: false; error: OnboardingErrorEnvelope } {
  const parsed = parseBodyAsObject(rawBody);
  if (!parsed.ok) {
    return parsed;
  }

  const reasonRaw = parsed.value.reason;
  if (reasonRaw !== undefined && typeof reasonRaw !== 'string') {
    return {
      ok: false,
      error: createError({
        code: 'invalid_request_body',
        category: 'validation',
        message: 'reason must be a string when provided.',
        retryable: false,
      }),
    };
  }

  return {
    ok: true,
    parsed: {
      expectedRevision: null,
      normalizedBody: parsed.value,
    },
  };
}

function parseSkipBody(rawBody: string | undefined):
  | { ok: true; parsed: ParsedMutatingBody }
  | { ok: false; error: OnboardingErrorEnvelope } {
  const parsed = parseBodyAsObject(rawBody);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    parsed: {
      expectedRevision: null,
      normalizedBody: parsed.value,
    },
  };
}

function buildIdempotencyScope(
  avatarId: string,
  actionType: Exclude<OnboardingActionType, 'status'>,
  stepId: string | null
): string {
  const stepSegment = stepId ? `:step:${stepId}` : '';
  return `avatar:${avatarId}:action:${actionType}${stepSegment}`;
}

function isTimeoutLikeError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (name === 'TimeoutError' || name === 'AbortError') {
    return true;
  }

  return lowered.includes('timeout') || lowered.includes('timed out');
}

async function ensureAvatarAccess(
  context: BaseRequestContext,
  action: TransitionContext
): Promise<{ ok: true } | { ok: false; response: OnboardingServiceResponse }> {
  const avatar = await avatarService.getAvatar(context.avatarId);
  if (!avatar) {
    const now = Date.now();
    const initialState = createInitialOnboardingState(now);
    const error = createError({
      code: 'avatar_not_found',
      category: 'validation',
      message: 'Avatar not found.',
      retryable: false,
    });

    return {
      ok: false,
      response: {
        statusCode: 404,
        envelope: buildEnvelope({
          now,
          avatarId: context.avatarId,
          requestId: context.requestId,
          actionType: action.actionType,
          stepId: action.stepId,
          actionResult: 'rejected',
          reasonCode: error.code,
          idempotencyKey: null,
          idempotencyScope: null,
          idempotencyReplayed: false,
          idempotencyInFlight: false,
          snapshot: initialState,
          error,
        }),
      },
    };
  }

  if (!context.effectiveIsAdmin) {
    if (!context.walletAddress) {
      const now = Date.now();
      const state = createInitialOnboardingState(now);
      const error = createError({
        code: 'authentication_required',
        category: 'auth',
        message: 'Wallet sign-in required.',
        retryable: false,
      });

      return {
        ok: false,
        response: {
          statusCode: 403,
          envelope: buildEnvelope({
            now,
            avatarId: context.avatarId,
            requestId: context.requestId,
            actionType: action.actionType,
            stepId: action.stepId,
            actionResult: 'rejected',
            reasonCode: error.code,
            idempotencyKey: null,
            idempotencyScope: null,
            idempotencyReplayed: false,
            idempotencyInFlight: false,
            snapshot: state,
            error,
          }),
        },
      };
    }

    try {
      await avatarService.assertAvatarOwnership(context.avatarId, context.walletAddress, { isAdmin: false });
    } catch (ownershipError) {
      const now = Date.now();
      const state = createInitialOnboardingState(now);
      const verificationUnavailable = ownershipError instanceof avatarService.AvatarOwnershipError
        && ownershipError.code === 'verification_unavailable';
      const error = createError({
        code: verificationUnavailable ? 'ownership_verification_unavailable' : 'forbidden',
        category: verificationUnavailable ? 'dependency' : 'auth',
        message: verificationUnavailable
          ? 'Avatar ownership verification temporarily unavailable.'
          : 'Forbidden.',
        retryable: verificationUnavailable,
      });

      return {
        ok: false,
        response: {
          statusCode: verificationUnavailable ? 503 : 403,
          envelope: buildEnvelope({
            now,
            avatarId: context.avatarId,
            requestId: context.requestId,
            actionType: action.actionType,
            stepId: action.stepId,
            actionResult: 'rejected',
            reasonCode: error.code,
            idempotencyKey: null,
            idempotencyScope: null,
            idempotencyReplayed: false,
            idempotencyInFlight: false,
            snapshot: state,
            error,
          }),
        },
      };
    }
  }

  return { ok: true };
}

function replayFromRecord(
  record: StoredOnboardingIdempotencyItem,
  now: number
): OnboardingServiceResponse {
  try {
    const parsed = JSON.parse(record.responseBody ?? '{}') as {
      timestamp?: string;
      idempotency?: {
        replayed?: boolean;
        inFlight?: boolean;
      };
      action?: {
        result?: string;
        reasonCode?: string | null;
      };
    };

    parsed.timestamp = toIso(now);

    if (!parsed.idempotency || typeof parsed.idempotency !== 'object') {
      parsed.idempotency = { replayed: true, inFlight: false };
    }
    parsed.idempotency.replayed = true;
    parsed.idempotency.inFlight = false;

    if (!parsed.action || typeof parsed.action !== 'object') {
      parsed.action = { result: 'replayed', reasonCode: 'idempotency_replay' };
    }
    parsed.action.result = 'replayed';
    parsed.action.reasonCode = parsed.action.reasonCode ?? 'idempotency_replay';

    return {
      statusCode: record.responseStatusCode ?? 200,
      envelope: parsed as OnboardingServiceResponse['envelope'],
    };
  } catch {
    const snapshot = {
      state: 'not_started',
      currentStepId: null,
      revision: 0,
      updatedAt: now,
      steps: [],
    } as OnboardingStateSnapshot;

    const error = createError({
      code: 'internal_error',
      category: 'dependency',
      message: 'Failed to replay idempotent response.',
      retryable: true,
    });

    return {
      statusCode: 500,
      envelope: buildEnvelope({
        now,
        avatarId: record.avatarId,
        requestId: 'replay',
        actionType: record.actionType,
        stepId: record.stepId,
        actionResult: 'rejected',
        reasonCode: error.code,
        idempotencyKey: record.idempotencyKey,
        idempotencyScope: record.scope,
        idempotencyReplayed: true,
        idempotencyInFlight: false,
        snapshot,
        error,
      }),
    };
  }
}

async function runMutatingAction(
  context: MutatingRequestContext,
  transition: TransitionContext,
  parser: (rawBody: string | undefined) => { ok: true; parsed: ParsedMutatingBody } | { ok: false; error: OnboardingErrorEnvelope },
  reducer: (snapshot: OnboardingStateSnapshot, now: number) => { snapshot: OnboardingStateSnapshot; actionResult: 'applied' | 'no_op'; reasonCode: string | null }
): Promise<OnboardingServiceResponse> {
  const access = await ensureAvatarAccess(context, transition);
  if (!access.ok) {
    return access.response;
  }

  const startNow = Date.now();
  const stateRecord = await getOrCreateOnboardingStateRecord(context.avatarId, startNow);

  if (transition.actionType === 'status') {
    throw new Error('status action is not valid for mutating onboarding routes');
  }
  const actionType: Exclude<OnboardingActionType, 'status'> = transition.actionType;

  const scope = buildIdempotencyScope(context.avatarId, actionType, transition.stepId);

  const idempotencyValidation = validateIdempotencyKey(context.idempotencyKey);
  if (!idempotencyValidation.ok) {
    return {
      statusCode: 400,
      envelope: buildEnvelope({
        now: startNow,
        avatarId: context.avatarId,
        requestId: context.requestId,
        actionType: transition.actionType,
        stepId: transition.stepId,
        actionResult: 'rejected',
        reasonCode: idempotencyValidation.error.code,
        idempotencyKey: context.idempotencyKey,
        idempotencyScope: scope,
        idempotencyReplayed: false,
        idempotencyInFlight: false,
        snapshot: stateRecord.snapshot,
        error: idempotencyValidation.error,
      }),
    };
  }
  const idempotencyKey = idempotencyValidation.key;

  const parsedBodyResult = parser(context.rawBody);
  if (!parsedBodyResult.ok) {
    return {
      statusCode: 400,
      envelope: buildEnvelope({
        now: startNow,
        avatarId: context.avatarId,
        requestId: context.requestId,
        actionType: transition.actionType,
        stepId: transition.stepId,
        actionResult: 'rejected',
        reasonCode: parsedBodyResult.error.code,
        idempotencyKey: context.idempotencyKey,
        idempotencyScope: scope,
        idempotencyReplayed: false,
        idempotencyInFlight: false,
        snapshot: stateRecord.snapshot,
        error: parsedBodyResult.error,
      }),
    };
  }

  const normalizedBodyText = stableStringify(parsedBodyResult.parsed.normalizedBody);
  const fingerprint = computeFingerprint(context.method, context.path, normalizedBodyText);

  const idempotencyResult = await acquireIdempotencyRecord({
    avatarId: context.avatarId,
    actionType,
    stepId: transition.stepId,
    idempotencyKey,
    scope,
    fingerprint,
    method: context.method,
    path: context.path,
    normalizedBody: normalizedBodyText,
    now: startNow,
  });

  if (idempotencyResult.type === 'replay') {
    return replayFromRecord(idempotencyResult.record, startNow);
  }

  if (idempotencyResult.type === 'conflict') {
    const latest = await getOrCreateOnboardingStateRecord(context.avatarId, startNow);
    const statusCode = 409;
    const error = createError({
      code: idempotencyResult.code,
      category: idempotencyResult.code === 'idempotency_in_flight' ? 'transient' : 'validation',
      message: idempotencyResult.code === 'idempotency_in_flight'
        ? 'Request with this idempotency key is still in progress.'
        : 'This idempotency key was already used with a different request payload.',
      retryable: idempotencyResult.code === 'idempotency_in_flight',
      details: idempotencyResult.retryAfterMs
        ? { retryAfterMs: idempotencyResult.retryAfterMs }
        : null,
    });

    return {
      statusCode,
      envelope: buildEnvelope({
        now: startNow,
        avatarId: context.avatarId,
        requestId: context.requestId,
        actionType: transition.actionType,
        stepId: transition.stepId,
        actionResult: 'rejected',
        reasonCode: error.code,
        idempotencyKey: context.idempotencyKey,
        idempotencyScope: scope,
        idempotencyReplayed: false,
        idempotencyInFlight: error.code === 'idempotency_in_flight',
        snapshot: latest.snapshot,
        error,
      }),
    };
  }

  const lock = await acquireTransitionLock({
    avatarId: context.avatarId,
    requestId: context.requestId,
    actionType: transition.actionType,
    now: Date.now(),
  });

  let finalResponse: OnboardingServiceResponse;

  if (!lock.acquired) {
    const error = createError({
      code: 'onboarding_busy',
      category: 'transient',
      message: 'Another onboarding transition is in progress.',
      retryable: true,
      details: {
        retryAfterMs: lock.retryAfterMs,
      },
    });

    finalResponse = {
      statusCode: 409,
      envelope: buildEnvelope({
        now: Date.now(),
        avatarId: context.avatarId,
        requestId: context.requestId,
        actionType: transition.actionType,
        stepId: transition.stepId,
        actionResult: 'rejected',
        reasonCode: error.code,
        idempotencyKey: context.idempotencyKey,
        idempotencyScope: scope,
        idempotencyReplayed: false,
        idempotencyInFlight: true,
        snapshot: lock.record.snapshot,
        error,
      }),
    };

    await completeIdempotencyRecord({
      avatarId: context.avatarId,
      actionType,
      stepId: transition.stepId,
      idempotencyKey,
      fingerprint,
      statusCode: finalResponse.statusCode,
      responseBody: JSON.stringify(finalResponse.envelope),
      now: Date.now(),
    });

    return finalResponse;
  }

  try {
    const lockedState = lock.record;

    if (
      parsedBodyResult.parsed.expectedRevision !== null
      && parsedBodyResult.parsed.expectedRevision !== lockedState.snapshot.revision
    ) {
      const error = createError({
        code: 'revision_mismatch',
        category: 'validation',
        message: 'expectedRevision does not match current onboarding revision.',
        retryable: false,
        details: {
          expectedRevision: parsedBodyResult.parsed.expectedRevision,
          actualRevision: lockedState.snapshot.revision,
        },
      });

      finalResponse = {
        statusCode: 409,
        envelope: buildEnvelope({
          now: Date.now(),
          avatarId: context.avatarId,
          requestId: context.requestId,
          actionType: transition.actionType,
          stepId: transition.stepId,
          actionResult: 'rejected',
          reasonCode: error.code,
          idempotencyKey: context.idempotencyKey,
          idempotencyScope: scope,
          idempotencyReplayed: false,
          idempotencyInFlight: false,
          snapshot: lockedState.snapshot,
          error,
        }),
      };
    } else {
      const transitionNow = Date.now();
      const transitionResult = reducer(lockedState.snapshot, transitionNow);
      let responseSnapshot = transitionResult.snapshot;

      if (transitionResult.actionResult === 'applied') {
        const persisted = await saveOnboardingSnapshot({
          avatarId: context.avatarId,
          requestId: context.requestId,
          expectedRevision: lockedState.snapshot.revision,
          snapshot: transitionResult.snapshot,
          now: transitionNow,
        });

        if (!persisted.ok) {
          if (persisted.reason === 'busy') {
            const error = createError({
              code: 'onboarding_busy',
              category: 'transient',
              message: 'Another onboarding transition is in progress.',
              retryable: true,
              details: {
                retryAfterMs: Math.max(250, (persisted.record.transitionLockExpiresAt ?? transitionNow) - transitionNow),
              },
            });

            finalResponse = {
              statusCode: 409,
              envelope: buildEnvelope({
                now: transitionNow,
                avatarId: context.avatarId,
                requestId: context.requestId,
                actionType: transition.actionType,
                stepId: transition.stepId,
                actionResult: 'rejected',
                reasonCode: error.code,
                idempotencyKey: context.idempotencyKey,
                idempotencyScope: scope,
                idempotencyReplayed: false,
                idempotencyInFlight: true,
                snapshot: persisted.record.snapshot,
                error,
              }),
            };
          } else {
            const error = createError({
              code: 'revision_mismatch',
              category: 'validation',
              message: 'Onboarding revision changed while applying transition.',
              retryable: true,
              details: {
                expectedRevision: lockedState.snapshot.revision,
                actualRevision: persisted.record.snapshot.revision,
              },
            });

            finalResponse = {
              statusCode: 409,
              envelope: buildEnvelope({
                now: transitionNow,
                avatarId: context.avatarId,
                requestId: context.requestId,
                actionType: transition.actionType,
                stepId: transition.stepId,
                actionResult: 'rejected',
                reasonCode: error.code,
                idempotencyKey: context.idempotencyKey,
                idempotencyScope: scope,
                idempotencyReplayed: false,
                idempotencyInFlight: false,
                snapshot: persisted.record.snapshot,
                error,
              }),
            };
          }
        } else {
          responseSnapshot = persisted.record.snapshot;
          finalResponse = {
            statusCode: 200,
            envelope: buildEnvelope({
              now: transitionNow,
              avatarId: context.avatarId,
              requestId: context.requestId,
              actionType: transition.actionType,
              stepId: transition.stepId,
              actionResult: transitionResult.actionResult,
              reasonCode: transitionResult.reasonCode,
              idempotencyKey: context.idempotencyKey,
              idempotencyScope: scope,
              idempotencyReplayed: false,
              idempotencyInFlight: false,
              snapshot: responseSnapshot,
              error: null,
            }),
          };
        }
      } else {
        finalResponse = {
          statusCode: 200,
          envelope: buildEnvelope({
            now: transitionNow,
            avatarId: context.avatarId,
            requestId: context.requestId,
            actionType: transition.actionType,
            stepId: transition.stepId,
            actionResult: transitionResult.actionResult,
            reasonCode: transitionResult.reasonCode,
            idempotencyKey: context.idempotencyKey,
            idempotencyScope: scope,
            idempotencyReplayed: false,
            idempotencyInFlight: false,
            snapshot: responseSnapshot,
            error: null,
          }),
        };
      }
    }
  } catch (error) {
    const now = Date.now();
    const latest = await getOrCreateOnboardingStateRecord(context.avatarId, now);

    if (error instanceof OnboardingTransitionError) {
      const typedError = createError({
        code: error.code,
        category: error.category,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      });

      finalResponse = {
        statusCode: error.statusCode,
        envelope: buildEnvelope({
          now,
          avatarId: context.avatarId,
          requestId: context.requestId,
          actionType: transition.actionType,
          stepId: transition.stepId,
          actionResult: 'rejected',
          reasonCode: typedError.code,
          idempotencyKey: context.idempotencyKey,
          idempotencyScope: scope,
          idempotencyReplayed: false,
          idempotencyInFlight: false,
          snapshot: latest.snapshot,
          error: typedError,
        }),
      };
    } else if (isTimeoutLikeError(error)) {
      const typedError = createError({
        code: 'step_timeout',
        category: 'transient',
        message: 'Onboarding step timed out.',
        retryable: true,
      });

      finalResponse = {
        statusCode: 504,
        envelope: buildEnvelope({
          now,
          avatarId: context.avatarId,
          requestId: context.requestId,
          actionType: transition.actionType,
          stepId: transition.stepId,
          actionResult: 'rejected',
          reasonCode: typedError.code,
          idempotencyKey: context.idempotencyKey,
          idempotencyScope: scope,
          idempotencyReplayed: false,
          idempotencyInFlight: false,
          snapshot: latest.snapshot,
          error: typedError,
        }),
      };
    } else {
      logger.error('Onboarding orchestrator error', {
        avatarId: context.avatarId,
        actionType: transition.actionType,
        stepId: transition.stepId,
        error: error instanceof Error ? error.message : String(error),
      });

      const typedError = createError({
        code: 'internal_error',
        category: 'dependency',
        message: 'Internal server error.',
        retryable: true,
      });

      finalResponse = {
        statusCode: 500,
        envelope: buildEnvelope({
          now,
          avatarId: context.avatarId,
          requestId: context.requestId,
          actionType: transition.actionType,
          stepId: transition.stepId,
          actionResult: 'rejected',
          reasonCode: typedError.code,
          idempotencyKey: context.idempotencyKey,
          idempotencyScope: scope,
          idempotencyReplayed: false,
          idempotencyInFlight: false,
          snapshot: latest.snapshot,
          error: typedError,
        }),
      };
    }
  } finally {
    await releaseTransitionLock(context.avatarId, context.requestId);
  }

  await completeIdempotencyRecord({
    avatarId: context.avatarId,
    actionType,
    stepId: transition.stepId,
    idempotencyKey,
    fingerprint,
    statusCode: finalResponse.statusCode,
    responseBody: JSON.stringify(finalResponse.envelope),
    now: Date.now(),
  });

  return finalResponse;
}

export async function getOnboardingStatus(
  request: OnboardingStatusRequest
): Promise<OnboardingServiceResponse> {
  const access = await ensureAvatarAccess(request, { actionType: 'status', stepId: null });
  if (!access.ok) {
    return access.response;
  }

  const now = Date.now();
  const state = await getOrCreateOnboardingStateRecord(request.avatarId, now);

  return {
    statusCode: 200,
    envelope: buildEnvelope({
      now,
      avatarId: request.avatarId,
      requestId: request.requestId,
      actionType: 'status',
      stepId: null,
      actionResult: 'no_op',
      reasonCode: null,
      idempotencyKey: null,
      idempotencyScope: null,
      idempotencyReplayed: false,
      idempotencyInFlight: false,
      snapshot: state.snapshot,
      error: null,
    }),
  };
}

export async function executeOnboardingStep(
  request: OnboardingExecuteStepRequest
): Promise<OnboardingServiceResponse> {
  return runMutatingAction(
    request,
    {
      actionType: 'execute_step',
      stepId: request.stepId,
    },
    parseExecuteBody,
    (snapshot, now) => executeStepTransition(snapshot, request.stepId, now),
  );
}

export async function restartOnboarding(
  request: OnboardingRestartRequest
): Promise<OnboardingServiceResponse> {
  return runMutatingAction(
    request,
    {
      actionType: 'restart',
      stepId: null,
    },
    parseRestartBody,
    (snapshot, now) => restartTransition(snapshot, now),
  );
}

export async function skipOptionalOnboardingStep(
  request: OnboardingSkipOptionalRequest
): Promise<OnboardingServiceResponse> {
  return runMutatingAction(
    request,
    {
      actionType: 'skip_optional',
      stepId: request.stepId,
    },
    parseSkipBody,
    (snapshot, now) => skipOptionalStepTransition(snapshot, request.stepId, now),
  );
}
