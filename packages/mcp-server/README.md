# @swarm/mcp-server

Unified tool management via Model Context Protocol (MCP).

## Overview

This package provides a central registry for all agent tools, eliminating the duplicate implementations across handlers. Tools are defined once using Zod schemas and can be:

1. **Exposed via MCP** - For any MCP-compatible client (Claude, etc.)
2. **Called directly** - Via `ToolClient` in Lambda handlers
3. **Converted to OpenAI format** - For LLM function calling

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ToolRegistry                         │
│  ┌──────────┬──────────┬──────────┬──────────┐         │
│  │  media   │  gallery │  wallet  │  models  │ ...     │
│  └──────────┴──────────┴──────────┴──────────┘         │
└─────────────────────────────────────────────────────────┘
           │                        │
           ▼                        ▼
    ┌─────────────┐          ┌─────────────┐
    │ ToolClient  │          │  MCP Server │
    │ (handlers)  │          │   (stdio)   │
    └─────────────┘          └─────────────┘
           │                        │
           ▼                        ▼
    ┌─────────────┐          ┌─────────────┐
    │  Telegram   │          │   Claude    │
    │   Handler   │          │   Desktop   │
    └─────────────┘          └─────────────┘
```

## Usage

### In Lambda Handlers

```typescript
import {
  ToolRegistry,
  createToolClient,
  createMediaTools,
  createGalleryTools,
} from '@swarm/mcp-server';

// Create registry and register tools
const registry = new ToolRegistry();
registry.registerAll(createMediaTools(mediaService, creditService));
registry.registerAll(createGalleryTools(galleryService));

// Create client for this platform
const client = createToolClient(registry, 'telegram');

// Get OpenAI-format tools for LLM
const tools = client.getOpenAITools();

// Execute a tool
const result = await client.execute('generate_image', 
  { prompt: 'A whale on the moon' },
  { agentId: 'agent-123' }
);

if (result.media) {
  // Send the image to the user
  await sendPhoto(chatId, result.media.url, result.media.caption);
}
```

### As MCP Server

```typescript
import { runMCPServer, ToolRegistry, createMediaTools } from '@swarm/mcp-server';

const registry = new ToolRegistry();
registry.registerAll(createMediaTools(mediaService, creditService));
// ... register more tools

runMCPServer({
  name: 'swarm-agent-tools',
  version: '1.0.0',
  registry,
  defaultContext: { platform: 'api' },
  resolveAgentId: (meta) => {
    if (!meta?.agentId) {
      throw new Error('agentId is required for tool execution');
    }
    return meta.agentId as string;
  },
});
```

## Agent Identity and Scope

Tool execution must be scoped to a specific agent. MCP clients should pass `agentId` (and optional `userId`) in request metadata. The server should reject requests that do not provide an `agentId`, and services should enforce agent scoping for reads and writes (jobs, gallery, secrets, wallets).

Example metadata:

```json
{
  "_meta": {
    "agentId": "agent-123",
    "userId": "user-456"
  }
}
```

## Tool Categories

| Category | Tools | Description |
|----------|-------|-------------|
| `media` | generate_image, generate_video, generate_sticker | Media generation |
| `gallery` | get_my_gallery, search_gallery, send_gallery_image | Gallery management |
| `wallet` | get_my_wallets, create_solana_wallet, get_wallet_balance | Crypto wallets |
| `config` | list_available_models, change_my_model, get_my_model_config | LLM config |
| `profile` | update_my_profile, set_profile_image | Agent profile |
| `secrets` | get_my_secrets, store_secret | Secure credentials |
| `readonly` | get_pending_jobs, get_job_status, get_tool_credits | Status queries |

## Platform Availability

Some tools are restricted to specific platforms:

| Tool | telegram | discord | admin-ui | api |
|------|----------|---------|----------|-----|
| generate_image | ✅ | ✅ | ✅ | ✅ |
| create_solana_wallet | ❌ | ❌ | ✅ | ✅ |
| store_secret | ❌ | ❌ | ✅ | ✅ |
| request_model_selection | ❌ | ❌ | ✅ | ❌ |

## Context Injection

Tools can have dynamic descriptions based on current state:

```typescript
defineTool({
  name: 'send_gallery_image',
  description: 'Send an image from my gallery',
  contextBuilder: async (context) => {
    const items = await getGallery(context.agentId, { limit: 3 });
    return `Recent: ${items.map(i => i.id).join(', ')}`;
  },
  // ...
});

// Result: "Send an image from my gallery\n\n📌 Recent: img1, img2, img3"
```

## Migration Path

### Phase 1: ✅ Package Created
- Tool definitions in `@swarm/mcp-server`
- Registry and client infrastructure

### Phase 2: Handler Migration
1. Add `@swarm/mcp-server` to handler dependencies
2. Create service adapters from existing code
3. Replace inline tools with registry
4. Test parallel with old implementation
5. Remove old tool code

### Phase 3: MCP Endpoints
1. Deploy as standalone MCP server
2. Require agentId in MCP metadata and reject missing agent scope
3. Configure MCP clients (Claude Desktop or other) with command/args and env as needed
4. Enable agent management from MCP-compatible clients

## MCP Registration Checklist

1. Pick a deployment mode: local stdio for dev, hosted service for shared access.
2. Enforce `agentId` resolution and reject requests without scope.
3. Decide how clients supply identity (metadata vs env).
4. Add rate limits and audit logging around tool execution.
5. Document the client configuration format for your target MCP clients.

## Client Configuration Examples

### Claude Desktop (local stdio)

```json
{
  "mcpServers": {
    "swarm-tools": {
      "command": "pnpm",
      "args": ["--filter", "@swarm/mcp-server", "start"],
      "env": {
        "SWARM_AGENT_ID": "my-agent",
        "SWARM_PLATFORM": "admin-ui"
      }
    }
  }
}
```

### Hosted MCP Server (HTTP transport)

```json
{
  "mcpServers": {
    "swarm-tools": {
      "command": "node",
      "args": ["dist/server.js"],
      "env": {
        "MCP_ENDPOINT": "https://mcp.example.com",
        "SWARM_AGENT_ID": "my-agent",
        "SWARM_PLATFORM": "admin-ui"
      }
    }
  }
}
```

### Required Metadata

- `agentId` is required for every request (tool execution is scoped by agent).
- `platform` should be set to `admin-ui`, `telegram`, `discord`, `twitter`, or `api`.

## Development

```bash
# Build
pnpm build

# Watch mode  
pnpm dev

# Run as MCP server
pnpm start
```
