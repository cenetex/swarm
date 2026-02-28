/**
 * Telegram Admin Utilities
 *
 * Combines diagnostics, repair planning, and setup for Telegram integration.
 * These are admin-facing operations used by the MCP adapter, avatar routes,
 * and activation-readiness checks.
 */
import type { SecretType, UserSession } from '../../types.js';
import type { updateAvatar } from '../avatars.js';
import type { storeSecret } from '../secrets.js';
import {
  getTelegramWebhookInfoDetailed,
  getTelegramWebhookUrlForAvatar,
  validateTelegramToken,
  type TelegramWebhookInfoDetailed,
} from './telegram.js';
import {
  computeTelegramOnboardingExecution,
  deriveTelegramOnboardingStepStatus,
  type TelegramOnboardingExecution,
  type TelegramOnboardingExecuteAction,
  type TelegramOnboardingStepStatus,
} from './telegram-onboarding.js';

// =============================================================================
// Diagnostics
// =============================================================================

export type TelegramDiagnosticsIssueCode =
  | 'missing_bot_token'
  | 'invalid_bot_token'
  | 'missing_webhook_secret'
  | 'webhook_url_mismatch'
  | 'webhook_pending_updates'
  | 'webhook_last_error'
  | 'telegram_disabled_in_config'
  | 'unknown_error';

export interface TelegramLastUpdateSnapshot {
  receivedAt: number;
  updateId?: number;
  chatId?: number;
  chatType?: string;
  fromUserId?: number;
  messageId?: number;
  textPreview?: string;
}

export interface TelegramDiagnosis {
  avatarId: string;
  platformEnabled: boolean;
  tokenPresent: boolean;
  webhookSecretPresent: boolean;
  onboardingStep?: TelegramOnboardingStepStatus;
  bot?: {
    id?: number;
    username?: string;
    first_name?: string;
    is_bot?: boolean;
  };
  webhook: {
    expectedUrl: string;
    actualUrl?: string;
    isCorrectUrl?: boolean;
    pendingUpdateCount?: number;
    lastErrorDate?: number;
    lastErrorMessage?: string;
    ipAddress?: string;
    maxConnections?: number;
    allowedUpdates?: string[];
  };
  lastUpdate?: {
    snapshot?: TelegramLastUpdateSnapshot;
    secondsAgo?: number;
  };
  issues: Array<{ code: TelegramDiagnosticsIssueCode; message: string }>;
}

export interface TelegramDiagnosticsDeps {
  now?: () => number;
  getAvatar?: (avatarId: string) => Promise<{
    platforms?: {
      telegram?: {
        enabled?: boolean;
      };
    };
  } | null>;
  getSecretValueForAvatar?: (avatarId: string, secretType: SecretType) => Promise<string | null>;
  validateTelegramToken?: typeof validateTelegramToken;
  getTelegramWebhookInfoDetailed?: typeof getTelegramWebhookInfoDetailed;
  getTelegramWebhookUrlForAvatar?: typeof getTelegramWebhookUrlForAvatar;
  getLastTelegramUpdateSnapshot?: (avatarId: string) => Promise<TelegramLastUpdateSnapshot | undefined>;
}

const DEFAULT_LAST_UPDATE_SK = 'TELEGRAM#LAST_UPDATE';

async function defaultGetLastTelegramUpdateSnapshot(
  avatarId: string
): Promise<TelegramLastUpdateSnapshot | undefined> {
  const tableName = process.env.ADMIN_TABLE;
  if (!tableName) return undefined;

  const [{ DynamoDBClient }, { DynamoDBDocumentClient, GetCommand }] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
  ]);

  const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const res = await dynamoClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `AVATAR#${avatarId}`, sk: DEFAULT_LAST_UPDATE_SK },
      ConsistentRead: true,
    })
  );

  const item = res.Item as undefined | { snapshot?: TelegramLastUpdateSnapshot };
  return item?.snapshot;
}

function addIssue(
  issues: TelegramDiagnosis['issues'],
  code: TelegramDiagnosticsIssueCode,
  message: string
) {
  issues.push({ code, message });
}

function deriveWebhookIssues(
  issues: TelegramDiagnosis['issues'],
  expectedUrl: string,
  webhookInfo: TelegramWebhookInfoDetailed
) {
  if (webhookInfo.url && webhookInfo.url !== expectedUrl) {
    addIssue(
      issues,
      'webhook_url_mismatch',
      `Telegram webhook URL is set to ${webhookInfo.url}, expected ${expectedUrl}`
    );
  }

  if ((webhookInfo.pending_update_count || 0) > 0) {
    addIssue(
      issues,
      'webhook_pending_updates',
      `Telegram has ${webhookInfo.pending_update_count} pending update(s)`
    );
  }

  if (webhookInfo.last_error_message) {
    addIssue(
      issues,
      'webhook_last_error',
      `Telegram webhook last error: ${webhookInfo.last_error_message}`
    );
  }
}

function finalizeDiagnosis(diagnosis: TelegramDiagnosis): TelegramDiagnosis {
  diagnosis.onboardingStep = deriveTelegramOnboardingStepStatus({
    platformEnabled: diagnosis.platformEnabled,
    tokenPresent: diagnosis.tokenPresent,
    webhookSecretPresent: diagnosis.webhookSecretPresent,
    issues: diagnosis.issues,
  });
  return diagnosis;
}

export async function diagnoseTelegram(
  avatarId: string,
  deps: TelegramDiagnosticsDeps = {}
): Promise<TelegramDiagnosis> {
  const now = deps.now ?? (() => Date.now());
  const getAvatarImpl = deps.getAvatar ?? (async (id: string) => {
    const { getAvatar } = await import('../avatars.js');
    return getAvatar(id);
  });
  const getSecretValueForAvatarImpl =
    deps.getSecretValueForAvatar
    ?? (async (id: string, secretType: SecretType) => {
      const { _getSecretValueInternal } = await import('../secrets.js');
      return _getSecretValueInternal(id, secretType, 'default');
    });
  const validateTelegramTokenImpl = deps.validateTelegramToken ?? validateTelegramToken;
  const getTelegramWebhookInfoDetailedImpl =
    deps.getTelegramWebhookInfoDetailed ?? getTelegramWebhookInfoDetailed;
  const getTelegramWebhookUrlForAvatarImpl =
    deps.getTelegramWebhookUrlForAvatar ?? getTelegramWebhookUrlForAvatar;
  const getLastTelegramUpdateSnapshotImpl =
    deps.getLastTelegramUpdateSnapshot ?? defaultGetLastTelegramUpdateSnapshot;

  const expectedUrl = getTelegramWebhookUrlForAvatarImpl(avatarId);
  const issues: TelegramDiagnosis['issues'] = [];

  const avatar = await getAvatarImpl(avatarId);
  const platformEnabled = Boolean(avatar?.platforms?.telegram?.enabled);

  const botToken = await getSecretValueForAvatarImpl(avatarId, 'telegram_bot_token');
  const webhookSecret = await getSecretValueForAvatarImpl(avatarId, 'telegram_webhook_secret');

  const diagnosis: TelegramDiagnosis = {
    avatarId,
    platformEnabled,
    tokenPresent: Boolean(botToken),
    webhookSecretPresent: Boolean(webhookSecret),
    webhook: {
      expectedUrl,
    },
    issues,
  };

  if (!platformEnabled) {
    addIssue(issues, 'telegram_disabled_in_config', 'Telegram is disabled in avatar config');
  }

  if (!botToken) {
    addIssue(issues, 'missing_bot_token', 'Missing Telegram bot token secret');
    return finalizeDiagnosis(diagnosis);
  }

  if (!webhookSecret) {
    addIssue(issues, 'missing_webhook_secret', 'Missing Telegram webhook secret');
  }

  const validation = await validateTelegramTokenImpl(botToken);
  if (!validation.valid) {
    addIssue(issues, 'invalid_bot_token', 'Telegram bot token failed validation (getMe)');
    return finalizeDiagnosis(diagnosis);
  }
  diagnosis.bot = {
    id: validation.botInfo?.id,
    username: validation.botInfo?.username,
    first_name: validation.botInfo?.firstName,
    is_bot: true,
  };

  try {
    const webhookInfo = await getTelegramWebhookInfoDetailedImpl(botToken);
    diagnosis.webhook.actualUrl = webhookInfo.url;
    diagnosis.webhook.isCorrectUrl = !webhookInfo.url || webhookInfo.url === expectedUrl;
    diagnosis.webhook.pendingUpdateCount = webhookInfo.pending_update_count;
    diagnosis.webhook.lastErrorDate = webhookInfo.last_error_date;
    diagnosis.webhook.lastErrorMessage = webhookInfo.last_error_message;
    diagnosis.webhook.ipAddress = webhookInfo.ip_address;
    diagnosis.webhook.maxConnections = webhookInfo.max_connections;
    diagnosis.webhook.allowedUpdates = webhookInfo.allowed_updates;

    deriveWebhookIssues(issues, expectedUrl, webhookInfo);
  } catch {
    addIssue(issues, 'unknown_error', 'Failed to fetch Telegram webhook info');
  }

  try {
    const snapshot = await getLastTelegramUpdateSnapshotImpl(avatarId);
    if (snapshot) {
      const secondsAgo = Math.max(0, Math.floor((now() - snapshot.receivedAt) / 1000));
      diagnosis.lastUpdate = { snapshot, secondsAgo };
    }
  } catch {
    // best-effort
  }

  return finalizeDiagnosis(diagnosis);
}

// =============================================================================
// Repair Planning
// =============================================================================

export interface TelegramRepairOptions {
  force?: boolean;
  includeDisabled?: boolean;
  repairOnPendingUpdates?: boolean;
  repairOnLastError?: boolean;
}

export type TelegramRepairPlan =
  | { action: 'skip'; reason: string }
  | { action: 'repair'; reason: string };

export interface TelegramOnboardingRepairPlan {
  step: TelegramOnboardingStepStatus;
  execution: TelegramOnboardingExecution;
}

export function computeTelegramOnboardingRepairPlan(
  diagnosis: TelegramDiagnosis,
  requestedAction: TelegramOnboardingExecuteAction = 'repair'
): TelegramOnboardingRepairPlan {
  const step = diagnosis.onboardingStep ?? deriveTelegramOnboardingStepStatus({
    platformEnabled: diagnosis.platformEnabled,
    tokenPresent: diagnosis.tokenPresent,
    webhookSecretPresent: diagnosis.webhookSecretPresent,
    issues: diagnosis.issues,
  });

  const execution = computeTelegramOnboardingExecution(step, requestedAction);
  return { step, execution };
}

export function computeTelegramRepairPlan(
  diagnosis: TelegramDiagnosis,
  options: TelegramRepairOptions = {}
): TelegramRepairPlan {
  const includeDisabled = Boolean(options.includeDisabled);
  const force = Boolean(options.force);
  const repairOnPendingUpdates = Boolean(options.repairOnPendingUpdates);
  const repairOnLastError = Boolean(options.repairOnLastError);

  if (!diagnosis.platformEnabled && !includeDisabled) {
    return { action: 'skip', reason: 'Telegram disabled in avatar config' };
  }

  if (!diagnosis.tokenPresent) {
    return { action: 'skip', reason: 'Missing Telegram bot token' };
  }

  if (force) {
    return { action: 'repair', reason: 'Forced repair requested' };
  }

  const issueCodes = new Set(diagnosis.issues.map(i => i.code));

  if (issueCodes.has('missing_webhook_secret')) {
    return { action: 'repair', reason: 'Telegram webhook secret is missing' };
  }

  if (issueCodes.has('webhook_url_mismatch')) {
    return { action: 'repair', reason: 'Telegram webhook URL mismatch' };
  }

  if (repairOnPendingUpdates && issueCodes.has('webhook_pending_updates')) {
    return { action: 'repair', reason: 'Telegram webhook has pending updates' };
  }

  if (repairOnLastError && issueCodes.has('webhook_last_error')) {
    return { action: 'repair', reason: 'Telegram webhook last error reported' };
  }

  return { action: 'skip', reason: 'Webhook already matches expected URL' };
}

// =============================================================================
// Setup
// =============================================================================

export interface TelegramSetupResult {
  success: boolean;
  error?: string;
  status?: {
    webhookUrl?: string;
    webhookInfo?: { url?: string; pending_update_count?: number };
    reRegistered?: boolean;
    botUsername?: string;
    botId?: number;
  };
}

export interface TelegramSetupDeps {
  validateTelegramToken: (token: string) => Promise<{ valid: boolean; error?: string; botInfo?: { username?: string; id?: number } }>;
  registerTelegramWebhook: (token: string, avatarId: string, secretToken: string) => Promise<{
    success: boolean;
    message: string;
    webhookUrl?: string;
    secretToken?: string;
    webhookInfo?: { url?: string; pending_update_count?: number };
    reRegistered?: boolean;
  }>;
  generateWebhookSecret: () => string;
  updateAvatar: typeof updateAvatar;
  storeSecret: typeof storeSecret;
}

export async function setupTelegramIntegration(params: {
  avatarId: string;
  token: string;
  session: UserSession;
  deps: TelegramSetupDeps;
}): Promise<TelegramSetupResult> {
  const { avatarId, token, session, deps } = params;

  const validation = await deps.validateTelegramToken(token);
  if (!validation.valid) {
    return { success: false, error: validation.error || 'Invalid Telegram bot token' };
  }

  const secretToken = deps.generateWebhookSecret();
  const webhookResult = await deps.registerTelegramWebhook(token, avatarId, secretToken);
  if (!webhookResult.success || !webhookResult.secretToken) {
    return { success: false, error: webhookResult.message || 'Failed to register Telegram webhook' };
  }

  await Promise.all([
    deps.updateAvatar(
      avatarId,
      {
        platforms: {
          telegram: {
            enabled: true,
            botUsername: validation.botInfo?.username,
            botId: validation.botInfo?.id,
          },
        },
      },
      session
    ),
    deps.storeSecret(
      avatarId,
      'telegram_bot_token',
      'default',
      token,
      session,
      `Telegram bot token for ${avatarId}`
    ),
    deps.storeSecret(
      avatarId,
      'telegram_webhook_secret',
      'default',
      webhookResult.secretToken,
      session,
      `Telegram webhook secret for ${avatarId}`
    ),
  ]);

  return {
    success: true,
    status: {
      webhookUrl: webhookResult.webhookUrl,
      webhookInfo: webhookResult.webhookInfo,
      reRegistered: webhookResult.reRegistered,
      botUsername: validation.botInfo?.username,
      botId: validation.botInfo?.id,
    },
  };
}
