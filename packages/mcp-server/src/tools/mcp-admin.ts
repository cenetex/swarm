/**
 * MCP Admin Tools
 *
 * Tools for listing and toggling MCP servers (toolsets and external servers).
 * Only available in admin mode.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';
import { TOOLSETS, type ToolsetId } from '../tool-metadata.js';

// Toolset metadata for display
const TOOLSET_INFO: Record<ToolsetId, { name: string; description: string }> = {
  core: { name: 'Core', description: 'Basic response tools (always enabled)' },
  media: { name: 'Media', description: 'Image, video, and sticker generation' },
  voice: { name: 'Voice', description: 'Text-to-speech and voice cloning' },
  wallet: { name: 'Wallet', description: 'Solana and Ethereum wallet management' },
  profile: { name: 'Profile', description: 'Avatar profile and persona updates' },
  gallery: { name: 'Gallery', description: 'Media gallery and reference images' },
  secrets: { name: 'Secrets', description: 'API keys and credential management' },
  jobs: { name: 'Jobs', description: 'Background job and credit management' },
  reference: { name: 'Reference', description: 'Character reference images' },
  models: { name: 'Models', description: 'LLM model configuration' },
  config: { name: 'Config', description: 'Avatar configuration settings' },
  admin: { name: 'Admin', description: 'Administrative tools' },
  diagnostics: { name: 'Diagnostics', description: 'Issue reporting and debugging' },
  telegram: { name: 'Telegram', description: 'Telegram bot integration' },
  twitter: { name: 'Twitter', description: 'Twitter/X integration' },
  discord: { name: 'Discord', description: 'Discord bot integration' },
  property: { name: 'Property', description: 'Real estate property research' },
  memory: { name: 'Memory', description: 'Long-term memory and recall' },
  nft: { name: 'NFT', description: 'NFT ownership and lineage' },
  'claude-code': { name: 'Claude Code', description: 'Claude Code avatar for coding tasks' },
  moltbook: { name: 'Moltbook', description: 'Moltbook social network for AI agents' },
};

export interface McpConfig {
  enabledToolsets: ToolsetId[];
  externalServers: ExternalMcpServer[];
}

export interface ExternalMcpServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  addedAt: number;
  addedBy: string;
}

export interface McpAdminServices {
  getMcpConfig: (avatarId: string) => Promise<McpConfig | null>;
  updateMcpConfig: (avatarId: string, config: McpConfig, updatedBy: string) => Promise<void>;
}

export const createMcpAdminTools = (services: McpAdminServices) => [
  defineTool({
    name: 'list_mcp_servers',
    description: `List all available MCP servers (internal toolsets and external servers) for an avatar.
Shows which are currently enabled and provides descriptions for each.
Use this to see what capabilities can be enabled for the avatar.`,
    toolset: 'admin',
    platforms: ['admin-ui', 'api', 'mcp'],
    inputSchema: z.object({
      avatarId: z.string().optional().describe('Avatar ID to list servers for. Uses context avatar if omitted.'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const avatarId = input.avatarId || context.avatarId;
      if (!avatarId || avatarId === 'default') {
        return { success: false, error: 'Avatar ID required' };
      }

      try {
        const config = await services.getMcpConfig(avatarId);
        const enabledToolsets = config?.enabledToolsets || [];
        const externalServers = config?.externalServers || [];

        // Build internal toolsets list
        const internalServers = TOOLSETS.map((toolsetId) => {
          const info = TOOLSET_INFO[toolsetId];
          return {
            id: toolsetId,
            type: 'internal' as const,
            name: info.name,
            description: info.description,
            enabled: toolsetId === 'core' || enabledToolsets.includes(toolsetId),
            alwaysEnabled: toolsetId === 'core',
          };
        });

        // Build external servers list
        const external = externalServers.map((server) => ({
          id: server.id,
          type: 'external' as const,
          name: server.name,
          description: `${server.transport.toUpperCase()} server${server.command ? `: ${server.command}` : ''}${server.url ? `: ${server.url}` : ''}`,
          enabled: server.enabled,
          transport: server.transport,
          alwaysEnabled: false,
        }));

        const enabledCount = internalServers.filter((s) => s.enabled).length + external.filter((s) => s.enabled).length;
        const totalCount = internalServers.length + external.length;

        return {
          success: true,
          data: {
            avatarId,
            summary: `${enabledCount}/${totalCount} servers enabled`,
            internal: internalServers,
            external,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to list MCP servers: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    },
  }),

  defineTool({
    name: 'toggle_mcp_server',
    description: `Enable or disable an MCP server (toolset or external server) for an avatar.
Internal toolsets control which tool categories are available.
External servers are custom MCP connections (stdio or SSE).
Note: 'core' toolset cannot be disabled.`,
    toolset: 'admin',
    platforms: ['admin-ui', 'api', 'mcp'],
    inputSchema: z.object({
      avatarId: z.string().optional().describe('Avatar ID to configure. Uses context avatar if omitted.'),
      serverId: z.string().describe('ID of the server/toolset to toggle'),
      enabled: z.boolean().describe('Whether to enable (true) or disable (false)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const avatarId = input.avatarId || context.avatarId;
      if (!avatarId || avatarId === 'default') {
        return { success: false, error: 'Avatar ID required' };
      }

      // Prevent disabling core
      if (input.serverId === 'core' && !input.enabled) {
        return { success: false, error: 'Cannot disable core toolset' };
      }

      try {
        const config = await services.getMcpConfig(avatarId);
        const currentConfig: McpConfig = config || {
          enabledToolsets: [],
          externalServers: [],
        };

        // Check if it's an internal toolset
        if (TOOLSETS.includes(input.serverId as ToolsetId)) {
          const toolsetId = input.serverId as ToolsetId;
          if (input.enabled) {
            // Add to enabled list if not already there
            if (!currentConfig.enabledToolsets.includes(toolsetId)) {
              currentConfig.enabledToolsets.push(toolsetId);
            }
          } else {
            // Remove from enabled list
            currentConfig.enabledToolsets = currentConfig.enabledToolsets.filter(
              (t) => t !== toolsetId
            );
          }
        } else {
          // Check if it's an external server
          const serverIndex = currentConfig.externalServers.findIndex(
            (s) => s.id === input.serverId
          );
          if (serverIndex === -1) {
            return { success: false, error: `Server '${input.serverId}' not found` };
          }
          currentConfig.externalServers[serverIndex].enabled = input.enabled;
        }

        // Save updated config
        await services.updateMcpConfig(
          avatarId,
          currentConfig,
          context.session?.email || 'system'
        );

        const info = TOOLSETS.includes(input.serverId as ToolsetId)
          ? TOOLSET_INFO[input.serverId as ToolsetId]
          : currentConfig.externalServers.find((s) => s.id === input.serverId);

        return {
          success: true,
          data: {
            avatarId,
            serverId: input.serverId,
            enabled: input.enabled,
            message: `${input.enabled ? 'Enabled' : 'Disabled'} ${info?.name || input.serverId}`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to toggle MCP server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    },
  }),

  defineTool({
    name: 'add_external_mcp_server',
    description: `Add an external MCP server connection to an avatar.
Supports stdio (command-based) and SSE (HTTP-based) transports.
The server will be added but disabled by default.`,
    toolset: 'admin',
    platforms: ['admin-ui', 'api', 'mcp'],
    inputSchema: z.object({
      avatarId: z.string().optional().describe('Avatar ID to add server to. Uses context avatar if omitted.'),
      name: z.string().describe('Display name for the server'),
      transport: z.enum(['stdio', 'sse']).describe('Transport type'),
      command: z.string().optional().describe('For stdio: command to run (e.g., "npx", "node")'),
      args: z.array(z.string()).optional().describe('For stdio: command arguments'),
      url: z.string().optional().describe('For SSE: server URL'),
      env: z.record(z.string(), z.string()).optional().describe('Environment variables to set'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const avatarId = input.avatarId || context.avatarId;
      if (!avatarId || avatarId === 'default') {
        return { success: false, error: 'Avatar ID required' };
      }

      // Validate transport-specific fields
      if (input.transport === 'stdio' && !input.command) {
        return { success: false, error: 'Command required for stdio transport' };
      }
      if (input.transport === 'sse' && !input.url) {
        return { success: false, error: 'URL required for SSE transport' };
      }

      try {
        const config = await services.getMcpConfig(avatarId);
        const currentConfig: McpConfig = config || {
          enabledToolsets: [],
          externalServers: [],
        };

        // Generate unique ID
        const id = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const newServer: ExternalMcpServer = {
          id,
          name: input.name,
          enabled: false, // Disabled by default
          transport: input.transport,
          command: input.command,
          args: input.args,
          url: input.url,
          env: input.env,
          addedAt: Date.now(),
          addedBy: context.session?.email || 'system',
        };

        currentConfig.externalServers.push(newServer);

        await services.updateMcpConfig(
          avatarId,
          currentConfig,
          context.session?.email || 'system'
        );

        return {
          success: true,
          data: {
            avatarId,
            server: newServer,
            message: `Added external MCP server '${input.name}'. Use toggle_mcp_server to enable it.`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to add external MCP server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    },
  }),

  defineTool({
    name: 'remove_external_mcp_server',
    description: `Remove an external MCP server connection from an avatar.`,
    toolset: 'admin',
    platforms: ['admin-ui', 'api', 'mcp'],
    inputSchema: z.object({
      avatarId: z.string().optional().describe('Avatar ID to remove server from. Uses context avatar if omitted.'),
      serverId: z.string().describe('ID of the external server to remove'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const avatarId = input.avatarId || context.avatarId;
      if (!avatarId || avatarId === 'default') {
        return { success: false, error: 'Avatar ID required' };
      }

      try {
        const config = await services.getMcpConfig(avatarId);
        if (!config) {
          return { success: false, error: 'No MCP config found for avatar' };
        }

        const serverIndex = config.externalServers.findIndex((s) => s.id === input.serverId);
        if (serverIndex === -1) {
          return { success: false, error: `External server '${input.serverId}' not found` };
        }

        const removed = config.externalServers.splice(serverIndex, 1)[0];

        await services.updateMcpConfig(
          avatarId,
          config,
          context.session?.email || 'system'
        );

        return {
          success: true,
          data: {
            avatarId,
            serverId: input.serverId,
            message: `Removed external MCP server '${removed.name}'`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to remove external MCP server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    },
  }),
];

export default createMcpAdminTools;
