/**
 * Chat LLM Client Module
 * Handles LLM API key management, direct API fallback, retry logic,
 * and OpenRouter client initialization for the admin chat handler.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL,
  logger,
} from '@swarm/core';
import { z } from 'zod';
import {
  executeWithFallback,
  withOpenRouterFallbackRouting,
} from '../services/models-registry.js';

const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
export const LLM_MODEL = process.env.LLM_MODEL || DEFAULT_LLM_MODEL;
export const LLM_MAX_TOKENS = Number.isFinite(Number.parseInt(process.env.LLM_MAX_TOKENS ?? '', 10))
  ? Number.parseInt(process.env.LLM_MAX_TOKENS ?? '', 10)
  : DEFAULT_LLM_MAX_TOKENS;

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProdLike = NODE_ENV === 'production' || NODE_ENV === 'staging';

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampIntMinMax(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// Timeout/retry settings
// IMPORTANT: `/chat` is served behind API Gateway (and sometimes CloudFront), which effectively
// caps end-to-end response time (typically ~29s). Keep defaults within that budget.
export const LLM_TIMEOUT_MS = parseIntEnv('LLM_TIMEOUT_MS', isProdLike ? 27_000 : 60_000);
export const LLM_MAX_RETRIES = parseIntEnv('LLM_MAX_RETRIES', isProdLike ? 0 : 2); // total attempts = 1 + retries
export const LLM_MAX_STEPS = clampIntMinMax(parseIntEnv('LLM_MAX_STEPS', isProdLike ? 4 : 10), 1, 20);
export const LLM_TOOL_MAX_TOKENS = clampIntMinMax(parseIntEnv('LLM_TOOL_MAX_TOKENS', isProdLike ? 1200 : 2048), 256, 8192);
const LLM_RETRY_BASE_DELAY_MS = 250;
const LLM_RETRY_MAX_DELAY_MS = 2_000;

export type LlmUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export function normalizeUsage(raw?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}): LlmUsage | undefined {
  if (!raw) return undefined;
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens;
  const totalTokens = raw.total_tokens ?? (promptTokens && completionTokens
    ? promptTokens + completionTokens
    : undefined);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

export function logLlmMetrics(params: {
  avatarId?: string;
  model: string;
  latencyMs: number;
  usage?: LlmUsage;
  toolCalls: number;
  finishReason?: string;
  mode: 'direct';
  step?: number;
}): void {
  logger.info('LLM call completed', {
    subsystem: 'llm',
    event: 'llm_call_completed',
    avatarId: params.avatarId,
    model: params.model,
    latencyMs: params.latencyMs,
    promptTokens: params.usage?.promptTokens,
    completionTokens: params.usage?.completionTokens,
    totalTokens: params.usage?.totalTokens,
    toolCalls: params.toolCalls,
    finishReason: params.finishReason,
    mode: params.mode,
    step: params.step,
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getRetryDelayMs(attemptNumber: number): number {
  // attemptNumber is 1-based (1 = first retry)
  const exp = Math.min(LLM_RETRY_MAX_DELAY_MS, LLM_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attemptNumber - 1)));
  const jitter = Math.floor(Math.random() * 150);
  return exp + jitter;
}

/**
 * Custom error for 402 Payment Required / insufficient credits from OpenRouter.
 * This is a non-retryable error — retrying won't help until credits are added.
 */
export class LlmCreditsExhaustedError extends Error {
  public readonly statusCode = 402;
  public readonly model?: string;
  public readonly requestedMaxTokens?: number;
  public readonly reducedMaxTokens?: number;
  constructor(message: string, opts?: { model?: string; requestedMaxTokens?: number; reducedMaxTokens?: number }) {
    super(message);
    this.name = 'LlmCreditsExhaustedError';
    this.model = opts?.model;
    this.requestedMaxTokens = opts?.requestedMaxTokens;
    this.reducedMaxTokens = opts?.reducedMaxTokens;
  }
}

/**
 * Fraction to reduce max_tokens by on a 402 adaptive retry.
 * E.g. 0.5 means retry with half the original budget.
 */
export const CREDIT_RETRY_TOKEN_FRACTION = 0.5;
export const CREDIT_RETRY_MIN_TOKENS = 128;

export function isRetryableLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';

  // Abort/timeouts
  if (name === 'AbortError' || message.toLowerCase().includes('timeout')) return true;

  // Network-ish
  const lowered = message.toLowerCase();
  if (
    lowered.includes('fetch failed') ||
    lowered.includes('econnreset') ||
    lowered.includes('enotfound') ||
    lowered.includes('eai_again') ||
    lowered.includes('socket')
  ) {
    return true;
  }

  // Rate limiting / transient upstream
  if (lowered.includes('http 429') || lowered.includes('rate limit')) return true;

  return false;
}

// Cache the API key after first fetch
let cachedApiKey: string | null = null;

export async function getLlmApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  if (!LLM_API_KEY_SECRET_ARN) {
    throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  }

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({
    SecretId: LLM_API_KEY_SECRET_ARN,
  }));

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  // Parse JSON secret (handles {"api_key": "..."} format)
  try {
    const parsed = JSON.parse(response.SecretString);
    cachedApiKey = parsed.api_key || parsed.apiKey || parsed.API_KEY;
    if (!cachedApiKey) {
      logger.error('LLM API key not found in parsed secret', undefined, { keysAvailable: Object.keys(parsed) });
      throw new Error('api_key not found in secret');
    }
  } catch (e) {
    // Plain string secret - check if it looks like an API key
    if (response.SecretString.startsWith('sk-')) {
      cachedApiKey = response.SecretString;
    } else {
      logger.error('Failed to parse LLM secret', e);
      throw new Error('Invalid LLM API key format');
    }
  }

  logger.info('LLM API key loaded', { keyPrefix: cachedApiKey.substring(0, 10) });
  return cachedApiKey!;
}

type FallbackTool = {
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
    inputSchema?: unknown;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Keys that must be stripped from tool schemas for JSON Schema 2020-12 compliance.
// - $schema: explicit draft declaration rejected by providers
// - nullable: OpenAPI 3.x extension, not valid JSON Schema
// - default: many providers reject default values in tool input schemas
// - definitions/$defs: only valid at root; we inline $ref targets instead
const STRIP_KEYS = new Set(['$schema', 'nullable', 'default', 'definitions', '$defs']);

/**
 * Valid JSON Schema 2020-12 type values.
 */
const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/**
 * Resolve a JSON Pointer reference (e.g. "#/properties/a" or "#/$defs/Foo")
 * within a root schema object.
 */
function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Sanitize a tool schema for JSON Schema 2020-12 compliance.
 *
 * Handles:
 * - Stripping $schema, nullable, default, definitions/$defs
 * - Converting nullable to anyOf [..., {type: "null"}]
 * - Converting type arrays (draft-07) to anyOf (2020-12)
 * - Resolving $ref pointers by inlining the referenced sub-schema
 * - Validating type values
 */
function sanitizeToolSchema(schema: unknown, root?: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) {
    return schema.map(item => sanitizeToolSchema(item, root));
  }
  if (!isRecord(schema)) {
    return schema;
  }

  // Establish root for $ref resolution on first call
  const effectiveRoot = root ?? (isRecord(schema) ? schema : undefined);

  // Resolve $ref before any other processing
  if (typeof schema.$ref === 'string' && effectiveRoot) {
    const resolved = resolveRef(effectiveRoot, schema.$ref);
    if (isRecord(resolved)) {
      return sanitizeToolSchema(resolved, effectiveRoot);
    }
    // Unresolvable ref - fall back to permissive object
    return { type: 'object' };
  }

  const nullable = schema.nullable === true;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    // Strip keys that are not valid / cause provider rejections
    if (STRIP_KEYS.has(key)) {
      continue;
    }
    // Skip $ref (already handled above for resolvable refs)
    if (key === '$ref') {
      continue;
    }
    sanitized[key] = sanitizeToolSchema(value, effectiveRoot);
  }

  // Convert type arrays (JSON Schema draft-07 shorthand) to anyOf (2020-12).
  // e.g. { type: ["string", "null"] } -> { anyOf: [{ type: "string" }, { type: "null" }] }
  if (Array.isArray(sanitized.type)) {
    const types = (sanitized.type as unknown[]).filter(
      t => typeof t === 'string' && VALID_TYPES.has(t)
    ) as string[];
    if (types.length > 0) {
      // Pull out properties that belong to the individual type schemas
      const { type: _type, ...rest } = sanitized;
      if (types.length === 1) {
        return { ...rest, type: types[0] };
      }
      return {
        ...rest,
        anyOf: types.map(t => ({ type: t })),
      };
    }
  }

  // Validate single type value
  if (typeof sanitized.type === 'string' && !VALID_TYPES.has(sanitized.type)) {
    // Invalid type - remove it rather than sending a bad value
    delete sanitized.type;
  }

  // Convert OpenAPI nullable to JSON Schema 2020-12 anyOf pattern
  if (nullable) {
    return {
      anyOf: [
        sanitized,
        { type: 'null' },
      ],
    };
  }

  return sanitized;
}

/**
 * Validate a resolved tool schema and log diagnostics for problems.
 * Returns true if the schema looks valid enough to send.
 */
function validateToolSchema(schema: Record<string, unknown>, toolName: string): boolean {
  // Must have a type field at root level
  if (!schema.type && !schema.anyOf && !schema.oneOf && !schema.allOf) {
    logger.warn('Tool schema missing type/composition keyword', {
      event: 'tool_schema_invalid',
      subsystem: 'llm',
      toolName,
      issue: 'missing_type',
    });
    return false;
  }

  // Check for leftover $ref that was not resolved
  const json = JSON.stringify(schema);
  if (json.includes('"$ref"')) {
    logger.warn('Tool schema contains unresolved $ref', {
      event: 'tool_schema_invalid',
      subsystem: 'llm',
      toolName,
      issue: 'unresolved_ref',
    });
    return false;
  }

  // Check for leftover $schema
  if (json.includes('"$schema"')) {
    logger.warn('Tool schema contains $schema declaration', {
      event: 'tool_schema_invalid',
      subsystem: 'llm',
      toolName,
      issue: 'leftover_schema_decl',
    });
    return false;
  }

  return true;
}

function resolveFallbackToolParameters(tool: FallbackTool, toolIndex?: number): Record<string, unknown> {
  const toolName = tool.function?.name ?? `tool[${toolIndex ?? '?'}]`;

  const explicit = tool.function?.parameters;
  if (isRecord(explicit)) {
    const sanitized = sanitizeToolSchema(explicit);
    if (isRecord(sanitized)) {
      validateToolSchema(sanitized, toolName);
      return sanitized;
    }
  }

  const inputSchema = tool.function?.inputSchema;
  if (!inputSchema) {
    return { type: 'object' };
  }

  let rawSchema: unknown;
  try {
    const { $schema: _, ...rest } = z.toJSONSchema(inputSchema as any) as Record<string, unknown>;
    rawSchema = rest;
  } catch (err) {
    logger.warn('zodToJsonSchema conversion failed for tool, falling back to plain schema', {
      event: 'tool_schema_conversion_error',
      subsystem: 'llm',
      toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    // Some tools may already provide plain JSON Schema instead of Zod.
    if (isRecord(inputSchema)) {
      rawSchema = inputSchema;
    } else {
      return { type: 'object' };
    }
  }

  const sanitized = sanitizeToolSchema(rawSchema);
  if (isRecord(sanitized)) {
    validateToolSchema(sanitized, toolName);
    return sanitized;
  }

  return { type: 'object' };
}

// Export for testing
export { sanitizeToolSchema as _sanitizeToolSchema, validateToolSchema as _validateToolSchema };

/**
 * Fallback direct API call when SDK streaming validation fails
 * Uses non-streaming API to avoid SDK's Zod validation issues with null usage fields
 */
export async function callLlmDirectFallback(
  model: string,
  messages: Array<{ role: string; content: string | { type: string; text?: string; image_url?: unknown }[]; toolCallId?: string; tool_call_id?: string; name?: string; tool_calls?: unknown[] }>,
  maxTokens: number,
  tools?: unknown[]
): Promise<{
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: LlmUsage;
  latencyMs: number;
  model: string;
  attemptedModels: string[];
  usedFallback: boolean;
}> {
  const apiKey = await getLlmApiKey();
  const start = Date.now();

  // Normalize messages to OpenAI Chat Completions format:
  // - Tool messages need `tool_call_id` (snake_case), not `toolCallId` (camelCase)
  // - Assistant messages with tool_calls need them preserved
  const normalizedMessages = messages.map(msg => {
    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id || msg.toolCallId;
      if (!toolCallId || toolCallId.trim() === '') {
        // Convert orphaned tool message to user message to avoid provider 400
        return { role: 'user', content: '[system: tool result omitted — missing tool_call_id]' };
      }
      return {
        role: 'tool' as const,
        content: msg.content,
        tool_call_id: toolCallId,
      };
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      return { role: msg.role, content: msg.content, tool_calls: msg.tool_calls };
    }
    return { role: msg.role, content: msg.content };
  });

  const baseBody: Record<string, unknown> = {
    messages: normalizedMessages,
    max_tokens: maxTokens,
    stream: false, // Disable streaming to avoid SDK validation issues
  };

  if (tools && tools.length > 0) {
    // Convert SDK tools to OpenAI format with sanitized schemas
    baseBody.tools = tools.map((t: unknown, index: number) => {
      const tool = t as FallbackTool;
      const toolName = tool.function?.name ?? `tool[${index}]`;
      const parameters = resolveFallbackToolParameters(tool, index);

      logger.info('Resolved tool schema for fallback dispatch', {
        event: 'tool_schema_resolved',
        subsystem: 'llm',
        toolName,
        toolIndex: index,
        hasType: 'type' in parameters,
        topLevelKeys: Object.keys(parameters),
      });

      return {
        type: 'function',
        function: {
          name: tool.function?.name,
          description: tool.function?.description,
          parameters,
        },
      };
    });
  }

  const fetchCompletion = async (candidateModel: string): Promise<Response> => {
    const body = withOpenRouterFallbackRouting(baseBody, candidateModel, {
      requireParameters: !!tools && tools.length > 0,
    });
    let response: Response | null = null;
    let lastError: unknown;
    let creditRetried = false;

    for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
      try {
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://swarm.admin',
            'X-Title': 'Swarm Admin',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        });

        if (response.ok) {
          return response;
        }

        // 402 = insufficient credits — attempt one adaptive retry with reduced max_tokens
        if (response.status === 402) {
          const errorText = await response.text();
          const reducedTokens = Math.max(
            CREDIT_RETRY_MIN_TOKENS,
            Math.floor(maxTokens * CREDIT_RETRY_TOKEN_FRACTION)
          );
          const canRetryWithLess = reducedTokens < maxTokens && !creditRetried;

          logger.error('OpenRouter credits exhausted (402)', undefined, {
            event: 'provider_credit_exhausted',
            subsystem: 'llm',
            statusCode: 402,
            model: candidateModel,
            requestedMaxTokens: maxTokens,
            reducedMaxTokens: canRetryWithLess ? reducedTokens : undefined,
            willRetry: canRetryWithLess,
            responseBody: errorText.slice(0, 500),
          });

          if (canRetryWithLess) {
            // Retry once with a reduced token budget (separate from normal retry loop)
            creditRetried = true;
            logger.info('Retrying with reduced max_tokens after 402', {
              event: 'provider_credit_retry',
              subsystem: 'llm',
              model: candidateModel,
              originalMaxTokens: maxTokens,
              reducedMaxTokens: reducedTokens,
            });

            const retryBody = { ...body, max_tokens: reducedTokens };
            const retryResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://swarm.admin',
                'X-Title': 'Swarm Admin',
              },
              body: JSON.stringify(retryBody),
              signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
            });

            if (retryResponse.ok) {
              return retryResponse;
            }

            // Still 402 or other error — fall through to throw
            const retryErrorText = retryResponse.status === 402
              ? await retryResponse.text()
              : errorText;
            logger.error('Adaptive retry still failed (402)', undefined, {
              event: 'provider_credit_exhausted',
              subsystem: 'llm',
              statusCode: retryResponse.status,
              model: candidateModel,
              requestedMaxTokens: maxTokens,
              reducedMaxTokens: reducedTokens,
              responseBody: retryErrorText.slice(0, 500),
            });
          }

          throw new LlmCreditsExhaustedError(
            `OpenRouter API error: 402 ${errorText}`,
            { model: candidateModel, requestedMaxTokens: maxTokens, reducedMaxTokens: creditRetried ? reducedTokens : undefined }
          );
        }

        const shouldRetry = response.status === 429 || response.status >= 500;
        if (!shouldRetry || attempt >= LLM_MAX_RETRIES) {
          const errorText = await response.text();
          logger.error(`OpenRouter API non-retryable error: ${response.status}`, undefined, {
            event: 'provider_api_error',
            subsystem: 'llm',
            statusCode: response.status,
            model: candidateModel,
            responseBody: errorText.slice(0, 1000),
            messageCount: normalizedMessages.length,
            toolMessageCount: normalizedMessages.filter(m => m.role === 'tool').length,
            hasTools: !!tools && tools.length > 0,
          });
          throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
        }

        lastError = new Error(`OpenRouter API retryable error: HTTP ${response.status}`);
      } catch (err) {
        lastError = err;
        if (!isRetryableLlmError(err) || attempt >= LLM_MAX_RETRIES) {
          throw err;
        }
      }

      await sleep(getRetryDelayMs(attempt + 1));
    }

    if (!response || !response.ok) {
      throw (lastError instanceof Error ? lastError : new Error('OpenRouter API request failed'));
    }

    return response;
  };

  const fallbackResult = await executeWithFallback(fetchCompletion, {
    primaryModel: model,
    avatarId: 'admin-chat',
  });
  const response = fallbackResult.result;

  const data = await response.json() as {
    model?: string;
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
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

  const choice = data.choices?.[0]?.message;
  const content = choice?.content || '';
  const toolCalls = (choice?.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
  }));

  const selectedModel = data.model || fallbackResult.model;
  return {
    content,
    toolCalls,
    usage: normalizeUsage(data.usage),
    latencyMs: Date.now() - start,
    model: selectedModel,
    attemptedModels: fallbackResult.attemptedModels,
    usedFallback: fallbackResult.usedFallback || selectedModel !== model,
  };
}
