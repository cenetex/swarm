/**
 * Activation Readiness — Core Checks
 *
 * Evaluates identity resolution, required secrets,
 * onboarding state, and platform enablement.
 */
import type { AvatarRecord } from '../../types.js';
import { getAccountSummary as getAccountSummaryDefault } from '../accounts.js';
import type {
  ReadinessCheckV1,
  ActivationReadinessContext,
  ActivationReadinessDeps,
} from './types.js';
import {
  hasText,
  executeStepAction,
  openUiRouteAction,
  contactSupportAction,
  hasSecretConfigured,
} from './remediation-helpers.js';

export async function evaluateIdentityCheck(
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

  const getAccountSummaryImpl = deps.getAccountSummary ?? getAccountSummaryDefault;
  let account: Awaited<ReturnType<typeof getAccountSummaryDefault>>;
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

export async function evaluateSecretsCheck(
  avatar: AvatarRecord,
  deps: ActivationReadinessDeps
): Promise<ReadinessCheckV1> {
  const id = 'secrets.required.present';
  const title = 'Required secrets are present';

  const telegramEnabled = Boolean(avatar.platforms?.telegram?.enabled);
  const telegramUsesManagedBotToken = Boolean(avatar.platforms?.telegram?.isAdminBot);
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
      telegramEnabled && !telegramUsesManagedBotToken
        ? hasSecretConfigured(avatar.avatarId, 'telegram_bot_token', deps)
        : Promise.resolve(true),
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
  if (telegramEnabled && !telegramUsesManagedBotToken && !telegramBotToken) missing.add('telegram_bot_token');
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

export function evaluateOnboardingCheck(avatar: AvatarRecord): ReadinessCheckV1 {
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

export function evaluatePlatformCheck(avatar: AvatarRecord): ReadinessCheckV1 {
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
