/**
 * MCP Server for Swarm Agent Tools
 * 
 * Exposes agent tools via Model Context Protocol for use by any MCP client.
 * This enables tool sharing across different AI assistants and platforms.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry, type ToolContext } from './registry.js';

export interface MCPServerOptions {
  /** Name of the MCP server */
  name?: string;
  /** Version string */
  version?: string;
  /** The tool registry to expose */
  registry: ToolRegistry;
  /** Default context for tool execution */
  defaultContext: Omit<ToolContext, 'agentId'>;
  /** Function to resolve agent ID from request metadata */
  resolveAgentId?: (meta?: Record<string, unknown>) => string;
}

/**
 * Create and configure an MCP server
 */
export function createMCPServer(options: MCPServerOptions): Server {
  const {
    name = 'swarm-agent-tools',
    version = '1.0.0',
    registry,
    defaultContext,
    resolveAgentId,
  } = options;

  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = registry.toMCPFormat();
    return { tools };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;

    // Resolve agent ID - require it to be present
    const agentId = resolveAgentId?.(request.params._meta as Record<string, unknown> | undefined);
    if (!agentId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'agentId is required in request metadata' }) }],
        isError: true,
      };
    }

    // Build context
    const context: ToolContext = {
      ...defaultContext,
      agentId,
    };

    // Execute tool
    const result = await registry.execute(toolName, args, context);

    if (!result.success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: result.error }),
          },
        ],
        isError: true,
      };
    }

    // Format response
    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

    // Add data as text
    if (result.data) {
      content.push({
        type: 'text',
        text: JSON.stringify(result.data, null, 2),
      });
    }

    // Add media as embedded resource if present
    if (result.media) {
      content.push({
        type: 'text',
        text: `[Media: ${result.media.type}] ${result.media.url}${result.media.caption ? ` - ${result.media.caption}` : ''}`,
      });
    }

    // Add pending job info
    if (result.pendingJob) {
      content.push({
        type: 'text',
        text: `[Pending Job: ${result.pendingJob.type}] ID: ${result.pendingJob.jobId}`,
      });
    }

    return { content };
  });

  return server;
}

/**
 * Run the MCP server with stdio transport
 */
export async function runMCPServer(options: MCPServerOptions): Promise<void> {
  const server = createMCPServer(options);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error(`[MCP Server] ${options.name || 'swarm-agent-tools'} running on stdio`);
}

export default createMCPServer;
