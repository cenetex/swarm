/**
 * MCP Client Adapter
 * 
 * Allows handlers to use the tool registry directly without MCP protocol overhead.
 * This is the bridge between the unified tool registry and platform-specific handlers.
 */
import { ToolRegistry, type ToolContext, type ToolResult, type ToolDefinition } from './registry.js';

export interface ToolClientOptions {
  /** The tool registry to use */
  registry: ToolRegistry;
  /** Platform this client is for */
  platform: ToolContext['platform'];
}

/**
 * Client for invoking tools from handlers
 */
export class ToolClient {
  private registry: ToolRegistry;
  private platform: ToolContext['platform'];

  constructor(options: ToolClientOptions) {
    this.registry = options.registry;
    this.platform = options.platform;
  }

  /**
   * Execute a tool by name
   */
  async execute<T = unknown>(
    toolName: string,
    args: Record<string, unknown>,
    context: { agentId: string; userId?: string; conversationId?: string; replyToMessageId?: string; session?: { email?: string; isAdmin?: boolean } }
  ): Promise<ToolResult<T>> {
    const fullContext: ToolContext = {
      ...context,
      platform: this.platform,
    };

    return this.registry.execute<T>(toolName, args, fullContext);
  }

  /**
   * Get tools in OpenAI function format for LLM calls
   */
  getOpenAITools(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return this.registry.toOpenAIFormat(this.platform);
  }

  /**
   * Get tools with context-enhanced descriptions
   */
  async getOpenAIToolsWithContext(
    agentId: string
  ): Promise<Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>> {
    return this.registry.toOpenAIFormatWithContext({
      agentId,
      platform: this.platform,
    });
  }

  /**
   * Get a tool definition by name
   */
  getTool(name: string): ToolDefinition | undefined {
    const tool = this.registry.get(name);
    if (!tool) return undefined;

    // Check platform availability
    if (tool.platforms && !tool.platforms.includes(this.platform)) {
      return undefined;
    }

    return tool;
  }

  /**
   * Check if a tool exists and is available for this platform
   */
  hasTool(name: string): boolean {
    return this.getTool(name) !== undefined;
  }

  /**
   * Check if a tool is a manual/UI tool
   */
  isManualTool(name: string): boolean {
    const tool = this.getTool(name);
    return tool?.execute === false;
  }

  /**
   * Get all available tool names
   */
  getToolNames(): string[] {
    return this.registry
      .getForPlatform(this.platform)
      .map(t => t.name);
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: ToolDefinition['category']): ToolDefinition[] {
    return this.registry
      .getByCategory(category)
      .filter(t => !t.platforms || t.platforms.includes(this.platform));
  }
}

/**
 * Create a tool client for a specific platform
 */
export function createToolClient(
  registry: ToolRegistry,
  platform: ToolContext['platform']
): ToolClient {
  return new ToolClient({ registry, platform });
}

export default ToolClient;
