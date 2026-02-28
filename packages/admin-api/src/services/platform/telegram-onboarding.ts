export type TelegramOnboardingStepState = 'pending' | 'verified' | 'repairable' | 'blocked';

export type TelegramOnboardingReasonCode =
  | 'TELEGRAM_PLATFORM_DISABLED'
  | 'TELEGRAM_TOKEN_MISSING'
  | 'TELEGRAM_TOKEN_INVALID'
  | 'TELEGRAM_SECRET_MISSING'
  | 'TELEGRAM_WEBHOOK_MISMATCH'
  | 'TELEGRAM_DIAGNOSTICS_UNAVAILABLE';

export type TelegramOnboardingReasonCategory =
  | 'prerequisite'
  | 'configuration'
  | 'auth'
  | 'transient';

export type TelegramOnboardingRecommendedAction = 'verify' | 'repair' | 'manual';

export interface TelegramOnboardingReason {
  code: TelegramOnboardingReasonCode;
  category: TelegramOnboardingReasonCategory;
  message: string;
  repairable: boolean;
  requiresUserAction: boolean;
  legacyIssueCode?: string;
}

export interface TelegramOnboardingRemediation {
  canVerify: true;
  canRepair: boolean;
  recommendedAction: TelegramOnboardingRecommendedAction;
  nextAction: string;
  autoRepairOperations: Array<'ensure_webhook_secret' | 'ensure_webhook_registration'>;
}

export interface TelegramOnboardingStepStatus {
  step: 'telegram';
  state: TelegramOnboardingStepState;
  reasons: TelegramOnboardingReason[];
  remediation: TelegramOnboardingRemediation;
}

export type TelegramOnboardingExecuteAction = 'verify' | 'repair';

export interface TelegramOnboardingExecution {
  requestedAction: TelegramOnboardingExecuteAction;
  shouldMutate: boolean;
  idempotent: true;
  reasonCodes: TelegramOnboardingReasonCode[];
  reason: string;
}

export interface TelegramOnboardingSnapshot {
  platformEnabled: boolean;
  tokenPresent: boolean;
  webhookSecretPresent: boolean;
  issues: Array<{ code: string; message: string }>;
}

const REASON_PRIORITY: Record<TelegramOnboardingReasonCode, number> = {
  TELEGRAM_TOKEN_INVALID: 10,
  TELEGRAM_TOKEN_MISSING: 20,
  TELEGRAM_PLATFORM_DISABLED: 30,
  TELEGRAM_SECRET_MISSING: 40,
  TELEGRAM_WEBHOOK_MISMATCH: 50,
  TELEGRAM_DIAGNOSTICS_UNAVAILABLE: 60,
};

function sortReasons(
  reasons: TelegramOnboardingReason[]
): TelegramOnboardingReason[] {
  return reasons.sort((a, b) => REASON_PRIORITY[a.code] - REASON_PRIORITY[b.code]);
}

function buildNextAction(
  state: TelegramOnboardingStepState,
  reasons: TelegramOnboardingReason[]
): string {
  if (state === 'verified') {
    return 'Telegram onboarding is verified. No remediation is required.';
  }

  if (state === 'repairable') {
    return 'Run repair to upsert webhook secret and webhook registration, then re-verify.';
  }

  if (state === 'blocked') {
    return 'Replace the Telegram bot token and run verify again.';
  }

  if (reasons.some(reason => reason.code === 'TELEGRAM_TOKEN_MISSING')) {
    return 'Add a Telegram bot token, then run verify.';
  }

  if (reasons.some(reason => reason.code === 'TELEGRAM_PLATFORM_DISABLED')) {
    return 'Enable Telegram in avatar config, then run verify.';
  }

  if (reasons.some(reason => reason.code === 'TELEGRAM_DIAGNOSTICS_UNAVAILABLE')) {
    return 'Retry verify. Telegram diagnostics failed with a transient dependency error.';
  }

  return 'Complete missing Telegram prerequisites, then run verify.';
}

function determineState(reasons: TelegramOnboardingReason[]): TelegramOnboardingStepState {
  if (reasons.some(reason => reason.code === 'TELEGRAM_TOKEN_INVALID')) {
    return 'blocked';
  }

  if (reasons.some(reason =>
    reason.code === 'TELEGRAM_TOKEN_MISSING'
    || reason.code === 'TELEGRAM_PLATFORM_DISABLED'
    || reason.code === 'TELEGRAM_DIAGNOSTICS_UNAVAILABLE'
  )) {
    return 'pending';
  }

  if (reasons.some(reason =>
    reason.code === 'TELEGRAM_SECRET_MISSING'
    || reason.code === 'TELEGRAM_WEBHOOK_MISMATCH'
  )) {
    return 'repairable';
  }

  return 'verified';
}

function pushReason(
  map: Map<TelegramOnboardingReasonCode, TelegramOnboardingReason>,
  reason: TelegramOnboardingReason
) {
  if (!map.has(reason.code)) {
    map.set(reason.code, reason);
  }
}

export function deriveTelegramOnboardingStepStatus(
  snapshot: TelegramOnboardingSnapshot
): TelegramOnboardingStepStatus {
  const issueCodes = new Set(snapshot.issues.map(issue => issue.code));
  const reasonMap = new Map<TelegramOnboardingReasonCode, TelegramOnboardingReason>();
  const tokenUsable = snapshot.tokenPresent && !issueCodes.has('invalid_bot_token');

  if (!snapshot.platformEnabled || issueCodes.has('telegram_disabled_in_config')) {
    pushReason(reasonMap, {
      code: 'TELEGRAM_PLATFORM_DISABLED',
      category: 'prerequisite',
      message: 'Telegram is disabled in avatar config.',
      repairable: false,
      requiresUserAction: true,
      legacyIssueCode: issueCodes.has('telegram_disabled_in_config')
        ? 'telegram_disabled_in_config'
        : undefined,
    });
  }

  if (!snapshot.tokenPresent || issueCodes.has('missing_bot_token')) {
    pushReason(reasonMap, {
      code: 'TELEGRAM_TOKEN_MISSING',
      category: 'prerequisite',
      message: 'Telegram bot token is missing.',
      repairable: false,
      requiresUserAction: true,
      legacyIssueCode: issueCodes.has('missing_bot_token') ? 'missing_bot_token' : undefined,
    });
  }

  if (issueCodes.has('invalid_bot_token')) {
    pushReason(reasonMap, {
      code: 'TELEGRAM_TOKEN_INVALID',
      category: 'auth',
      message: 'Telegram bot token is invalid.',
      repairable: false,
      requiresUserAction: true,
      legacyIssueCode: 'invalid_bot_token',
    });
  }

  if (tokenUsable && (!snapshot.webhookSecretPresent || issueCodes.has('missing_webhook_secret'))) {
    pushReason(reasonMap, {
      code: 'TELEGRAM_SECRET_MISSING',
      category: 'configuration',
      message: 'Telegram webhook secret is missing.',
      repairable: true,
      requiresUserAction: false,
      legacyIssueCode: issueCodes.has('missing_webhook_secret') ? 'missing_webhook_secret' : undefined,
    });
  }

  if (tokenUsable && issueCodes.has('webhook_url_mismatch')) {
    pushReason(reasonMap, {
      code: 'TELEGRAM_WEBHOOK_MISMATCH',
      category: 'configuration',
      message: 'Telegram webhook URL does not match the expected onboarding URL.',
      repairable: true,
      requiresUserAction: false,
      legacyIssueCode: 'webhook_url_mismatch',
    });
  }

  if (issueCodes.has('unknown_error')) {
    pushReason(reasonMap, {
      code: 'TELEGRAM_DIAGNOSTICS_UNAVAILABLE',
      category: 'transient',
      message: 'Telegram diagnostics failed due to a transient dependency error.',
      repairable: false,
      requiresUserAction: false,
      legacyIssueCode: 'unknown_error',
    });
  }

  const reasons = sortReasons(Array.from(reasonMap.values()));
  const state = determineState(reasons);
  const recommendedAction: TelegramOnboardingRecommendedAction = state === 'repairable'
    ? 'repair'
    : state === 'verified'
      ? 'verify'
      : reasons.some(reason => reason.requiresUserAction)
        ? 'manual'
        : 'verify';
  const remediation: TelegramOnboardingRemediation = {
    canVerify: true,
    canRepair: state === 'repairable',
    recommendedAction,
    nextAction: buildNextAction(state, reasons),
    autoRepairOperations: state === 'repairable'
      ? ['ensure_webhook_secret', 'ensure_webhook_registration']
      : [],
  };

  return {
    step: 'telegram',
    state,
    reasons,
    remediation,
  };
}

export function computeTelegramOnboardingExecution(
  step: TelegramOnboardingStepStatus,
  requestedAction: TelegramOnboardingExecuteAction
): TelegramOnboardingExecution {
  if (requestedAction === 'repair') {
    if (step.state === 'repairable' && step.remediation.canRepair) {
      return {
        requestedAction,
        shouldMutate: true,
        idempotent: true,
        reasonCodes: step.reasons.map(reason => reason.code),
        reason: 'Repairable Telegram onboarding state.',
      };
    }

    return {
      requestedAction,
      shouldMutate: false,
      idempotent: true,
      reasonCodes: step.reasons.map(reason => reason.code),
      reason: `No-op repair for state=${step.state}.`,
    };
  }

  return {
    requestedAction,
    shouldMutate: false,
    idempotent: true,
    reasonCodes: step.reasons.map(reason => reason.code),
    reason: 'Verification is diagnostics-only and has no mutation.',
  };
}
