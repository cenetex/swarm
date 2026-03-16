/**
 * @swarm/mcp-server
 * 
 * Unified tool management via Model Context Protocol.
 * 
 * This package provides:
 * 1. ToolRegistry - Central registry for all tool definitions
 * 2. Tool factories - Functions to create tool instances with service injection
 * 3. MCP Server - Expose tools via MCP for any MCP-compatible client
 * 4. ToolClient - Direct tool invocation for Lambda handlers
 * 
 * Usage in handlers:
 * ```typescript
 * import { ToolRegistry, createToolClient, createMediaTools, createGalleryTools } from '@swarm/mcp-server';
 * 
 * const registry = new ToolRegistry();
 * registry.registerAll(createMediaTools(mediaService, creditService));
 * registry.registerAll(createGalleryTools(galleryService));
 * 
 * const client = createToolClient(registry, 'telegram');
 * const result = await client.execute('generate_image', { prompt: '...' }, { avatarId: '...' });
 * ```
 * 
 * Usage as MCP server:
 * ```typescript
 * import { runMCPServer, ToolRegistry } from '@swarm/mcp-server';
 * 
 * const registry = new ToolRegistry();
 * // ... register tools ...
 * 
 * runMCPServer({
 *   registry,
 *   defaultContext: { platform: 'api' },
 * });
 * ```
 */

// Core registry
export {
  ToolRegistry,
  defineTool,
  defineReadonlyTool,
  defineManualTool,
  globalRegistry,
  MANUAL_TOOL_NAMES,
  UPLOAD_TOOL_NAMES,
  isPauseForInputTool,
  withTaskAction,
  extractTaskAction,
  type TaskAction,
  type ToolContext,
  type ToolResult,
  type ToolDefinition,
} from './registry.js';

export {
  McpCatalogEntrySchema,
  McpCatalogSchema,
  ingestCatalog,
  type McpCatalog,
  type McpCatalogEntry,
  type CatalogIngestionOptions,
} from './catalog.js';

export {
  TOOLSETS,
  TOOL_TAGS,
  type ToolsetId,
  type ToolTag,
} from './tool-metadata.js';

export {
  routeTools,
  type ToolRoutingOptions,
  type ToolRoutingResult,
} from './tool-router.js';

// Client for direct invocation
export {
  ToolClient,
  createToolClient,
} from './client.js';

// MCP Server
export {
  createMCPServer,
  runMCPServer,
  type MCPServerOptions,
} from './server.js';

// Tool factories
export * from './tools/index.js';
