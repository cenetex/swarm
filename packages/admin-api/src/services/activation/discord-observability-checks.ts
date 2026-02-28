/**
 * Activation Readiness — Discord & Observability Checks
 *
 * Evaluates Discord connection health, gateway readiness,
 * and observability logging availability.
 */
import type { AvatarRecord } from '../../types.js';
import { getConnectionStatus as getDiscordConnectionStatusDefault } from '../discord.js';
import type { ReadinessCheckV1, ActivationReadinessDeps } from './types.js';
import {
  executeStepAction,
  openUiRouteAction,
  contactSupportAction,
} from './remediation-helpers.js';

export async function evaluateDiscordHealthCheck(
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

  const getDiscordConnectionStatusImpl = deps.getDiscordConnectionStatus ?? getDiscordConnectionStatusDefault;
  const discordMode = avatar.platforms?.discord?.mode;

  try {
    const status = await getDiscordConnectionStatusImpl(avatar.avatarId, discordMode, deps.discordServiceDeps);

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

export function evaluateDiscordGatewayReadinessCheck(avatar: AvatarRecord): ReadinessCheckV1 {
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

export function evaluateObservabilityCheck(): ReadinessCheckV1 {
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
