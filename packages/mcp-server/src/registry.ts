/**
 * MCP Tool Registry
 *
 * Unified tool definition and management system using Model Context Protocol.
 * All tools are defined once and can be exposed via MCP or used directly.
 *
 * Design Goals:
 * 1. Single source of truth for all tool definitions
 * 2. Zod-based schemas with automatic JSON Schema conversion
 * 3. Platform-agnostic execution (Telegram, Discord, Web, etc.)
 * 4. Context-aware tool descriptions
 * 5. Type-safe input/output validation
 */
import { z, type ZodType, type ZodObject, type ZodRawShape } from 'zod';

/** Convert a zod schema to JSON Schema, stripping the $schema field for OpenAI/MCP compat */
function zodToJsonSchema(schema: ZodType<any>, _opts?: { target?: string }): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
import { CATEGORY_TOOLSET_MAP, TOOLSET_DEFAULT_TAGS, type ToolsetId, type ToolTag } from './tool-metadata.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Execution context passed to every tool
 */
export interface ToolContext {
  /** The avatar ID executing the tool */
  avatarId: string;
  /** Platform the request originated from */
  platform: 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api' | 'mcp';
  /** User or chat identifier */
  userId?: string;
  /** Conversation/chat ID for async callbacks (raw ID, not prefixed) */
  conversationId?: string;
  /** Message ID to reply to for async callbacks */
  replyToMessageId?: string;
  /** Session data for auth/permissions */
  session?: {
    email?: string;
    isAdmin?: boolean;
  };
  /** Sender identity (for wallet-aware tools) */
  sender?: {
    walletAddress?: string;
    displayName?: string;
    avatarUrl?: string;
  };
}

/**
 * Tool execution result
 */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Media to send to the user */
  media?: {
    type: 'image' | 'video' | 'sticker';
    url: string;
    caption?: string;
  };
  /** Pending async job */
  pendingJob?: {
    jobId: string;
    type: 'image' | 'video' | 'sticker' | 'property_research' | 'claude_code';
    prompt?: string;
    purpose?: string;
    status?: string;
  };
  /** UI action (for admin-ui) */
  uiAction?: {
    type: 'upload_widget' | 'secret_request' | 'model_selector' | 'feature_toggle' | 'twitter_connect' | 'property_research';
    payload: Record<string, unknown>;
  };
}

/**
 * Tool definition - using 'any' for simpler registry storage
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<TInput = any, TOutput = unknown> {
  /** Unique tool name (snake_case) */
  name: string;
  /** Human-readable description for LLM */
  description: string;
  /** Optional category for organization */
  category?: 'media' | 'wallet' | 'profile' | 'config' | 'gallery' | 'secrets' | 'readonly' | 'diagnostics' | 'telegram' | 'property' | 'nft' | 'moltbook' | 'token-launch';
  /** Toolset grouping for routing */
  toolset?: ToolsetId;
  /** Tags for discovery/routing */
  tags?: ToolTag[];
  /** Zod schema for input validation */
  inputSchema: ZodType<TInput>;
  /** Zod schema for output validation (optional) */
  outputSchema?: ZodType<TOutput>;
  /** Execute the tool (false = manual/UI tool) */
  execute: ((input: TInput, context: ToolContext) => Promise<ToolResult<TOutput>>) | false;
  /** Platforms this tool is available on (default: all) */
  platforms?: Array<'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api' | 'mcp'>;
  /** Dynamic context builder for description enhancement */
  contextBuilder?: (context: ToolContext) => Promise<string | undefined>;
  /** Dynamic visibility check - return false to hide this tool from the list */
  shouldShow?: (context: ToolContext) => Promise<boolean>;
}

// ============================================================================
// Tool Registry
// ============================================================================

/**
 * Central registry for all tools
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /**
   * Register a tool
   */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, normalizeToolDefinition(tool));
  }

  /**
   * Register multiple tools
   */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Get a tool by name
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools filtered by platform
   */
  getForPlatform(platform: ToolContext['platform']): ToolDefinition[] {
    return this.getAll().filter(tool => {
      if (!tool.platforms) return true; // Default: available everywhere
      return tool.platforms.includes(platform);
    });
  }

  /**
   * Get tools filtered by category
   */
  getByCategory(category: ToolDefinition['category']): ToolDefinition[] {
    return this.getAll().filter(tool => tool.category === category);
  }

  /**
   * Execute a tool with validation
   */
  async execute<T = unknown>(
    name: string,
    input: unknown,
    context: ToolContext
  ): Promise<ToolResult<T>> {
    const tool = this.get(name);

    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` };
    }

    // Check platform availability
    if (tool.platforms && !tool.platforms.includes(context.platform)) {
      return { success: false, error: `Tool ${name} not available on ${context.platform}` };
    }

    // Manual tools don't execute
    if (tool.execute === false) {
      const uiActionType = (() => {
        switch (name) {
          case 'request_secret':
            return 'secret_request';
          case 'request_model_selection':
            return 'model_selector';
          case 'request_feature_toggle':
            return 'feature_toggle';
          case 'request_twitter_connection':
            return 'twitter_connect';
          case 'request_property_research':
            return 'property_research';
          default:
            return 'model_selector';
        }
      })();
      const payload = { ...(input as Record<string, unknown>), type: uiActionType };
      return {
        success: true,
        data: { type: 'manual_tool', name, input } as T,
        uiAction: {
          type: uiActionType,
          payload,
        },
      };
    }

    // Validate input
    const parseResult = tool.inputSchema.safeParse(input);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((e) => ({
        path: e.path.map((p: PropertyKey) => String(p)),
        message: e.message,
      }));

      // Provide structured hints for common, easily-fixable validation failures.
      const extra: Record<string, unknown> = {
        errorType: 'validation_error',
        tool: name,
        retryable: true,
        issues,
      };

      if (name === 'twitter_post' && input && typeof input === 'object') {
        const obj = input as Record<string, unknown>;
        const text = typeof obj.text === 'string' ? obj.text : undefined;
        if (typeof text === 'string') {
          const maxChars = 280;
          extra.constraints = { maxChars };
          extra.textLength = text.length;
          if (text.length > maxChars) {
            extra.overBy = text.length - maxChars;
            extra.hint = 'Tweet too long. Rewrite to <= 280 characters and retry twitter_post (keep any important URLs/mentions).';
          }
        }
      }

      return {
        success: false,
        error: `Validation error: ${parseResult.error.issues.map((e) => e.message).join(', ')}`,
        data: extra as T,
      };
    }

    // Execute
    try {
      const result = await tool.execute(parseResult.data, context);

      // Validate output if schema provided
      if (tool.outputSchema && result.success && result.data) {
        const outputResult = tool.outputSchema.safeParse(result.data);
        if (!outputResult.success) {
          console.warn(`[ToolRegistry] Output validation failed for ${name}:`, outputResult.error);
        }
      }

      return result as ToolResult<T>;
    } catch (error) {
      console.error(`[ToolRegistry] Tool ${name} error:`, error instanceof Error ? error.message : String(error));
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Convert tools to OpenAI function format
   */
  toOpenAIFormat(platform?: ToolContext['platform']): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    const tools = platform ? this.getForPlatform(platform) : this.getAll();

    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeOpenAiSchema(
          zodToJsonSchema(tool.inputSchema, { target: 'openApi3' }) as Record<string, unknown>
        ),
      },
    }));
  }

  /**
   * Convert a specific tool list to OpenAI function format
   */
  toOpenAIFormatForTools(tools: ToolDefinition[]): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeOpenAiSchema(
          zodToJsonSchema(tool.inputSchema, { target: 'openApi3' }) as Record<string, unknown>
        ),
      },
    }));
  }

  /**
   * Convert tools to OpenAI format with context-enhanced descriptions
   */
  async toOpenAIFormatWithContext(
    context: ToolContext
  ): Promise<Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>> {
    const tools = this.getForPlatform(context.platform);

    return Promise.all(
      tools.map(async tool => {
        let description = tool.description;

        // Inject dynamic context if available
        if (tool.contextBuilder) {
          const contextStr = await tool.contextBuilder(context);
          if (contextStr) {
            description = `${description}\n\n📌 ${contextStr}`;
          }
        }

        return {
          type: 'function' as const,
          function: {
            name: tool.name,
            description,
            parameters: sanitizeOpenAiSchema(
              zodToJsonSchema(tool.inputSchema, { target: 'openApi3' }) as Record<string, unknown>
            ),
          },
        };
      })
    );
  }

  /**
   * Convert a specific tool list to OpenAI format with context
   */
  async toOpenAIFormatWithContextForTools(
    context: ToolContext,
    tools: ToolDefinition[]
  ): Promise<Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>> {
    return Promise.all(
      tools.map(async tool => {
        let description = tool.description;

        if (tool.contextBuilder) {
          const contextStr = await tool.contextBuilder(context);
          if (contextStr) {
            description = `${description}\n\n📌 ${contextStr}`;
          }
        }

        return {
          type: 'function' as const,
          function: {
            name: tool.name,
            description,
            parameters: sanitizeOpenAiSchema(
              zodToJsonSchema(tool.inputSchema, { target: 'openApi3' }) as Record<string, unknown>
            ),
          },
        };
      })
    );
  }

  /**
   * Convert to MCP tool format
   */
  toMCPFormat(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }) as Record<string, unknown>,
    }));
  }

  /**
   * Convert to MCP tool format with metadata
   */
  toMCPFormatWithMetadata(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    metadata: {
      toolset: ToolsetId;
      tags: ToolTag[];
      category?: ToolDefinition['category'];
    };
  }> {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }) as Record<string, unknown>,
      metadata: {
        toolset: tool.toolset || 'core',
        tags: tool.tags || [],
        category: tool.category,
      },
    }));
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Helper to define a tool with full type inference
 */
export function defineTool<
  TInput extends ZodObject<ZodRawShape>,
  TOutput = unknown
>(definition: {
  name: string;
  description: string;
  category?: ToolDefinition['category'];
  toolset?: ToolsetId;
  tags?: ToolTag[];
  inputSchema: TInput;
  outputSchema?: ZodType<TOutput>;
  execute: ((input: z.infer<TInput>, context: ToolContext) => Promise<ToolResult<TOutput>>) | false;
  platforms?: ToolDefinition['platforms'];
  contextBuilder?: (context: ToolContext) => Promise<string | undefined>;
  shouldShow?: (context: ToolContext) => Promise<boolean>;
}): ToolDefinition<z.infer<TInput>, TOutput> {
  return definition as unknown as ToolDefinition<z.infer<TInput>, TOutput>;
}

/**
 * Create a read-only tool (no side effects)
 */
export function defineReadonlyTool<
  TInput extends ZodObject<ZodRawShape>,
  TOutput = unknown
>(
  definition: Omit<Parameters<typeof defineTool<TInput, TOutput>>[0], 'category'>
): ToolDefinition<z.infer<TInput>, TOutput> {
  return defineTool({ ...definition, category: 'readonly' });
}

/**
 * Create a manual/UI tool that doesn't auto-execute
 */
export function defineManualTool<TInput extends ZodObject<ZodRawShape>>(
  definition: Omit<Parameters<typeof defineTool<TInput, never>>[0], 'execute' | 'category'>
): ToolDefinition<z.infer<TInput>, never> {
  return defineTool({ ...definition, execute: false, category: 'config' });
}

function sanitizeOpenAiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...schema };
  delete sanitized.$schema;
  return sanitized;
}

function normalizeToolDefinition(tool: ToolDefinition): ToolDefinition {
  const toolset = tool.toolset
    || (tool.category ? CATEGORY_TOOLSET_MAP[tool.category] : undefined)
    || 'core';
  const tags = tool.tags && tool.tags.length > 0
    ? tool.tags
    : (TOOLSET_DEFAULT_TAGS[toolset] || []);

  return { ...tool, toolset, tags };
}

// Global registry singleton
export const globalRegistry = new ToolRegistry();

export default globalRegistry;
