/**
 * LLM Client Module
 * Handles all LLM API calls, XML tool call parsing, image handling,
 * and message formatting for the message processor.
 */
import { randomUUID } from 'crypto';
import {
  createCircuitBreaker,
  isUsableOpenRouterModelId,
  logger,
  LLMError,
  SwarmErrorCode,
  type LLMConfig,
} from '@swarm/core';

// LLM Configuration
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
// NOTE: The message processor Lambda timeout is set in infra; keep this below that value.
// Default increased to better handle slow OpenRouter responses in multi-agent channels.
const LLM_TIMEOUT_MS = Number.parseInt(process.env.LLM_TIMEOUT_MS || '', 10) || 90_000;
const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models?output_modalities=text';
const OPENROUTER_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// Circuit breaker for LLM calls — trips after 3 consecutive failures,
// half-opens after 30s. Prevents burning Lambda concurrency on a down provider.
const llmCircuitBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });

interface OpenRouterCatalogModel {
  id?: string;
  name?: string;
  context_length?: number;
  architecture?: {
    output_modalities?: string[];
  };
  supported_parameters?: string[];
}

interface OpenRouterChatModel {
  id: string;
  contextLength: number;
  supportedParameters: string[];
}

let openRouterModelCache: { expiresAt: number; models: OpenRouterChatModel[] } | null = null;

function isTextModel(model: OpenRouterCatalogModel): boolean {
  const modalities = model.architecture?.output_modalities || [];
  return modalities.length === 0 || modalities.some((modality) => modality.toLowerCase() === 'text');
}

function supportsTools(model: OpenRouterChatModel): boolean {
  return model.supportedParameters.includes('tools') ||
    model.supportedParameters.includes('tool_choice');
}

function scoreModel(model: OpenRouterChatModel, requireTools: boolean): number {
  let score = Math.min(model.contextLength, 1_000_000) / 1_000;
  if (supportsTools(model)) score += 1_000;
  if (requireTools && !supportsTools(model)) score -= 10_000;
  if (model.id.toLowerCase().includes('free')) score -= 500;
  return score;
}

async function listOpenRouterChatModels(apiKey: string): Promise<OpenRouterChatModel[]> {
  const now = Date.now();
  if (openRouterModelCache && openRouterModelCache.expiresAt > now) return openRouterModelCache.models;

  const response = await fetch(OPENROUTER_MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog unavailable: HTTP ${response.status}`);
  }

  const data = await response.json() as { data?: OpenRouterCatalogModel[] };
  const models = (data.data || [])
    .filter((model): model is OpenRouterCatalogModel & { id: string } =>
      isUsableOpenRouterModelId(model.id) && isTextModel(model)
    )
    .map((model) => ({
      id: model.id,
      contextLength: model.context_length || 0,
      supportedParameters: model.supported_parameters || [],
    }));

  if (models.length === 0) {
    throw new Error('OpenRouter model catalog returned no chat-capable models');
  }

  openRouterModelCache = { expiresAt: now + OPENROUTER_MODEL_CACHE_TTL_MS, models };
  return models;
}

async function resolveLiveOpenRouterModel(
  configuredModel: string,
  apiKey: string,
  requireTools: boolean,
): Promise<{ primaryModel: string; fallbackModels: string[] }> {
  const models = await listOpenRouterChatModels(apiKey);
  const ranked = [...models]
    .filter((model) => !requireTools || supportsTools(model))
    .sort((a, b) => {
      const scoreDelta = scoreModel(b, requireTools) - scoreModel(a, requireTools);
      if (scoreDelta !== 0) return scoreDelta;
      return a.id.localeCompare(b.id);
    });

  const configured = configuredModel.trim();
  const configuredModelEntry = configured
    ? models.find((model) => model.id === configured && (!requireTools || supportsTools(model)))
    : undefined;
  const primaryModel = configuredModelEntry?.id || ranked[0]?.id;
  if (!primaryModel) {
    throw new Error('OpenRouter model catalog has no model matching the request requirements');
  }

  return {
    primaryModel,
    fallbackModels: ranked
      .map((model) => model.id)
      .filter((id) => id !== primaryModel)
      .slice(0, 2),
  };
}

/**
 * LLM Message format
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Parse XML-style function calls that some models output in their text content
 * instead of using proper tool_calls format.
 *
 * Handles formats like:
 * 1. Full invoke format:
 *    <function_calls>
 *      <invoke name="send_message">
 *        <parameter name="text">Hello!</parameter>
 *      </invoke>
 *    </function_calls>
 *
 * 2. Direct tool tag format:
 *    <send_message>Hello!</send_message>
 *
 * Returns extracted tool calls and cleaned content (with XML removed).
 */
export function parseXmlToolCalls(content: string): {
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  cleanedContent: string;
} {
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  let cleanedContent = content;

  // Known tool names that might appear as direct XML tags
  const knownTools = ['send_message', 'react', 'ignore', 'wait', 'generate_image', 'remember', 'recall', 'take_selfie'];

  // Pattern 1: Match <function_calls>...</function_calls> wrapper format
  const functionCallsPattern = /<(?:antml:)?function_calls>([\s\S]*?)<\/(?:antml:)?function_calls>/gi;
  let match: RegExpExecArray | null;

  while ((match = functionCallsPattern.exec(content)) !== null) {
    const block = match[1];

    // Extract <invoke> blocks
    const invokePattern = /<(?:antml:)?invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/(?:antml:)?invoke>/gi;
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokePattern.exec(block)) !== null) {
      const toolName = invokeMatch[1];
      const paramsBlock = invokeMatch[2];
      const args: Record<string, unknown> = {};

      // Extract <parameter> values
      const paramPattern = /<(?:antml:)?parameter\s+name=["']([^"']+)["']>([^<]*)<\/(?:antml:)?parameter>/gi;
      let paramMatch: RegExpExecArray | null;

      while ((paramMatch = paramPattern.exec(paramsBlock)) !== null) {
        const paramName = paramMatch[1];
        const paramValue = paramMatch[2].trim();

        try {
          args[paramName] = JSON.parse(paramValue);
        } catch {
          args[paramName] = paramValue;
        }
      }

      toolCalls.push({
        id: `xml_${randomUUID().slice(0, 8)}`,
        name: toolName,
        arguments: args,
      });

      logger.info('Parsed XML tool call from content (invoke format)', {
        toolName,
        args,
      });
    }

    // Remove the matched XML block from content
    cleanedContent = cleanedContent.replace(match[0], '').trim();
  }

  // Pattern 2: Match direct tool tags like <send_message>...</send_message>
  for (const toolName of knownTools) {
    const directPattern = new RegExp(`<${toolName}>([\\s\\S]*?)<\\/${toolName}>`, 'gi');
    let directMatch: RegExpExecArray | null;

    while ((directMatch = directPattern.exec(cleanedContent)) !== null) {
      const textContent = directMatch[1].trim();

      // For send_message, the content is the text parameter
      const args: Record<string, unknown> = toolName === 'send_message'
        ? { text: textContent }
        : toolName === 'react'
          ? { emoji: textContent }
          : { value: textContent };

      toolCalls.push({
        id: `xml_${randomUUID().slice(0, 8)}`,
        name: toolName,
        arguments: args,
      });

      logger.info('Parsed XML tool call from content (direct tag format)', {
        toolName,
        args,
      });

      // Remove the matched tag from content
      cleanedContent = cleanedContent.replace(directMatch[0], '').trim();
    }
  }

  return { toolCalls, cleanedContent };
}

/**
 * Strip avatar name prefix from response if the model accidentally included it.
 * Models sometimes see `[Username]: message` in history and mimic the pattern.
 * This removes prefixes like `[Rati]:`, `[Chamuel 😇]:`, `Rati:`, etc.
 */
export function stripAvatarNamePrefix(content: string, avatarName: string): string {
  if (!content || !avatarName) return content;

  // Try various prefix patterns the model might use
  const patterns = [
    // [Name]: format (with optional emoji/special chars)
    new RegExp(`^\\[${escapeRegex(avatarName)}[^\\]]*\\]:\\s*`, 'i'),
    // Name: format at start of message
    new RegExp(`^${escapeRegex(avatarName)}:\\s*`, 'i'),
  ];

  for (const pattern of patterns) {
    if (pattern.test(content)) {
      return content.replace(pattern, '').trim();
    }
  }

  return content;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function messagesHaveImageContent(messages: LLMMessage[]): boolean {
  return messages.some(m =>
    Array.isArray(m.content) &&
    m.content.some(part => (part as { type?: string }).type === 'image_url')
  );
}

export function toTextOnlyMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content;
    const textParts: string[] = [];
    const imageUrls: string[] = [];
    for (const part of parts) {
      if (part.type === 'text') {
        if (part.text?.trim()) textParts.push(part.text.trim());
      } else if (part.type === 'image_url') {
        if (part.image_url?.url) imageUrls.push(part.image_url.url);
      }
    }

    const combined = [
      ...textParts,
      ...(imageUrls.length > 0 ? [`[images: ${imageUrls.join(', ')}]`] : []),
    ].join('\n');

    return { ...m, content: combined };
  });
}

/**
 * Call the LLM API with tools
 */
export async function callLLM(
  messages: LLMMessage[],
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  config: LLMConfig,
  secrets: Record<string, string>
): Promise<{
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}> {
  const apiKey = secrets['OPENROUTER_API_KEY'] || secrets['openrouter_api_key'];
  if (!apiKey) {
    throw new LLMError('OPENROUTER_API_KEY not found in secrets', {
      code: SwarmErrorCode.LLM_MISSING_API_KEY,
    });
  }

  // Circuit breaker — fail fast when LLM provider is unhealthy
  if (!llmCircuitBreaker.canExecute()) {
    logger.warn('LLM circuit breaker is open, failing fast', {
      event: 'circuit_breaker_open',
      subsystem: 'llm',
      state: llmCircuitBreaker.state(),
      model: config.model,
    });
    throw new LLMError('LLM circuit breaker is open — provider unhealthy', {
      code: SwarmErrorCode.LLM_CIRCUIT_OPEN,
      model: config.model,
    });
  }

  const modelPlan = await resolveLiveOpenRouterModel(config.model || '', apiKey, tools.length > 0);

  const requestBody: Record<string, unknown> = {
    model: modelPlan.primaryModel,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    ...(modelPlan.fallbackModels.length > 0 ? { models: [modelPlan.primaryModel, ...modelPlan.fallbackModels], route: 'fallback' } : {}),
    provider: {
      allow_fallbacks: true,
      ...(tools.length > 0 ? { require_parameters: true } : {}),
    },
  };

  if (tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
  }

  const timeoutMs = config.timeoutMs ?? LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const doRequest = async (body: Record<string, unknown>) => fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://swarm.platform',
        'X-Title': 'Swarm Platform',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let response = await doRequest(requestBody);

    if (!response.ok) {
      const text = await response.text();
      const hasImages = messagesHaveImageContent(messages);
      const looksLikeUnsupportedImage = /image|images|multimodal|modalit|vision/i.test(text);

      if (hasImages && looksLikeUnsupportedImage) {
        logger.warn('LLM rejected image input; retrying text-only', {
          status: response.status,
          model: config.model,
          errorPreview: text.slice(0, 200),
        });
        const fallbackBody = {
          ...requestBody,
          messages: toTextOnlyMessages(messages),
        };
        response = await doRequest(fallbackBody);
        if (!response.ok) {
          const retryText = await response.text();
          throw new LLMError(`LLM API error: ${response.status} ${retryText.slice(0, 200)}`, {
            code: SwarmErrorCode.LLM_API_ERROR,
            model: config.model,
            statusCode: response.status,
            retryable: response.status >= 500 || response.status === 429,
          });
        }
      } else {
        throw new LLMError(`LLM API error: ${response.status} ${text.slice(0, 200)}`, {
          code: SwarmErrorCode.LLM_API_ERROR,
          model: config.model,
          statusCode: response.status,
          retryable: response.status >= 500 || response.status === 429,
        });
      }
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices?.[0]?.message;
    if (!choice) {
      throw new LLMError('No response from LLM', {
        code: SwarmErrorCode.LLM_EMPTY_RESPONSE,
        model: config.model,
        retryable: true,
      });
    }

    // Parse proper tool_calls from the API response
    const apiToolCalls = choice.tool_calls?.map(tc => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        logger.warn('Failed to parse tool call arguments', {
          toolName: tc.function.name,
          arguments: tc.function.arguments?.slice(0, 100),
        });
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      };
    }) || [];

    // Also check for XML-style tool calls in content (some models output these in text)
    let finalContent = choice.content || undefined;
    let xmlToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    if (finalContent && (finalContent.includes('<function_calls>') || finalContent.includes('<invoke'))) {
      const parsed = parseXmlToolCalls(finalContent);
      xmlToolCalls = parsed.toolCalls;
      finalContent = parsed.cleanedContent || undefined;

      if (xmlToolCalls.length > 0) {
        logger.info('Extracted XML tool calls from content', {
          count: xmlToolCalls.length,
          tools: xmlToolCalls.map(t => t.name),
        });
      }
    }

    // Combine API tool calls with any XML-parsed tool calls
    const allToolCalls = [...apiToolCalls, ...xmlToolCalls];

    llmCircuitBreaker.recordSuccess();

    return {
      content: finalContent,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
    };
  } catch (error) {
    llmCircuitBreaker.recordFailure();
    if (llmCircuitBreaker.state() === 'open') {
      logger.error('LLM circuit breaker tripped to OPEN after consecutive failures', {
        event: 'circuit_breaker_tripped',
        subsystem: 'llm',
        model: config.model,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
