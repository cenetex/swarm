/**
 * Telegram integration routes.
 *
 * - GET  /avatars/{id}/telegram/diagnose
 * - POST /avatars/{id}/telegram/repair
 * - GET  /avatars/{id}/telegram/known-users
 * - POST /avatars/{id}/telegram/resolve-group
 * - POST /avatars/{id}/telegram/bind-code            (#1471)
 * - GET  /avatars/{id}/telegram/binding              (#1471)
 * - DELETE /avatars/{id}/telegram/binding            (#1471)
 * - GET  /avatars/{id}/telegram/state                (#1474 — aggregated)
 * - DELETE /avatars/{id}/telegram/allowed-chats/:cid (#1474)
 * - DELETE /avatars/{id}/telegram/allowed-dmers/:uid (#1474)
 */
import type { HttpResponse } from "@swarm/core";
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as telegramService from '../../services/telegram.js';
import * as secretsService from '../../services/secrets.js';
import { diagnoseTelegram, computeTelegramRepairPlan } from '../../services/telegram-admin.js';
import {
  computeTelegramOnboardingExecution,
  deriveTelegramOnboardingStepStatus,
} from '../../services/telegram-onboarding.js';
import { getKnownTelegramUsers } from '../../services/channel-state.js';
import * as telegramBindings from '../../services/telegram-bindings.js';
import * as telegramDmApprovals from '../../services/telegram-dm-approvals.js';

export async function handleTelegramRoutes(
  ctx: RouteContext,
): Promise<HttpResponse | null> {
  const { method, path, event, corsHeaders, session } = ctx;

  // ── GET /avatars/{id}/telegram/diagnose ──────────────────────────────────
  const diagnoseMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/(diagnose|diagnostics)$/);
  if (method === 'GET' && diagnoseMatch) {
    const avatarId = diagnoseMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const report = await diagnoseTelegram(avatarId);
      const onboardingStep = report.onboardingStep ?? deriveTelegramOnboardingStepStatus({
        platformEnabled: report.platformEnabled,
        tokenPresent: report.tokenPresent,
        webhookSecretPresent: report.webhookSecretPresent,
        issues: report.issues,
      });
      const onboardingExecution = computeTelegramOnboardingExecution(onboardingStep, 'verify');
      return jsonResponse(corsHeaders, 200, {
        ...report,
        onboardingStep,
        onboardingExecution,
        stepState: onboardingStep.state,
        reasonCodes: onboardingStep.reasons.map(reason => reason.code),
        remediation: onboardingStep.remediation,
      });
    } catch (err) {
      logger.error('Telegram diagnosis failed', {
        event: 'telegram_diagnose_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Diagnosis failed' });
    }
  }

  // ── POST /avatars/{id}/telegram/repair ───────────────────────────────────
  const repairMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/repair$/);
  if (method === 'POST' && repairMatch) {
    const avatarId = repairMatch[1];
    const body = parseJsonBody<{
      dryRun?: boolean;
      force?: boolean;
      includeDisabled?: boolean;
      rotateSecret?: boolean;
      repairOnPendingUpdates?: boolean;
      repairOnLastError?: boolean;
    }>(event);
    const rotateSecret = Boolean(body.rotateSecret);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    logger.setContext({ subsystem: 'telegram', avatarId });

    const before = await diagnoseTelegram(avatarId);
    const beforeOnboardingStep = before.onboardingStep ?? deriveTelegramOnboardingStepStatus({
      platformEnabled: before.platformEnabled,
      tokenPresent: before.tokenPresent,
      webhookSecretPresent: before.webhookSecretPresent,
      issues: before.issues,
    });
    const onboardingExecution = computeTelegramOnboardingExecution(beforeOnboardingStep, 'repair');
    const plan = computeTelegramRepairPlan(before, {
      force: Boolean(body.force),
      includeDisabled: Boolean(body.includeDisabled),
      repairOnPendingUpdates: Boolean(body.repairOnPendingUpdates),
      repairOnLastError: Boolean(body.repairOnLastError),
    });

    if (plan.action === 'skip') {
      return jsonResponse(corsHeaders, 200, {
        avatarId,
        action: 'skipped',
        reason: plan.reason,
        idempotent: onboardingExecution.idempotent,
        reasonCodes: onboardingExecution.reasonCodes,
        onboardingStep: {
          requestedAction: onboardingExecution.requestedAction,
          execution: onboardingExecution,
          before: beforeOnboardingStep,
        },
        before,
      });
    }

    if (body.dryRun) {
      return jsonResponse(corsHeaders, 200, {
        avatarId,
        action: 'would_repair',
        reason: plan.reason,
        idempotent: onboardingExecution.idempotent,
        reasonCodes: onboardingExecution.reasonCodes,
        onboardingStep: {
          requestedAction: onboardingExecution.requestedAction,
          execution: onboardingExecution,
          before: beforeOnboardingStep,
        },
        before,
      });
    }

    // Repair without user re-submitting the token.
    const botToken = await secretsService._getSecretValueInternal(
      avatarId,
      'telegram_bot_token',
      'default',
    );
    if (!botToken) {
      return jsonResponse(corsHeaders, 400, {
        error: 'Missing Telegram bot token secret',
        reasonCodes: onboardingExecution.reasonCodes,
        onboardingStep: {
          requestedAction: onboardingExecution.requestedAction,
          execution: onboardingExecution,
          before: beforeOnboardingStep,
        },
      });
    }

    let webhookSecret = await secretsService._getSecretValueInternal(
      avatarId,
      'telegram_webhook_secret',
      'default',
    );

    const hadSecret = Boolean(webhookSecret);
    if (!webhookSecret || rotateSecret) {
      webhookSecret = telegramService.generateWebhookSecret();
    }

    logger.info('Telegram webhook repair requested', {
      event: 'telegram_webhook_repair_requested',
      force: Boolean(body.force),
      includeDisabled: Boolean(body.includeDisabled),
      rotateSecret,
      hadSecret,
    });

    const result = await telegramService.registerTelegramWebhook(
      botToken,
      avatarId,
      webhookSecret,
    );
    if (!result.success) {
      logger.warn('Telegram webhook repair failed', {
        event: 'telegram_webhook_repair_failed',
        error: result.message,
      });
      return jsonResponse(corsHeaders, 400, {
        error: result.message || 'Failed to repair Telegram webhook',
        reasonCodes: onboardingExecution.reasonCodes,
        onboardingStep: {
          requestedAction: onboardingExecution.requestedAction,
          execution: onboardingExecution,
          before: beforeOnboardingStep,
        },
      });
    }

    // Only store the secret if it was missing or explicitly rotated.
    if (!hadSecret || rotateSecret) {
      await secretsService.storeSecret(
        avatarId,
        'telegram_webhook_secret',
        'default',
        webhookSecret,
        session,
        `Telegram webhook secret for ${avatarId}`,
      );
    }

    const after = await diagnoseTelegram(avatarId);
    const afterOnboardingStep = after.onboardingStep ?? deriveTelegramOnboardingStepStatus({
      platformEnabled: after.platformEnabled,
      tokenPresent: after.tokenPresent,
      webhookSecretPresent: after.webhookSecretPresent,
      issues: after.issues,
    });
    const afterOnboardingExecution = computeTelegramOnboardingExecution(afterOnboardingStep, 'repair');
    return jsonResponse(corsHeaders, 200, {
      avatarId,
      action: 'repaired',
      reason: plan.reason,
      idempotent: rotateSecret ? false : onboardingExecution.idempotent,
      reasonCodes: onboardingExecution.reasonCodes,
      rotatedSecret: !hadSecret || rotateSecret ? true : false,
      onboardingStep: {
        requestedAction: onboardingExecution.requestedAction,
        execution: onboardingExecution,
        before: beforeOnboardingStep,
        after: afterOnboardingStep,
        afterExecution: afterOnboardingExecution,
      },
      before,
      after,
      status: {
        webhookUrl: result.webhookUrl,
        reRegistered: result.reRegistered,
        webhookInfo: result.webhookInfo,
      },
    });
  }

  // ── GET /avatars/{id}/telegram/known-users ───────────────────────────────
  const knownUsersMatch = path.match(
    /^\/avatars\/([^/]+)\/telegram\/known-users$/,
  );
  if (method === 'GET' && knownUsersMatch) {
    const avatarId = knownUsersMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const users = await getKnownTelegramUsers(avatarId);
      return jsonResponse(corsHeaders, 200, { users });
    } catch (err) {
      logger.error('Failed to get known Telegram users', {
        event: 'telegram_known_users_failed',
        error: err,
      });
      return jsonResponse(corsHeaders, 500, {
        error: 'Failed to get known Telegram users',
      });
    }
  }

  // ── POST /avatars/{id}/telegram/resolve-group ────────────────────────────
  const resolveGroupMatch = path.match(
    /^\/avatars\/([^/]+)\/telegram\/resolve-group$/,
  );
  if (method === 'POST' && resolveGroupMatch) {
    const avatarId = resolveGroupMatch[1];
    const body = parseJsonBody<{ username?: string }>(event);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    if (!body.username || typeof body.username !== 'string') {
      return jsonResponse(corsHeaders, 400, { error: 'username is required' });
    }

    // Get bot token to make the API call
    const botToken = await secretsService._getSecretValueInternal(
      avatarId,
      'telegram_bot_token',
      'default',
    );
    if (!botToken) {
      return jsonResponse(corsHeaders, 400, {
        error: 'Telegram bot token not configured',
      });
    }

    try {
      // Parse the username - check if it looks like a t.me/ URL or just a username
      let username = body.username;
      const urlMatch = username.match(/(?:https?:\/\/)?t\.me\/([+@]?[\w]+)/);
      if (urlMatch) {
        username = urlMatch[1];
        // Check if it's an invite hash (starts with +)
        if (username.startsWith('+')) {
          return jsonResponse(corsHeaders, 400, {
            error: 'Invite links can\'t be resolved. Add the bot to the group first, then select it from "Recently active".',
          });
        }
      }

      const result = await telegramService.resolveGroupUsername(
        botToken,
        username,
      );
      if (!result) {
        return jsonResponse(corsHeaders, 404, {
          error:
            'Group not found or bot does not have access. Make sure the bot is a member of the group.',
        });
      }
      return jsonResponse(corsHeaders, 200, result);
    } catch (err) {
      logger.error('Failed to resolve Telegram group', {
        event: 'telegram_resolve_group_failed',
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to resolve group' });
    }
  }

  // ── POST /avatars/{id}/telegram/bind-code ────────────────────────────────
  // #1471: Issue a one-time bind code and return a Telegram deep link that
  // starts the owner-binding flow. The owner taps the link in their browser,
  // Telegram opens the bot DM with `/start bind_<code>`, the bot posts an
  // inline-keyboard confirmation, and the tap writes the binding.
  const bindCodeMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/bind-code$/);
  if (method === 'POST' && bindCodeMatch) {
    const avatarId = bindCodeMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });

    const botUsername = avatar.platforms?.telegram?.botUsername;
    if (!botUsername) {
      return jsonResponse(corsHeaders, 400, {
        error: 'Configure a bot token first — we need the bot username to build the deep link.',
      });
    }

    try {
      const record = await telegramBindings.issueBindCode(avatarId);
      const deepLink = `https://t.me/${botUsername}?start=bind_${record.code}`;
      logger.info('Issued Telegram bind code', {
        event: 'telegram_bind_code_issued',
        avatarId,
        actor: session.email,
      });
      return jsonResponse(corsHeaders, 200, {
        code: record.code,
        deepLink,
        expiresAt: record.ttl * 1000,
      });
    } catch (err) {
      logger.error('Failed to issue Telegram bind code', {
        event: 'telegram_bind_code_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to issue bind code' });
    }
  }

  // ── GET /avatars/{id}/telegram/binding ───────────────────────────────────
  // #1471: Return the current owner binding (if any) so the admin UI can
  // show "Bound as @<username>" instead of the bind CTA.
  const bindingMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/binding$/);
  if (method === 'GET' && bindingMatch) {
    const avatarId = bindingMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const binding = await telegramBindings.getOwnerBinding(avatarId);
      return jsonResponse(corsHeaders, 200, {
        bound: Boolean(binding),
        telegramUserId: binding?.telegramUserId,
        telegramUsername: binding?.telegramUsername,
        boundAt: binding?.boundAt,
      });
    } catch (err) {
      logger.error('Failed to fetch Telegram binding', {
        event: 'telegram_binding_fetch_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to fetch binding' });
    }
  }

  // ── DELETE /avatars/{id}/telegram/binding ────────────────────────────────
  // #1471: Unbind so the owner can rebind (e.g., lost phone, moved accounts).
  if (method === 'DELETE' && bindingMatch) {
    const avatarId = bindingMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      await telegramBindings.deleteOwnerBinding(avatarId);
      logger.info('Deleted Telegram owner binding', {
        event: 'telegram_binding_deleted',
        avatarId,
        actor: session.email,
      });
      return jsonResponse(corsHeaders, 200, { ok: true });
    } catch (err) {
      logger.error('Failed to delete Telegram binding', {
        event: 'telegram_binding_delete_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to delete binding' });
    }
  }

  // ── GET /avatars/{id}/telegram/state ─────────────────────────────────────
  // #1474: Aggregated state for the read-only dashboard view. One round-trip
  // gives the UI everything it needs: owner binding, approved chats,
  // approved DMers, live pending DM approvals.
  const stateMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/state$/);
  if (method === 'GET' && stateMatch) {
    const avatarId = stateMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const [avatar, binding, pending] = await Promise.all([
        avatarService.getAvatar(avatarId),
        telegramBindings.getOwnerBinding(avatarId),
        telegramDmApprovals.listPending(avatarId),
      ]);
      if (!avatar) return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });

      const telegramCfg = avatar.platforms?.telegram;
      return jsonResponse(corsHeaders, 200, {
        botUsername: telegramCfg?.botUsername,
        platformEnabled: Boolean(telegramCfg?.enabled),
        binding: binding
          ? {
              telegramUserId: binding.telegramUserId,
              telegramUsername: binding.telegramUsername,
              boundAt: binding.boundAt,
            }
          : null,
        allowedChats: telegramCfg?.allowedChats ?? [],
        allowedDmUsers: telegramCfg?.allowedDmUsers ?? [],
        pendingDms: pending.map(p => ({
          requesterId: p.requesterId,
          requesterUsername: p.requesterUsername,
          requesterDisplayName: p.requesterDisplayName,
          firstMessage: p.firstMessage,
          issuedAt: p.issuedAt,
        })),
      });
    } catch (err) {
      logger.error('Failed to fetch Telegram state', {
        event: 'telegram_state_fetch_failed',
        avatarId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to fetch Telegram state' });
    }
  }

  // ── DELETE /avatars/{id}/telegram/allowed-chats/{chatId} ────────────────
  // #1474: Revoke access to a chat from the dashboard. Same mutation that
  // the [🚫 Disable] inline button does in the group itself (#1472), but
  // reachable when the bot has already been kicked.
  const revokeChatMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/allowed-chats\/([^/]+)$/);
  if (method === 'DELETE' && revokeChatMatch) {
    const avatarId = revokeChatMatch[1];
    const chatId = decodeURIComponent(revokeChatMatch[2]);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const avatar = await avatarService.getAvatar(avatarId);
      if (!avatar) return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
      const telegramCfg = avatar.platforms?.telegram;
      const existing = telegramCfg?.allowedChats ?? [];
      const filtered = existing.filter(c => String(c.chatId) !== chatId);
      if (filtered.length === existing.length) {
        return jsonResponse(corsHeaders, 404, { error: 'Chat not in allowlist' });
      }
      await avatarService.updateAvatar(
        avatarId,
        {
          platforms: {
            ...avatar.platforms,
            telegram: { ...telegramCfg!, allowedChats: filtered },
          },
        },
        session,
      );
      logger.info('Revoked Telegram chat access via dashboard', {
        event: 'telegram_chat_revoked_via_dashboard',
        avatarId,
        chatId,
        actor: session.email,
      });
      return jsonResponse(corsHeaders, 200, { ok: true });
    } catch (err) {
      logger.error('Failed to revoke Telegram chat', {
        event: 'telegram_chat_revoke_failed',
        avatarId,
        chatId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to revoke chat' });
    }
  }

  // ── DELETE /avatars/{id}/telegram/allowed-dmers/{userId} ────────────────
  // #1474: Revoke a DM approval from the dashboard. Mirrors the [🚫 Revoke]
  // inline button in the owner's Telegram DM (#1473).
  const revokeDmerMatch = path.match(/^\/avatars\/([^/]+)\/telegram\/allowed-dmers\/([^/]+)$/);
  if (method === 'DELETE' && revokeDmerMatch) {
    const avatarId = revokeDmerMatch[1];
    const userId = decodeURIComponent(revokeDmerMatch[2]);

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    try {
      const avatar = await avatarService.getAvatar(avatarId);
      if (!avatar) return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
      const telegramCfg = avatar.platforms?.telegram;
      const existing = telegramCfg?.allowedDmUsers ?? [];
      const filtered = existing.filter(u => String(u.userId) !== userId);
      if (filtered.length === existing.length) {
        return jsonResponse(corsHeaders, 404, { error: 'User not in DM allowlist' });
      }
      await avatarService.updateAvatar(
        avatarId,
        {
          platforms: {
            ...avatar.platforms,
            telegram: { ...telegramCfg!, allowedDmUsers: filtered },
          },
        },
        session,
      );
      logger.info('Revoked Telegram DM access via dashboard', {
        event: 'telegram_dm_revoked_via_dashboard',
        avatarId,
        userId,
        actor: session.email,
      });
      return jsonResponse(corsHeaders, 200, { ok: true });
    } catch (err) {
      logger.error('Failed to revoke Telegram DM access', {
        event: 'telegram_dmer_revoke_failed',
        avatarId,
        userId,
        error: err,
      });
      return jsonResponse(corsHeaders, 500, { error: 'Failed to revoke DM access' });
    }
  }

  return null;
}
