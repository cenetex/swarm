/**
 * Media Service Resolvers
 *
 * Implementations for model resolution, API key resolution, credits, and gallery.
 * These can be configured with different DynamoDB tables to work with both
 * handlers (STATE_TABLE) and admin-api (ADMIN_TABLE).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type {
  AICapability,
  ResolvedModel,
  ResolvedApiKey,
  CreditCheckResult,
  GalleryItemInput,
  GalleryItemOutput,
  MediaServiceDependencies,
} from './types.js';
import { DEFAULT_MODELS } from './types.js';

/**
 * Configuration for creating resolvers
 */
export interface ResolverConfig {
  tableName: string;
  region?: string;
  dynamoClient?: DynamoDBDocumentClient;
}

/**
 * Create a DynamoDB document client
 */
function createDocClient(region: string = 'us-east-1'): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

const VALID_PROVIDERS = ['replicate', 'openai', 'openrouter', 'anthropic'] as const;
type ValidProvider = typeof VALID_PROVIDERS[number];

function isValidProvider(value: unknown): value is ValidProvider {
  return typeof value === 'string' && VALID_PROVIDERS.includes(value as ValidProvider);
}

function getDefaultProvider(capability: AICapability): ValidProvider {
  if (capability === 'image_generation' || capability === 'video_generation') {
    return 'openrouter';
  }
  if (capability === 'transcription') {
    return 'openai';
  }
  if (capability === 'llm') {
    return 'anthropic';
  }
  return 'replicate';
}

function getPreferredProviders(capability: AICapability): ValidProvider[] {
  if (capability === 'image_generation' || capability === 'video_generation') {
    return ['openrouter'];
  }
  if (capability === 'llm') {
    return ['openrouter', 'anthropic', 'openai'];
  }
  if (capability === 'text_to_speech') {
    return ['replicate', 'openai'];
  }
  if (capability === 'transcription') {
    return ['openai', 'replicate'];
  }
  return ['replicate'];
}

// ============================================================================
// MODEL RESOLUTION
// ============================================================================

/**
 * Create a model resolver that checks avatar config in DynamoDB
 */
export function createModelResolver(config: ResolverConfig): MediaServiceDependencies['resolveModel'] {
  const docClient = config.dynamoClient || createDocClient(config.region);

  return async (avatarId: string, capability: AICapability): Promise<ResolvedModel> => {
    try {
      // Check avatar's integration config
      const result = await docClient.send(new GetCommand({
        TableName: config.tableName,
        Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      }));

      // Check integrations.<provider>.models.{capability} (admin-api format)
      // Then check synced config format (STATE_TABLE) for the matching capability.
      const item = result.Item;
      const syncedConfigModel =
        capability === 'image_generation'
          ? item?.config?.media?.image?.model
          : capability === 'video_generation'
            ? item?.config?.media?.video?.model
            : undefined;
      const syncedConfigProvider =
        capability === 'image_generation'
          ? item?.config?.media?.image?.provider
          : capability === 'video_generation'
            ? item?.config?.media?.video?.provider
            : undefined;

      for (const provider of getPreferredProviders(capability)) {
        const configuredModel = item?.integrations?.[provider]?.models?.[capability];
        if (configuredModel) {
          console.log(`[MediaResolver] Using configured ${capability} model for ${avatarId}: ${configuredModel} (${provider})`);
          return {
            model: configuredModel,
            provider,
          };
        }
      }

      const isLegacyReplicateMediaConfig =
        (capability === 'image_generation' || capability === 'video_generation') &&
        syncedConfigProvider === 'replicate';

      if (syncedConfigModel && !isLegacyReplicateMediaConfig) {
        const resolvedProvider = isValidProvider(syncedConfigProvider)
          ? syncedConfigProvider
          : getDefaultProvider(capability);
        console.log(`[MediaResolver] Using synced ${capability} model for ${avatarId}: ${syncedConfigModel} (${resolvedProvider})`);
        return {
          model: syncedConfigModel,
          provider: resolvedProvider,
        };
      }
    } catch (err) {
      console.warn(`[MediaResolver] Failed to get avatar config: ${err}`);
    }

    // Fall back to default
    const defaultModel = DEFAULT_MODELS[capability];
    const defaultProvider = getDefaultProvider(capability);
    console.log(`[MediaResolver] Using default ${capability} model: ${defaultModel} (${defaultProvider})`);
    return {
      model: defaultModel,
      provider: defaultProvider,
    };
  };
}

// ============================================================================
// API KEY RESOLUTION
// ============================================================================

// Cached system key
let cachedSystemReplicateKey: string | null = null;

/**
 * Get system Replicate API key from env, Secrets Manager, or DynamoDB
 */
async function getSystemReplicateKey(
  docClient: DynamoDBDocumentClient,
  tableName: string
): Promise<string | null> {
  // Check env var first (fastest)
  const envKey = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (envKey) {
    return envKey;
  }

  // Check cached key
  if (cachedSystemReplicateKey) {
    return cachedSystemReplicateKey;
  }

  // Try Secrets Manager ARN
  const secretArn = process.env.REPLICATE_API_KEY_SECRET_ARN;
  if (secretArn) {
    try {
      const secretsClient = new SecretsManagerClient({});
      const response = await secretsClient.send(new GetSecretValueCommand({
        SecretId: secretArn,
      }));
      if (response.SecretString) {
        try {
          const parsed = JSON.parse(response.SecretString);
          cachedSystemReplicateKey = parsed.api_key || parsed.apiKey || response.SecretString;
        } catch {
          cachedSystemReplicateKey = response.SecretString;
        }
        console.log('[MediaResolver] Loaded system Replicate API key from Secrets Manager');
        return cachedSystemReplicateKey;
      }
    } catch (err) {
      console.warn('[MediaResolver] Failed to get Replicate key from Secrets Manager:', err);
    }
  }

  // Try GLOBAL secret in DynamoDB
  try {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: 'GLOBAL', sk: 'SECRET#replicate_api_key#default' },
    }));
    if (result.Item?.value) {
      cachedSystemReplicateKey = result.Item.value;
      console.log('[MediaResolver] Loaded system Replicate API key from GLOBAL secret');
      return cachedSystemReplicateKey;
    }
  } catch (err) {
    console.warn('[MediaResolver] Failed to get GLOBAL secret:', err);
  }

  return null;
}

/**
 * Trial credit constants
 */
const TRIAL_MAX_CREDITS = 3;
const TRIAL_DAILY_RECHARGE = 1;

/**
 * Get current trial credits (with recharge calculation) WITHOUT consuming
 */
async function getTrialCredits(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string
): Promise<{ available: number; lastRecharge: number }> {
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;

  let credits = TRIAL_MAX_CREDITS;
  let lastRecharge = now;

  try {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `AVATAR#${avatarId}`, sk: 'IMAGE_TRIAL' },
    }));
    if (result.Item) {
      credits = result.Item.credits ?? TRIAL_MAX_CREDITS;
      lastRecharge = result.Item.lastRecharge ?? now;
    }
  } catch (err) {
    console.warn('[MediaResolver] Failed to get trial credits:', err);
  }

  // Calculate recharged credits
  const daysSinceRecharge = Math.floor((now - lastRecharge) / msPerDay);
  if (daysSinceRecharge > 0) {
    credits = Math.min(credits + daysSinceRecharge * TRIAL_DAILY_RECHARGE, TRIAL_MAX_CREDITS);
  }

  return { available: credits, lastRecharge };
}

/**
 * Actually consume a trial credit (called after successful operation)
 * Uses atomic operations with optimistic locking to prevent race conditions.
 */
async function consumeTrialCreditInternal(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  maxRetries: number = 3
): Promise<{ remaining: number }> {
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Get current state
      const result = await docClient.send(new GetCommand({
        TableName: tableName,
        Key: { pk: `AVATAR#${avatarId}`, sk: 'IMAGE_TRIAL' },
      }));

      if (!result.Item) {
        // First time user - create record with initial credits minus 1
        const initialCredits = TRIAL_MAX_CREDITS - 1;
        await docClient.send(new PutCommand({
          TableName: tableName,
          Item: {
            pk: `AVATAR#${avatarId}`,
            sk: 'IMAGE_TRIAL',
            credits: initialCredits,
            lastRecharge: now,
            updatedAt: now,
            version: 1,
          },
          // Only succeed if record still doesn't exist (prevent race on first create)
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        console.log(`[MediaResolver] Created trial credits for new user: avatar=${avatarId}, remaining=${initialCredits}`);
        return { remaining: initialCredits };
      }

      // Calculate recharged credits
      const storedCredits = result.Item.credits ?? TRIAL_MAX_CREDITS;
      const lastRecharge = result.Item.lastRecharge ?? now;
      const storedVersion = result.Item.version ?? 0;
      const daysSinceRecharge = Math.floor((now - lastRecharge) / msPerDay);

      let availableCredits = storedCredits;
      if (daysSinceRecharge > 0) {
        availableCredits = Math.min(storedCredits + daysSinceRecharge * TRIAL_DAILY_RECHARGE, TRIAL_MAX_CREDITS);
      }

      // Consume one credit
      const newCredits = Math.max(0, availableCredits - 1);
      const newVersion = storedVersion + 1;

      // Atomic update with version check (optimistic locking)
      await docClient.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: `AVATAR#${avatarId}`, sk: 'IMAGE_TRIAL' },
        UpdateExpression: 'SET credits = :newCredits, lastRecharge = :now, updatedAt = :now, version = :newVersion',
        ConditionExpression: 'attribute_not_exists(version) OR version = :oldVersion',
        ExpressionAttributeValues: {
          ':newCredits': newCredits,
          ':now': now,
          ':newVersion': newVersion,
          ':oldVersion': storedVersion,
        },
      }));

      console.log(`[MediaResolver] Consumed trial credit: avatar=${avatarId}, remaining=${newCredits}`);
      return { remaining: newCredits };

    } catch (err: unknown) {
      const error = err as { name?: string };
      // ConditionalCheckFailedException means someone else modified the record - retry
      if (error.name === 'ConditionalCheckFailedException') {
        console.warn(`[MediaResolver] Trial credit conflict, retrying (attempt ${attempt + 1}/${maxRetries}): avatar=${avatarId}`);
        // Small random backoff to reduce contention
        await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 50));
        continue;
      }
      console.error('[MediaResolver] Failed to consume trial credit:', err);
      throw err;
    }
  }

  // If we exhausted retries, throw an error
  throw new Error(`Failed to consume trial credit after ${maxRetries} retries due to concurrent modifications`);
}

/**
 * Get avatar-specific Replicate API key from Secrets Manager
 * Tries the admin-api path format: swarm/{avatarId}/replicate_api_key/default
 */
async function getAvatarReplicateKey(avatarId: string): Promise<string | null> {
  const secretPrefix = process.env.SECRET_PREFIX || 'swarm';
  const secretName = `${secretPrefix}/${avatarId}/replicate_api_key/default`;

  try {
    const secretsClient = new SecretsManagerClient({});
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretName,
    }));
    if (response.SecretString) {
      console.log(`[MediaResolver] Found avatar-specific Replicate API key for ${avatarId}`);
      return response.SecretString.trim();
    }
  } catch (err: unknown) {
    const error = err as { name?: string };
    // ResourceNotFoundException is expected if avatar hasn't configured their own key
    if (error.name !== 'ResourceNotFoundException') {
      console.warn(`[MediaResolver] Failed to get avatar Replicate key: ${err}`);
    }
  }

  return null;
}

/**
 * Create an API key resolver with avatar -> system -> trial fallback
 * Note: For trial usage, this only CHECKS credits, does not consume.
 * The caller must call consumeTrialCredit after successful operation.
 */
export function createApiKeyResolver(config: ResolverConfig): MediaServiceDependencies['resolveApiKey'] {
  const docClient = config.dynamoClient || createDocClient(config.region);

  return async (avatarId: string, provider: string): Promise<ResolvedApiKey> => {
    if (provider !== 'replicate') {
      throw new Error(`API key resolution not implemented for provider: ${provider}`);
    }

    // If the avatar explicitly disabled global/system usage, require an avatar key.
    // This flag currently lives on the admin-api record (ADMIN_TABLE). STATE_TABLE
    // configs may not include it, so we only enforce when explicitly false.
    let requireAvatarKey = false;
    try {
      const configResult = await docClient.send(new GetCommand({
        TableName: config.tableName,
        Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
      }));
      const useGlobalKey = configResult.Item?.integrations?.replicate?.useGlobalKey;
      if (useGlobalKey === false) {
        requireAvatarKey = true;
      }
    } catch (err) {
      console.warn('[MediaResolver] Failed to read replicate.useGlobalKey, defaulting to legacy behavior:', err);
    }

    // Check avatar-specific secret from Secrets Manager (admin-api path format)
    const avatarKey = await getAvatarReplicateKey(avatarId);
    if (avatarKey) {
      return { key: avatarKey, source: 'avatar' };
    }

    // Fallback: Check DynamoDB for legacy format (value stored directly in table)
    try {
      const result = await docClient.send(new GetCommand({
        TableName: config.tableName,
        Key: { pk: `AVATAR#${avatarId}`, sk: 'SECRET#replicate_api_key#default' },
      }));
      if (result.Item?.value) {
        console.log(`[MediaResolver] Found legacy DynamoDB secret for ${avatarId}`);
        return { key: result.Item.value, source: 'avatar' };
      }
    } catch (err) {
      console.warn('[MediaResolver] Failed to get avatar secret from DynamoDB:', err);
    }

    if (requireAvatarKey) {
      console.warn('[MediaResolver] Avatar-specific Replicate key required but missing; falling back to system key.', {
        avatarId,
      });
    }

    // Check system key
    const systemKey = await getSystemReplicateKey(docClient, config.tableName);
    if (!systemKey) {
      throw new Error('No Replicate API key configured. Set up an avatar or system key.');
    }

    // System key exists - check trial credits (but don't consume yet)
    const { available } = await getTrialCredits(docClient, config.tableName, avatarId);
    if (available <= 0) {
      throw new Error('Free Replicate media credits exhausted. Credits recharge at 1/day (max 3).');
    }

    return {
      key: systemKey,
      source: 'trial',
      trialCreditsAvailable: available,
    };
  };
}

/**
 * Create a trial credit consumer (called after successful operation)
 */
export function createTrialCreditConsumer(config: ResolverConfig): MediaServiceDependencies['consumeTrialCredit'] {
  const docClient = config.dynamoClient || createDocClient(config.region);

  return async (avatarId: string): Promise<{ remaining: number }> => {
    return consumeTrialCreditInternal(docClient, config.tableName, avatarId);
  };
}

// ============================================================================
// CREDITS (using existing credits service pattern)
// ============================================================================

/**
 * Create a credit checker
 */
export function createCreditChecker(config: ResolverConfig): MediaServiceDependencies['checkCredits'] {
  const docClient = config.dynamoClient || createDocClient(config.region);

  return async (avatarId: string, operation: string): Promise<CreditCheckResult> => {
    // Check rate limiting in credits table
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour window
    const maxPerWindow = operation === 'generate_image' ? 20 : 10;

    try {
      const result = await docClient.send(new GetCommand({
        TableName: config.tableName,
        Key: { pk: `AVATAR#${avatarId}`, sk: `CREDITS#${operation}` },
      }));

      if (result.Item) {
        const windowStart = result.Item.windowStart || 0;
        const count = result.Item.count || 0;

        if (now - windowStart < windowMs && count >= maxPerWindow) {
          return {
            allowed: false,
            reason: `Rate limited: ${count}/${maxPerWindow} ${operation} calls in the last hour`,
            remaining: 0,
          };
        }
      }

      return { allowed: true, remaining: maxPerWindow };
    } catch (err) {
      console.warn('[MediaResolver] Credit check failed, allowing:', err);
      return { allowed: true };
    }
  };
}

/**
 * Create a credit consumer
 */
export function createCreditConsumer(config: ResolverConfig): MediaServiceDependencies['consumeCredits'] {
  const docClient = config.dynamoClient || createDocClient(config.region);

  return async (avatarId: string, operation: string): Promise<void> => {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;

    try {
      const result = await docClient.send(new GetCommand({
        TableName: config.tableName,
        Key: { pk: `AVATAR#${avatarId}`, sk: `CREDITS#${operation}` },
      }));

      let windowStart = now;
      let count = 0;

      if (result.Item) {
        windowStart = result.Item.windowStart || now;
        count = result.Item.count || 0;

        // Reset window if expired
        if (now - windowStart >= windowMs) {
          windowStart = now;
          count = 0;
        }
      }

      await docClient.send(new PutCommand({
        TableName: config.tableName,
        Item: {
          pk: `AVATAR#${avatarId}`,
          sk: `CREDITS#${operation}`,
          windowStart,
          count: count + 1,
          updatedAt: now,
        },
      }));
    } catch (err) {
      console.warn('[MediaResolver] Failed to consume credit:', err);
    }
  };
}

// ============================================================================
// GALLERY
// ============================================================================

/**
 * Create a gallery saver
 */
export function createGallerySaver(config: ResolverConfig): MediaServiceDependencies['saveToGallery'] {
  const docClient = config.dynamoClient || createDocClient(config.region);

  return async (avatarId: string, item: GalleryItemInput): Promise<GalleryItemOutput> => {
    const now = Date.now();
    const galleryItem: GalleryItemOutput = {
      ...item,
      avatarId,
      createdAt: now,
    };

    await docClient.send(new PutCommand({
      TableName: config.tableName,
      Item: {
        pk: `AVATAR#${avatarId}`,
        sk: `GALLERY#${now}#${item.id}`,
        ...galleryItem,
        postedToTwitter: false,
        convertedToSticker: false,
      },
    }));

    console.log(`[MediaResolver] Saved to gallery: avatar=${avatarId}, id=${item.id}`);
    return galleryItem;
  };
}

// ============================================================================
// REPLICATE INPUT VALIDATION
// ============================================================================

/**
 * Create a Replicate input validator that validates parameters against model schemas.
 *
 * The actual schema fetching/caching/validation logic lives in
 * admin-api's replicate-schema.ts. This factory creates a thin wrapper
 * that can be injected via MediaServiceDependencies.
 *
 * @param validateFn - The actual validation function (from replicate-schema.ts)
 */
export function createReplicateInputValidator(
  validateFn: (
    modelId: string,
    input: Record<string, unknown>,
    apiKey: string,
  ) => Promise<{ cleanedInput: Record<string, unknown>; adjustments: string[] }>,
): NonNullable<MediaServiceDependencies['validateReplicateInput']> {
  return validateFn;
}

// ============================================================================
// FACTORY: Create all dependencies at once
// ============================================================================

/**
 * Create all media service dependencies for a given table
 */
export function createMediaDependencies(config: ResolverConfig): MediaServiceDependencies {
  return {
    resolveModel: createModelResolver(config),
    resolveApiKey: createApiKeyResolver(config),
    checkCredits: createCreditChecker(config),
    consumeCredits: createCreditConsumer(config),
    consumeTrialCredit: createTrialCreditConsumer(config),
    saveToGallery: createGallerySaver(config),
  };
}

/**
 * Create all media service dependencies including Replicate input validation
 */
export function createMediaDependenciesWithValidation(
  config: ResolverConfig,
  validateFn: (
    modelId: string,
    input: Record<string, unknown>,
    apiKey: string,
  ) => Promise<{ cleanedInput: Record<string, unknown>; adjustments: string[] }>,
): MediaServiceDependencies {
  return {
    ...createMediaDependencies(config),
    validateReplicateInput: createReplicateInputValidator(validateFn),
  };
}
