/**
 * Secure Secrets Service
 * Write-only secrets management with Secrets Manager
 */
import {
  CreateSecretCommand,
  UpdateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  RestoreSecretCommand,
  type CreateSecretCommandInput,
} from '@swarm/core';
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from '@swarm/core';
import { logger } from '@swarm/core';
import type { SecretMetadata, SecretType, UserSession } from '../types.js';
import { getDynamoClient } from './dynamo-client.js';
import { getSecretsClient } from './aws-clients.js';

const secretsClient = getSecretsClient();
const dynamoClient = getDynamoClient();

const SECRETS_TABLE = process.env.ADMIN_TABLE!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

// Cache secret values in-memory to reduce Secrets Manager (and KMS decrypt) calls.
// Lambda containers are reused, so this can significantly cut steady-state costs.
const SECRET_CACHE_TTL_MS = Number.parseInt(process.env.SECRETS_CACHE_TTL_MS || '300000', 10);
const secretValueCache = new Map<string, { value: string | null; expiresAt: number }>();

/**
 * Generate a unique secret ARN/name
 */
function generateSecretName(avatarId: string | null, secretType: SecretType, name: string): string {
  const sanitizedName = name.replace(/[^a-zA-Z0-9-_]/g, '-');
  if (avatarId) {
    return `${SECRET_PREFIX}/${avatarId}/${secretType}/${sanitizedName}`;
  }
  return `${SECRET_PREFIX}/global/${secretType}/${sanitizedName}`;
}

/**
 * Store a secret securely
 * - Creates/updates in Secrets Manager with KMS encryption
 * - Stores metadata in DynamoDB (NO secret values)
 * - Returns only the metadata
 */
export async function storeSecret(
  avatarId: string | null,
  secretType: SecretType,
  name: string,
  value: string,
  session: UserSession,
  description?: string
): Promise<SecretMetadata> {
  const secretName = generateSecretName(avatarId, secretType, name);
  const now = Date.now();

  // Check if secret already exists
  let secretArn: string;
  let isNew = false;

  try {
    const existing = await secretsClient.send(new DescribeSecretCommand({
      SecretId: secretName,
    }));
    secretArn = existing.ARN!;

    // If secret is scheduled for deletion, restore it first
    if (existing.DeletedDate) {
      logger.info(`Restoring secret from scheduled deletion`, { secretName });
      await secretsClient.send(new RestoreSecretCommand({
        SecretId: secretName,
      }));
    }

    // Update existing secret
    await secretsClient.send(new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: value,
    }));

    // Invalidate cache for this secret
    secretValueCache.delete(secretArn);
  } catch (error: unknown) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      // Create new secret
      isNew = true;
      const createInput: CreateSecretCommandInput = {
        Name: secretName,
        SecretString: value,
        Description: description,
        Tags: [
          { Key: 'swarm:avatar', Value: avatarId || 'global' },
          { Key: 'swarm:type', Value: secretType },
          { Key: 'swarm:managed', Value: 'true' },
        ],
      };

      // Use AWS-managed key (default) by not specifying KmsKeyId.

      const result = await secretsClient.send(new CreateSecretCommand(createInput));
      secretArn = result.ARN!;
    } else {
      throw error;
    }
  }

  // Store metadata in DynamoDB
  const metadata: SecretMetadata = {
    pk: avatarId ? `AVATAR#${avatarId}` : 'GLOBAL',
    sk: `SECRET#${secretType}#${name}`,
    secretType,
    name,
    description,
    secretArn,
    createdAt: isNew ? now : 0, // Will be preserved on update
    createdBy: isNew ? session.email : '',
    updatedAt: now,
    updatedBy: session.email,
    isGlobal: !avatarId,
  };

  // Get existing metadata to preserve createdAt/createdBy
  if (!isNew) {
    const existing = await dynamoClient.send(new GetCommand({
      TableName: SECRETS_TABLE,
      Key: { pk: metadata.pk, sk: metadata.sk },
    }));
    if (existing.Item) {
      metadata.createdAt = existing.Item.createdAt;
      metadata.createdBy = existing.Item.createdBy;
    }
  }

  await dynamoClient.send(new PutCommand({
    TableName: SECRETS_TABLE,
    Item: metadata,
  }));

  return metadata;
}

/**
 * Store platform secrets (convenience wrapper)
 */
export async function storeTelegramSecrets(
  avatarId: string,
  botToken: string,
  session: UserSession
): Promise<SecretMetadata> {
  return storeSecret(
    avatarId,
    'telegram_bot_token',
    'bot-token',
    botToken,
    session,
    `Telegram bot token for ${avatarId}`
  );
}

export async function storeTwitterSecrets(
  avatarId: string,
  secrets: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessSecret: string;
    bearerToken?: string;
  },
  session: UserSession
): Promise<SecretMetadata[]> {
  const results: SecretMetadata[] = [];

  results.push(await storeSecret(avatarId, 'twitter_api_key', 'api-key', secrets.apiKey, session));
  results.push(await storeSecret(avatarId, 'twitter_api_secret', 'api-secret', secrets.apiSecret, session));
  results.push(await storeSecret(avatarId, 'twitter_access_token', 'access-token', secrets.accessToken, session));
  results.push(await storeSecret(avatarId, 'twitter_access_secret', 'access-secret', secrets.accessSecret, session));
  
  if (secrets.bearerToken) {
    results.push(await storeSecret(avatarId, 'twitter_bearer_token', 'bearer-token', secrets.bearerToken, session));
  }

  return results;
}

export async function storeDiscordSecrets(
  avatarId: string,
  secrets: {
    botToken: string;
    clientId?: string;
    clientSecret?: string;
  },
  session: UserSession
): Promise<SecretMetadata[]> {
  const results: SecretMetadata[] = [];

  results.push(await storeSecret(avatarId, 'discord_bot_token', 'bot-token', secrets.botToken, session));
  
  if (secrets.clientId) {
    results.push(await storeSecret(avatarId, 'discord_client_id', 'client-id', secrets.clientId, session));
  }
  if (secrets.clientSecret) {
    results.push(await storeSecret(avatarId, 'discord_client_secret', 'client-secret', secrets.clientSecret, session));
  }

  return results;
}

/**
 * Store AI provider API key (global or per-avatar)
 */
export async function storeAIProviderKey(
  provider: 'openrouter' | 'anthropic' | 'openai' | 'replicate',
  apiKey: string,
  session: UserSession,
  avatarId?: string
): Promise<SecretMetadata> {
  const secretType = `${provider}_api_key` as SecretType;
  return storeSecret(
    avatarId || null,
    secretType,
    'api-key',
    apiKey,
    session,
    `${provider} API key${avatarId ? ` for ${avatarId}` : ' (global)'}`
  );
}

/**
 * List secrets (metadata only, NOT values)
 */
export async function listSecrets(
  avatarId?: string
): Promise<SecretMetadata[]> {
  const results: SecretMetadata[] = [];

  if (avatarId) {
    // List secrets for specific avatar
    const avatarecrets = await dynamoClient.send(new QueryCommand({
      TableName: SECRETS_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':sk': 'SECRET#',
      },
    }));
    results.push(...(avatarecrets.Items as SecretMetadata[] || []));
  } else {
    // List all secrets (global + all avatars)
    const globalSecrets = await dynamoClient.send(new QueryCommand({
      TableName: SECRETS_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': 'GLOBAL',
        ':sk': 'SECRET#',
      },
    }));
    results.push(...(globalSecrets.Items as SecretMetadata[] || []));

    // Query for all avatar secrets would require a scan or GSI
    // For now, return global only when no avatarId specified
  }

  return results;
}

/** Options for deleteSecret. */
export interface DeleteSecretOptions {
  /** If true, immediately deletes without recovery period. Use for re-creatable secrets like OAuth tokens. */
  forceDelete?: boolean;
  /** Recovery window in days (7-30). Ignored when forceDelete is true. Defaults to AWS default (30 days). */
  recoveryWindowDays?: number;
}

/**
 * Delete a secret
 * @param forceDelete - (legacy positional) If true, immediately deletes without recovery period.
 * @param options - Named options bag (preferred). Overrides positional forceDelete when provided.
 */
export async function deleteSecret(
  avatarId: string | null,
  secretType: SecretType,
  name: string,
  _session: UserSession,
  forceDeleteOrOptions: boolean | DeleteSecretOptions = false
): Promise<void> {
  const opts: DeleteSecretOptions =
    typeof forceDeleteOrOptions === 'boolean'
      ? { forceDelete: forceDeleteOrOptions }
      : forceDeleteOrOptions;

  const pk = avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  const sk = `SECRET#${secretType}#${name}`;

  // Get the metadata to find the ARN
  const existing = await dynamoClient.send(new GetCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
  }));

  if (!existing.Item) {
    throw new Error('Secret not found');
  }

  const metadata = existing.Item as SecretMetadata;

  // Delete from Secrets Manager
  const deleteParams: { SecretId: string; ForceDeleteWithoutRecovery?: boolean; RecoveryWindowInDays?: number } = {
    SecretId: metadata.secretArn,
  };
  if (opts.forceDelete) {
    deleteParams.ForceDeleteWithoutRecovery = true;
  } else if (opts.recoveryWindowDays) {
    deleteParams.RecoveryWindowInDays = opts.recoveryWindowDays;
  }
  await secretsClient.send(new DeleteSecretCommand(deleteParams));

  // Delete metadata from DynamoDB
  await dynamoClient.send(new DeleteCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
  }));
}

/**
 * Check if a secret exists
 */
export async function secretExists(
  avatarId: string | null,
  secretType: SecretType,
  name: string
): Promise<boolean> {
  const pk = avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  const sk = `SECRET#${secretType}#${name}`;

  const result = await dynamoClient.send(new GetCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
    ConsistentRead: true,
  }));

  return !!result.Item;
}

/**
 * Get secret ARN (for Lambda environment variables)
 * Does NOT return the secret value
 */
export async function getSecretArn(
  avatarId: string | null,
  secretType: SecretType,
  name: string
): Promise<string | null> {
  const pk = avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  const sk = `SECRET#${secretType}#${name}`;

  const result = await dynamoClient.send(new GetCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
    ConsistentRead: true,
  }));

  return (result.Item as SecretMetadata)?.secretArn || null;
}

async function getLatestSecretArnForType(
  avatarId: string,
  secretType: SecretType
): Promise<string | null> {
  const pk = avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  const result = await dynamoClient.send(new QueryCommand({
    TableName: SECRETS_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': pk,
      ':skPrefix': `SECRET#${secretType}#`,
    },
  }));

  const items = (result.Items || []) as SecretMetadata[];
  if (items.length === 0) return null;

  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return items[0]?.secretArn || null;
}

/**
 * Get secret value - INTERNAL USE ONLY
 *
 * WARNING: This function breaks the "write-only" security model.
 * Only use for legitimate internal operations like:
 * - Avatar retrieving its own Helius API key for RPC calls
 * - Avatar retrieving its own wallet private key for signing
 *
 * NEVER expose this through the admin API or chat tools.
 * NEVER use to retrieve secrets for display or export.
 *
 * @internal
 */
export async function _getSecretValueInternal(
  avatarId: string | null,
  secretType: SecretType,
  name: string
): Promise<string | null> {
  // Audit logging removed - secret access is already tracked via CloudWatch metrics
  // and request logs. Explicit logging of secret names/types could aid attackers.

  let secretArn = await getSecretArn(avatarId, secretType, name);
  if (!secretArn && name === 'default') {
    // For global secrets, we always use an explicit name and skip the “latest” fallback.
    if (avatarId !== null) {
      secretArn = await getLatestSecretArnForType(avatarId, secretType);
    }
  }
  if (!secretArn) return null;

  const cached = secretValueCache.get(secretArn);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    const value = response.SecretString || null;
    secretValueCache.set(secretArn, { value, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
    return value;
  } catch (error) {
    // Don't log the full error object as it may contain sensitive context
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error retrieving secret', undefined, { errorDetail: errorMessage });
    return null;
  }
}

/** Dependencies that can be injected for testing. */
export interface SecretCleanupDeps {
  listSecrets: (avatarId: string) => Promise<SecretMetadata[]>;
  deleteSecret: (
    avatarId: string | null,
    secretType: SecretType,
    name: string,
    session: UserSession,
    options: boolean | DeleteSecretOptions,
  ) => Promise<void>;
}

const defaultCleanupDeps: SecretCleanupDeps = { listSecrets, deleteSecret };

/**
 * Delete all secrets for an avatar.
 * Used during avatar deletion to clean up Secrets Manager resources.
 * Secrets are scheduled for deletion with a 7-day recovery window so they
 * can be restored if the avatar is un-deleted within that period.
 * Errors are logged but do not throw — caller should not fail if secret cleanup fails.
 */
export async function deleteAllAvatarSecrets(
  avatarId: string,
  session: UserSession,
  deps: SecretCleanupDeps = defaultCleanupDeps
): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errors = 0;

  const secrets = await deps.listSecrets(avatarId);
  for (const secret of secrets) {
    try {
      await deps.deleteSecret(
        avatarId,
        secret.secretType,
        secret.name,
        session,
        { recoveryWindowDays: 7 },
      );
      deleted++;
    } catch (err) {
      errors++;
      logger.warn(`[Secrets] Failed to delete secret for avatar`, {
        secretType: secret.secretType,
        secretName: secret.name,
        avatarId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (secrets.length > 0) {
    logger.info(`[Secrets] Avatar secret cleanup complete`, { avatarId, deleted, total: secrets.length, errors });
  }

  return { deleted, errors };
}

/**
 * @deprecated Use _getSecretValueInternal instead - renamed to make internal-only usage clear
 */
export const getSecretValue = _getSecretValueInternal;
