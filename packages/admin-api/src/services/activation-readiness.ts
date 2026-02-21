import type { AvatarRecord, SecretType } from '../types.js';
import { getAccountSummary } from './accounts.js';
import { secretExists } from './secrets.js';
import {
  diagnoseTelegram,
  type TelegramDiagnosis,
  type TelegramDiagnosticsIssueCode,
} from './telegram-admin.js';
import { getConnectionStatus as getTwitterConnectionStatus } from './twitter-oauth.js';
import { getConnectionStatus as getDiscordConnectionStatus, type DiscordServiceDeps } from './discord.js';

export const ACTIVATION_READINESS_VERSION = 'activation_readiness_v1' as const;

export type ActivationGateStatus = 'pass' | 'fail';
export type ReadinessCheckStatus = 'pass' | 'fail' | 'warn' | 'not_applicable';
export type RemediationKind =
  | 'execute_step'
  | 'open_ui_route'
  | 'open_external_docs'
  | 'contact_support';

type ReadinessEvidenceValue = string | number | boolean | null;

export interface RemediationActionV1 {
  id: string;
  kind: RemediationKind;
  label: string;
  description: string;
  retryable: boolean;
  target?: {
    method?: 'GET' | 'POST';
    endpoint?: string;
    route?: string;
    docsUrl?: string;
  };
  supportHint?: {
    runbookKey: string;
    reasonCode: string;
  };
}

export interface ReadinessCheckV1 {
  id: string;
  title: string;
  required: boolean;
  status: ReadinessCheckStatus;
  reasonCode: string;
  message: string;
  sourceStep?: string;
  remediation: RemediationActionV1[];
  evidence?: Record<string, ReadinessEvidenceValue>;
}

export interface ActivationReadinessReportV1 {
  version: typeof ACTIVATION_READINESS_VERSION;
  avatarId: string;
  evaluatedAt: string;
  gateStatus: ActivationGateStatus;
  summary: {
    requiredTotal: number;
    requiredPassing: number;
    requiredFailing: number;
    optionalTotal: number;
    optionalFailing: number;
  };
  checks: ReadinessCheckV1[];
}

export interface ActivationReadinessContext {
  effectiveIsAdmin: boolean;
  walletAddress: string | null;
  accountId: string | null;
}

export interface ActivationReadinessDeps {
  now?: () => number;
  getAccountSummary?: typeof getAccountSummary;
  secretExists?: typeof secretExists;
  diagnoseTelegram?: typeof diagnoseTelegram;
  getTwitterConnectionStatus?: typeof getTwitterConnectionStatus;
  getDiscordConnectionStatus?: typeof getDiscordConnectionStatus;
  discordServiceDeps?: DiscordServiceDeps;
}

const TELEGRAM_BLOCKING_ISSUES: ReadonlySet<TelegramDiagnosticsIssueCode> = new Set([
  'missing_bot_token',
  'invalid_bot_token',
  'missing_webhook_secret',
  'webhook_url_mismatch',
  'webhook_pending_updates',
  'webhook_last_error',
  'unknown_error',
]);

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function executeStepAction(
  id: string,
  avatarId: string,
  step: string,
  label: string,
  description: string
): RemediationActionV1 {
  return {
    id,
    kind: 'execute_step',
    label,
    description,
    retryable: true,
    target: {
      method: 'POST',
      endpoint: `/onboarding/${avatarId}/steps/${step}/execute`,
      route: `/avatars/${avatarId}/onboarding?step=${step}`,
    },
  };
}

function openUiRouteAction(
  id: string,
  route: string,
  label: string,
  description: string
): RemediationActionV1 {
  return {
    id,
    kind: 'open_ui_route',
    label,
    description,
    retryable: true,
    target: {
      method: 'GET',
      route,
    },
  };
}

function externalDocsAction(
  id: string,
  docsUrl: string,
  label: string,
  description: string
): RemediationActionV1 {
  return {
    id,
    kind: 'open_external_docs',
    label,
    description,
    retryable: true,
    target: {
      docsUrl,
    },
  };
}

function contactSupportAction(
  id: string,
  label: string,
  description: string,
  runbookKey: string,
  reasonCode: string
): RemediationActionV1 {
  return {
    id,
    kind: 'contact_support',
    label,
    description,
    retryable: false,
    supportHint: {
      runbookKey,
      reasonCode,
    },
  };
}

async function hasSecretConfigured(
  avatarId: string,
  secretType: SecretType,
  deps: ActivationReadinessDeps
): Promise<boolean> {
  const secretExistsImpl = deps.secretExists ?? secretExists;
  const [avatarSpecific, global] = await Promise.all([
    secretExistsImpl(avatarId, secretType, 'default'),
    secretExistsImpl(null, secretType, 'default'),
  ]);
  return avatarSpecific || global;
}

async function evaluateIdentityCheck(
  context: ActivationReadinessContext,
  deps: ActivationReadinessDeps
): Promise<ReadinessCheckV1> {
  const id = 'identity.account.resolved';
  const title = 'Account identity is resolved';

  if (context.effectiveIsAdmin) {
    return {
      id,
      title,
      required: true,
      status: 'pass',
      reasonCode: 'ACCOUNT_RESOLVED',
      message: 'Admin actor is authorized for activation.',
      remediation: [],
      evidence: {
        actorIsAdmin: true,
      },
    };
  }

  if (!context.walletAddress) {
    return {
      id,
      title,
      required: true,
      status: 'fail',
      reasonCode: 'ACCOUNT_UNRESOLVED',
      message: 'Activation requires a wallet-authenticated owner session.',
      sourceStep: 'auth',
      remediation: [
        openUiRouteAction(
          'resolve_wallet_session',
          '/auth',
          'Connect Wallet',
          'Authenticate with your wallet to resolve account identity.'
        ),
      ],
      evidence: {
        walletAddressPresent: false,
        accountIdPresent: false,
      },
    };
  }

  if (!context.accountId) {
    return {
      id,
      title,
      required: true,
      status: 'fail',
      reasonCode: 'ACCOUNT_UNRESOLVED',
      message: 'No account is linked to the current wallet session.',
      sourceStep: 'auth',
      remediation: [
        openUiRouteAction(
          'refresh_account_session',
          '/auth',
          'Refresh Session',
          'Re-authenticate to refresh account linkage for this wallet.'
        ),
      ],
      evidence: {
        walletAddressPresent: true,
        accountIdPresent: false,
      },
    };
  }

  const getAccountSummaryImpl = deps.getAccountSummary ?? getAccountSummary;
  let account: Awaited<ReturnType<typeof getAccountSummary>>;
  try {
    account = await getAccountSummaryImpl(context.accountId);
  } catch {
    return {
      id,
      title,
      required: true,
      status: 'fail',
      reasonCode: 'ACCOUNT_UNRESOLVED',
      message: 'Account lookup failed while evaluating activation readiness.',
      sourceStep: 'auth',
      remediation: [
        openUiRouteAction(
          'retry_account_lookup',
          '/auth',
          'Retry Authentication',
          'Re-authenticate and retry activation readiness evaluation.'
        ),
        contactSupportAction(
          'account_lookup_failed_support',
          'Contact Support',
          'If account lookup keeps failing, contact support with request details.',
          'activation-account-lookup-failed',
          'ACCOUNT_UNRESOLVED'
        ),
      ],
      evidence: {
        walletAddressPresent: true,
        accountIdPresent: true,
      },
    };
  }
  if (!account) {
    return {
      id,
      title,
      required: true,
      status: 'fail',
      reasonCode: 'ACCOUNT_UNRESOLVED',
      message: 'Account profile could not be resolved for activation.',
      sourceStep: 'auth',
      remediation: [
        openUiRouteAction(
          'resolve_account_profile',
          '/auth',
          'Resolve Account',
          'Sign in again to re-establish account profile data.'
        ),
        contactSupportAction(
          'account_profile_missing_support',
          'Contact Support',
          'If this persists after re-authentication, contact support with your wallet address.',
          'activation-account-unresolved',
          'ACCOUNT_UNRESOLVED'
        ),
      ],
      evidence: {
        walletAddressPresent: true,
        accountIdPresent: true,
      },
    };
  }

  const linkedToWallet = account.identities.some(
    (identity) => identity.type === 'wallet' && identity.providerId === context.walletAddress
  );
  if (!linkedToWallet) {
    return {
      id,
      title,
      required: true,
      status: 'fail',
      reasonCode: 'ACCOUNT_FORBIDDEN',
      message: 'Wallet identity does not match the resolved account for activation.',
      sourceStep: 'auth',
      remediation: [
        openUiRouteAction(
          'switch_wallet_identity',
          '/auth',
          'Switch Wallet',
          'Switch to the wallet that owns this avatar and authenticate again.'
        ),
        contactSupportAction(
          'account_wallet_mismatch_support',
          'Contact Support',
          'If account linkage is incorrect, contact support to resolve identity mapping.',
          'activation-account-forbidden',
          'ACCOUNT_FORBIDDEN'
        ),
      ],
      evidence: {
        linkedWalletIdentity: false,
        identityCount: account.identities.length,
      },
    };
  }

  return {
    id,
    title,
    required: true,
    status: 'pass',
    reasonCode: 'ACCOUNT_RESOLVED',
    message: 'Wallet identity is linked to an activation-eligible account.',
    remediation: [],
    evidence: {
      linkedWalletIdentity: true,
      identityCount: account.identities.length,
    },
  };
}

async function evaluateSecretsCheck(
  avatar: AvatarRecord,
  deps: ActivationReadinessDeps
): Promise<ReadinessCheckV1> {
  const id = 'secrets.required.present';
  const title = 'Required secrets are present';

  const telegramEnabled = Boolean(avatar.platforms?.telegram?.enabled);
  const twitterEnabled = Boolean(avatar.platforms?.twitter?.enabled);
  const discordEnabled = Boolean(avatar.platforms?.discord?.enabled);
  const discordMode = avatar.platforms?.discord?.mode;

  let telegramBotToken = true;
  let telegramWebhookSecret = true;
  let twitterAccessToken = true;
  let twitterAccessSecret = true;
  let discordBotToken = true;
  let discordWebhookUrl = true;

  try {
    [
      telegramBotToken,
      telegramWebhookSecret,
      twitterAccessToken,
      twitterAccessSecret,
      discordBotToken,
      discordWebhookUrl,
    ] = await Promise.all([
      telegramEnabled ? hasSecretConfigured(avatar.avatarId, 'telegram_bot_token', deps) : Promise.resolve(true),
      telegramEnabled ? hasSecretConfigured(avatar.avatarId, 'telegram_webhook_secret', deps) : Promise.resolve(true),
      twitterEnabled ? hasSecretConfigured(avatar.avatarId, 'twitter_access_token', deps) : Promise.resolve(true),
      twitterEnabled ? hasSecretConfigured(avatar.avatarId, 'twitter_access_secret', deps) : Promise.resolve(true),
      discordEnabled ? hasSecretConfigured(avatar.avatarId, 'discord_bot_token', deps) : Promise.resolve(true),
      discordEnabled ? hasSecretConfigured(avatar.avatarId, 'discord_webhook_url', deps) : Promise.resolve(true),
    ]);
  } catch {
    return {
      id,
      title,
      required: true,
      status: 'fail',
      reasonCode: 'REQUIRED_SECRET_CHECK_UNAVAILABLE',
      message: 'Failed to verify required secrets for activation.',
      sourceStep: 'secrets',
      remediation: [
        openUiRouteAction(
          'retry_secret_verification',
          `/avatars/${avatar.avatarId}/onboarding?step=secrets`,
          'Review Secrets Setup',
          'Open secrets setup and retry readiness verification.'
        ),
        contactSupportAction(
          'secret_verification_failed_support',
          'Contact Support',
          'If secret verification continues to fail, contact support for backend diagnostics.',
          'activation-secret-check-failed',
          'REQUIRED_SECRET_CHECK_UNAVAILABLE'
        ),
      ],
      evidence: {
        telegramEnabled,
        twitterEnabled,
        discordEnabled,
      },
    };
  }

  const missing = new Set<string>();
  if (telegramEnabled && !telegramBotToken) missing.add('telegram_bot_token');
  if (telegramEnabled && !telegramWebhookSecret) missing.add('telegram_webhook_secret');
  if (twitterEnabled && !twitterAccessToken) missing.add('twitter_access_token');
  if (twitterEnabled && !twitterAccessSecret) missing.add('twitter_access_secret');

  if (discordEnabled) {
    if (discordMode === 'hybrid') {
      if (!discordBotToken) missing.add('discord_bot_token');
      if (!discordWebhookUrl) missing.add('discord_webhook_url');
    } else if (discordMode === 'webhook') {
      if (!discordWebhookUrl) missing.add('discord_webhook_url');
    } else if (discordMode === 'bot') {
      if (!discordBotToken) missing.add('discord_bot_token');
    } else if (!discordBotToken && !discordWebhookUrl) {
      missing.add('discord_bot_token_or_discord_webhook_url');
    }
  }

  if (missing.size > 0) {
    const missingList = Array.from(missing).sort();
    return {
      id,
      title,
      required: true,
      status: 'fail',
      reasonCode: 'REQUIRED_SECRET_MISSING',
      message: `Missing required secrets: ${missingList.join(', ')}`,
      sourceStep: 'secrets',
      remediation: [
        executeStepAction(
          'execute_secrets_step',
          avatar.avatarId,
          'secrets',
          'Run Secrets Setup',
          'Execute the secrets setup step to store required credentials.'
        ),
        openUiRouteAction(
          'open_secrets_settings',
          `/avatars/${avatar.avatarId}/onboarding?step=secrets`,
          'Open Secrets Setup',
          'Open setup and provide the missing secret values.'
        ),
      ],
      evidence: {
        missingCount: missingList.length,
        missingSecrets: missingList.join(','),
      },
    };
  }

  return {
    id,
    title,
    required: true,
    status: 'pass',
    reasonCode: 'REQUIRED_SECRETS_PRESENT',
    message: 'Required secrets for enabled platforms are configured.',
    remediation: [],
    evidence: {
      telegramEnabled,
      twitterEnabled,
      discordEnabled,
      telegramBotToken,
      telegramWebhookSecret,
      twitterAccessToken,
      twitterAccessSecret,
      discordBotToken,
      discordWebhookUrl,
    },
  };
}

function evaluateOnboardingCheck(avatar: AvatarRecord): ReadinessCheckV1 {
  if (avatar.status === 'deleted') {
    return {
      id: 'onboarding.state.verified',
      title: 'Onboarding state is activation-ready',
      required: true,
      status: 'fail',
      reasonCode: 'ONBOARDING_NOT_READY',
      message: 'Deleted avatars cannot be activated.',
      sourceStep: 'persona',
      remediation: [
        contactSupportAction(
          'deleted_avatar_activation_support',
          'Contact Support',
          'This avatar is deleted. Contact support if it needs to be restored.',
          'activation-avatar-deleted',
          'ONBOARDING_NOT_READY'
        ),
      ],
      evidence: {
        personaConfigured: false,
        avatarStatus: avatar.status,
      },
    };
  }

  const personaConfigured = hasText(avatar.persona);

  if (personaConfigured) {
    return {
      id: 'onboarding.state.verified',
      title: 'Onboarding state is activation-ready',
      required: true,
      status: 'pass',
      reasonCode: 'ONBOARDING_READY',
      message: 'Persona configuration is complete for activation.',
      sourceStep: 'persona',
      remediation: [],
      evidence: {
        personaConfigured: true,
        avatarStatus: avatar.status,
      },
    };
  }

  return {
    id: 'onboarding.state.verified',
    title: 'Onboarding state is activation-ready',
    required: true,
    status: 'fail',
    reasonCode: 'ONBOARDING_NOT_READY',
    message: 'Avatar persona must be configured before activation.',
    sourceStep: 'persona',
    remediation: [
      executeStepAction(
        'execute_persona_step',
        avatar.avatarId,
        'persona',
        'Run Persona Step',
        'Execute persona setup to complete activation prerequisites.'
      ),
      openUiRouteAction(
        'open_persona_setup',
        `/avatars/${avatar.avatarId}/onboarding?step=persona`,
        'Open Persona Setup',
        'Provide persona details in onboarding before activating.'
      ),
    ],
    evidence: {
      personaConfigured: false,
      avatarStatus: avatar.status,
    },
  };
}

function evaluatePlatformCheck(avatar: AvatarRecord): ReadinessCheckV1 {
  const enabledPlatforms = [
    avatar.platforms?.telegram?.enabled ? 'telegram' : null,
    avatar.platforms?.twitter?.enabled ? 'twitter' : null,
    avatar.platforms?.discord?.enabled ? 'discord' : null,
    avatar.platforms?.web?.enabled ? 'web' : null,
  ].filter((platform): platform is string => platform !== null);

  if (enabledPlatforms.length > 0) {
    return {
      id: 'platform.enabled.at_least_one',
      title: 'At least one platform is enabled',
      required: true,
      status: 'pass',
      reasonCode: 'PLATFORM_ENABLED',
      message: 'At least one runtime platform is enabled.',
      sourceStep: 'platforms',
      remediation: [],
      evidence: {
        enabledCount: enabledPlatforms.length,
        enabledPlatforms: enabledPlatforms.join(','),
      },
    };
  }

  return {
    id: 'platform.enabled.at_least_one',
    title: 'At least one platform is enabled',
    required: true,
    status: 'fail',
    reasonCode: 'NO_PLATFORM_ENABLED',
    message: 'At least one platform must be enabled before activation.',
    sourceStep: 'platforms',
    remediation: [
      executeStepAction(
        'execute_platforms_step',
        avatar.avatarId,
        'platforms',
        'Run Platform Setup',
        'Execute platform setup to enable at least one channel.'
      ),
      openUiRouteAction(
        'open_platform_settings',
        `/avatars/${avatar.avatarId}/onboarding?step=platforms`,
        'Open Platform Setup',
        'Enable at least one platform in onboarding before activation.'
      ),
    ],
    evidence: {
      enabledCount: 0,
      enabledPlatforms: '',
    },
  };
}

function evaluateTelegramProfileCheck(avatar: AvatarRecord): ReadinessCheckV1 {
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

function evaluateTelegramWebhookCheck(
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

async function evaluateTwitterHealthCheck(
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

  const getTwitterConnectionStatusImpl = deps.getTwitterConnectionStatus ?? getTwitterConnectionStatus;

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

async function evaluateDiscordHealthCheck(
  avatar: AvatarRecord,
  deps: ActivationReadinessDeps
): Promise<ReadinessCheckV1> {
  const discordEnabled = Boolean(avatar.platforms?.discord?.enabled);
  if (!discordEnabled) {
    return {
      id: 'integration.discord.connection_healthy',
      title: 'Discord integration health',
      required: false,
      status: 'not_applicable',
      reasonCode: 'DISCORD_NOT_ENABLED',
      message: 'Discord is not enabled for this avatar.',
      sourceStep: 'discord',
      remediation: [],
      evidence: {
        discordEnabled: false,
      },
    };
  }

  const getDiscordConnectionStatusImpl = deps.getDiscordConnectionStatus ?? getDiscordConnectionStatus;
  const discordMode = avatar.platforms?.discord?.mode;

  try {
    const status = await getDiscordConnectionStatusImpl(avatar.avatarId, discordMode, deps.discordServiceDeps);

    // Fully healthy: credentials valid AND runtime healthy (mode-aware)
    if (status.connected) {
      return {
        id: 'integration.discord.connection_healthy',
        title: 'Discord integration health',
        required: true,
        status: 'pass',
        reasonCode: 'DISCORD_CONNECTED',
        message: 'Discord integration is connected.',
        sourceStep: 'discord',
        remediation: [],
        evidence: {
          discordEnabled: true,
          connected: true,
          credentialsValid: status.credentialsValid,
          runtimeHealthy: status.runtimeHealthy,
          mode: status.mode,
          runtimeReason: status.runtimeDetail?.reason ?? null,
        },
      };
    }

    // Credentials valid but runtime unhealthy (bot/hybrid mode false-positive fix)
    if (status.credentialsValid && !status.runtimeHealthy) {
      const runtimeReason = status.runtimeDetail?.reason ?? 'unknown';
      return {
        id: 'integration.discord.connection_healthy',
        title: 'Discord integration health',
        required: true,
        status: 'fail',
        reasonCode: 'DISCORD_RUNTIME_UNAVAILABLE',
        message: `Discord credentials are valid but the gateway runtime is unavailable (${runtimeReason}). Bot/hybrid ingress will not receive messages.`,
        sourceStep: 'discord',
        remediation: [
          contactSupportAction(
            'discord_gateway_not_deployed',
            'Deploy Gateway',
            'The Discord gateway service must be deployed for bot/hybrid mode. Enable enableDiscordGateway in the infrastructure configuration and redeploy.',
            'activation-discord-gateway-unavailable',
            'DISCORD_RUNTIME_UNAVAILABLE'
          ),
          openUiRouteAction(
            'open_discord_settings',
            `/avatars/${avatar.avatarId}/onboarding?step=discord`,
            'Switch to Webhook Mode',
            'If gateway deployment is not available, switch to webhook mode which does not require a gateway runtime.'
          ),
        ],
        evidence: {
          discordEnabled: true,
          connected: false,
          credentialsValid: true,
          runtimeHealthy: false,
          mode: status.mode,
          runtimeReason,
        },
      };
    }

    // Credentials invalid (or no credentials)
    return {
      id: 'integration.discord.connection_healthy',
      title: 'Discord integration health',
      required: true,
      status: 'fail',
      reasonCode: 'DISCORD_CONNECTION_UNHEALTHY',
      message: 'Discord is enabled but no valid bot or webhook connection is configured.',
      sourceStep: 'discord',
      remediation: [
        executeStepAction(
          'execute_discord_connection_step',
          avatar.avatarId,
          'discord',
          'Run Discord Connection',
          'Execute Discord setup to configure bot token or webhook connectivity.'
        ),
        openUiRouteAction(
          'open_discord_settings',
          `/avatars/${avatar.avatarId}/onboarding?step=discord`,
          'Open Discord Setup',
          'Configure Discord integration before activation.'
        ),
      ],
      evidence: {
        discordEnabled: true,
        connected: false,
        credentialsValid: status.credentialsValid,
        runtimeHealthy: status.runtimeHealthy,
        mode: status.mode,
        runtimeReason: status.runtimeDetail?.reason ?? null,
      },
    };
  } catch {
    return {
      id: 'integration.discord.connection_healthy',
      title: 'Discord integration health',
      required: true,
      status: 'warn',
      reasonCode: 'DISCORD_HEALTH_UNKNOWN',
      message: 'Discord health check is temporarily unavailable.',
      sourceStep: 'discord',
      remediation: [
        openUiRouteAction(
          'open_discord_status',
          `/avatars/${avatar.avatarId}/onboarding?step=discord`,
          'Check Discord Setup',
          'Open Discord setup and verify the integration status.'
        ),
      ],
      evidence: {
        discordEnabled: true,
        connected: false,
      },
    };
  }
}

/**
 * Evaluate whether avatars configured with Discord bot/hybrid mode have
 * gateway runtime available. When the gateway is disabled at the infrastructure
 * level, bot/hybrid mode avatars will not receive inbound Discord messages.
 *
 * The check uses the DISCORD_GATEWAY_ENABLED environment variable (set by CDK
 * via the CfnOutput/Lambda env) to determine gateway availability.
 * - Webhook-only avatars always pass (no gateway dependency).
 * - Bot/hybrid avatars warn when gateway is disabled.
 */
function evaluateDiscordGatewayReadinessCheck(avatar: AvatarRecord): ReadinessCheckV1 {
  const discordEnabled = Boolean(avatar.platforms?.discord?.enabled);
  const discordMode = avatar.platforms?.discord?.mode;

  if (!discordEnabled) {
    return {
      id: 'platform.discord.gateway_available',
      title: 'Discord gateway runtime is available',
      required: false,
      status: 'not_applicable',
      reasonCode: 'DISCORD_NOT_ENABLED',
      message: 'Discord is not enabled for this avatar.',
      sourceStep: 'discord',
      remediation: [],
      evidence: {
        discordEnabled: false,
      },
    };
  }

  // Webhook-only mode does not require the gateway
  if (discordMode === 'webhook') {
    return {
      id: 'platform.discord.gateway_available',
      title: 'Discord gateway runtime is available',
      required: false,
      status: 'not_applicable',
      reasonCode: 'DISCORD_WEBHOOK_ONLY',
      message: 'Webhook-only Discord mode does not require the gateway runtime.',
      sourceStep: 'discord',
      remediation: [],
      evidence: {
        discordEnabled: true,
        discordMode: 'webhook',
        gatewayRequired: false,
      },
    };
  }

  // Bot and hybrid modes require the gateway runtime
  const gatewayEnabled = process.env.DISCORD_GATEWAY_ENABLED === 'true';

  if (gatewayEnabled) {
    return {
      id: 'platform.discord.gateway_available',
      title: 'Discord gateway runtime is available',
      required: true,
      status: 'pass',
      reasonCode: 'DISCORD_GATEWAY_AVAILABLE',
      message: 'Discord gateway runtime is deployed and available for inbound messages.',
      sourceStep: 'discord',
      remediation: [],
      evidence: {
        discordEnabled: true,
        discordMode: discordMode ?? 'unknown',
        gatewayRequired: true,
        gatewayEnabled: true,
      },
    };
  }

  // Gateway is not deployed — warn for bot/hybrid mode
  return {
    id: 'platform.discord.gateway_available',
    title: 'Discord gateway runtime is available',
    required: true,
    status: 'warn',
    reasonCode: 'DISCORD_GATEWAY_UNAVAILABLE',
    message:
      `Discord ${discordMode ?? 'bot'} mode requires the gateway runtime to receive ` +
      'inbound messages. The gateway is currently disabled in this environment. ' +
      'Outbound webhook operations will still work, but the bot will not receive ' +
      'new messages from Discord channels.',
    sourceStep: 'discord',
    remediation: [
      contactSupportAction(
        'contact_support_discord_gateway',
        'Contact Support',
        'Request that the Discord gateway be enabled for this environment (enableDiscordGateway=true in CDK context).',
        'activation-discord-gateway-unavailable',
        'DISCORD_GATEWAY_UNAVAILABLE'
      ),
    ],
    evidence: {
      discordEnabled: true,
      discordMode: discordMode ?? 'unknown',
      gatewayRequired: true,
      gatewayEnabled: false,
    },
  };
}

function evaluateObservabilityCheck(): ReadinessCheckV1 {
  const observabilityAvailable = Boolean(process.env.LOG_GROUP_PREFIX || process.env.ADMIN_LOG_GROUPS);

  if (observabilityAvailable) {
    return {
      id: 'observability.logging.available',
      title: 'Observability logging is available',
      required: false,
      status: 'pass',
      reasonCode: 'OBSERVABILITY_AVAILABLE',
      message: 'Logging integration is configured for this environment.',
      sourceStep: 'observability',
      remediation: [],
      evidence: {
        observabilityAvailable: true,
      },
    };
  }

  return {
    id: 'observability.logging.available',
    title: 'Observability logging is available',
    required: false,
    status: 'warn',
    reasonCode: 'OBSERVABILITY_DEGRADED',
    message: 'Centralized logging is not fully configured for this environment.',
    sourceStep: 'observability',
    remediation: [
      contactSupportAction(
        'contact_support_observability',
        'Contact Support',
        'Contact support to verify logging configuration and diagnostics availability.',
        'activation-observability-degraded',
        'OBSERVABILITY_DEGRADED'
      ),
    ],
    evidence: {
      observabilityAvailable: false,
    },
  };
}

export async function evaluateActivationReadiness(
  avatar: AvatarRecord,
  context: ActivationReadinessContext,
  deps: ActivationReadinessDeps = {}
): Promise<ActivationReadinessReportV1> {
  const now = deps.now ?? (() => Date.now());
  const diagnoseTelegramImpl = deps.diagnoseTelegram ?? diagnoseTelegram;

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
