/**
 * Chat Tool Helpers Module
 * Handles tool building, execution, media extraction, pending tool UI responses,
 * and message sanitization for the admin chat handler.
 */
import {
  logger,
  extractThinking,
  resolveAllowedToolsets,
  type ToolCategory,
} from '@swarm/core';
import {
  ToolRegistry,
  type ToolContext,
  type ToolResult as McpToolResult,
  type AllServices,
} from '@swarm/mcp-server';
import { z } from 'zod';
import type {
  AdminChatMessage,
  ToolCall,
  ToolResult,
} from '../types.js';
import { isProbablyPrivateMediaUrl, redactMediaUrlsFromText } from '../utils/redact-media-urls.js';
import { _sanitizeToolSchema } from './chat-llm.js';
import * as avatars from '../services/avatars.js';

/**
 * Local Tool type — replaces @openrouter/sdk's Tool type.
 * Matches the shape we build in buildOpenRouterTools().
 */
export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    inputSchema?: unknown;
    execute?: (params: Record<string, unknown>) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

/**
 * Check if a tool has an executable function — replaces @openrouter/sdk's hasExecuteFunction.
 */
export function hasExecuteFunction(tool: Tool): tool is Tool & { function: { execute: (params: Record<string, unknown>) => Promise<unknown> } } {
  return typeof tool.function.execute === 'function';
}

/**
 * Sanitize conversation history to ensure valid message format
 * Removes orphaned tool results and ensures proper message structure
 */
export function sanitizeMessages(messages: AdminChatMessage[]): AdminChatMessage[] {
  // -------------------------------------------------------------------------
  // Phase 1: Enforce adjacency — tool messages must immediately follow their
  // matching assistant message. Anthropic rejects tool_result blocks that
  // don't have a tool_use in the *previous* message. Reorder or strip to fix.
  // -------------------------------------------------------------------------
  const reordered: AdminChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Collect the IDs this assistant expects results for
      const expectedIds = new Set(msg.tool_calls.map(tc => tc.id).filter(Boolean));

      // Gather matching tool results — they may be immediately after, or
      // separated by intervening messages (e.g. error messages added to history).
      const toolResults: AdminChatMessage[] = [];
      const deferred: AdminChatMessage[] = [];
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j];
        if (candidate.role === 'tool') {
          const tcId = (candidate as ToolResult).tool_call_id;
          if (tcId && expectedIds.has(tcId)) {
            toolResults.push(candidate);
            expectedIds.delete(tcId);
            continue;
          }
        }
        // Stop scanning when we hit another assistant message (new turn)
        if (candidate.role === 'assistant') break;
        deferred.push(candidate);
      }

      if (toolResults.length > 0) {
        // Keep only the tool_calls that have results
        const resultIds = new Set(toolResults.map(tr => (tr as ToolResult).tool_call_id));
        const matchedCalls = msg.tool_calls.filter(tc => tc.id && resultIds.has(tc.id));
        const assistantMsg = matchedCalls.length < msg.tool_calls.length
          ? { ...msg, tool_calls: matchedCalls.length > 0 ? matchedCalls : undefined }
          : msg;

        reordered.push(assistantMsg);
        // Tool results immediately after assistant (adjacency enforced)
        reordered.push(...toolResults);
        // Then any non-tool messages that were between them
        reordered.push(...deferred);
        i += 1 + toolResults.length + deferred.length;
      } else {
        // No tool results found — strip tool_calls from this assistant message
        reordered.push({ ...msg, tool_calls: undefined });
        i++;
      }
      continue;
    }

    reordered.push(msg);
    i++;
  }

  // -------------------------------------------------------------------------
  // Phase 2: Clean up — remove orphaned tool results and empty assistants,
  // strip thinking tags, normalize empty content.
  // -------------------------------------------------------------------------
  const toolCallIds = new Set<string>();
  for (const msg of reordered) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) toolCallIds.add(tc.id);
      }
    }
  }

  const sanitized: AdminChatMessage[] = [];
  for (const msg of reordered) {
    if (msg.role === 'tool') {
      const toolCallId = (msg as ToolResult).tool_call_id;
      if (!toolCallId || toolCallId.trim() === '' || !toolCallIds.has(toolCallId)) {
        logger.info('Skipping orphaned tool result', { toolCallId });
        continue;
      }
    }

    if (msg.role === 'assistant') {
      const rawContent = msg.content;
      const isEmpty = rawContent === null || rawContent === undefined || rawContent === '';

      if (isEmpty && msg.tool_calls && msg.tool_calls.length > 0) {
        sanitized.push({ ...msg, content: null as unknown as string });
        continue;
      }

      if (isEmpty && !msg.tool_calls) {
        // No content and no tool_calls — skip entirely
        continue;
      }

      if (typeof rawContent === 'string') {
        const { cleanContent } = extractThinking(rawContent);
        if (cleanContent !== rawContent) {
          sanitized.push({ ...msg, content: cleanContent });
          continue;
        }
      }
    }

    sanitized.push(msg);
  }

  return sanitized;
}

export function sanitizeToolError(value: unknown): string {
  if (typeof value !== 'string') {
    return value instanceof Error ? value.message : 'Tool failed';
  }

  const raw = value.trim();
  if (!raw) return 'Tool failed';

  // Try to extract a readable message from JSON error bodies (common for provider APIs).
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const detail = typeof obj.detail === 'string' ? obj.detail : undefined;
        const title = typeof obj.title === 'string' ? obj.title : undefined;
        const error = typeof obj.error === 'string' ? obj.error : undefined;
        const message = typeof obj.message === 'string' ? obj.message : undefined;
        const candidate = detail || error || message || title;
        if (candidate && candidate.trim()) return candidate.trim();
      }
    } catch {
      // fall through
    }
  }

  // Strip AWS ARNs (arn:aws:...) to prevent infrastructure detail leakage.
  // Handles both standard ARNs (with 12-digit account ID) and S3-style ARNs (empty account/region).
  let sanitized = raw.replace(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:[^\s,)]+/gi, '[internal-resource]');

  // If it's an AWS authorization error, replace entirely with a generic message
  if (/is not authorized to perform:/i.test(sanitized) || /AccessDeniedException/i.test(sanitized)) {
    return 'A permissions error occurred. The team has been notified.';
  }

  // Strip standalone AWS account IDs (12-digit numbers preceded by common AWS context markers)
  sanitized = sanitized.replace(/(?<=account\s|Account\s|account:|Account:)\s*\d{12}\b/g, ' [account]');

  // Avoid dumping long JSON/stack traces into user-visible chat.
  if (sanitized.length > 300) return `${sanitized.slice(0, 300)}…`;
  return sanitized;
}

export function stringifyToolResultForModel(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return JSON.stringify({ data: result });

  const obj = { ...(result as Record<string, unknown>) };
  if (typeof obj.error === 'string') obj.error = sanitizeToolError(obj.error);
  if (typeof obj.message === 'string') obj.message = sanitizeToolError(obj.message);
  return JSON.stringify(obj);
}

export function normalizeToolResult(result: McpToolResult, toolName: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    success: result.success,
  };

  if (result.error) {
    payload.error = sanitizeToolError(result.error);
  }

  if (result.data !== undefined) {
    if (typeof result.data === 'object' && result.data !== null) {
      Object.assign(payload, result.data as Record<string, unknown>);
      payload.data = result.data;
    } else {
      payload.data = result.data;
    }
  }

  if (result.media?.url && payload.url === undefined) {
    payload.url = result.media.url;
    payload.type = payload.type ?? result.media.type;
  }

  if (result.pendingJob) {
    payload._pendingJob = result.pendingJob;
    payload.jobId = payload.jobId ?? result.pendingJob.jobId;
    payload.status = payload.status ?? result.pendingJob.status ?? 'pending';
  }

  if (result.uiAction?.payload && payload.type === undefined && result.uiAction.type === 'upload_widget') {
    payload.type = 'upload_url';
  }

  if (!result.success && !payload.message) {
    payload.message = `Tool ${toolName} failed${result.error ? `: ${sanitizeToolError(result.error)}` : ''}`;
  }

  return payload;
}

/**
 * Convert a Zod v3 inputSchema to a sanitized JSON Schema object suitable
 * for LLM provider dispatch (JSON Schema draft 2020-12 compatible).
 *
 * The OpenRouter SDK internally requires Zod v4 schemas (checking for `_zod`),
 * but our tools use Zod v3. Pre-converting here ensures:
 * 1. The fallback direct API path has valid `parameters` immediately
 * 2. Schema issues (like $ref, nullable, type arrays) are caught early
 */
function convertInputSchemaToParameters(
  inputSchema: unknown,
  toolName: string
): Record<string, unknown> {
  let rawSchema: unknown;
  try {
    const { $schema: _, ...rest } = z.toJSONSchema(inputSchema as any) as Record<string, unknown>;
    rawSchema = rest;
  } catch (err) {
    logger.warn('Failed to convert tool inputSchema to JSON Schema', {
      event: 'tool_schema_conversion_error',
      subsystem: 'llm',
      toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fall back to a permissive object schema
    return { type: 'object' };
  }

  const sanitized = _sanitizeToolSchema(rawSchema);
  if (typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }

  return { type: 'object' };
}

export async function buildOpenRouterTools(
  registry: ToolRegistry,
  context: ToolContext,
  options: { enabledCategories?: ToolCategory[] } = {}
): Promise<Tool[]> {
  const toolDefs = registry.getForPlatform(context.platform);
  const allowedToolsets = resolveAllowedToolsets(options.enabledCategories);
  // Include all tools from allowed toolsets - no keyword-based routing
  const toolsetFiltered = allowedToolsets
    ? toolDefs.filter(tool => allowedToolsets.includes(tool.toolset || 'core'))
    : toolDefs;

  // Filter out tools where shouldShow returns false
  const visibilityChecks = await Promise.all(
    toolsetFiltered.map(async (tool) => {
      if (tool.shouldShow) {
        try {
          return await tool.shouldShow(context);
        } catch {
          return true; // Show on error
        }
      }
      return true; // No shouldShow = always visible
    })
  );
  const filtered = toolsetFiltered.filter((_, index) => visibilityChecks[index]);

  return Promise.all(filtered.map(async (toolDef) => {
    let description = toolDef.description;
    if (toolDef.contextBuilder) {
      const contextStr = await toolDef.contextBuilder(context);
      if (contextStr) {
        description = `${description}\n\n📌 ${contextStr}`;
      }
    }

    // Pre-convert Zod v3 schema to sanitized JSON Schema.
    // The SDK's internal Zod v4 conversion (convertZodToJsonSchema) will fail
    // on v3 schemas, but the fallback path uses `parameters` directly.
    const parameters = convertInputSchemaToParameters(toolDef.inputSchema, toolDef.name);

    const toolFn: Record<string, unknown> = {
      name: toolDef.name,
      description,
      inputSchema: toolDef.inputSchema,
      // Pre-sanitized JSON Schema for the direct API fallback path.
      // resolveFallbackToolParameters checks this field first.
      parameters,
    };

    if (toolDef.execute !== false) {
      toolFn.execute = async (params: Record<string, unknown>) => {
        const result = await registry.execute(toolDef.name, params, context);
        return normalizeToolResult(result, toolDef.name);
      };
    }

    return {
      type: 'function',
      function: toolFn,
    } as Tool;
  }));
}

export async function executeUiTool(
  toolName: string,
  args: Record<string, unknown>,
  tools: Tool[]
): Promise<Record<string, unknown>> {
  const tool = tools.find(candidate => candidate.function.name === toolName);
  if (!tool || !hasExecuteFunction(tool)) {
    throw new Error(`Tool ${toolName} is manual or not available`);
  }
  const validator = tool.function.inputSchema as unknown as {
    safeParse: (value: unknown) =>
      | { success: true; data: Record<string, unknown> }
      | { success: false; error: { message: string } };
  };
  const parsedArgs = validator.safeParse(args);
  if (!parsedArgs.success) {
    throw new Error(`Invalid input for tool ${toolName}: ${parsedArgs.error.message}`);
  }
  return await tool.function.execute(parsedArgs.data) as Record<string, unknown>;
}

export async function buildModelSelectorPayload(
  services: AllServices['models'],
  avatarId: string,
  family?: string
): Promise<Record<string, unknown>> {
  const models = await services.listModels(family);
  const config = await services.getConfig(avatarId);
  const currentModel = config?.model;

  return {
    type: 'model_selector',
    models: models.map(model => ({
      id: model.id,
      name: model.name,
      pricing: model.pricing ? {
        prompt: Number(model.pricing.prompt),
        completion: Number(model.pricing.completion),
      } : undefined,
      contextLength: (model as { context_length?: number }).context_length ?? model.contextLength,
      provider: (model as { provider?: string }).provider || model.id.split('/')[0] || 'other',
    })),
    currentModel,
    ...(family ? { instructions: `Showing models filtered by "${family}".` } : {}),
  };
}

export async function buildFeatureTogglePayload(
  avatarId: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const feature = args.feature as 'media' | 'voice' | 'twitter' | 'telegram' | 'discord';
  const label = args.label as string;
  const description = args.description as string | undefined;
  const config = await avatars.getAvatar(avatarId);

  let currentState = false;
  const avatarConfig = config as Record<string, unknown> | null | undefined;
  if (avatarConfig) {
    switch (feature) {
      case 'media':
        currentState = Boolean((avatarConfig.mediaConfig as Record<string, unknown> | undefined)?.enabled);
        break;
      case 'voice':
        currentState = Boolean((avatarConfig.voiceConfig as Record<string, unknown> | undefined)?.enabled);
        break;
      case 'twitter':
      case 'telegram': {
        const platforms = avatarConfig.platforms as Record<string, { enabled?: boolean }> | undefined;
        currentState = Boolean(platforms?.[feature]?.enabled);
        break;
      }
      case 'discord': {
        const platforms = avatarConfig.platforms as Record<string, { enabled?: boolean }> | undefined;
        currentState = Boolean(platforms?.[feature]?.enabled);
        break;
      }
    }
  }

  return {
    type: 'feature_toggle',
    feature,
    currentState,
    label,
    description,
  };
}

export function buildPendingToolResponse(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'configure_integration') {
    if (args.integration === 'twitter') {
      return ''; // TwitterConnectPrompt renders its own UI
    }
    return ''; // IntegrationConfigPrompt renders its own UI
  }
  if (toolName === 'request_model_selection') {
    return 'Please select a model:';
  }
  if (toolName === 'request_feature_toggle') {
    return 'Please choose your preference below:';
  }
  if (toolName === 'request_secret') {
    const label = typeof args.label === 'string'
      ? args.label
      : typeof args.secretType === 'string'
        ? args.secretType.replace(/_/g, ' ')
        : 'the requested secret';
    return `Please enter ${label}.`;
  }
  if (toolName === 'request_twitter_connection' || toolName === 'twitter_request_integration') {
    return ''; // TwitterConnectPrompt renders its own UI
  }
  if (toolName === 'request_property_research') {
    return 'Please grant property research access:';
  }
  if (toolName === 'manage_api_keys') {
    return ''; // ApiKeyManagementPrompt renders its own UI
  }
  if (
    toolName === 'get_profile_upload_url' ||
    toolName === 'get_reference_image_upload_url' ||
    toolName === 'get_character_reference_upload_url' ||
    toolName === 'set_profile_image' ||
    toolName === 'set_character_reference'
  ) {
    return 'Please upload your image:';
  }
  return 'Please provide the requested input.';
}

/** Media item generated during chat */
export interface MediaItem {
  type: 'image' | 'video' | 'sticker' | 'audio';
  url: string;
  prompt?: string;
  id?: string;
}

/**
 * Extract media URLs from tool results
 */
export function extractMediaFromToolResults(toolResults: ToolResult[]): MediaItem[] {
  const media: MediaItem[] = [];

  const isAudioUrl = (url: string) => {
    const lowerUrl = url.toLowerCase();
    return (
      lowerUrl.includes('.mp3') ||
      lowerUrl.includes('.wav') ||
      lowerUrl.includes('.ogg') ||
      lowerUrl.includes('.opus') ||
      lowerUrl.includes('/audio/') ||
      lowerUrl.includes('/voice/')
    );
  };

  for (const result of toolResults) {
    try {
      const parsed = JSON.parse(result.content);

      // Get URL from either 'url' or 'resultUrl' field
      const mediaUrl = parsed.url || parsed.resultUrl;

      // Direct image/media generation result (check for success + url/resultUrl)
      // Also check for status === 'completed' as alternative success indicator
      const isSuccess = parsed.success || (parsed.status === 'completed' && mediaUrl);

      // Skip Twitter/X URLs - these are tweet links, not media
      const isTwitterUrl = mediaUrl && typeof mediaUrl === 'string' &&
        (mediaUrl.includes('x.com/') || mediaUrl.includes('twitter.com/'));

      if (isSuccess && mediaUrl && typeof mediaUrl === 'string' && !isTwitterUrl) {
        // Determine type from context, parsed.type, or file extension
        let mediaType: 'image' | 'video' | 'sticker' | 'audio' = parsed.type || 'image';

        if (isAudioUrl(mediaUrl)) {
          mediaType = 'audio';
        } else if (mediaUrl.includes('.mp4') || mediaUrl.includes('.webm') || mediaUrl.includes('/video')) {
          mediaType = 'video';
        } else if (mediaUrl.includes('/sticker')) {
          mediaType = 'sticker';
        }

        media.push({
          type: mediaType,
          url: mediaUrl,
          prompt: parsed.prompt,
          id: parsed.id || parsed.jobId,
        });
      }

      // Gallery items (can be in .items or .data array)
      const itemsArray = Array.isArray(parsed.items) ? parsed.items
        : Array.isArray(parsed.data) ? parsed.data
        : null;
      if (itemsArray) {
        for (const item of itemsArray) {
          if (item.url) {
            media.push({
              type: (isAudioUrl(String(item.url)) ? 'audio' : (item.type || 'image')),
              url: item.url,
              prompt: item.prompt,
              id: item.id,
            });
          }
        }
      }

      // Voice tool results have URLs nested in data (introUrl, previewUrl, url)
      // Handle { success: true, data: { introUrl, previewUrl, url, ... } }
      if (isSuccess && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
        const dataObj = parsed.data as Record<string, unknown>;
        // Check for voice-specific URLs
        const voiceUrls = [dataObj.introUrl, dataObj.previewUrl, dataObj.url].filter(
          (u): u is string => typeof u === 'string' && u.length > 0
        );
        for (const voiceUrl of voiceUrls) {
          const isTwitter = voiceUrl.includes('x.com/') || voiceUrl.includes('twitter.com/');
          if (!isTwitter) {
            media.push({
              type: isAudioUrl(voiceUrl) ? 'audio' : 'image',
              url: voiceUrl,
              prompt: typeof dataObj.message === 'string' ? dataObj.message : undefined,
              id: typeof dataObj.assetId === 'string' ? dataObj.assetId : undefined,
            });
          }
        }
      }
    } catch {
      // Not JSON, skip
    }
  }

  return media;
}

type MessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

export function toSdkMessages(messages: AdminChatMessage[]): Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: MessageContent; toolCallId?: string; tool_calls?: AdminChatMessage['tool_calls'] }> {
  return messages.map(message => {
    if (message.role === 'tool') {
      const tcId = message.tool_call_id;
      if (!tcId || (typeof tcId === 'string' && tcId.trim() === '')) {
        // Skip tool messages with missing/empty tool_call_id — they cause provider 400 errors
        return {
          role: 'user' as const,
          content: '[system: tool result omitted — missing tool_call_id]',
        };
      }
      return {
        role: 'tool' as const,
        content: typeof message.content === 'string' ? redactMediaUrlsFromText(message.content) : message.content,
        toolCallId: tcId,
      };
    }

    // If a message has media (generated images/videos shown in UI), include image URLs as multimodal parts.
    // This makes vision-capable models able to see what they previously generated.
    const mediaImages = (message.media || []).filter(m => m.type === 'image' && typeof m.url === 'string');
    const modelSafeImages = mediaImages.filter(img => !isProbablyPrivateMediaUrl(img.url));
    if (modelSafeImages.length > 0) {
      const baseText = Array.isArray(message.content)
        ? (message.content.find(p => p.type === 'text') as { text?: string } | undefined)?.text || ''
        : String(message.content || '');
      const sanitizedBaseText = redactMediaUrlsFromText(baseText);

      return {
        role: message.role,
        content: [
          { type: 'text', text: sanitizedBaseText },
          ...modelSafeImages.map(img => ({
            type: 'image_url',
            image_url: { url: img.url },
          })),
        ],
      };
    }

    const result: { role: typeof message.role; content: MessageContent; tool_calls?: AdminChatMessage['tool_calls'] } = {
      role: message.role,
      content: (() => {
        const raw = message.content as MessageContent;
        if (typeof raw === 'string') return redactMediaUrlsFromText(raw);
        if (Array.isArray(raw)) {
          return raw.map((part: { type: string; text?: string; image_url?: { url: string } }) => (
            part.type === 'text' && typeof part.text === 'string'
              ? { ...part, text: redactMediaUrlsFromText(part.text) }
              : part
          ));
        }
        return raw;
      })(),
    };
    // Preserve tool_calls on assistant messages so the provider can match
    // subsequent tool result messages to their originating tool calls.
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      result.tool_calls = message.tool_calls;
    }
    return result;
  });
}

// The SDK returns ParsedToolCall with unknown types - we need to handle that
export type SdkToolCall = {
  id: unknown;
  name: unknown;
  arguments: unknown;
};

export function toAdminToolCall(toolCall: SdkToolCall): ToolCall {
  return {
    id: String(toolCall.id),
    type: 'function',
    function: {
      name: String(toolCall.name),
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    },
  };
}
