/**
 * Activation Readiness — Evaluation Orchestrator
 *
 * Runs all readiness checks and produces the final report.
 */
import type { AvatarRecord } from '../../types.js';
import { diagnoseTelegram as diagnoseTelegramDefault, type TelegramDiagnosis } from '../telegram-admin.js';
import type {
  ReadinessCheckV1,
  ActivationReadinessReportV1,
  ActivationReadinessContext,
  ActivationReadinessDeps,
} from './types.js';
import { ACTIVATION_READINESS_VERSION } from './types.js';
import {
  evaluateIdentityCheck,
  evaluateSecretsCheck,
  evaluateOnboardingCheck,
  evaluatePlatformCheck,
} from './core-checks.js';
import {
  evaluateTelegramProfileCheck,
  evaluateTelegramWebhookCheck,
  evaluateTwitterHealthCheck,
} from './platform-checks.js';
import {
  evaluateDiscordHealthCheck,
  evaluateDiscordGatewayReadinessCheck,
  evaluateObservabilityCheck,
} from './discord-observability-checks.js';

export async function evaluateActivationReadiness(
  avatar: AvatarRecord,
  context: ActivationReadinessContext,
  deps: ActivationReadinessDeps = {}
): Promise<ActivationReadinessReportV1> {
  const now = deps.now ?? (() => Date.now());
  const diagnoseTelegramImpl = deps.diagnoseTelegram ?? diagnoseTelegramDefault;

  const telegramEnabled = Boolean(avatar.platforms?.telegram?.enabled);
  const checks: ReadinessCheckV1[] = [];

  checks.push(evaluateOnboardingCheck(avatar));
  checks.push(await evaluateIdentityCheck(context, deps));
  checks.push(evaluatePlatformCheck(avatar));
  checks.push(evaluateTelegramProfileCheck(avatar));

  let diagnosis: TelegramDiagnosis | null = null;
  let diagnosisError = false;
  if (telegramEnabled) {
    try {
      diagnosis = await diagnoseTelegramImpl(avatar.avatarId);
    } catch {
      diagnosisError = true;
    }
  }
  checks.push(evaluateTelegramWebhookCheck(avatar, diagnosis, diagnosisError));

  checks.push(await evaluateTwitterHealthCheck(avatar, deps));
  checks.push(await evaluateDiscordHealthCheck(avatar, deps));
  checks.push(evaluateDiscordGatewayReadinessCheck(avatar));
  checks.push(await evaluateSecretsCheck(avatar, deps));
  checks.push(evaluateObservabilityCheck());

  const requiredChecks = checks.filter((check) => check.required);
  const requiredFailing = requiredChecks.filter((check) => check.status === 'fail').length;
  const optionalChecks = checks.filter((check) => !check.required);
  const optionalFailing = optionalChecks.filter((check) => check.status === 'fail').length;

  return {
    version: ACTIVATION_READINESS_VERSION,
    avatarId: avatar.avatarId,
    evaluatedAt: new Date(now()).toISOString(),
    gateStatus: requiredFailing > 0 ? 'fail' : 'pass',
    summary: {
      requiredTotal: requiredChecks.length,
      requiredPassing: requiredChecks.length - requiredFailing,
      requiredFailing,
      optionalTotal: optionalChecks.length,
      optionalFailing,
    },
    checks,
  };
}

export function getBlockingReadinessChecks(
  readiness: ActivationReadinessReportV1
): ReadinessCheckV1[] {
  return readiness.checks.filter((check) => check.required && check.status === 'fail');
}

export function toLegacyActivationIssues(
  readiness: ActivationReadinessReportV1
): string[] {
  return getBlockingReadinessChecks(readiness).map((check) => check.message);
}
