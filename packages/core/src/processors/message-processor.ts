/**
 * MessageProcessor
 *
 * Unified message processing pipeline for all platforms.
 * This is the single source of truth for how messages are processed,
 * ensuring consistent behavior across Telegram, Discord, Web, Twitter, etc.
 *
 * Architecture:
 * 1. Load avatar configuration
 * 2. Detect enabled tool categories
 * 3. Build filtered tool registry
 * 4. Build dynamic system prompt
 * 5. Inject context (memory, dreams)
 * 6. Call LLM with tools
 * 7. Execute tool calls
 * 8. Return structured response
 */

import type {
  ProcessorConfig,
  ProcessorResult,
  ProcessorMessage,
  ProcessorOptions,
  ProcessorAvatarConfig,
  ProcessorMediaItem,
  ProcessorPendingJob,
  AvatarService,
  MemoryService,
  DreamsService,
  VoiceService,
} from './types.js';
import {
  detectEnabledCategories,
  createToolContext,
  filterTools,
  type ToolContext,
  type FilterableToolDefinition,
} from './tool-builder.js';
import { buildDynamicSystemPrompt, buildChatSystemPrompt } from './prompt-builder.js';
import { resolveSystemPrompt } from './system-prompt-resolver.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Strip avatar name prefix from response if the model accidentally included it.
 * Models sometimes see `[Username]: message` in history and mimic the pattern.
 */
function stripAvatarNamePrefix(content: string | undefined, avatarName: string | undefined): string {
  if (!content || !avatarName) return content || '';
  
  const escapedName = avatarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^\\[${escapedName}[^\\]]*\\]:\\s*`, 'i'),
    new RegExp(`^${escapedName}:\\s*`, 'i'),
  ];
  
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      return content.replace(pattern, '').trim();
    }
  }
  
  return content;
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * LLM tool definition in OpenAI format
 */
export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * LLM response with potential tool calls
 */
export interface LLMResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  media?: { type: 'image' | 'video' | 'sticker'; url: string; caption?: string };
  pendingJob?: ProcessorPendingJob;
}

/**
 * Dependencies injected into MessageProcessor
 */
export interface MessageProcessorDependencies {
  /** Service for loading avatar configuration */
  avatarService: AvatarService;
  /** Service for memory (remember/recall) */
  memoryService?: MemoryService;
  /** Service for dreams context */
  dreamsService?: DreamsService;
  /** Service for voice transcription */
  voiceService?: VoiceService;
  /** Function to get all registered tools */
  getRegisteredTools: (avatarId: string) => Promise<FilterableToolDefinition[]>;
  /** Function to convert tools to LLM format */
  toLLMFormat: (tools: FilterableToolDefinition[], context: ToolContext) => Promise<LLMTool[]>;
  /** Function to call the LLM */
  callLLM: (params: {
    messages: ProcessorMessage[];
    tools: LLMTool[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }) => Promise<LLMResponse>;
  /** Function to execute a tool */
  executeTool: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolExecutionResult>;
}

// =============================================================================
// MESSAGE PROCESSOR
// =============================================================================

/**
 * Unified message processor for all platforms.
 *
 * Usage:
 * ```typescript
 * const processor = new MessageProcessor(dependencies);
 * const result = await processor.process(
 *   'Hello!',
 *   conversationHistory,
 *   { avatarId: 'avatar123', platform: 'telegram', conversationId: 'chat456' }
 * );
 * ```
 */
export class MessageProcessor {
  private deps: MessageProcessorDependencies;

  constructor(dependencies: MessageProcessorDependencies) {
    this.deps = dependencies;
  }

  /**
   * Process a message and return the response.
   * This is the main entry point for all message processing.
   */
  async process(
    userMessage: string | null,
    conversationHistory: ProcessorMessage[],
    config: ProcessorConfig,
    options: ProcessorOptions = {}
  ): Promise<ProcessorResult> {
    // 1. Load avatar configuration
    const avatar = await this.loadAvatar(config.avatarId);
    if (!avatar) {
      return {
        response: 'Avatar not found.',
        history: conversationHistory,
      };
    }

    // 2. Build tool context
    const toolContext = createToolContext(config);

    // 3. Get filtered tools based on enabled categories
    const allTools = await this.deps.getRegisteredTools(config.avatarId);
    const filteredTools = await filterTools(allTools, toolContext, avatar.enabledCategories);
    const llmTools = await this.deps.toLLMFormat(filteredTools, toolContext);

    // 4. Build system prompt
    const systemPrompt = await this.buildSystemPrompt(avatar, config, options, userMessage, conversationHistory);

    // 5. Prepare messages
    const messages = await this.prepareMessages(
      systemPrompt,
      userMessage,
      conversationHistory,
      config,
      options
    );

    // 6. Run the LLM + tool execution loop
    const result = await this.runProcessingLoop(
      messages,
      llmTools,
      toolContext,
      avatar,
      options
    );

    return result;
  }

  /**
   * Load avatar configuration with enabled categories detection.
   */
  private async loadAvatar(avatarId: string): Promise<ProcessorAvatarConfig | null> {
    const avatar = await this.deps.avatarService.getAvatar(avatarId);
    if (!avatar) return null;

    // If enabledCategories not set, detect them
    if (!avatar.enabledCategories || avatar.enabledCategories.length === 0) {
      const enabledToolsets = avatar.mcpConfig?.enabledToolsets || [];
      avatar.enabledCategories = detectEnabledCategories({
        voice: true, // Default enabled unless env var disables
        memory: enabledToolsets.includes('memory'),
        telegram: Boolean(avatar.platforms?.telegram?.enabled),
        twitter: Boolean(avatar.platforms?.twitter?.enabled),
        discord: Boolean(avatar.platforms?.discord?.enabled),
        nft: true, // Default enabled
        property: enabledToolsets.includes('property'),
      });
    }

    return avatar;
  }

  /**
   * Build the system prompt with all context injected.
   */
  private async buildSystemPrompt(
    avatar: ProcessorAvatarConfig,
    config: ProcessorConfig,
    options: ProcessorOptions,
    userMessage: string | null,
    conversationHistory: ProcessorMessage[]
  ): Promise<string> {
    // Base prompt: custom prompt override if provided, otherwise build based on platform.
    // Note: we still inject dreams/memory below even for custom prompts.
    let systemPrompt: string = options.customSystemPrompt || '';

    if (!systemPrompt) {
      // If an operator override is set, the resolver returns it verbatim
      // (inline) or fetched (url) — see #1522. Fail-closed: on URL error the
      // resolver falls back to buildDynamicSystemPrompt, which for messaging
      // platforms is more than the chat template would produce, but still
      // correct. Without an override, keep the platform-specific defaults.
      if (avatar.systemPromptOverride) {
        systemPrompt = await resolveSystemPrompt(avatar, config.platform);
      } else if (config.platform === 'admin-ui' || config.platform === 'api') {
        systemPrompt = buildDynamicSystemPrompt(avatar, config.platform);
      } else {
        systemPrompt = buildChatSystemPrompt(avatar, config.platform as 'telegram' | 'discord' | 'twitter' | 'web');
      }
    }

    // Inject dreams context if enabled
    if (options.dreamsEnabled && this.deps.dreamsService && avatar.persona) {
      try {
        const { dream } = await this.deps.dreamsService.getDreamForResponse(
          config.avatarId,
          avatar.persona
        );
        const dreamSection = this.deps.dreamsService.formatDreamForPrompt(dream);
        if (dreamSection) {
          systemPrompt = dreamSection + '\n\n' + systemPrompt;
        }
      } catch {
        // Dreams context failed, continue without it
      }
    }

    // Inject memory context if memory category is enabled
    if (
      this.deps.memoryService &&
      avatar.enabledCategories.includes('memory')
    ) {
      try {
        const lastUserFromHistory = (() => {
          for (let i = conversationHistory.length - 1; i >= 0; i -= 1) {
            const msg = conversationHistory[i];
            if (msg?.role !== 'user') continue;
            if (typeof msg.content === 'string') return msg.content;
            // Multimodal: best-effort extract text parts.
            if (Array.isArray(msg.content)) {
              const text = msg.content
                .filter((p: { type?: string; text?: string }) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
                .map((p: { text?: string }) => p.text as string)
                .join('\n');
              if (text.trim()) return text;
            }
          }
          return '';
        })();

        const query = (userMessage ?? lastUserFromHistory).trim();

        const memoryContext = query && this.deps.memoryService.getMemoryContextForQuery
          ? await this.deps.memoryService.getMemoryContextForQuery(config.avatarId, query)
          : await this.deps.memoryService.getMemoryContext(config.avatarId);
        if (memoryContext) {
          systemPrompt += '\n\n' + memoryContext;
        }
      } catch {
        // Memory context failed, continue without it
      }
    }

    return systemPrompt;
  }

  /**
   * Prepare the messages array for the LLM.
   */
  private async prepareMessages(
    systemPrompt: string,
    userMessage: string | null,
    conversationHistory: ProcessorMessage[],
    config: ProcessorConfig,
    options: ProcessorOptions
  ): Promise<ProcessorMessage[]> {
    const messages: ProcessorMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
    ];

    // Add user message if present
    if (userMessage !== null) {
      let messageContent: string | ProcessorMessage['content'] = userMessage;

      // Handle audio transcription
      if (options.attachments && this.deps.voiceService) {
        const audioAttachments = options.attachments.filter(a => a.type === 'audio');
        for (const audio of audioAttachments) {
          try {
            const transcription = await this.deps.voiceService.transcribeAudio({
              avatarId: config.avatarId,
              url: audio.data,
            });
            if (transcription.text) {
              messageContent = `${messageContent}\n\n[Voice message transcription]: "${transcription.text}"`;
            }
          } catch {
            messageContent = `${messageContent}\n\n[Voice message received but transcription failed]`;
          }
        }
      }

      // Handle image attachments
      if (options.attachments) {
        const imageAttachments = options.attachments.filter(a => a.type === 'image');
        if (imageAttachments.length > 0) {
          messageContent = [
            { type: 'text' as const, text: messageContent as string },
            ...imageAttachments.map(a => ({
              type: 'image_url' as const,
              image_url: { url: a.data },
            })),
          ];
        }
      }

      messages.push({ role: 'user', content: messageContent as string });
    }

    return messages;
  }

  /**
   * Run the main processing loop (LLM call + tool execution).
   */
  private async runProcessingLoop(
    messages: ProcessorMessage[],
    tools: LLMTool[],
    context: ToolContext,
    avatar: ProcessorAvatarConfig,
    options: ProcessorOptions
  ): Promise<ProcessorResult> {
    const maxIterations = 10;
    let iterations = 0;
    const allMedia: ProcessorMediaItem[] = [];
    const pendingJobs: ProcessorPendingJob[] = [];
    const avatarUpdates: { profileImageUrl?: string; name?: string } = {};

    while (iterations < maxIterations) {
      iterations++;

      // Call LLM
      const callStart = Date.now();
      const llmResponse = await this.deps.callLLM({
        messages,
        tools,
        model: options.model || avatar.llmConfig?.model,
        maxTokens: options.maxTokens || avatar.llmConfig?.maxTokens,
        temperature: avatar.llmConfig?.temperature,
      });
      const latencyMs = Date.now() - callStart;

      logger.info('LLM call completed', {
        subsystem: 'llm',
        event: 'llm_call_completed',
        avatarId: avatar.avatarId,
        platform: context.platform,
        model: options.model || avatar.llmConfig?.model,
        latencyMs,
        promptTokens: llmResponse.usage?.promptTokens,
        completionTokens: llmResponse.usage?.completionTokens,
        totalTokens: llmResponse.usage?.totalTokens,
        finishReason: llmResponse.finishReason,
        toolCalls: llmResponse.toolCalls?.length || 0,
        iteration: iterations,
      });

      // If no tool calls, we're done
      if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
        // Strip avatar name prefix if the model accidentally added it
        const cleanedResponse = stripAvatarNamePrefix(llmResponse.content, avatar.name);
        return {
          response: cleanedResponse,
          history: messages.slice(1), // Remove system message
          media: allMedia.length > 0 ? allMedia : undefined,
          pendingJobs: pendingJobs.length > 0 ? pendingJobs : undefined,
          avatarUpdates: Object.keys(avatarUpdates).length > 0 ? avatarUpdates : undefined,
        };
      }

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: llmResponse.content || '',
        tool_calls: llmResponse.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of llmResponse.toolCalls) {
        const toolName = toolCall.function.name;
        let args: Record<string, unknown>;

        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ success: false, error: 'Invalid tool arguments' }),
          });
          continue;
        }

        // Execute the tool
        const result = await this.deps.executeTool(toolName, args, context);

        // Collect media and pending jobs
        if (result.media) {
          allMedia.push({
            type: result.media.type,
            url: result.media.url,
            caption: result.media.caption,
          });
        }

        if (result.pendingJob) {
          pendingJobs.push(result.pendingJob);
        }

        // Track avatar updates
        if (toolName === 'set_profile_image' && result.success && result.data) {
          const data = result.data as { url?: string };
          if (data.url) {
            avatarUpdates.profileImageUrl = data.url;
          }
        }

        if (toolName === 'update_profile' && result.success && result.data) {
          const data = result.data as { name?: string };
          if (data.name) {
            avatarUpdates.name = data.name;
          }
        }

        // Add tool result message
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Max iterations reached
    return {
      response: 'Processing took too long. Please try again.',
      history: messages.slice(1),
      media: allMedia.length > 0 ? allMedia : undefined,
      pendingJobs: pendingJobs.length > 0 ? pendingJobs : undefined,
    };
  }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a MessageProcessor with the given dependencies.
 */
export function createMessageProcessor(
  dependencies: MessageProcessorDependencies
): MessageProcessor {
  return new MessageProcessor(dependencies);
}
