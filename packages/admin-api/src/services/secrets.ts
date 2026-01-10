/**
 * Secure Secrets Service
 * Write-only secrets management with KMS encryption
 */
import {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SecretMetadata, SecretType, UserSession } from '../types.js';

const secretsClient = new SecretsManagerClient({});
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SECRETS_TABLE = process.env.ADMIN_TABLE!;
const KMS_KEY_ID = process.env.KMS_KEY_ID!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

/**
 * Generate a unique secret ARN/name
 */
function generateSecretName(agentId: string | null, secretType: SecretType, name: string): string {
  const sanitizedName = name.replace(/[^a-zA-Z0-9-_]/g, '-');
  if (agentId) {
    return `${SECRET_PREFIX}/${agentId}/${secretType}/${sanitizedName}`;
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
  agentId: string | null,
  secretType: SecretType,
  name: string,
  value: string,
  session: UserSession,
  description?: string
): Promise<SecretMetadata> {
  const secretName = generateSecretName(agentId, secretType, name);
  const now = Date.now();

  // Check if secret already exists
  let secretArn: string;
  let isNew = false;

  try {
    const existing = await secretsClient.send(new DescribeSecretCommand({
      SecretId: secretName,
    }));
    secretArn = existing.ARN!;
    
    // Update existing secret
    await secretsClient.send(new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: value,
    }));
  } catch (error: unknown) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      // Create new secret
      isNew = true;
      const result = await secretsClient.send(new CreateSecretCommand({
        Name: secretName,
        SecretString: value,
        KmsKeyId: KMS_KEY_ID,
        Description: description,
        Tags: [
          { Key: 'swarm:agent', Value: agentId || 'global' },
          { Key: 'swarm:type', Value: secretType },
          { Key: 'swarm:managed', Value: 'true' },
        ],
      }));
      secretArn = result.ARN!;
    } else {
      throw error;
    }
  }

  // Store metadata in DynamoDB
  const metadata: SecretMetadata = {
    pk: agentId ? `AGENT#${agentId}` : 'GLOBAL',
    sk: `SECRET#${secretType}#${name}`,
    secretType,
    name,
    description,
    secretArn,
    createdAt: isNew ? now : 0, // Will be preserved on update
    createdBy: isNew ? session.email : '',
    updatedAt: now,
    updatedBy: session.email,
    isGlobal: !agentId,
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
  agentId: string,
  botToken: string,
  session: UserSession
): Promise<SecretMetadata> {
  return storeSecret(
    agentId,
    'telegram_bot_token',
    'bot-token',
    botToken,
    session,
    `Telegram bot token for ${agentId}`
  );
}

export async function storeTwitterSecrets(
  agentId: string,
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

  results.push(await storeSecret(agentId, 'twitter_api_key', 'api-key', secrets.apiKey, session));
  results.push(await storeSecret(agentId, 'twitter_api_secret', 'api-secret', secrets.apiSecret, session));
  results.push(await storeSecret(agentId, 'twitter_access_token', 'access-token', secrets.accessToken, session));
  results.push(await storeSecret(agentId, 'twitter_access_secret', 'access-secret', secrets.accessSecret, session));
  
  if (secrets.bearerToken) {
    results.push(await storeSecret(agentId, 'twitter_bearer_token', 'bearer-token', secrets.bearerToken, session));
  }

  return results;
}

export async function storeDiscordSecrets(
  agentId: string,
  secrets: {
    botToken: string;
    clientId?: string;
    clientSecret?: string;
  },
  session: UserSession
): Promise<SecretMetadata[]> {
  const results: SecretMetadata[] = [];

  results.push(await storeSecret(agentId, 'discord_bot_token', 'bot-token', secrets.botToken, session));
  
  if (secrets.clientId) {
    results.push(await storeSecret(agentId, 'discord_client_id', 'client-id', secrets.clientId, session));
  }
  if (secrets.clientSecret) {
    results.push(await storeSecret(agentId, 'discord_client_secret', 'client-secret', secrets.clientSecret, session));
  }

  return results;
}

/**
 * Store AI provider API key (global or per-agent)
 */
export async function storeAIProviderKey(
  provider: 'openrouter' | 'anthropic' | 'openai' | 'replicate',
  apiKey: string,
  session: UserSession,
  agentId?: string
): Promise<SecretMetadata> {
  const secretType = `${provider}_api_key` as SecretType;
  return storeSecret(
    agentId || null,
    secretType,
    'api-key',
    apiKey,
    session,
    `${provider} API key${agentId ? ` for ${agentId}` : ' (global)'}`
  );
}

/**
 * List secrets (metadata only, NOT values)
 */
export async function listSecrets(
  agentId?: string
): Promise<SecretMetadata[]> {
  const results: SecretMetadata[] = [];

  if (agentId) {
    // List secrets for specific agent
    const agentSecrets = await dynamoClient.send(new QueryCommand({
      TableName: SECRETS_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AGENT#${agentId}`,
        ':sk': 'SECRET#',
      },
    }));
    results.push(...(agentSecrets.Items as SecretMetadata[] || []));
  } else {
    // List all secrets (global + all agents)
    const globalSecrets = await dynamoClient.send(new QueryCommand({
      TableName: SECRETS_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': 'GLOBAL',
        ':sk': 'SECRET#',
      },
    }));
    results.push(...(globalSecrets.Items as SecretMetadata[] || []));

    // Query for all agent secrets would require a scan or GSI
    // For now, return global only when no agentId specified
  }

  return results;
}

/**
 * Delete a secret
 */
export async function deleteSecret(
  agentId: string | null,
  secretType: SecretType,
  name: string,
  _session: UserSession
): Promise<void> {
  const pk = agentId ? `AGENT#${agentId}` : 'GLOBAL';
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
  await secretsClient.send(new DeleteSecretCommand({
    SecretId: metadata.secretArn,
    ForceDeleteWithoutRecovery: false, // Allow recovery for 7 days
  }));

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
  agentId: string | null,
  secretType: SecretType,
  name: string
): Promise<boolean> {
  const pk = agentId ? `AGENT#${agentId}` : 'GLOBAL';
  const sk = `SECRET#${secretType}#${name}`;

  const result = await dynamoClient.send(new GetCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
  }));

  return !!result.Item;
}

/**
 * Get secret ARN (for Lambda environment variables)
 * Does NOT return the secret value
 */
export async function getSecretArn(
  agentId: string | null,
  secretType: SecretType,
  name: string
): Promise<string | null> {
  const pk = agentId ? `AGENT#${agentId}` : 'GLOBAL';
  const sk = `SECRET#${secretType}#${name}`;

  const result = await dynamoClient.send(new GetCommand({
    TableName: SECRETS_TABLE,
    Key: { pk, sk },
  }));

  return (result.Item as SecretMetadata)?.secretArn || null;
}

/**
 * Get secret value - INTERNAL USE ONLY
 *
 * WARNING: This function breaks the "write-only" security model.
 * Only use for legitimate internal operations like:
 * - Agent retrieving its own Helius API key for RPC calls
 * - Agent retrieving its own wallet private key for signing
 *
 * NEVER expose this through the admin API or chat tools.
 * NEVER use to retrieve secrets for display or export.
 *
 * @internal
 */
export async function _getSecretValueInternal(
  agentId: string,
  secretType: SecretType,
  name: string
): Promise<string | null> {
  // Log access for audit purposes
  console.warn(`[AUDIT] Secret value accessed: agent=${agentId}, type=${secretType}, name=${name}`);

  const secretArn = await getSecretArn(agentId, secretType, name);
  if (!secretArn) return null;

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    return response.SecretString || null;
  } catch (error) {
    console.error('Error retrieving secret:', error);
    return null;
  }
}

/**
 * @deprecated Use _getSecretValueInternal instead - renamed to make internal-only usage clear
 */
export const getSecretValue = _getSecretValueInternal;
