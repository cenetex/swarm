/**
 * Admin Chatbot Handler
 * Conversational interface for setting up agents with tool use
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import * as chatHistory from '../services/chat-history.js';
import { OpenRouter, fromChatMessages, hasExecuteFunction, toChatMessage, stepCountIs, type Tool } from '@openrouter/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ChatRequestSchema,
  type AdminChatMessage,
  type ToolCall,
  type ToolResult,
  type UserSession,
} from '../types.js';
import { logger } from '@swarm/core';
import { buildDynamicSystemPrompt, detectEnabledCategories, type ToolCategory } from '../services/dynamic-prompts.js';
import { recordError } from '../services/auto-issues.js';
import {
  ToolRegistry,
  registerAllTools,
  routeTools,
  type ToolContext,
  type ToolResult as McpToolResult,
  type AllServices,
  type ToolsetId,
} from '@swarm/mcp-server';
import { createMCPServices } from '../services/mcp-adapter.js';
import { isPauseForInputTool } from '../tools/index.js';
import * as agents from '../services/agents.js';

const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';

// Timeout settings
const LLM_TIMEOUT_MS = 60_000; // 60 seconds for LLM calls (can be slow)

// Cache the API key after first fetch
let cachedApiKey: string | null = null;

async function getLlmApiKey(): Promise<string> {
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

function getOpenRouterClient(): OpenRouter {
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

/**
 * Fallback direct API call when SDK streaming validation fails
 * Uses non-streaming API to avoid SDK's Zod validation issues with null usage fields
 */
async function callLlmDirectFallback(
  model: string,
  messages: Array<{ role: string; content: string | { type: string; text?: string; image_url?: unknown }[] }>,
  tools?: unknown[]
): Promise<{
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}> {
  const apiKey = await getLlmApiKey();
  
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: 2048,
    stream: false, // Disable streaming to avoid SDK validation issues
  };
  
  if (tools && tools.length > 0) {
    // Convert SDK tools to OpenAI format
    body.tools = tools.map((t: unknown) => {
      const tool = t as {
        function?: {
          name?: string;
          description?: string;
          parameters?: unknown;
          inputSchema?: unknown;
        };
      };
      const parameters = tool.function?.parameters
        || (tool.function?.inputSchema
          ? zodToJsonSchema(tool.function.inputSchema as Parameters<typeof zodToJsonSchema>[0], { target: 'openApi3' })
          : undefined);
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
  
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
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
  };
  
  const choice = data.choices?.[0]?.message;
  const content = choice?.content || '';
  const toolCalls = (choice?.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
  }));
  
  return { content, toolCalls };
}

/**
 * Sanitize conversation history to ensure valid message format
 * Removes orphaned tool results and ensures proper message structure
 */
function sanitizeMessages(messages: AdminChatMessage[]): AdminChatMessage[] {
  const sanitized: AdminChatMessage[] = [];
  const validToolCallIds = new Set<string>();

  // First pass: collect valid tool call IDs from assistant messages
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          validToolCallIds.add(tc.id);
        }
      }
    }
  }

  // Second pass: filter and validate messages
  for (const msg of messages) {
    if (msg.role === 'tool') {
      // Only include tool results that have a matching tool call
      const toolCallId = (msg as ToolResult).tool_call_id;
      if (!toolCallId || !validToolCallIds.has(toolCallId)) {
        logger.info('Skipping orphaned tool result', { toolCallId });
        continue;
      }
    }
    sanitized.push(msg);
  }

  return sanitized;
}

interface AgentContext {
  id: string;
  name?: string;
  description?: string;
  persona?: string;
  enabledCategories?: ToolCategory[];
}

/**
 * Build system prompt dynamically based on enabled tool categories
 */
function buildSystemPrompt(agent?: AgentContext): string {
  if (agent) {
    // Use dynamic prompt builder with enabled categories
    const categories = agent.enabledCategories || [
      // Default categories if not specified
      'secrets', 'profile', 'media', 'gallery', 'wallets', 'diagnostics'
    ];
    
    return buildDynamicSystemPrompt({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      persona: agent.persona,
      enabledCategories: categories,
      platform: 'admin-ui',
    });
  }

  // Fallback for no agent context
  return `You are a Swarm agent assistant. Please select an agent to chat with.`;
}

const CATEGORY_TOOLSETS: Record<ToolCategory, ToolsetId[]> = {
  secrets: ['secrets'],
  wallets: ['wallet'],
  profile: ['profile'],
  media: ['media'],
  gallery: ['gallery'],
  voice: ['voice'],
  telegram: ['telegram'],
  twitter: ['twitter'],
  discord: ['discord'],
  memory: ['memory'],
  nft: ['nft'],
  property: ['property'],
  diagnostics: ['diagnostics'],
};

function resolveAllowedToolsets(categories?: ToolCategory[]): ToolsetId[] | undefined {
  if (!categories || categories.length === 0) return undefined;
  const toolsets = new Set<ToolsetId>(['core', 'admin', 'config', 'jobs']);

  for (const category of categories) {
    const mapped = CATEGORY_TOOLSETS[category] || [];
    for (const toolset of mapped) {
      toolsets.add(toolset);
    }
  }

  return Array.from(toolsets);
}

function normalizeToolResult(result: McpToolResult, toolName: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    success: result.success,
  };

  if (result.error) {
    payload.error = result.error;
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
    payload.message = `Tool ${toolName} failed${result.error ? `: ${result.error}` : ''}`;
  }

  return payload;
}

async function buildOpenRouterTools(
  registry: ToolRegistry,
  context: ToolContext,
  options: { userMessage?: string; enabledCategories?: ToolCategory[] } = {}
): Promise<Tool[]> {
  const toolDefs = registry.getForPlatform(context.platform);
  const allowedToolsets = resolveAllowedToolsets(options.enabledCategories);
  const filtered = allowedToolsets
    ? toolDefs.filter(tool => allowedToolsets.includes(tool.toolset || 'core'))
    : toolDefs;
  const includeToolsets = new Set<ToolsetId>(['admin', 'config', 'jobs']);
  if (options.enabledCategories?.includes('telegram')) includeToolsets.add('telegram');
  if (options.enabledCategories?.includes('twitter')) includeToolsets.add('twitter');
  if (options.enabledCategories?.includes('discord')) includeToolsets.add('discord');
  const routing = routeTools(filtered, {
    text: options.userMessage,
    maxToolsets: 3,
    includeToolsets: Array.from(includeToolsets),
  });

  return Promise.all(routing.tools.map(async (toolDef) => {
    let description = toolDef.description;
    if (toolDef.contextBuilder) {
      const contextStr = await toolDef.contextBuilder(context);
      if (contextStr) {
        description = `${description}\n\n📌 ${contextStr}`;
      }
    }

    const toolFn: Record<string, unknown> = {
      name: toolDef.name,
      description,
      inputSchema: toolDef.inputSchema,
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
    } as unknown as Tool;
  }));
}

async function executeUiTool(
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

async function buildModelSelectorPayload(
  services: AllServices['models'],
  agentId: string,
  family?: string
): Promise<Record<string, unknown>> {
  const models = await services.listModels(family);
  const config = await services.getConfig(agentId);
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

async function buildFeatureTogglePayload(
  agentId: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const feature = args.feature as 'media' | 'voice' | 'twitter' | 'telegram' | 'discord';
  const label = args.label as string;
  const description = args.description as string | undefined;
  const config = await agents.getAgent(agentId);

  let currentState = false;
  const agentConfig = config as Record<string, unknown> | null | undefined;
  if (agentConfig) {
    switch (feature) {
      case 'media':
        currentState = Boolean((agentConfig.mediaConfig as Record<string, unknown> | undefined)?.enabled);
        break;
      case 'voice':
        currentState = Boolean((agentConfig.voiceConfig as Record<string, unknown> | undefined)?.enabled);
        break;
      case 'twitter':
      case 'telegram': {
        const platforms = agentConfig.platforms as Record<string, { enabled?: boolean }> | undefined;
        currentState = Boolean(platforms?.[feature]?.enabled);
        break;
      }
      case 'discord': {
        const platforms = agentConfig.platforms as Record<string, { enabled?: boolean }> | undefined;
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

function buildPendingToolResponse(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'request_model_selection') {
    return 'Please select a model:';
  }
  if (toolName === 'request_feature_toggle') {
    return 'Please choose your preference below:';
  }
  if (toolName === 'request_secret') {
    const label = typeof args.label === 'string' ? args.label : 'the requested secret';
    return `Please enter ${label}.`;
  }
  if (toolName === 'request_twitter_connection') {
    return 'Please connect your X/Twitter account:';
  }
  if (toolName === 'request_property_research') {
    return 'Please grant property research access:';
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

// The SDK returns ParsedToolCall with unknown types - we need to handle that
type SdkToolCall = {
  id: unknown;
  name: unknown;
  arguments: unknown;
};

function toSdkMessages(messages: AdminChatMessage[]): Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string; toolCallId?: string }> {
  return messages.map(message => {
    if (message.role === 'tool') {
      return {
        role: 'tool' as const,
        content: message.content,
        toolCallId: message.tool_call_id,
      };
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

function buildModelInput(systemPrompt: string, messages: AdminChatMessage[]) {
  const sanitizedMessages = sanitizeMessages(messages);
  const inputMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...sanitizedMessages,
  ];
  // Cast to any to work around OpenRouter SDK's strict internal types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fromChatMessages(toSdkMessages(inputMessages) as any);
}

function toAdminToolCall(toolCall: SdkToolCall): ToolCall {
  return {
    id: String(toolCall.id),
    type: 'function',
    function: {
      name: String(toolCall.name),
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    },
  };
}

/** Media item generated during chat */
interface MediaItem {
  type: 'image' | 'video' | 'sticker';
  url: string;
  prompt?: string;
  id?: string;
}

/**
 * Extract media URLs from tool results
 */
function extractMediaFromToolResults(toolResults: ToolResult[]): MediaItem[] {
  const media: MediaItem[] = [];

  for (const result of toolResults) {
    try {
      const parsed = JSON.parse(result.content);

      // Get URL from either 'url' or 'resultUrl' field
      const mediaUrl = parsed.url || parsed.resultUrl;

      // Direct image/media generation result (check for success + url/resultUrl)
      // Also check for status === 'completed' as alternative success indicator
      const isSuccess = parsed.success || (parsed.status === 'completed' && mediaUrl);
      if (isSuccess && mediaUrl && typeof mediaUrl === 'string') {
        // Determine type from context, parsed.type, or file extension
        let mediaType: 'image' | 'video' | 'sticker' = parsed.type || 'image';
        if (mediaUrl.includes('.mp4') || mediaUrl.includes('.webm') || mediaUrl.includes('/video')) {
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

      // Gallery items
      if (Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (item.url) {
            media.push({
              type: item.type || 'image',
              url: item.url,
              prompt: item.prompt,
              id: item.id,
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

/**
 * Process a chat message, executing tools as needed
 */
async function processChat(
  userMessage: string,
  conversationHistory: AdminChatMessage[],
  session: UserSession,
  agent?: AgentContext
): Promise<{
  response: string;
  history: AdminChatMessage[];
  media?: MediaItem[];
  pendingJobs?: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }>;
  agentUpdates?: { profileImageUrl?: string };
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}> {
  const agentId = agent?.id;
  const mcpServices = agentId ? createMCPServices(agentId, session) : null;
  const toolRegistry = agentId && mcpServices ? new ToolRegistry() : null;
  if (toolRegistry && mcpServices) {
    registerAllTools(toolRegistry, mcpServices);
  }
  const toolContext: ToolContext | null = agentId ? {
    agentId,
    platform: 'admin-ui',
    userId: session.userId,
    session: { email: session.email, isAdmin: session.isAdmin },
  } : null;
  const tools = toolRegistry && toolContext
    ? await buildOpenRouterTools(toolRegistry, toolContext, {
        userMessage,
        enabledCategories: agent?.enabledCategories,
      })
    : [];

  // Log tools available for debugging
  logger.info('Tools created', {
    event: 'tools_created',
    agentId,
    toolCount: tools.length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolNames: tools.map((t: any) => t.function?.name ?? t.name),
  });

  const messages: AdminChatMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  let response = '';
  let pendingToolCall: { id: string; name: string; arguments: Record<string, unknown> } | undefined;
  const allMedia: MediaItem[] = [];
  const pendingJobs: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }> = [];
  const agentUpdates: { profileImageUrl?: string } = {};
  const systemPrompt = buildSystemPrompt(agent);
  const input = buildModelInput(systemPrompt, messages);

  logger.info('LLM request', {
    event: 'llm_request',
    model: LLM_MODEL,
    messageCount: messages.length,
    toolsIncluded: tools.length > 0,
  });

  // Try SDK first, fallback to direct API if SDK's Zod validation fails
  let toolCalls: SdkToolCall[] = [];
  let adminToolCalls: ToolCall[] = [];
  let modelResult: ReturnType<typeof getOpenRouterClient.prototype.callModel> | null = null;
  let usedFallback = false;
  let fallbackResponse = '';

  try {
    // Tools from the SDK are already in the correct format
    modelResult = getOpenRouterClient().callModel({
      model: LLM_MODEL,
      input,
      maxOutputTokens: 2048,
      ...(tools.length > 0 ? { tools, stopWhen: stepCountIs(10) } : {}),
    });

    toolCalls = await modelResult.getToolCalls();
    adminToolCalls = toolCalls.map(toAdminToolCall);
  } catch (sdkError) {
    // Check if this is a Zod validation/schema error (SDK uses zod/v4 internally)
    const errorName = sdkError instanceof Error ? sdkError.name : '';
    const errorMessage = sdkError instanceof Error ? sdkError.message : '';
    const isZodError = errorName === 'ZodError' || 
      errorMessage.includes('invalid_type') ||
      errorMessage.includes('Invalid Zod schema');
    
    if (isZodError) {
      logger.warn('SDK Zod validation error, falling back to direct API', {
        event: 'sdk_fallback',
        errorName,
        errorMessage,
      });
      
      // Build messages for direct API call
      const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...toSdkMessages(sanitizeMessages(messages)),
      ];
      
      const fallbackResult = await callLlmDirectFallback(
        LLM_MODEL,
        apiMessages as Array<{ role: string; content: string }>,
        tools.length > 0 ? tools : undefined
      );
      
      usedFallback = true;
      fallbackResponse = fallbackResult.content;
      
      // Convert fallback tool calls to admin format
      adminToolCalls = fallbackResult.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
      
      // Create pseudo-SdkToolCalls for compatibility with existing code
      toolCalls = fallbackResult.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })) as unknown as SdkToolCall[];
    } else {
      // Re-throw non-Zod errors
      throw sdkError;
    }
  }

  logger.info('LLM response', {
    event: 'llm_response',
    hasToolCalls: toolCalls.length > 0,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map(tc => String(tc.name)),
    usedFallback,
  });

  // Helper to safely extract tool call args as Record<string, unknown>
  const getToolArgs = (tc: SdkToolCall): Record<string, unknown> => {
    if (tc.arguments && typeof tc.arguments === 'object') {
      return tc.arguments as Record<string, unknown>;
    }
    return {};
  };

  const pauseToolCall = toolCalls.find(tc => isPauseForInputTool(String(tc.name), getToolArgs(tc)));
  if (pauseToolCall && mcpServices && agentId) {
    let pendingArgs = getToolArgs(pauseToolCall);
    const toolName = String(pauseToolCall.name);
    try {
      if (toolName === 'request_model_selection') {
        const family = typeof pendingArgs.family === 'string'
          ? pendingArgs.family
          : typeof pendingArgs.preferredFamily === 'string'
            ? pendingArgs.preferredFamily
            : undefined;
        pendingArgs = await buildModelSelectorPayload(mcpServices.models, agentId, family);
      } else if (toolName === 'request_feature_toggle') {
        pendingArgs = await buildFeatureTogglePayload(agentId, pendingArgs);
      } else if (toolName === 'request_twitter_connection') {
        pendingArgs = { type: 'twitter_connect', ...pendingArgs };
      } else if (
        toolName === 'get_profile_upload_url' ||
        toolName === 'get_reference_image_upload_url' ||
        toolName === 'get_character_reference_upload_url' ||
        toolName === 'set_profile_image' ||
        toolName === 'set_character_reference'
      ) {
        pendingArgs = await executeUiTool(toolName, pendingArgs, tools);
      }
    } catch (error) {
      logger.error('Failed to build pending tool payload', error, {
        toolName,
      });
    }

    pendingToolCall = {
      id: String(pauseToolCall.id),
      name: toolName,
      arguments: pendingArgs,
    };

    response = buildPendingToolResponse(toolName, pendingArgs);
    messages.push({
      role: 'assistant',
      content: response,
      tool_calls: adminToolCalls.length > 0 ? adminToolCalls : [toAdminToolCall(pauseToolCall)],
    });

    return {
      response,
      history: messages,
      pendingToolCall,
    };
  }

  const toolResults: ToolResult[] = [];
  
  // When using fallback, we skip the SDK's tool execution stream since we don't have it
  // The fallback only returns tool calls, not execution results
  if (toolCalls.length > 0 && modelResult && !usedFallback) {
    for await (const item of modelResult.getNewMessagesStream()) {
      if (item && typeof item === 'object' && 'type' in item && item.type === 'function_call_output') {
        const outputItem = item as { callId?: string; output?: string };
        if (outputItem.callId && typeof outputItem.output === 'string') {
          toolResults.push({
            tool_call_id: outputItem.callId,
            role: 'tool',
            content: outputItem.output,
          });
        }
      }
    }
  }

  // Get final response - either from SDK or fallback
  if (usedFallback) {
    response = fallbackResponse;
  } else if (modelResult) {
    const finalResponse = await modelResult.getResponse();
    const assistantMessage = toChatMessage(finalResponse);
    response = typeof assistantMessage.content === 'string' ? assistantMessage.content : '';
  }

  if (toolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: adminToolCalls,
    });
    for (const result of toolResults) {
      messages.push(result as AdminChatMessage);
    }
  }

  if (!response) {
    response = 'I apologize, but I couldn\'t generate a response.';
  }
  messages.push({ role: 'assistant', content: response });

  const toolCallNames = new Map(toolCalls.map(tc => [tc.id, tc.name]));
  for (const result of toolResults) {
    logger.info('Tool result', { toolCallId: result.tool_call_id, contentLength: result.content?.length || 0 });

    if (result.content && typeof result.content === 'string') {
      try {
        const parsed = JSON.parse(result.content);
        const toolName = toolCallNames.get(result.tool_call_id);
        if (parsed._pendingJob) {
          pendingJobs.push({
            jobId: parsed._pendingJob.jobId,
            type: parsed._pendingJob.type || 'image',
            prompt: parsed._pendingJob.prompt,
            purpose: parsed._pendingJob.purpose,
          });
        } else if (parsed.jobId && (parsed.status === 'pending' || parsed.status === 'processing')) {
          pendingJobs.push({
            jobId: parsed.jobId,
            type: toolName === 'generate_video'
              ? 'video'
              : toolName === 'generate_sticker'
                ? 'sticker'
                : 'image',
            prompt: parsed.prompt,
          });
        }
      } catch {
        // Not JSON, skip
      }
    }
  }

  const mediaFromResults = extractMediaFromToolResults(toolResults);
  logger.info('Extracted media items from tool results', { count: mediaFromResults.length });
  allMedia.push(...mediaFromResults);

  // Check for profile image updates from tool results
  for (const result of toolResults) {
    const toolName = toolCallNames.get(result.tool_call_id);
    if (toolName === 'set_profile_image' || toolName === 'save_uploaded_profile_image') {
      if (result.content && typeof result.content === 'string') {
        try {
          const parsed = JSON.parse(result.content);
          if (parsed.success && (parsed.data?.url || parsed.url || parsed.resultUrl)) {
            agentUpdates.profileImageUrl = parsed.data?.url || parsed.url || parsed.resultUrl;
            logger.info('Profile image updated', { profileImageUrl: agentUpdates.profileImageUrl });
          }
        } catch {
          // Not JSON, skip
        }
      }
    }
  }

  logger.info('Final response', { 
    mediaCount: allMedia.length, 
    pendingJobCount: pendingJobs.length,
    hasPendingToolCall: !!pendingToolCall,
    pendingToolCallName: pendingToolCall?.name,
  });
  return { 
    response, 
    history: messages, 
    media: allMedia.length > 0 ? allMedia : undefined, 
    pendingJobs: pendingJobs.length > 0 ? pendingJobs : undefined,
    agentUpdates: agentUpdates.profileImageUrl ? agentUpdates : undefined,
    pendingToolCall,
  };
}

/**
 * Lambda handler for admin chat API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const resolveCorsOrigin = (): string => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);
    const fallbackOrigin = allowedOrigins[0] || 'http://localhost:5173';
    const requestOrigin = event.headers['origin'] || event.headers['Origin'];
    if (!requestOrigin) return fallbackOrigin;
    const normalizedRequest = requestOrigin.replace(/\/$/, '');
    const match = allowedOrigins.find(allowed => normalizedRequest === allowed.replace(/\/$/, ''));
    return match || fallbackOrigin;
  };

  // CORS headers - restricted to configured admin domains
  const allowedOrigin = resolveCorsOrigin();
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate the request
    const session = await authenticateRequest(event);
    const requestId = event.requestContext.requestId;
    
    // Set logging context for this handler
    logger.setContext({ subsystem: 'chat', requestId });
    
    // Require admin access
    if (!requireAdmin(session)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    const method = event.requestContext.http.method;

    // GET /chat?agentId=xxx - Retrieve chat history
    if (method === 'GET') {
      const agentId = event.queryStringParameters?.agentId;
      const history = await chatHistory.getChatHistory(session, agentId);
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ history }),
      };
    }

    // DELETE /chat?agentId=xxx - Clear chat history
    if (method === 'DELETE') {
      const agentId = event.queryStringParameters?.agentId;
      await chatHistory.clearChatHistory(session, agentId);
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    }

    // POST /chat - Send a message
    // Parse and validate request body
    const parseResult = ChatRequestSchema.safeParse(JSON.parse(event.body || '{}'));
    if (!parseResult.success) {
      logger.error('Validation error', undefined, {
        event: 'validation_error',
        agentId: JSON.parse(event.body || '{}').agent?.id,
        requestId,
        errors: parseResult.error.errors,
        bodyPreview: event.body?.substring(0, 500),
      });
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid request',
          details: parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        }),
      };
    }
    const { message, history, agent } = parseResult.data;

    const agentRecord = agent?.id ? await agents.getAgent(agent.id) : null;
    const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
    const enabledCategories = agentRecord
      ? detectEnabledCategories({
          voice: voiceEnabled && Boolean(agentRecord.voiceConfig?.enabled),
          memory: false,
          telegram: Boolean(agentRecord.platforms?.telegram?.enabled),
          twitter: Boolean(agentRecord.platforms?.twitter?.enabled),
          discord: Boolean(agentRecord.platforms?.discord?.enabled),
          nft: true,
          property: true,
        })
      : undefined;
    const agentContext = agent ? {
      id: agent.id,
      name: agentRecord?.name ?? agent.name,
      description: agentRecord?.description ?? agent.description,
      persona: agentRecord?.persona ?? agent.persona,
      enabledCategories,
    } : undefined;

    // Log request entry
    logger.info('Request received', {
      event: 'request_received',
      agentId: agent?.id,
      requestId,
      messageLength: message.length,
      historyLength: history.length,
    });

    // Process the chat with agent context
    const result = await processChat(message, history, session, agentContext);

    // Save the updated history to DynamoDB for cross-device sync
    await chatHistory.saveChatHistory(session, result.history, agent?.id);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: result.response,
        history: result.history,
        // Include media generated during this response
        media: result.media,
        // Include pending jobs for async generation (image/video)
        pendingJobs: result.pendingJobs,
        // Include pending tool call if one needs user input
        pendingToolCall: result.pendingToolCall,
        // Include agent updates (e.g., profile image changes)
        agentUpdates: result.agentUpdates,
      }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('Handler error', error, {
      event: 'handler_error',
      requestId: event.requestContext.requestId,
    });

    // Record error in auto-issues system
    recordError({
      error: errorMessage,
      stack: errorStack,
      subsystem: 'chat',
      category: 'handler_error',
      requestId: event.requestContext.requestId,
    }).catch(() => {
      // Ignore recording failures
    });
    
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: errorMessage,
      }),
    };
  }
}
