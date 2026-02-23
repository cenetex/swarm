/**
 * Secret management and token validation routes.
 *
 * - POST /avatars/{id}/secrets
 * - GET  /avatars/{id}/secrets
 * - POST /avatars/{id}/validate-token
 * - POST /avatars/{id}/validate-ai-key
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as secretsService from '../../services/secrets.js';
import * as auditLogService from '../../services/audit-log.js';
import type { ActorType } from '../../services/audit-log.js';
import { parseJsonBody } from '../../http/request-body.js';
import * as telegramService from '../../services/telegram.js';
import * as discordService from '../../services/discord.js';
import { setupTelegramIntegration } from '../../services/telegram-admin.js';
import { validateReplicateApiKey } from '../../services/replicate.js';
import { SecretType } from '../../types.js';

/**
 * Resolve actor type from context: admin or owner.
 */
function resolveActorType(effectiveIsAdmin: boolean): ActorType {
  return effectiveIsAdmin ? 'admin' : 'owner';
}

export async function handleSecretsRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, event, corsHeaders, session } = ctx;

  const secretsMatch = path.match(/^\/avatars\/([^/]+)\/secrets$/);

  // ── POST /avatars/{id}/secrets — Save a secret for an avatar ─────────────
  if (method === 'POST' && secretsMatch) {
    const avatarId = secretsMatch[1];
    const body = parseJsonBody<Record<string, unknown>>(event);
    const { key, type, value } = body as { key?: string; type?: string; value?: string };
    const rawKey = key || type;
    let telegramStatus: {
      webhookUrl?: string;
      webhookInfo?: { url?: string; pending_update_count?: number };
      reRegistered?: boolean;
    } | null = null;

    const normalizedKey = typeof rawKey === 'string' ? rawKey.trim().toLowerCase() : rawKey;

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    if (typeof normalizedKey !== 'string' || typeof value !== 'string' || !normalizedKey || !value) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'key and value are required' }),
      };
    }

    const secretType = SecretType.safeParse(normalizedKey);
    if (!secretType.success) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Unsupported secret key: ${normalizedKey}`,
          allowed: SecretType.options,
        }),
      };
    }

    if (normalizedKey === 'telegram_bot_token') {
      logger.setContext({ subsystem: 'telegram', avatarId });
      logger.info('Telegram token setup requested via API', {
        event: 'telegram_token_setup_via_api',
      });

      const setupResult = await setupTelegramIntegration({
        avatarId,
        token: value,
        session,
        deps: {
          validateTelegramToken: telegramService.validateTelegramToken,
          registerTelegramWebhook: telegramService.registerTelegramWebhook,
          generateWebhookSecret: telegramService.generateWebhookSecret,
          updateAvatar: avatarService.updateAvatar,
          storeSecret: secretsService.storeSecret,
        },
      });

      if (!setupResult.success) {
        logger.warn('Telegram token setup failed', {
          event: 'telegram_token_setup_failed',
          error: setupResult.error,
        });
        return jsonResponse(corsHeaders, 400, {
          error: setupResult.error || 'Failed to configure Telegram',
        });
      }

      telegramStatus = setupResult.status
        ? {
            webhookUrl: setupResult.status.webhookUrl,
            webhookInfo: setupResult.status.webhookInfo,
            reRegistered: setupResult.status.reRegistered,
          }
        : null;
    } else {
      if (normalizedKey === 'replicate_api_key') {
        logger.setContext({ subsystem: 'media', avatarId });
        logger.info('Replicate key validation requested via API', {
          event: 'replicate_key_validate_via_api',
        });

        const validation = await validateReplicateApiKey(value);
        if (!validation.valid) {
          return jsonResponse(corsHeaders, 400, {
            error: validation.error || 'Replicate key invalid',
          });
        }
      }

      await secretsService.storeSecret(
        avatarId,
        secretType.data,
        'default',
        value,
        session,
        `${normalizedKey} for avatar ${avatarId}`,
      );
    }

    // Audit: record secret set operation (log key name only, never the value)
    try {
      const actorId = ctx.walletAddress || session.email || 'unknown';
      await auditLogService.recordAuditEvent({
        avatarId,
        eventType: 'secret_set',
        actorId,
        actorType: resolveActorType(ctx.effectiveIsAdmin),
        details: {
          secretKey: normalizedKey,
        },
      });
    } catch (err) {
      logger.warn('Failed to record secret set audit event', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: `${normalizedKey} stored securely`,
        telegramStatus: telegramStatus || undefined,
      }),
    };
  }

  // ── GET /avatars/{id}/secrets — List secrets (not values) ────────────────
  if (method === 'GET' && secretsMatch) {
    const avatarId = secretsMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const secrets = await secretsService.listSecrets(avatarId);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(secrets),
    };
  }

  // ── POST /avatars/{id}/validate-token ────────────────────────────────────
  const validateTokenMatch = path.match(/^\/avatars\/([^/]+)\/validate-token$/);
  if (method === 'POST' && validateTokenMatch) {
    const avatarId = validateTokenMatch[1];
    const body = parseJsonBody<{ type?: string; value?: string }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const normalizedType = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';

    if (!normalizedType || typeof body.value !== 'string' || !body.value) {
      return jsonResponse(corsHeaders, 400, { error: 'type and value are required' });
    }

    const secretType = SecretType.safeParse(normalizedType);
    if (!secretType.success) {
      return jsonResponse(corsHeaders, 400, {
        error: `Unsupported secret type: ${normalizedType}`,
        allowed: SecretType.options,
      });
    }

    switch (secretType.data) {
      case 'telegram_bot_token': {
        const validation = await telegramService.validateTelegramToken(body.value);
        return jsonResponse(corsHeaders, 200, validation);
      }
      case 'discord_bot_token': {
        const validation = await discordService.validateBotToken(body.value);
        return jsonResponse(corsHeaders, 200, validation);
      }
      case 'discord_webhook_url': {
        const validation = await discordService.validateWebhookUrl(body.value);
        return jsonResponse(corsHeaders, 200, validation);
      }
      default:
        return jsonResponse(corsHeaders, 400, {
          error: 'Validation not supported for this secret type',
        });
    }
  }

  // ── POST /avatars/{id}/validate-ai-key ───────────────────────────────────
  const validateAiKeyMatch = path.match(/^\/avatars\/([^/]+)\/validate-ai-key$/);
  if (method === 'POST' && validateAiKeyMatch) {
    const avatarId = validateAiKeyMatch[1];
    const body = parseJsonBody<{
      integration?: string;
      value?: string;
    }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const integration = typeof body.integration === 'string' ? body.integration.trim().toLowerCase() : '';
    const value = typeof body.value === 'string' ? body.value.trim() : '';

    if (!integration || !value) {
      return jsonResponse(corsHeaders, 400, {
        error: 'integration and value are required',
      });
    }

    if (integration === 'replicate') {
      const validation = await validateReplicateApiKey(value);
      return jsonResponse(corsHeaders, validation.valid ? 200 : 400, validation);
    }

    if (integration === 'openai') {
      try {
        const resp = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${value}` },
        });
        if (resp.status === 401) {
          return jsonResponse(corsHeaders, 400, {
            valid: false,
            error: 'Invalid API key. Please check your OpenAI dashboard.',
          });
        }
        if (!resp.ok) {
          return jsonResponse(corsHeaders, 400, {
            valid: false,
            error: `OpenAI API error: ${resp.status} ${resp.statusText}`,
          });
        }
        return jsonResponse(corsHeaders, 200, { valid: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return jsonResponse(corsHeaders, 400, {
          valid: false,
          error: `Could not validate API key: ${msg}`,
        });
      }
    }

    // Best-effort validation for other providers (format-only).
    if (integration === 'anthropic') {
      const looksValid = value.startsWith('sk-ant-') || value.length > 20;
      return jsonResponse(corsHeaders, looksValid ? 200 : 400, {
        valid: looksValid,
        error: looksValid
          ? undefined
          : 'API key format looks invalid. Expected something like sk-ant-...',
      });
    }

    if (integration === 'openrouter') {
      const looksValid = value.length > 20;
      return jsonResponse(corsHeaders, looksValid ? 200 : 400, {
        valid: looksValid,
        error: looksValid ? undefined : 'API key format looks invalid.',
      });
    }

    return jsonResponse(corsHeaders, 400, {
      valid: false,
      error: `Unsupported integration: ${integration}`,
    });
  }

  return null;
}
