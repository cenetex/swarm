/**
 * Replicate Model Schema Service
 *
 * Fetches, caches, and validates Replicate model input schemas.
 * Eliminates hardcoded model parameter lists by querying the Replicate API
 * for each model's OpenAPI schema (valid aspect ratios, output formats, etc.).
 *
 * Cache layers: in-memory (5 min) → DynamoDB (24h TTL) → Replicate API
 */
import { GetCommand, PutCommand } from '@swarm/core';
import type { DynamoDBDocumentClient } from '@swarm/core';
import { createSystemLogger } from '../structured-logger.js';

const log = createSystemLogger('replicate-schema');

// ============================================================================
// Types
// ============================================================================

/** Extracted parameter info from a model's OpenAPI input schema */
export interface ModelParamInfo {
  type: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

/** Result of extracting supported parameters from a model schema */
export interface ModelSupportedParams {
  /** Model identifier (owner/name) */
  modelId: string;
  /** Map of parameter name → info (enum values, defaults, etc.) */
  params: Record<string, ModelParamInfo>;
  /** Raw OpenAPI input schema for advanced use */
  rawSchema?: Record<string, unknown>;
  /** When the schema was fetched */
  fetchedAt: number;
}

/** Result of validating inputs against a model schema */
export interface ValidationResult {
  /** Cleaned input object with invalid params stripped/corrected */
  cleanedInput: Record<string, unknown>;
  /** Human-readable descriptions of adjustments made */
  adjustments: string[];
}

/** Model search result from Replicate API */
export interface ReplicateModelResult {
  url: string;
  owner: string;
  name: string;
  description: string;
  visibility: string;
  run_count: number;
  cover_image_url?: string;
  default_example?: {
    completed_at?: string;
    output?: unknown;
  };
  latest_version?: {
    id: string;
  };
}

// ============================================================================
// In-memory cache (per Lambda invocation, 5-min TTL)
// ============================================================================

const memoryCache = new Map<string, { data: ModelSupportedParams; expiry: number }>();
const MEMORY_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getFromMemoryCache(modelId: string): ModelSupportedParams | undefined {
  const entry = memoryCache.get(modelId);
  if (entry && entry.expiry > Date.now()) return entry.data;
  if (entry) memoryCache.delete(modelId);
  return undefined;
}

function setMemoryCache(modelId: string, data: ModelSupportedParams): void {
  memoryCache.set(modelId, { data, expiry: Date.now() + MEMORY_TTL_MS });
}

// ============================================================================
// DynamoDB cache (24h TTL)
// ============================================================================

const DYNAMO_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getFromDynamoCache(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  modelId: string,
): Promise<ModelSupportedParams | undefined> {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `REPLICATE_MODEL#${modelId}`, sk: 'SCHEMA' },
    }));
    if (!result.Item) return undefined;

    const fetchedAt = result.Item.fetchedAt as number;
    if (Date.now() - fetchedAt > DYNAMO_TTL_MS) return undefined;

    return {
      modelId: result.Item.modelId as string,
      params: result.Item.params as Record<string, ModelParamInfo>,
      fetchedAt,
    };
  } catch (err) {
    log.warn('cache', 'dynamo_cache_read_failed', {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function setDynamoCache(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  data: ModelSupportedParams,
): Promise<void> {
  try {
    const ttl = Math.floor((Date.now() + DYNAMO_TTL_MS) / 1000); // DynamoDB TTL in seconds
    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        pk: `REPLICATE_MODEL#${data.modelId}`,
        sk: 'SCHEMA',
        modelId: data.modelId,
        params: data.params,
        fetchedAt: data.fetchedAt,
        ttl,
      },
    }));
  } catch (err) {
    log.warn('cache', 'dynamo_cache_write_failed', {
      modelId: data.modelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============================================================================
// Replicate API
// ============================================================================

/**
 * Fetch a model's metadata from Replicate (includes OpenAPI schema).
 */
export async function fetchReplicateModelSchema(
  modelId: string,
  apiKey: string,
  deps?: { fetchFn?: typeof fetch },
): Promise<Record<string, unknown> | undefined> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const [owner, name] = modelId.split('/');
  if (!owner || !name) return undefined;

  const url = `https://api.replicate.com/v1/models/${owner}/${name}`;
  try {
    const response = await fetchFn(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!response.ok) {
      log.warn('model', 'model_fetch_failed', { modelId, status: response.status });
      return undefined;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (err) {
    log.warn('model', 'model_fetch_error', {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Extract supported parameters from the model's OpenAPI input schema.
 */
export function extractSupportedParams(
  modelId: string,
  modelData: Record<string, unknown>,
): ModelSupportedParams {
  const params: Record<string, ModelParamInfo> = {};

  // Navigate: latest_version.openapi_schema.components.schemas.Input.properties
  const latestVersion = modelData.latest_version as Record<string, unknown> | undefined;
  const openapiSchema = latestVersion?.openapi_schema as Record<string, unknown> | undefined;
  const components = openapiSchema?.components as Record<string, unknown> | undefined;
  const schemas = components?.schemas as Record<string, unknown> | undefined;
  const inputSchema = schemas?.Input as Record<string, unknown> | undefined;
  const properties = inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;

  if (properties) {
    for (const [key, prop] of Object.entries(properties)) {
      const info: ModelParamInfo = {
        type: (prop.type as string) || 'unknown',
      };
      if (prop.description) info.description = prop.description as string;
      if (prop.enum) info.enum = prop.enum as unknown[];
      if (prop.default !== undefined) info.default = prop.default;
      if (prop.minimum !== undefined) info.minimum = prop.minimum as number;
      if (prop.maximum !== undefined) info.maximum = prop.maximum as number;

      // Handle allOf/anyOf patterns (common for enums with defaults)
      if (prop.allOf && Array.isArray(prop.allOf)) {
        for (const sub of prop.allOf as Record<string, unknown>[]) {
          if (sub.enum) info.enum = sub.enum as unknown[];
          if (sub.default !== undefined) info.default = sub.default;
        }
      }

      params[key] = info;
    }
  }

  return {
    modelId,
    params,
    rawSchema: inputSchema,
    fetchedAt: Date.now(),
  };
}

/**
 * Get the schema for a model with layered caching:
 * memory (5min) → DynamoDB (24h) → Replicate API
 */
export async function getReplicateModelSchema(
  modelId: string,
  apiKey: string,
  dynamoClient?: DynamoDBDocumentClient,
  tableName?: string,
  deps?: { fetchFn?: typeof fetch },
): Promise<ModelSupportedParams | undefined> {
  // Layer 1: memory cache
  const memCached = getFromMemoryCache(modelId);
  if (memCached) return memCached;

  // Layer 2: DynamoDB cache
  if (dynamoClient && tableName) {
    const dbCached = await getFromDynamoCache(dynamoClient, tableName, modelId);
    if (dbCached) {
      setMemoryCache(modelId, dbCached);
      return dbCached;
    }
  }

  // Layer 3: Replicate API
  const modelData = await fetchReplicateModelSchema(modelId, apiKey, deps);
  if (!modelData) return undefined;

  const result = extractSupportedParams(modelId, modelData);
  setMemoryCache(modelId, result);

  if (dynamoClient && tableName) {
    await setDynamoCache(dynamoClient, tableName, result);
  }

  return result;
}

// ============================================================================
// Input Validation
// ============================================================================

/**
 * Validate and clean input parameters against a model's schema.
 * - Strips parameters the model doesn't accept
 * - Corrects invalid enum values to defaults
 * - Returns human-readable adjustment descriptions
 */
export function validateReplicateInput(
  modelId: string,
  input: Record<string, unknown>,
  schema: ModelSupportedParams,
): ValidationResult {
  const cleanedInput: Record<string, unknown> = {};
  const adjustments: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    const paramInfo = schema.params[key];

    // Keep 'prompt' even if not in schema (some schemas omit it)
    if (!paramInfo) {
      if (key === 'prompt') {
        cleanedInput[key] = value;
        continue;
      }
      adjustments.push(`Removed unsupported parameter "${key}" for ${modelId}`);
      continue;
    }

    // Validate enum values
    if (paramInfo.enum && paramInfo.enum.length > 0) {
      if (!paramInfo.enum.includes(value)) {
        const fallback = paramInfo.default ?? paramInfo.enum[0];
        adjustments.push(
          `Corrected "${key}" from "${String(value)}" to "${String(fallback)}" ` +
          `(valid: ${paramInfo.enum.map(String).join(', ')})`
        );
        cleanedInput[key] = fallback;
        continue;
      }
    }

    // Validate numeric ranges
    if (typeof value === 'number') {
      let corrected = value;
      if (paramInfo.minimum !== undefined && value < paramInfo.minimum) {
        corrected = paramInfo.minimum;
        adjustments.push(`Corrected "${key}" from ${value} to ${corrected} (minimum: ${paramInfo.minimum})`);
      }
      if (paramInfo.maximum !== undefined && value > paramInfo.maximum) {
        corrected = paramInfo.maximum;
        adjustments.push(`Corrected "${key}" from ${value} to ${corrected} (maximum: ${paramInfo.maximum})`);
      }
      cleanedInput[key] = corrected;
      continue;
    }

    cleanedInput[key] = value;
  }

  return { cleanedInput, adjustments };
}

// ============================================================================
// Model Search
// ============================================================================

/**
 * Search for models on Replicate.
 */
export async function searchReplicateModels(
  query: string,
  apiKey: string,
  opts?: { cursor?: string; fetchFn?: typeof fetch },
): Promise<{ results: ReplicateModelResult[]; next?: string }> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const params = new URLSearchParams({ query });
  if (opts?.cursor) params.set('cursor', opts.cursor);

  const url = `https://api.replicate.com/v1/models?${params.toString()}`;

  try {
    const response = await fetchFn(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    if (!response.ok) {
      log.warn('search', 'model_search_failed', { query, status: response.status });
      return { results: [] };
    }

    const data = (await response.json()) as {
      results: ReplicateModelResult[];
      next?: string;
    };

    return {
      results: data.results || [],
      next: data.next || undefined,
    };
  } catch (err) {
    log.warn('search', 'model_search_error', {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return { results: [] };
  }
}

// ============================================================================
// Combined: Validate input for a model with auto-fetching schema
// ============================================================================

/**
 * Fetch schema (with caching) and validate input in one call.
 * If schema fetch fails, returns input as-is (graceful degradation).
 */
export async function validateReplicateInputWithSchema(
  modelId: string,
  input: Record<string, unknown>,
  apiKey: string,
  dynamoClient?: DynamoDBDocumentClient,
  tableName?: string,
  deps?: { fetchFn?: typeof fetch },
): Promise<ValidationResult> {
  const schema = await getReplicateModelSchema(modelId, apiKey, dynamoClient, tableName, deps);
  if (!schema || Object.keys(schema.params).length === 0) {
    // No schema available — pass through unchanged
    return { cleanedInput: { ...input }, adjustments: [] };
  }
  return validateReplicateInput(modelId, input, schema);
}
