export const ONBOARDING_CONTRACT_VERSION = 'onboarding_contract_v1' as const;

export type OnboardingActionType = 'status' | 'execute_step' | 'restart' | 'skip_optional';

export type OnboardingActionResult = 'applied' | 'no_op' | 'replayed' | 'rejected';

export type OnboardingState = 'not_started' | 'in_progress' | 'blocked' | 'completed';

export type OnboardingStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'blocked';

export type OnboardingErrorCategory =
  | 'validation'
  | 'transient'
  | 'dependency'
  | 'auth'
  | 'configuration';

export type OnboardingErrorCode =
  | 'avatar_not_found'
  | 'forbidden'
  | 'authentication_required'
  | 'ownership_verification_unavailable'
  | 'invalid_json_body'
  | 'invalid_request_body'
  | 'invalid_state_transition'
  | 'step_not_found'
  | 'step_not_optional'
  | 'step_timeout'
  | 'onboarding_busy'
  | 'revision_mismatch'
  | 'idempotency_key_required'
  | 'invalid_idempotency_key'
  | 'idempotency_key_reused'
  | 'idempotency_in_flight'
  | 'internal_error';

export interface OnboardingErrorEnvelope {
  code: OnboardingErrorCode | string;
  category: OnboardingErrorCategory;
  message: string;
  retryable: boolean;
  details: Record<string, unknown> | null;
}

export interface OnboardingStepError {
  code: string | null;
  category: OnboardingErrorCategory | null;
  message: string | null;
  retryable: boolean | null;
}

export interface OnboardingStepSnapshot {
  stepId: string;
  order: number;
  optional: boolean;
  status: OnboardingStepStatus;
  attemptCount: number;
  retryable: boolean;
  nextRetryAt: number | null;
  lastError: OnboardingStepError;
}

export interface OnboardingStateSnapshot {
  state: OnboardingState;
  currentStepId: string | null;
  revision: number;
  updatedAt: number;
  steps: OnboardingStepSnapshot[];
}

export interface OnboardingStepResponse {
  stepId: string;
  order: number;
  optional: boolean;
  status: OnboardingStepStatus;
  attemptCount: number;
  retryable: boolean;
  nextRetryAt: string | null;
  lastError: OnboardingStepError;
}

export interface OnboardingPayloadResponse {
  state: OnboardingState;
  currentStepId: string | null;
  revision: number;
  updatedAt: string;
  steps: OnboardingStepResponse[];
  allowedActions: OnboardingActionType[];
}

export interface OnboardingEnvelope {
  contractVersion: typeof ONBOARDING_CONTRACT_VERSION;
  requestId: string;
  timestamp: string;
  avatarId: string;
  action: {
    type: OnboardingActionType;
    stepId: string | null;
    result: OnboardingActionResult;
    reasonCode: string | null;
  };
  idempotency: {
    key: string | null;
    scope: string | null;
    replayed: boolean;
    inFlight: boolean;
  };
  onboarding: OnboardingPayloadResponse;
  error: OnboardingErrorEnvelope | null;
}

export interface OnboardingServiceResponse {
  statusCode: number;
  envelope: OnboardingEnvelope;
}

export interface OnboardingStepDefinition {
  stepId: string;
  order: number;
  optional: boolean;
}

export interface OnboardingTransitionResult {
  snapshot: OnboardingStateSnapshot;
  actionResult: Exclude<OnboardingActionResult, 'replayed' | 'rejected'>;
  reasonCode: string | null;
}

export interface StoredOnboardingStateItem {
  pk: string;
  sk: 'ONBOARDING#STATE';
  entityType: 'onboarding_state_v1';
  avatarId: string;
  contractVersion: typeof ONBOARDING_CONTRACT_VERSION;
  state: OnboardingState;
  currentStepId: string | null;
  revision: number;
  updatedAt: number;
  steps: OnboardingStepSnapshot[];
  transitionLockRequestId?: string;
  transitionLockActionType?: OnboardingActionType;
  transitionLockExpiresAt?: number;
}

export type StoredIdempotencyStatus = 'in_flight' | 'finished';

export interface StoredOnboardingIdempotencyItem {
  pk: string;
  sk: string;
  entityType: 'onboarding_idempotency_v1';
  avatarId: string;
  actionType: Exclude<OnboardingActionType, 'status'>;
  stepId: string | null;
  idempotencyKey: string;
  scope: string;
  fingerprint: string;
  status: StoredIdempotencyStatus;
  inFlightUntil: number;
  requestMethod: string;
  requestPath: string;
  requestBodyHash: string;
  responseStatusCode?: number;
  responseBody?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  expiresAt: number;
  ttl: number;
}

export interface OnboardingStateRecord {
  snapshot: OnboardingStateSnapshot;
  transitionLockRequestId: string | null;
  transitionLockActionType: OnboardingActionType | null;
  transitionLockExpiresAt: number | null;
}
