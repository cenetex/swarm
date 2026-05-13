/**
 * OpenAI-Compatible Chat Completions API
 *
 * Provides a public API endpoint compatible with the OpenAI /v1/chat/completions format.
 * This allows external applications to chat with any avatar using the familiar OpenAI API format.
 *
 * Authentication: API key via Authorization header (Bearer token)
 * Endpoint: POST /v1/chat/completions
 *
 * The model parameter is used to specify the avatar ID:
 *   - "avatar:{avatarId}" - e.g., "avatar:my-bot"
 *   - Just the avatarId works too - e.g., "my-bot"
 *
 * Usage:
 * ```bash
 * curl -X POST https://api.example.com/v1/chat/completions \
 *   -H "Authorization: Bearer sk-..." \
 *   -H "Content-Type: application/json" \
 *   -d '{
 *     "model": "avatar:my-bot",
 *     "messages": [{"role": "user", "content": "Hello!"}],
 *     "stream": true
 *   }'
 * ```
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger, detectEnabledCategories } from '@swarm/core';
import { processChat } from './chat.js';
import {
  LLM_TIMEOUT_MS,
  getLlmApiKey,
  normalizeUsage,
  type LlmUsage,
} from './chat-llm.js';
import type { UserSession } from '../types.js';
import * as avatars from '../services/avatars.js';
import * as voice from '../services/voice.js';
import * as energy from '../services/billing/energy.js';
import { getCorsHeaders } from '../http/cors.js';
import { getDynamoClient } from '../services/dynamo-client.js';
import { resolveTokenUsage, recordTokenUsage } from '../services/token-accounting.js';
import type { UsageSource } from '../services/token-accounting.js';

// =============================================================================
// Configuration
// =============================================================================

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const docClient = getDynamoClient();

// =============================================================================
// OpenAI-Compatible Types
// =============================================================================

export const OpenAIToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const OpenAIMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullish().transform(v => v ?? ''),
  name: z.string().optional(),
  tool_calls: z.array(OpenAIToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

export const OpenAIToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
  }).passthrough(),
}).passthrough();

export const OpenAIToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
    }).passthrough(),
  }).passthrough(),
]);

const ChatCompletionRequestSchema = z.object({
  model: z.string().optional(), // Will be parsed as avatar ID, optional for scoped keys
  messages: z.array(OpenAIMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional().default(false),
  user: z.string().optional(), // Optional user identifier for tracking
  tools: z.array(OpenAIToolSchema).optional(),
  tool_choice: OpenAIToolChoiceSchema.optional(),
  // Non-standard extensions for avatar features
  include_audio: z.boolean().optional().default(false), // Generate voice audio for response
});

type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type OpenAIChatMessage = z.infer<typeof OpenAIMessageSchema>;
export type OpenAIToolCall = z.infer<typeof OpenAIToolCallSchema>;

interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIToolCall[];
    audio?: {
      url: string;
      format: string;
      duration_ms?: number;
    };
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Whether token counts came from the provider or were estimated */
    usage_source: UsageSource;
  };
}

interface OpenAIError {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}

// =============================================================================
// API Key Authentication
// =============================================================================

interface ApiKeyRecord {
  pk: string; // API_KEY#{keyHash}
  sk: string; // 'META'
  keyPrefix: string; // First 8 chars for display (e.g., "sk-abc123...")
  keyHash: string; // SHA-256 hash of the full key
  avatarId: string; // The avatar this key grants access to, or '*' for all
  name: string; // Human-readable name for the key
  createdAt: number;
  createdBy: string; // Email or userId of creator
  lastUsedAt?: number;
  usageCount: number;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  enabled: boolean;
}

interface ApiKeyValidationResult {
  valid: boolean;
  session?: UserSession;
  avatarId?: string;
  error?: string;
  statusCode?: number;
  retryAfterSeconds?: number;
}

/**
 * Hash an API key for secure storage/lookup
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Extract API key from Authorization header
 */
export function extractApiKey(event: APIGatewayProxyEventV2): string | null {
  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader) return null;

  // Support both "Bearer sk-..." and just "sk-..."
  const key = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  // Validate format (must start with sk- or swarm-)
  if (!key.startsWith('sk-') && !key.startsWith('swarm-')) {
    return null;
  }

  return key;
}

interface ApiKeyRateLimitDeps {
  docClient: Pick<typeof docClient, 'send'>;
  tableName: string;
  now: () => number;
}

function getApiKeyRateLimitDeps(): ApiKeyRateLimitDeps {
  return {
    docClient,
    tableName: ADMIN_TABLE,
    now: () => Date.now(),
  };
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

async function incrementRateBucket(params: {
  keyHash: string;
  bucketType: 'MINUTE' | 'DAY';
  bucketStartMs: number;
  resetAtMs: number;
  limit: number;
  deps: ApiKeyRateLimitDeps;
}): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const { keyHash, bucketType, bucketStartMs, resetAtMs, limit, deps } = params;
  const now = deps.now();
  const ttl = Math.floor(resetAtMs / 1000) + 86400; // Keep buckets for one extra day.

  try {
    await deps.docClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: {
        pk: `API_KEY_RATE#${keyHash}`,
        sk: `${bucketType}#${bucketStartMs}`,
      },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, resetAt = :resetAt, #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: {
        '#count': 'count',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':limit': limit,
        ':resetAt': resetAtMs,
        ':ttl': ttl,
      },
    }));

    return { allowed: true };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
      };
    }
    throw err;
  }
}

export async function checkApiKeyRateLimit(
  keyHash: string,
  rateLimit: ApiKeyRecord['rateLimit'] | undefined,
  deps: ApiKeyRateLimitDeps = getApiKeyRateLimitDeps()
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const perMinute = toPositiveInt(rateLimit?.requestsPerMinute);
  const perDay = toPositiveInt(rateLimit?.requestsPerDay);
  if (!perMinute && !perDay) return { allowed: true };

  const now = deps.now();

  if (perMinute) {
    const minuteStart = Math.floor(now / 60000) * 60000;
    const minuteResult = await incrementRateBucket({
      keyHash,
      bucketType: 'MINUTE',
      bucketStartMs: minuteStart,
      resetAtMs: minuteStart + 60000,
      limit: perMinute,
      deps,
    });
    if (!minuteResult.allowed) {
      return minuteResult;
    }
  }

  if (perDay) {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayStartMs = dayStart.getTime();
    const dayResult = await incrementRateBucket({
      keyHash,
      bucketType: 'DAY',
      bucketStartMs: dayStartMs,
      resetAtMs: dayStartMs + 86400000,
      limit: perDay,
      deps,
    });
    if (!dayResult.allowed) {
      return dayResult;
    }
  }

  return { allowed: true };
}

/**
 * Validate API key and return the associated session
 */
export async function validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
  const keyHash = hashApiKey(apiKey);

  try {
    const result = await docClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `API_KEY#${keyHash}`,
        sk: 'META',
      },
    }));

    const keyRecord = result.Item as ApiKeyRecord | undefined;

    if (!keyRecord) {
      return { valid: false, error: 'Invalid API key' };
    }

    if (!keyRecord.enabled) {
      return { valid: false, error: 'API key is disabled' };
    }

    const rateLimitStatus = await checkApiKeyRateLimit(keyHash, keyRecord.rateLimit);
    if (!rateLimitStatus.allowed) {
      return {
        valid: false,
        error: 'API key rate limit exceeded',
        statusCode: 429,
        retryAfterSeconds: rateLimitStatus.retryAfterSeconds,
      };
    }

    // Update last used timestamp and usage count (fire and forget)
    docClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `API_KEY#${keyHash}`,
        sk: 'META',
      },
      UpdateExpression: 'SET lastUsedAt = :now, usageCount = usageCount + :one',
      ExpressionAttributeValues: {
        ':now': Date.now(),
        ':one': 1,
      },
    })).catch(err => {
      logger.warn('Failed to update API key usage', { error: err.message });
    });

    // Create a session for the API key user
    const session: UserSession = {
      email: `api-key:${keyRecord.keyPrefix}...`,
      userId: `api-key:${keyRecord.keyHash.slice(0, 16)}`,
      isAdmin: false,
      accessToken: '',
    };

    return {
      valid: true,
      session,
      avatarId: keyRecord.avatarId === '*' ? undefined : keyRecord.avatarId,
    };
  } catch (err) {
    logger.error('API key validation error', err);
    return { valid: false, error: 'Authentication error' };
  }
}

// =============================================================================
// Avatar Resolution
// =============================================================================

/**
 * Parse the model parameter to extract avatar ID
 * Supports: "avatar:my-bot", "my-bot", etc.
 */
export function parseAvatarId(model: string): string {
  // Handle "avatar:{id}" format
  if (model.startsWith('avatar:')) {
    return model.slice(7);
  }
  // Otherwise treat the whole model as the avatar ID
  return model;
}

/**
 * Resolve the effective model for a chat completion request.
 *
 * - If the request supplied a model, use it as-is.
 * - If it didn't and the API key is avatar-scoped, default to `avatar:{avatarId}`.
 * - Otherwise (wildcard key + no model), return an error.
 */
export function resolveModel(
  requestModel: string | undefined,
  validation: { avatarId?: string },
): { model: string } | { error: string } {
  if (requestModel) return { model: requestModel };
  if (validation.avatarId) return { model: `avatar:${validation.avatarId}` };
  return { error: 'model parameter is required for wildcard API keys' };
}

export function normalizeOpenAIMessageForProvider(message: OpenAIChatMessage): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    role: message.role,
    content: message.role === 'assistant' && message.tool_calls?.length && !message.content
      ? null
      : message.content,
  };

  if (message.name) {
    normalized.name = message.name;
  }
  if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
    normalized.tool_calls = message.tool_calls;
  }
  if (message.role === 'tool' && message.tool_call_id) {
    normalized.tool_call_id = message.tool_call_id;
  }

  return normalized;
}

export function usesExternalToolMode(request: {
  tools?: unknown[];
  tool_choice?: unknown;
  messages: Array<{ role: string; tool_calls?: unknown[] }>;
}): boolean {
  return Boolean(
    request.tools !== undefined ||
    request.tool_choice !== undefined ||
    request.messages.some(message =>
      message.role === 'tool' ||
      (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    )
  );
}

export function normalizeOpenAIToolCalls(value: unknown): OpenAIToolCall[] {
  const parsed = z.array(OpenAIToolCallSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function normalizeFinishReason(
  value: unknown,
  toolCalls: OpenAIToolCall[],
): ChatCompletionChoice['finish_reason'] {
  if (
    value === 'stop' ||
    value === 'length' ||
    value === 'tool_calls' ||
    value === 'content_filter'
  ) {
    return value;
  }
  return toolCalls.length > 0 ? 'tool_calls' : 'stop';
}

function buildExternalToolPromptText(request: Pick<ChatCompletionRequest, 'messages' | 'tools' | 'tool_choice'>): string {
  const parts = request.messages.map(message => {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return `${message.content}\n${JSON.stringify(message.tool_calls)}`;
    }
    if (message.role === 'tool') {
      return `${message.tool_call_id || ''}\n${message.content}`;
    }
    return message.content;
  });

  if (request.tools?.length) {
    parts.push(JSON.stringify(request.tools));
  }
  if (request.tool_choice !== undefined) {
    parts.push(JSON.stringify(request.tool_choice));
  }

  return parts.join('\n');
}

async function callExternalToolModel(params: {
  llmModel: string;
  systemPrompt: string;
  messages: ChatCompletionRequest['messages'];
  maxTokens?: number;
  temperature?: number;
  tools?: ChatCompletionRequest['tools'];
  toolChoice?: ChatCompletionRequest['tool_choice'];
}): Promise<{
  content: string | null;
  toolCalls: OpenAIToolCall[];
  usage?: LlmUsage;
  finishReason: ChatCompletionChoice['finish_reason'];
  latencyMs: number;
}> {
  const apiKey = await getLlmApiKey();
  const start = Date.now();
  const providerMessages = [
    { role: 'system', content: params.systemPrompt },
    ...params.messages.map(normalizeOpenAIMessageForProvider),
  ];

  const body: Record<string, unknown> = {
    model: params.llmModel,
    messages: providerMessages,
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    stream: false,
  };

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
  }
  if (params.toolChoice !== undefined) {
    body.tool_choice = params.toolChoice;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://swarm.rati.chat',
      'X-Title': 'Swarm API',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter external-tool error: ${response.status} ${errorText.slice(0, 1000)}`);
  }

  const data = await response.json() as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        tool_calls?: unknown;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  const choice = data.choices?.[0];
  const toolCalls = normalizeOpenAIToolCalls(choice?.message?.tool_calls);
  const rawContent = choice?.message?.content;
  const content = typeof rawContent === 'string'
    ? rawContent
    : toolCalls.length > 0
      ? null
      : '';

  return {
    content,
    toolCalls,
    usage: normalizeUsage(data.usage),
    finishReason: normalizeFinishReason(choice?.finish_reason, toolCalls),
    latencyMs: Date.now() - start,
  };
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function errorResponse(
  statusCode: number,
  message: string,
  type: string = 'invalid_request_error',
  code?: string,
  headers?: Record<string, string>
): APIGatewayProxyResultV2 {
  const error: OpenAIError = {
    error: {
      message,
      type,
      code,
    },
  };
  return jsonResponse(statusCode, error, headers);
}

function apiKeyValidationErrorResponse(
  validation: ApiKeyValidationResult,
  corsHeaders: Record<string, string>
): APIGatewayProxyResultV2 {
  const statusCode = validation.statusCode || 401;
  if (statusCode === 429) {
    return errorResponse(
      429,
      validation.error || 'Rate limit exceeded',
      'rate_limit_error',
      'rate_limit_exceeded',
      {
        ...corsHeaders,
        ...(validation.retryAfterSeconds ? { 'Retry-After': String(validation.retryAfterSeconds) } : {}),
      }
    );
  }

  return errorResponse(
    statusCode,
    validation.error || 'Invalid API key',
    'authentication_error',
    'invalid_api_key',
    corsHeaders
  );
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Lambda handler for OpenAI-compatible chat completions API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);
  const requestId = event.requestContext.requestId;

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  const method = event.requestContext.http.method;
  const rawPath = event.rawPath || '/';
  const path = rawPath.startsWith('/v1') ? rawPath : `/v1${rawPath}`;

  logger.info('OpenAI compat request', {
    event: 'request_received',
    subsystem: 'openai-compat',
    method,
    path,
    requestId,
  });

  // GET /v1/models - List available avatars as "models"
  if (method === 'GET' && (path === '/v1/models' || path === '/models')) {
    return handleListModels(event, corsHeaders);
  }

  // GET /v1/models/{model_id} - Get specific avatar details
  const modelMatch = path.match(/^\/v1\/models\/(.+)$/) || path.match(/^\/models\/(.+)$/);
  if (method === 'GET' && modelMatch) {
    return handleGetModel(event, modelMatch[1], corsHeaders);
  }

  // POST /v1/chat/completions - Main chat endpoint
  if (method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    return handleChatCompletions(event, corsHeaders, requestId);
  }

  return errorResponse(404, `Unknown endpoint: ${path}`, 'not_found', undefined, corsHeaders);
}

/**
 * GET /v1/models - List available avatars
 */
async function handleListModels(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>
): Promise<APIGatewayProxyResultV2> {
  // Validate API key
  const apiKey = extractApiKey(event);
  if (!apiKey) {
    return errorResponse(401, 'Missing API key', 'authentication_error', 'missing_api_key', corsHeaders);
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.valid) {
    return apiKeyValidationErrorResponse(validation, corsHeaders);
  }

  try {
    // If API key is scoped to a specific avatar, only return that one
    if (validation.avatarId) {
      // NOTE (#1385): metadata-only listing, not a chat/tool invocation.
      // Ownership enforcement lives at `handleChatCompletions` below where
      // the avatar record is actually used to serve a completion.
      const avatar = await avatars.getAvatar(validation.avatarId);
      if (!avatar) {
        return jsonResponse(200, { object: 'list', data: [] }, corsHeaders);
      }

      const voiceCheck = await voice.hasVoice(avatar.avatarId);
      const energyStatus = await energy.getEnergyStatus(avatar.avatarId);

      return jsonResponse(200, {
        object: 'list',
        data: [{
          id: `avatar:${avatar.avatarId}`,
          object: 'model',
          created: Math.floor((avatar.createdAt || Date.now()) / 1000),
          owned_by: 'swarm',
          permission: [],
          root: avatar.avatarId,
          parent: null,
          // Non-standard extensions
          capabilities: {
            voice: voiceCheck.hasVoice,
          },
          // Basic avatar info
          avatar: {
            name: avatar.name,
            description: avatar.description || null,
            profile_image: avatar.profileImage?.url || null,
          },
          // Energy availability
          energy: {
            current: energyStatus.current,
            max: energyStatus.max,
            refill_rate: energyStatus.refillPerHour,
            next_refill_minutes: energyStatus.nextRefillIn,
          },
        }],
      }, corsHeaders);
    }

    // For wildcard keys, list all public avatars
    // GSI1 uses sk as HASH key, pk as RANGE key - query for sk=CONFIG and filter for AVATAR# prefix
    const result = await docClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'sk = :sk AND begins_with(pk, :prefix)',
      FilterExpression: '#status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':prefix': 'AVATAR#',
        ':deleted': 'deleted',
      },
      Limit: 100,
    }));

    const avatarList = (result.Items || [])
      .filter((item: Record<string, unknown>) => item.status !== 'archived')
      .map((item: Record<string, unknown>) => {
        const voiceConfig = item.voiceConfig as Record<string, unknown> | undefined;
        const hasVoiceEnabled = !!(voiceConfig?.enabled && (voiceConfig?.defaultVoiceId || voiceConfig?.referenceUrl));
        const profileImage = item.profileImage as Record<string, unknown> | undefined;
        return {
          id: `avatar:${item.avatarId}`,
          object: 'model',
          created: Math.floor((item.createdAt as number || Date.now()) / 1000),
          owned_by: 'swarm',
          permission: [],
          root: item.avatarId,
          parent: null,
          // Non-standard extensions
          capabilities: {
            voice: hasVoiceEnabled,
          },
          // Basic avatar info for listing
          avatar: {
            name: item.name || null,
            description: item.description || null,
            profile_image: profileImage?.url || null,
          },
        };
      });

    return jsonResponse(200, {
      object: 'list',
      data: avatarList,
    }, corsHeaders);
  } catch (err) {
    logger.error('Failed to list models', err);
    return errorResponse(500, 'Failed to list models', 'server_error', undefined, corsHeaders);
  }
}

/**
 * GET /v1/models/{model_id} - Get detailed info about a specific avatar
 */
async function handleGetModel(
  event: APIGatewayProxyEventV2,
  modelId: string,
  corsHeaders: Record<string, string>
): Promise<APIGatewayProxyResultV2> {
  // Validate API key
  const apiKey = extractApiKey(event);
  if (!apiKey) {
    return errorResponse(401, 'Missing API key', 'authentication_error', 'missing_api_key', corsHeaders);
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.valid) {
    return apiKeyValidationErrorResponse(validation, corsHeaders);
  }

  try {
    // Parse model ID (strip avatar: prefix if present)
    const avatarId = modelId.replace(/^avatar:/, '');

    // Check if API key is scoped and has access to this avatar
    if (validation.avatarId && validation.avatarId !== avatarId) {
      return errorResponse(403, 'API key does not have access to this avatar', 'permission_error', 'access_denied', corsHeaders);
    }

    // NOTE (#1385): metadata-only model lookup, not a chat/tool invocation.
    // Ownership enforcement lives at `handleChatCompletions` below where
    // the avatar record is actually used to serve a completion.
    const avatar = await avatars.getAvatar(avatarId);
    if (!avatar) {
      return errorResponse(404, `Model not found: ${modelId}`, 'not_found', 'model_not_found', corsHeaders);
    }

    const voiceCheck = await voice.hasVoice(avatar.avatarId);
    const energyStatus = await energy.getEnergyStatus(avatar.avatarId);

    // Build detailed model response with avatar info
    const response = {
      id: `avatar:${avatar.avatarId}`,
      object: 'model',
      created: Math.floor((avatar.createdAt || Date.now()) / 1000),
      owned_by: 'swarm',
      permission: [],
      root: avatar.avatarId,
      parent: null,
      // Non-standard extensions with avatar details
      capabilities: {
        voice: voiceCheck.hasVoice,
      },
      avatar: {
        id: avatar.avatarId,
        name: avatar.name,
        description: avatar.description || null,
        // Profile images
        profile_image: avatar.profileImage?.url || null,
        character_reference: avatar.characterReference?.url || null,
        // Platform presence
        platforms: {
          telegram: avatar.platforms?.telegram?.enabled ? {
            username: avatar.platforms.telegram.botUsername || null,
            home_channel: avatar.platforms.telegram.homeChannelUrl || null,
          } : null,
          twitter: avatar.platforms?.twitter?.enabled ? {
            username: avatar.platforms.twitter.username || null,
          } : null,
          discord: avatar.platforms?.discord?.enabled ? {
            guild_id: avatar.platforms.discord.guildId || null,
          } : null,
        },
        // Voice info
        voice: voiceCheck.hasVoice ? {
          style: voiceCheck.voiceStyle || null,
        } : null,
        // Sticker pack (if available)
        sticker_pack: avatar.stickerPack ? {
          name: avatar.stickerPack.name,
          title: avatar.stickerPack.title,
          count: avatar.stickerPack.stickerCount,
        } : null,
      },
      // Energy availability for rate-limited operations
      energy: {
        current: energyStatus.current,
        max: energyStatus.max,
        refill_rate: energyStatus.refillPerHour,
        next_refill_minutes: energyStatus.nextRefillIn,
        costs: {
          voice: 1,
          image: 2,
          video: 3,
        },
      },
    };

    return jsonResponse(200, response, corsHeaders);
  } catch (err) {
    logger.error('Failed to get model', err);
    return errorResponse(500, 'Failed to get model', 'server_error', undefined, corsHeaders);
  }
}

/**
 * POST /v1/chat/completions - Generate a chat completion
 */
async function handleChatCompletions(
  event: APIGatewayProxyEventV2,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<APIGatewayProxyResultV2> {
  // Validate API key
  const apiKey = extractApiKey(event);
  if (!apiKey) {
    return errorResponse(401, 'Missing API key', 'authentication_error', 'missing_api_key', corsHeaders);
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.valid || !validation.session) {
    return apiKeyValidationErrorResponse(validation, corsHeaders);
  }

  // Parse request body
  let request: ChatCompletionRequest;
  try {
    const body = JSON.parse(event.body || '{}');
    const parseResult = ChatCompletionRequestSchema.safeParse(body);
    if (!parseResult.success) {
      const errorDetails = parseResult.error.issues.map((e) => `${(e.path as PropertyKey[]).map(String).join('.')}: ${e.message}`).join(', ');
      return errorResponse(400, `Invalid request: ${errorDetails}`, 'invalid_request_error', undefined, corsHeaders);
    }
    request = parseResult.data;
  } catch {
    return errorResponse(400, 'Invalid JSON body', 'invalid_request_error', undefined, corsHeaders);
  }

  const resolved = resolveModel(request.model, validation);
  if ('error' in resolved) {
    return errorResponse(400, resolved.error, 'invalid_request_error', undefined, corsHeaders);
  }
  const model = resolved.model;
  const avatarId = parseAvatarId(model);

  // Check if API key is authorized for this avatar
  if (validation.avatarId && validation.avatarId !== avatarId) {
    return errorResponse(403, `API key not authorized for avatar: ${avatarId}`, 'permission_error', 'unauthorized_avatar', corsHeaders);
  }

  // The scoped API key check above (`validation.avatarId !== avatarId`) is
  // the auth grant for this endpoint. API-key sessions don't carry a wallet
  // address — `session.userId` is a synthetic `api-key:<hash-prefix>` string
  // — so calling `assertAvatarOwnership` here always returned not_owner and
  // collapsed to 404 regardless of the real NFT state. NFT-transfer
  // revocation on this path should be driven by revoking the API key itself
  // (UI exposes this), or by a future flag-gated gate analogous to #1416.
  const avatarRecord = await avatars.getAvatar(avatarId);
  if (!avatarRecord) {
    return errorResponse(404, `Avatar not found: ${avatarId}`, 'not_found', 'avatar_not_found', corsHeaders);
  }

  // Reject unsupported stream + audio combination
  if (request.stream && request.include_audio) {
    return errorResponse(
      400,
      'Audio generation is not supported with streaming. Set stream: false to use include_audio, or disable include_audio to use streaming.',
      'invalid_request_error',
      'unsupported_stream_audio',
      corsHeaders,
    );
  }

  // Convert OpenAI messages to our internal format
  const history = request.messages.slice(0, -1).map(msg => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  }));

  const lastMessage = request.messages[request.messages.length - 1];
  const userMessage = lastMessage.role === 'user' ? lastMessage.content : null;

  // Build avatar context with enabled categories detected from avatar configuration
  const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
  const enabledToolsets = avatarRecord.mcpConfig?.enabledToolsets || [];
  const enabledCategories = detectEnabledCategories({
    voice: voiceEnabled,
    memory: enabledToolsets.includes('memory'),
    telegram: Boolean(avatarRecord.platforms?.telegram?.enabled),
    twitter: Boolean(avatarRecord.platforms?.twitter?.enabled),
    discord: Boolean(avatarRecord.platforms?.discord?.enabled),
  });

  const avatarContext = {
    id: avatarRecord.avatarId,
    name: avatarRecord.name,
    description: avatarRecord.description || '',
    persona: avatarRecord.persona || '',
    enabledCategories,
  };

  // Resolve model for logging
  const llmModel = avatarRecord.llmConfig?.model || 'anthropic/claude-3-5-sonnet-latest';
  const externalToolMode = usesExternalToolMode(request);

  logger.info('Processing chat completion', {
    event: 'chat_completion_start',
    subsystem: 'openai-compat',
    avatarId,
    messageCount: request.messages.length,
    requestId,
    model: llmModel,
    enabledCategoryCount: enabledCategories.length,
    externalToolMode,
    externalToolCount: request.tools?.length || 0,
  });

  try {
    if (externalToolMode) {
      const externalResult = await callExternalToolModel({
        llmModel,
        systemPrompt: avatarRecord.persona || `You are ${avatarRecord.name || 'an AI assistant'}.`,
        messages: request.messages,
        maxTokens: request.max_tokens,
        temperature: request.temperature,
        tools: request.tools,
        toolChoice: request.tool_choice,
      });

      const completionId = `chatcmpl-${requestId}`;
      const created = Math.floor(Date.now() / 1000);
      const promptText = buildExternalToolPromptText(request);
      const completionText = externalResult.content ?? JSON.stringify(externalResult.toolCalls);
      const tokenUsage = resolveTokenUsage(
        externalResult.usage,
        promptText,
        completionText,
        llmModel,
      );

      const keyHash = hashApiKey(apiKey);
      recordTokenUsage({
        requestId,
        keyHash,
        avatarId,
        model: llmModel,
        usage: tokenUsage,
      }).catch(err => {
        logger.warn('Token accounting recording failed', {
          event: 'token_accounting_error',
          subsystem: 'openai-compat',
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      if (request.stream) {
        return formatStreamingResponse(
          completionId,
          created,
          model,
          externalResult.content ?? '',
          tokenUsage,
          corsHeaders,
          {
            toolCalls: externalResult.toolCalls,
            finishReason: externalResult.finishReason,
          },
        );
      }

      const response: ChatCompletionResponse = {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: externalResult.content,
            ...(externalResult.toolCalls.length > 0 && { tool_calls: externalResult.toolCalls }),
          },
          finish_reason: externalResult.finishReason,
        }],
        usage: {
          prompt_tokens: tokenUsage.promptTokens,
          completion_tokens: tokenUsage.completionTokens,
          total_tokens: tokenUsage.totalTokens,
          usage_source: tokenUsage.usageSource,
        },
      };

      logger.info('External-tool chat completion successful', {
        event: 'external_tool_chat_completion_success',
        subsystem: 'openai-compat',
        avatarId,
        model: llmModel,
        responseLength: externalResult.content?.length || 0,
        toolCallCount: externalResult.toolCalls.length,
        finishReason: externalResult.finishReason,
        totalTokens: tokenUsage.totalTokens,
        usageSource: tokenUsage.usageSource,
        latencyMs: externalResult.latencyMs,
        requestId,
      });

      return jsonResponse(200, response, corsHeaders);
    }

    // Process the chat
    const result = await processChat(
      userMessage,
      history,
      validation.session,
      avatarContext,
      {
        maxTokens: request.max_tokens,
      }
    );

    // Build OpenAI-compatible response
    const completionId = `chatcmpl-${requestId}`;
    const created = Math.floor(Date.now() / 1000);

    // Resolve token usage: use model-aware estimation (provider-reported usage
    // will be preferred automatically when processChat returns it in the future).
    const promptText = request.messages.map(m => m.content).join('\n');
    const tokenUsage = resolveTokenUsage(
      undefined, // provider usage not yet surfaced from processChat
      promptText,
      result.response,
      llmModel,
    );

    // Record token accounting (fire-and-forget — must not block the response)
    const keyHash = hashApiKey(apiKey);
    recordTokenUsage({
      requestId,
      keyHash,
      avatarId,
      model: llmModel,
      usage: tokenUsage,
    }).catch(err => {
      logger.warn('Token accounting recording failed', {
        event: 'token_accounting_error',
        subsystem: 'openai-compat',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Streaming response path: format as SSE chunks
    if (request.stream) {
      return formatStreamingResponse(
        completionId,
        created,
        model,
        result.response,
        tokenUsage,
        corsHeaders,
      );
    }

    // Generate audio if requested and avatar has voice configured
    let audioData: { url: string; format: string; duration_ms?: number } | undefined;
    if (request.include_audio) {
      try {
        const voiceCheck = await voice.hasVoice(avatarId);
        if (voiceCheck.hasVoice) {
          logger.info('Generating voice audio for response', {
            event: 'voice_generation_start',
            subsystem: 'openai-compat',
            avatarId,
            requestId,
          });

          const voiceResult = await voice.generateVoiceMessage({
            avatarId,
            text: result.response,
          });

          audioData = {
            url: voiceResult.url,
            format: voiceResult.format || 'wav',
            duration_ms: voiceResult.durationMs,
          };

          logger.info('Voice audio generated', {
            event: 'voice_generation_success',
            subsystem: 'openai-compat',
            avatarId,
            audioUrl: voiceResult.url,
            requestId,
          });
        } else {
          logger.info('Voice not configured for avatar, skipping audio generation', {
            subsystem: 'openai-compat',
            avatarId,
            requestId,
          });
        }
      } catch (voiceErr) {
        // Log but don't fail the request - audio is optional
        logger.warn('Voice generation failed, returning text only', {
          subsystem: 'openai-compat',
          avatarId,
          requestId,
          error: voiceErr instanceof Error ? voiceErr.message : String(voiceErr),
        });
      }
    }

    const response: ChatCompletionResponse = {
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: result.response,
          ...(audioData && { audio: audioData }),
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: tokenUsage.promptTokens,
        completion_tokens: tokenUsage.completionTokens,
        total_tokens: tokenUsage.totalTokens,
        usage_source: tokenUsage.usageSource,
      },
    };

    logger.info('Chat completion successful', {
      event: 'chat_completion_success',
      subsystem: 'openai-compat',
      avatarId,
      model: llmModel,
      responseLength: result.response.length,
      totalTokens: tokenUsage.totalTokens,
      usageSource: tokenUsage.usageSource,
      hasAudio: !!audioData,
      requestId,
    });

    return jsonResponse(200, response, corsHeaders);
  } catch (err) {
    logger.error('Chat completion failed', err, {
      subsystem: 'openai-compat',
      avatarId,
      model: llmModel,
      requestId,
    });

    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    // If streaming was requested, return the error in SSE format
    if (request.stream) {
      const completionId = `chatcmpl-${requestId}`;
      const created = Math.floor(Date.now() / 1000);
      return formatStreamingError(completionId, created, model, errorMessage, corsHeaders);
    }

    return errorResponse(500, `Chat completion failed: ${errorMessage}`, 'server_error', undefined, corsHeaders);
  }
}

// =============================================================================
// Streaming Response Helpers
// =============================================================================

interface StreamChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason: string | null;
}

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: StreamChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

/**
 * Format a complete response as OpenAI-compatible SSE stream.
 *
 * Since Lambda + API Gateway buffers the full response anyway, we collect the
 * complete LLM output and emit it as SSE chunks in a single response body.
 * Clients that parse SSE events will see the familiar OpenAI streaming format.
 *
 * Chunk layout:
 * 1. First chunk with role delta
 * 2. Content chunk(s) with the response text
 * 3. Final chunk with finish_reason and usage
 * 4. data: [DONE] sentinel
 */
export function formatStreamingResponse(
  completionId: string,
  created: number,
  model: string,
  content: string,
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number },
  corsHeaders: Record<string, string>,
  options?: {
    toolCalls?: OpenAIToolCall[];
    finishReason?: ChatCompletionChoice['finish_reason'];
  },
): APIGatewayProxyResultV2 {
  let sseBody = '';
  const toolCalls = options?.toolCalls || [];
  const finishReason = options?.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop');

  // First chunk: role announcement
  const roleChunk: ChatCompletionChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: '' },
      finish_reason: null,
    }],
  };
  sseBody += `data: ${JSON.stringify(roleChunk)}\n\n`;

  // Content chunk: emit the full content as a single delta
  // (Lambda buffers the response anyway, so splitting into word-level chunks
  // would add complexity without real streaming benefit)
  if (content) {
    const contentChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: { content },
        finish_reason: null,
      }],
    };
    sseBody += `data: ${JSON.stringify(contentChunk)}\n\n`;
  }

  if (toolCalls.length > 0) {
    const toolCallChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: toolCalls.map((toolCall, index) => ({
            index,
            id: toolCall.id,
            type: toolCall.type,
            function: toolCall.function,
          })),
        },
        finish_reason: null,
      }],
    };
    sseBody += `data: ${JSON.stringify(toolCallChunk)}\n\n`;
  }

  // Final chunk: finish_reason + usage
  const finalChunk: ChatCompletionChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: tokenUsage.promptTokens,
      completion_tokens: tokenUsage.completionTokens,
      total_tokens: tokenUsage.totalTokens,
    },
  };
  sseBody += `data: ${JSON.stringify(finalChunk)}\n\n`;

  // Done sentinel
  sseBody += 'data: [DONE]\n\n';

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    body: sseBody,
  };
}

/**
 * Format an error as an OpenAI-compatible SSE error event.
 * Used when streaming is requested but an error occurs during LLM processing.
 */
export function formatStreamingError(
  completionId: string,
  created: number,
  model: string,
  errorMessage: string,
  corsHeaders: Record<string, string>,
): APIGatewayProxyResultV2 {
  let sseBody = '';

  // Emit an error as a chunk with empty content and a stop reason
  const errorChunk: ChatCompletionChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: { content: `Error: ${errorMessage}` },
      finish_reason: null,
    }],
  };
  sseBody += `data: ${JSON.stringify(errorChunk)}\n\n`;

  const finalChunk: ChatCompletionChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'stop',
    }],
  };
  sseBody += `data: ${JSON.stringify(finalChunk)}\n\n`;
  sseBody += 'data: [DONE]\n\n';

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    body: sseBody,
  };
}

// =============================================================================
// API Key Management (Admin Functions)
// =============================================================================

/**
 * Generate a new API key
 * Returns the full key (only shown once) and the record to store
 * Format: sk-rati-{base64url random bytes}
 */
export function generateApiKey(): { fullKey: string; record: Omit<ApiKeyRecord, 'pk' | 'sk' | 'createdAt' | 'createdBy' | 'usageCount' | 'enabled'> } {
  const randomPart = randomBytes(32).toString('base64url');
  const fullKey = `sk-rati-${randomPart}`;
  const keyHash = hashApiKey(fullKey);
  const keyPrefix = fullKey.slice(0, 12) + '...'; // "sk-rati-xxxx..."

  return {
    fullKey,
    record: {
      keyPrefix,
      keyHash,
      avatarId: '*', // Default to all avatars, can be scoped
      name: 'Unnamed API Key',
    },
  };
}

/**
 * Create and store a new API key
 */
export async function createApiKey(params: {
  avatarId?: string;
  name: string;
  createdBy: string;
  rateLimit?: { requestsPerMinute: number; requestsPerDay: number };
}): Promise<{ fullKey: string; keyPrefix: string }> {
  const { fullKey, record } = generateApiKey();

  const fullRecord: ApiKeyRecord = {
    pk: `API_KEY#${record.keyHash}`,
    sk: 'META',
    ...record,
    avatarId: params.avatarId || '*',
    name: params.name,
    createdAt: Date.now(),
    createdBy: params.createdBy,
    usageCount: 0,
    enabled: true,
    rateLimit: params.rateLimit,
  };

  await docClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: fullRecord.pk,
      sk: fullRecord.sk,
    },
    UpdateExpression: `
      SET keyPrefix = :keyPrefix,
          keyHash = :keyHash,
          avatarId = :avatarId,
          #name = :name,
          createdAt = :createdAt,
          createdBy = :createdBy,
          usageCount = :usageCount,
          enabled = :enabled
          ${params.rateLimit ? ', rateLimit = :rateLimit' : ''}
    `,
    ExpressionAttributeNames: {
      '#name': 'name',
    },
    ExpressionAttributeValues: {
      ':keyPrefix': fullRecord.keyPrefix,
      ':keyHash': fullRecord.keyHash,
      ':avatarId': fullRecord.avatarId,
      ':name': fullRecord.name,
      ':createdAt': fullRecord.createdAt,
      ':createdBy': fullRecord.createdBy,
      ':usageCount': fullRecord.usageCount,
      ':enabled': fullRecord.enabled,
      ...(params.rateLimit ? { ':rateLimit': params.rateLimit } : {}),
    },
  }));

  // Also store a reverse index for listing keys by avatar
  await docClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: params.avatarId ? `AVATAR#${params.avatarId}` : 'GLOBAL',
      sk: `API_KEY#${record.keyHash.slice(0, 16)}`,
    },
    UpdateExpression: 'SET keyPrefix = :keyPrefix, keyHash = :keyHash, #name = :name, createdAt = :createdAt, createdBy = :createdBy',
    ExpressionAttributeNames: {
      '#name': 'name',
    },
    ExpressionAttributeValues: {
      ':keyPrefix': fullRecord.keyPrefix,
      ':keyHash': fullRecord.keyHash,
      ':name': fullRecord.name,
      ':createdAt': fullRecord.createdAt,
      ':createdBy': fullRecord.createdBy,
    },
  }));

  return { fullKey, keyPrefix: record.keyPrefix };
}
