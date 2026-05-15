/**
 * Processor Adapter
 *
 * Bridges the unified MessageProcessor from @swarm/core to the admin-api services.
 * This adapter creates the dependency injection required by MessageProcessor using
 * the existing admin-api infrastructure.
 */

import {
  DEFAULT_LLM_MODEL as CORE_DEFAULT_LLM_MODEL,
  MessageProcessor,
  createMessageProcessor,
  type MessageProcessorDependencies,
  type ProcessorAvatarConfig,
  type ProcessorToolContext,
  type FilterableToolDefinition,
  type LLMTool,
  type ToolExecutionResult,
  detectEnabledCategories,
  filterTools,
  logger,
} from '@swarm/core';
import {
  ToolRegistry,
  registerAllTools,
  type ToolContext,
} from '@swarm/mcp-server';
import { z } from 'zod';
import type { UserSession } from '../types.js';
import * as avatars from './avatars.js';
import * as memory from './memory.js';
import { createMCPServices, createTelegramMCPServices } from './mcp-adapter.js';
import { formatDreamForPrompt, getDreamForResponse } from './dreams.js';
import * as voice from './voice.js';
import {
  executeWithFallback,
  withOpenRouterFallbackRouting,
} from './models-registry.js';
import { resolveOpenRouterChatModelPlan } from './openrouter-chat-models.js';

// =============================================================================
// LLM CONFIGURATION
// =============================================================================

const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const DEFAULT_LLM_MODEL = process.env.LLM_MODEL || CORE_DEFAULT_LLM_MODEL;
const DEFAULT_LLM_MAX_TOKENS = 2048;
const DEFAULT_LLM_TEMPERATURE = 0.7;
// Allow slow providers/models without tripping AbortController too aggressively.
// Keep this below the Lambda timeout (configured in infra).
const LLM_TIMEOUT_MS = Number.parseInt(process.env.LLM_TIMEOUT_MS || '', 10) || 90_000;

// =============================================================================
// LLM API KEY CACHE
// =============================================================================

let cachedLLMApiKey: string | null = null;

async function getLLMApiKey(): Promise<string> {
  if (cachedLLMApiKey) return cachedLLMApiKey;

  if (!LLM_API_KEY_SECRET_ARN) {
    throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  }

  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({
    SecretId: LLM_API_KEY_SECRET_ARN,
  }));

  if (!response.SecretString) {
    throw new Error('Failed to retrieve LLM API key');
  }

  cachedLLMApiKey = response.SecretString;
  return cachedLLMApiKey;
}

// =============================================================================
// TOOL FORMAT CONVERSION
// =============================================================================

/**
 * Convert filtered tool definitions to LLM-compatible format
 */
async function convertToolsToLLMFormat(
  tools: FilterableToolDefinition[],
  context: ProcessorToolContext
): Promise<LLMTool[]> {
  return Promise.all(
    tools.map(async (tool) => {
      let description = (tool as { description?: string }).description || '';

      // Inject dynamic context if available
      const contextBuilder = (tool as { contextBuilder?: (ctx: ProcessorToolContext) => Promise<string | undefined> }).contextBuilder;
      if (contextBuilder) {
        const contextStr = await contextBuilder(context);
        if (contextStr) {
          description = `${description}\n\n📌 ${contextStr}`;
        }
      }

      const inputSchema = (tool as { inputSchema?: unknown }).inputSchema;

      return {
        type: 'function' as const,
        function: {
          name: tool.name,
          description,
          parameters: inputSchema
            ? sanitizeOpenAiSchema((() => { const { $schema: _, ...rest } = z.toJSONSchema(inputSchema as any) as Record<string, unknown>; return rest; })())
            : {},
        },
      };
    })
  );
}

function sanitizeOpenAiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...schema };
  delete sanitized.$schema;
  return sanitized;
}

// =============================================================================
// AVATAR SERVICE ADAPTER
// =============================================================================

async function loadAvatarConfig(avatarId: string): Promise<ProcessorAvatarConfig | null> {
  const avatar = await avatars.getAvatar(avatarId);
  if (!avatar) return null;

  const mcpConfig = avatar.mcpConfig;
  const enabledToolsets = mcpConfig?.enabledToolsets || [];
  const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';

  // Detect enabled categories based on avatar configuration
  const enabledCategories = detectEnabledCategories({
    voice: voiceEnabled,
    memory: enabledToolsets.includes('memory'),
    telegram: Boolean(avatar.platforms?.telegram?.enabled),
    twitter: Boolean(avatar.platforms?.twitter?.enabled),
    discord: Boolean(avatar.platforms?.discord?.enabled),
    nft: true,
    property: enabledToolsets.includes('property'),
    signalStation: enabledToolsets.includes('signal-station'),
  });

  // Get wallets for context
  const { listWallets } = await import('./web3/wallets.js');
  let wallets: ProcessorAvatarConfig['wallets'] = [];
  try {
    const walletList = await listWallets(avatarId);
    wallets = walletList.map(w => ({
      name: w.name,
      publicKey: w.publicKey || w.address,
    }));
  } catch {
    // Wallet loading failed, continue without
  }

  return {
    avatarId: avatar.avatarId,
    name: avatar.name,
    description: avatar.description,
    persona: avatar.persona,
    enabledCategories,
    platforms: {
      telegram: avatar.platforms?.telegram ? { enabled: avatar.platforms.telegram.enabled } : undefined,
      twitter: avatar.platforms?.twitter ? { enabled: avatar.platforms.twitter.enabled } : undefined,
      discord: avatar.platforms?.discord ? { enabled: avatar.platforms.discord.enabled } : undefined,
    },
    wallets,
    llmConfig: {
      model: avatar.llmConfig?.model || DEFAULT_LLM_MODEL,
      temperature: avatar.llmConfig?.temperature ?? DEFAULT_LLM_TEMPERATURE,
      maxTokens: avatar.llmConfig?.maxTokens || DEFAULT_LLM_MAX_TOKENS,
    },
    mcpConfig: {
      enabledToolsets,
    },
  };
}

// =============================================================================
// TOOL REGISTRY MANAGEMENT
// =============================================================================

// Cache registries per avatar+platform to avoid recreation
const registryCache = new Map<string, { registry: ToolRegistry; tools: FilterableToolDefinition[] }>();

async function getRegisteredTools(
  avatarId: string,
  platform: ProcessorToolContext['platform'],
  session?: UserSession
): Promise<FilterableToolDefinition[]> {
  const cacheKey = `${avatarId}:${platform}`;

  // Check cache (valid for 5 minutes)
  const cached = registryCache.get(cacheKey);
  if (cached) {
    return cached.tools;
  }

  // Create services based on platform
  const services = platform === 'telegram'
    ? createTelegramMCPServices(avatarId)
    : createMCPServices(avatarId, session || {
        email: 'system@swarm.local',
        userId: `system-${avatarId}`,
        isAdmin: false,
        accessToken: '',
      });

  // Create registry and register all tools
  const registry = new ToolRegistry();
  registerAllTools(registry, services);

  // Get tools for this platform
  const tools = registry.getForPlatform(platform as ToolContext['platform']) as FilterableToolDefinition[];

  // Cache with TTL
  registryCache.set(cacheKey, { registry, tools });
  setTimeout(() => registryCache.delete(cacheKey), 5 * 60 * 1000);

  return tools;
}

async function executeToolFromRegistry(
  avatarId: string,
  platform: ProcessorToolContext['platform'],
  toolName: string,
  args: Record<string, unknown>,
  context: ProcessorToolContext,
  session?: UserSession
): Promise<ToolExecutionResult> {
  const cacheKey = `${avatarId}:${platform}`;
  let cached = registryCache.get(cacheKey);

  if (!cached) {
    // Recreate registry
    await getRegisteredTools(avatarId, platform, session);
    cached = registryCache.get(cacheKey);
  }

  if (!cached) {
    return { success: false, error: 'Tool registry not available' };
  }

  const registryContext: ToolContext = {
    avatarId: context.avatarId,
    platform: context.platform as ToolContext['platform'],
    userId: context.userId,
    conversationId: context.conversationId,
    replyToMessageId: context.replyToMessageId,
    session: context.session,
  };

  const result = await cached.registry.execute(toolName, args, registryContext);

  return {
    success: result.success,
    data: result.data,
    error: result.error,
    media: result.media,
    pendingJob: result.pendingJob,
  };
}

// =============================================================================
// LLM CALLING
// =============================================================================

import type { ProcessorMessage, ProcessorLLMResponse } from '@swarm/core';

function normalizeUsage(raw?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}): { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined {
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

async function callLLM(params: {
  messages: ProcessorMessage[];
  tools: LLMTool[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<ProcessorLLMResponse> {
  const apiKey = await getLLMApiKey();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    // Convert messages to OpenRouter format
    const openRouterMessages = params.messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: msg.tool_call_id || '',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        };
      }

      if (msg.tool_calls) {
        return {
          role: 'assistant' as const,
          content: typeof msg.content === 'string' ? msg.content : '',
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        };
      }

      return {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      };
    });

    const requestBody = {
      messages: openRouterMessages,
      tools: params.tools.length > 0 ? params.tools : undefined,
      max_tokens: params.maxTokens || DEFAULT_LLM_MAX_TOKENS,
      temperature: params.temperature ?? DEFAULT_LLM_TEMPERATURE,
    };
    const modelPlan = await resolveOpenRouterChatModelPlan({
      requestModel: params.model,
      defaultModel: DEFAULT_LLM_MODEL,
      apiKey,
      requireTools: params.tools.length > 0,
    });

    const fallbackResult = await executeWithFallback(async (candidateModel) => {
      const body = withOpenRouterFallbackRouting(requestBody, candidateModel, {
        requireParameters: params.tools.length > 0,
        fallbackModels: modelPlan.fallbackModels,
      });
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://swarm.rati.chat',
          'X-Title': 'AWS Swarm',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API error: ${response.status} ${errorText}`);
      }

      return response;
    }, {
      primaryModel: modelPlan.primaryModel,
      avatarId: 'processor-adapter',
      fallbackModels: modelPlan.fallbackModels,
    });
    const response = fallbackResult.result;

    const data = await response.json() as {
      model?: string;
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
    };

    const choice = data.choices[0];
    if (!choice) {
      throw new Error('No response from LLM');
    }

    if (fallbackResult.usedFallback || (data.model && data.model !== modelPlan.primaryModel)) {
      logger.info('Processor LLM fallback used', {
        event: 'processor_llm_fallback_used',
        requestedModel: modelPlan.primaryModel,
        responseModel: data.model || fallbackResult.model,
        attemptedModels: fallbackResult.attemptedModels,
      });
    }

    return {
      content: choice.message.content || '',
      toolCalls: choice.message.tool_calls,
      finishReason: choice.finish_reason as 'stop' | 'tool_calls' | 'length' | 'content_filter',
      usage: normalizeUsage(data.usage),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// =============================================================================
// CREATE PROCESSOR
// =============================================================================

export interface ProcessorAdapterOptions {
  /** User session for authenticated requests (admin-ui) */
  session?: UserSession;
  /** Platform context */
  platform: ProcessorToolContext['platform'];
  /** Enable dreams context injection */
  dreamsEnabled?: boolean;
}

/**
 * Create a MessageProcessor configured with admin-api services.
 * This is the main entry point for creating processors in handlers.
 */
export function createProcessor(options: ProcessorAdapterOptions): MessageProcessor {
  const { session, platform, dreamsEnabled } = options;

  const dependencies: MessageProcessorDependencies = {
    avatarService: {
      getAvatar: loadAvatarConfig,
    },

    memoryService: {
      getMemoryContext: async (avatarId: string) => {
        return memory.getMemoryContext(avatarId);
      },
      getMemoryContextForQuery: async (avatarId: string, query: string) => {
        return memory.getMemoryContextForQuery(avatarId, query);
      },
      remember: async (avatarId: string, fact: string, about?: string, userId?: string) => {
        await memory.remember(avatarId, fact, about, userId);
      },
      recall: async (avatarId: string, query: string, userId?: string) => {
        const result = await memory.recall(avatarId, query, userId);
        return result.facts;
      },
    },

    dreamsService: dreamsEnabled ? {
      getDreamForResponse,
      formatDreamForPrompt,
    } : undefined,

    voiceService: {
      transcribeAudio: async (params) => {
        return voice.transcribeAudio({
          avatarId: params.avatarId,
          url: params.url,
          assetId: params.assetId,
        });
      },
    },

    getRegisteredTools: async (avatarId: string) => {
      return getRegisteredTools(avatarId, platform, session);
    },

    toLLMFormat: async (tools: FilterableToolDefinition[], context: ProcessorToolContext) => {
      // First filter tools by enabled categories
      const avatar = await loadAvatarConfig(context.avatarId);
      const filteredTools = avatar
        ? await filterTools(tools, context, avatar.enabledCategories)
        : tools;
      return convertToolsToLLMFormat(filteredTools, context);
    },

    callLLM,

    executeTool: async (toolName: string, args: Record<string, unknown>, context: ProcessorToolContext) => {
      return executeToolFromRegistry(
        context.avatarId,
        platform,
        toolName,
        args,
        context,
        session
      );
    },
  };

  return createMessageProcessor(dependencies);
}

/**
 * Create a processor for web/admin-ui requests.
 */
export function createAdminProcessor(session: UserSession): MessageProcessor {
  return createProcessor({
    session,
    platform: 'admin-ui',
    dreamsEnabled: process.env.DREAMS_ENABLED === 'true',
  });
}

/**
 * Create a processor for Telegram requests.
 */
export function createTelegramProcessor(): MessageProcessor {
  return createProcessor({
    platform: 'telegram',
    dreamsEnabled: process.env.DREAMS_ENABLED === 'true',
  });
}

/**
 * Create a processor for Discord requests.
 */
export function createDiscordProcessor(): MessageProcessor {
  return createProcessor({
    platform: 'discord',
    dreamsEnabled: process.env.DREAMS_ENABLED === 'true',
  });
}

/**
 * Create a processor for Twitter requests.
 */
export function createTwitterProcessor(): MessageProcessor {
  return createProcessor({
    platform: 'twitter',
    dreamsEnabled: process.env.DREAMS_ENABLED === 'true',
  });
}

/**
 * Create a processor for Shared Chat (web group chat) requests.
 * Uses the same unified MessageProcessor as other platforms for consistency.
 */
export function createSharedChatProcessor(): MessageProcessor {
  return createProcessor({
    platform: 'shared-chat',
    dreamsEnabled: process.env.DREAMS_ENABLED === 'true',
  });
}
