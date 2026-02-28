/**
 * Activation Readiness — Telegram & Twitter Checks
 *
 * Evaluates Telegram profile/webhook health and Twitter OAuth status.
 */
import type { AvatarRecord } from '../../types.js';
import type { TelegramDiagnosis, TelegramDiagnosticsIssueCode } from '../telegram-admin.js';
import { getConnectionStatus as getTwitterConnectionStatusDefault } from '../twitter-oauth.js';
import type { ReadinessCheckV1, ActivationReadinessDeps } from './types.js';
import {
  hasText,
  executeStepAction,
  openUiRouteAction,
  externalDocsAction,
} from './remediation-helpers.js';

const TELEGRAM_BLOCKING_ISSUES: ReadonlySet<TelegramDiagnosticsIssueCode> = new Set([
  'missing_bot_token',
  'invalid_bot_token',
  'missing_webhook_secret',
  'webhook_url_mismatch',
  'webhook_pending_updates',
  'webhook_last_error',
  'unknown_error',
]);

export function evaluateTelegramProfileCheck(avatar: AvatarRecord): ReadinessCheckV1 {
  const telegramEnabled = Boolean(avatar.platforms?.telegram?.enabled);
  if (!telegramEnabled) {
    return {
      id: 'platform.telegram.profile_complete',
      title: 'Telegram profile configuration is complete',
      required: false,
      status: 'not_applicable',
      reasonCode: 'TELEGRAM_NOT_ENABLED',
      message: 'Telegram is not enabled for this avatar.',
      sourceStep: 'telegram',
      remediation: [],
      evidence: {
        telegramEnabled: false,
      },
    };
  }

  const botUsernamePresent = hasText(avatar.platforms?.telegram?.botUsername);
  if (botUsernamePresent) {
    return {
      id: 'platform.telegram.profile_complete',
      title: 'Telegram profile configuration is complete',
      required: true,
      status: 'pass',
      reasonCode: 'TELEGRAM_PROFILE_COMPLETE',
      message: 'Telegram profile configuration is complete.',
      sourceStep: 'telegram',
      remediation: [],
      evidence: {
        telegramEnabled: true,
        botUsernamePresent: true,
      },
    };
  }

  return {
    id: 'platform.telegram.profile_complete',
    title: 'Telegram profile configuration is complete',
    required: true,
    status: 'fail',
    reasonCode: 'TELEGRAM_CONFIG_MISSING',
    message: 'Telegram bot username is required when Telegram is enabled.',
    sourceStep: 'telegram',
    remediation: [
      executeStepAction(
        'execute_telegram_profile_step',
        avatar.avatarId,
        'telegram',
        'Run Telegram Setup',
        'Execute Telegram setup to complete required profile fields.'
      ),
      openUiRouteAction(
        'open_telegram_settings',
        `/avatars/${avatar.avatarId}/onboarding?step=telegram`,
        'Open Telegram Setup',
        'Configure Telegram profile fields before activation.'
      ),
    ],
    evidence: {
      telegramEnabled: true,
      botUsernamePresent: false,
    },
  };
}

export function evaluateTelegramWebhookCheck(
  avatar: AvatarRecord,
  diagnosis: TelegramDiagnosis | null,
  diagnosisError: boolean
): ReadinessCheckV1 {
  const telegramEnabled = Boolean(avatar.platforms?.telegram?.enabled);
  if (!telegramEnabled) {
    return {
      id: 'platform.telegram.webhook_healthy',
      title: 'Telegram webhook diagnostics are healthy',
      required: false,
      status: 'not_applicable',
      reasonCode: 'TELEGRAM_NOT_ENABLED',
      message: 'Telegram is not enabled for this avatar.',
      sourceStep: 'telegram',
      remediation: [],
      evidence: {
        telegramEnabled: false,
      },
    };
  }

  if (diagnosisError || !diagnosis) {
    return {
      id: 'platform.telegram.webhook_healthy',
      title: 'Telegram webhook diagnostics are healthy',
      required: true,
      status: 'fail',
      reasonCode: 'TELEGRAM_DIAGNOSTICS_STALE',
      message: 'Telegram diagnostics could not be verified for activation.',
      sourceStep: 'telegram',
      remediation: [
        executeStepAction(
          'execute_telegram_diagnostics_step',
          avatar.avatarId,
          'telegram',
          'Run Telegram Verification',
          'Re-run Telegram verification to refresh diagnostics.'
        ),
        openUiRouteAction(
          'open_telegram_diagnostics',
          `/avatars/${avatar.avatarId}/onboarding?step=telegram`,
          'Open Telegram Diagnostics',
          'Open Telegram onboarding diagnostics and run repair if needed.'
        ),
      ],
      evidence: {
        telegramEnabled: true,
        diagnosticsAvailable: false,
      },
    };
  }

  const blockingIssues = diagnosis.issues.filter((issue) => TELEGRAM_BLOCKING_ISSUES.has(issue.code));
  if (blockingIssues.length === 0) {
    return {
      id: 'platform.telegram.webhook_healthy',
      title: 'Telegram webhook diagnostics are healthy',
      required: true,
      status: 'pass',
      reasonCode: 'TELEGRAM_WEBHOOK_HEALTHY',
      message: 'Telegram diagnostics are healthy for activation.',
      sourceStep: 'telegram',
      remediation: [],
      evidence: {
        telegramEnabled: true,
        diagnosticsAvailable: true,
        issueCount: 0,
      },
    };
  }

  const issueCodes = blockingIssues.map((issue) => issue.code).join(',');
  return {
    id: 'platform.telegram.webhook_healthy',
    title: 'Telegram webhook diagnostics are healthy',
    required: true,
    status: 'fail',
    reasonCode: 'TELEGRAM_WEBHOOK_UNHEALTHY',
    message: `Telegram diagnostics reported blocking issues: ${issueCodes}`,
    sourceStep: 'telegram',
    remediation: [
      executeStepAction(
        'execute_telegram_repair_step',
        avatar.avatarId,
        'telegram',
        'Run Telegram Repair',
        'Execute Telegram repair to resolve webhook and token diagnostics.'
      ),
      openUiRouteAction(
        'open_telegram_repair',
        `/avatars/${avatar.avatarId}/onboarding?step=telegram`,
        'Open Telegram Repair',
        'Review Telegram diagnostics and repair the failing checks.'
      ),
    ],
    evidence: {
      telegramEnabled: true,
      diagnosticsAvailable: true,
      issueCount: blockingIssues.length,
      issueCodes,
    },
  };
}

export async function evaluateTwitterHealthCheck(
  avatar: AvatarRecord,
  deps: ActivationReadinessDeps
): Promise<ReadinessCheckV1> {
  const twitterEnabled = Boolean(avatar.platforms?.twitter?.enabled);
  if (!twitterEnabled) {
    return {
      id: 'integration.twitter.connection_healthy',
      title: 'Twitter integration health',
      required: false,
      status: 'not_applicable',
      reasonCode: 'TWITTER_NOT_ENABLED',
      message: 'Twitter is not enabled for this avatar.',
      sourceStep: 'twitter',
      remediation: [],
      evidence: {
        twitterEnabled: false,
      },
    };
  }

  const getTwitterConnectionStatusImpl = deps.getTwitterConnectionStatus ?? getTwitterConnectionStatusDefault;

  try {
    const status = await getTwitterConnectionStatusImpl(avatar.avatarId);
    if (status.connected) {
      return {
        id: 'integration.twitter.connection_healthy',
        title: 'Twitter integration health',
        required: true,
        status: 'pass',
        reasonCode: 'TWITTER_CONNECTED',
        message: 'Twitter integration is connected.',
        sourceStep: 'twitter',
        remediation: [],
        evidence: {
          twitterEnabled: true,
          connected: true,
          username: status.username ?? null,
        },
      };
    }

    return {
      id: 'integration.twitter.connection_healthy',
      title: 'Twitter integration health',
      required: true,
      status: 'fail',
      reasonCode: 'TWITTER_CONNECTION_UNHEALTHY',
      message: 'Twitter is enabled but OAuth connection is incomplete.',
      sourceStep: 'twitter',
      remediation: [
        executeStepAction(
          'execute_twitter_connection_step',
          avatar.avatarId,
          'twitter',
          'Run Twitter Connection',
          'Execute the Twitter connection step to authorize posting access.'
        ),
        openUiRouteAction(
          'open_twitter_settings',
          `/avatars/${avatar.avatarId}/onboarding?step=twitter`,
          'Open Twitter Setup',
          'Reconnect Twitter in onboarding before activation.'
        ),
        externalDocsAction(
          'open_twitter_oauth_docs',
          'https://developer.x.com/en/docs/authentication/oauth-1-0a',
          'Open OAuth Docs',
          'Review X/Twitter OAuth requirements if connection keeps failing.'
        ),
      ],
      evidence: {
        twitterEnabled: true,
        connected: false,
      },
    };
  } catch {
    return {
      id: 'integration.twitter.connection_healthy',
      title: 'Twitter integration health',
      required: true,
      status: 'warn',
      reasonCode: 'TWITTER_HEALTH_UNKNOWN',
      message: 'Twitter health check is temporarily unavailable.',
      sourceStep: 'twitter',
      remediation: [
        openUiRouteAction(
          'open_twitter_status',
          `/avatars/${avatar.avatarId}/onboarding?step=twitter`,
          'Check Twitter Setup',
          'Open Twitter setup and re-run connection verification.'
        ),
      ],
      evidence: {
        twitterEnabled: true,
        connected: false,
      },
    };
  }
}
