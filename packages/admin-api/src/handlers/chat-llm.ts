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
import { OpenRouter } from '@openrouter/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';

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
  mode: 'sdk' | 'fallback';
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

let cachedOpenRouter: OpenRouter | null = null;

export function getOpenRouterClient(): OpenRouter {
  if (!cachedOpenRouter) {
    cachedOpenRouter = new OpenRouter({
      apiKey: getLlmApiKey,
      httpReferer: 'https://swarm.admin',
      xTitle: 'Swarm Admin',
      timeoutMs: LLM_TIMEOUT_MS,
    });
  }
  return cachedOpenRouter;
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

function sanitizeToolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeToolSchema);
  }
  if (!isRecord(schema)) {
    return schema;
  }

  const nullable = schema.nullable === true;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    // Provider validates against JSON Schema draft 2020-12; OpenAPI extension
    // fields (e.g. nullable) and explicit $schema declarations can be rejected.
    if (key === 'nullable' || key === '$schema') {
      continue;
    }
    sanitized[key] = sanitizeToolSchema(value);
  }

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

function resolveFallbackToolParameters(tool: FallbackTool): Record<string, unknown> {
  const explicit = tool.function?.parameters;
  if (isRecord(explicit)) {
    const sanitized = sanitizeToolSchema(explicit);
    if (isRecord(sanitized)) {
      return sanitized;
    }
  }

  const inputSchema = tool.function?.inputSchema;
  if (!inputSchema) {
    return { type: 'object', additionalProperties: true };
  }

  let rawSchema: unknown;
  try {
    rawSchema = zodToJsonSchema(inputSchema as Parameters<typeof zodToJsonSchema>[0], { target: 'jsonSchema7' });
  } catch {
    // Some tools may already provide plain JSON Schema instead of Zod.
    if (isRecord(inputSchema)) {
      rawSchema = inputSchema;
    } else {
      return { type: 'object', additionalProperties: true };
    }
  }

  const sanitized = sanitizeToolSchema(rawSchema);
  return isRecord(sanitized)
    ? sanitized
    : { type: 'object', additionalProperties: true };
}

/**
 * Fallback direct API call when SDK streaming validation fails
 * Uses non-streaming API to avoid SDK's Zod validation issues with null usage fields
 */
export async function callLlmDirectFallback(
  model: string,
  messages: Array<{ role: string; content: string | { type: string; text?: string; image_url?: unknown }[] }>,
  maxTokens: number,
  tools?: unknown[]
): Promise<{
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: LlmUsage;
  latencyMs: number;
}> {
  const apiKey = await getLlmApiKey();
  const start = Date.now();

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: false, // Disable streaming to avoid SDK validation issues
  };

  if (tools && tools.length > 0) {
    // Convert SDK tools to OpenAI format
    body.tools = tools.map((t: unknown) => {
      const tool = t as FallbackTool;
      return {
        type: 'function',
        function: {
          name: tool.function?.name,
          description: tool.function?.description,
          parameters: resolveFallbackToolParameters(tool),
        },
      };
    });
  }

  let response: Response | null = null;
  let lastError: unknown;

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
        break;
      }

      const shouldRetry = response.status === 429 || response.status >= 500;
      if (!shouldRetry || attempt >= LLM_MAX_RETRIES) {
        const errorText = await response.text();
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

  const data = await response.json() as {
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

  return { content, toolCalls, usage: normalizeUsage(data.usage), latencyMs: Date.now() - start };
}
