# OpenRouter SDK + Zod Schema Refactor Plan

Last updated: 2026-01-10 (repo scan: admin-api + core + handlers)

## Overview

Refactor `packages/admin-api/src/handlers/chat.ts` to use the OpenRouter SDK's `tool()` helper with Zod schemas for type-safe tool definitions and automatic execution.

## Current State

- **26 tools** defined in `AGENT_TOOLS` array using OpenAI's raw JSON schema format
- Manual `fetch()` call to OpenRouter API in `callLLM()`
- Manual tool execution loop in `processChat()` with ~10 max iterations
- Special handling for "pause-for-input" tools: `request_secret`, `request_model_selection`, `get_profile_upload_url`, `get_reference_image_upload_url`, `set_profile_image` with `source="upload"`
- `processChat()` uses `pendingToolCall` to return upload URLs and wait for user input
- Giant `switch` statement in `executeTool()` with 26 cases
- Zod is already used for admin-api schemas in `packages/admin-api/src/types.ts` and Telegram webhook payload validation in `packages/admin-api/src/handlers/telegram-webhook.ts`, but admin chat tools are still JSON schema-based

## Status Check (2026-01-10)

- No `packages/admin-api/src/tools/` directory yet
- No `@openrouter/sdk` tool usage found in `packages/admin-api/src/handlers/chat.ts`
- `AGENT_TOOLS` + `executeTool()` remain the primary definitions/execution path

## Why Refactor?

1. **Type Safety**: Zod schemas provide runtime validation + TypeScript types
2. **Model Flexibility**: OpenRouter SDK works with any model (OpenAI, Anthropic, Google, etc.)
3. **Cleaner Code**: SDK handles message format conversion automatically
4. **Future-proof**: SDK handles tool execution loops, streaming, and format changes
5. **Validation**: Zod validates tool arguments before execution (catch bad LLM outputs)

## OpenRouter SDK Tool Pattern

```typescript
import { OpenRouter, tool } from '@openrouter/sdk';
import { z } from 'zod';

const myTool = tool({
  name: 'my_tool',
  description: 'What the tool does',
  inputSchema: z.object({
    param1: z.string().describe('Parameter description'),
    param2: z.number().optional().describe('Optional param'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async (params) => {
    // params is fully typed!
    return { success: true, message: 'Done' };
  },
});

// For tools that need user input (manual execution)
const manualTool = tool({
  name: 'request_secret',
  inputSchema: z.object({ ... }),
  execute: false, // Manual handling - no auto-execution
});
```

## Tool Categories

### 1. Auto-Execute Tools (SDK handles loop)
These can use `execute: async (params) => { ... }`:
- `store_secret`
- `update_my_profile`
- `list_available_models`
- `get_my_model_config`
- `change_my_model`
- `create_solana_wallet`
- `get_my_wallets`
- `get_wallet_balance`
- `get_my_secrets`
- `get_pending_jobs`
- `get_job_status`
- `set_profile_image` (for generate/url/gallery sources)
- `save_uploaded_profile_image`
- `save_reference_image`
- `list_reference_images`
- `delete_reference_image`
- `generate_image`
- `generate_video`
- `generate_sticker`
- `get_my_gallery`
- `search_gallery`
- `get_tool_credits`

### 2. Manual/Pause Tools (execute: false)
These need user interaction and should NOT auto-execute:
- `request_secret` → Shows secure input in UI
- `request_model_selection` → Shows dropdown in UI
- `get_profile_upload_url` → Returns upload widget
- `get_reference_image_upload_url` → Returns upload widget
- `set_profile_image` (source='upload') → Returns upload widget

## File Structure After Refactor

```
packages/admin-api/src/
├── handlers/
│   └── chat.ts                 # Slim orchestrator using SDK
├── tools/
│   ├── index.ts               # Export all tools
│   ├── schemas.ts             # Shared Zod schemas (secretType, etc.)
│   ├── secrets.ts             # request_secret, store_secret
│   ├── profile.ts             # update_my_profile, set_profile_image, etc.
│   ├── models.ts              # list_available_models, change_my_model, etc.
│   ├── wallets.ts             # create_solana_wallet, get_my_wallets, etc.
│   ├── media.ts               # generate_image, generate_video, etc.
│   └── gallery.ts             # get_my_gallery, search_gallery
└── types.ts                    # Keep existing types
```

## Shared Zod Schemas

```typescript
// tools/schemas.ts
import { z } from 'zod';

export const SecretTypeSchema = z.enum([
  'telegram_bot_token',
  'discord_bot_token',
  'twitter_api_key', 'twitter_api_secret', 'twitter_access_token',
  'twitter_access_secret', 'twitter_bearer_token',
  'helius_api_key', 'replicate_api_key', 'openrouter_api_key',
  'anthropic_api_key', 'openai_api_key',
]);

export const MediaTypeSchema = z.enum(['image', 'video', 'sticker']);

export const ImageSourceSchema = z.enum(['generate', 'url', 'gallery', 'upload']);

export const ResolutionSchema = z.enum(['1K', '2K', '4K']);

export const AspectRatioSchema = z.enum([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'
]);

export const ReferenceImageCategorySchema = z.enum([
  'profile', 'character', 'style', 'background', 'other'
]);
```

## Example Tool Conversions

### Before: request_secret (JSON Schema)
```typescript
{
  type: 'function',
  function: {
    name: 'request_secret',
    description: 'Request a secret value from the user...',
    parameters: {
      type: 'object',
      properties: {
        secretType: { type: 'string', enum: [...], description: '...' },
        label: { type: 'string', description: '...' },
        instructions: { type: 'string', description: '...' },
      },
      required: ['secretType', 'label'],
    },
  },
}
```

### After: request_secret (Zod + SDK)
```typescript
// tools/secrets.ts
import { tool } from '@openrouter/sdk';
import { z } from 'zod';
import { SecretTypeSchema } from './schemas.js';

export const requestSecret = tool({
  name: 'request_secret',
  description: 'Request a secret value from the user. Shows a secure input field in the UI.',
  inputSchema: z.object({
    secretType: SecretTypeSchema.describe('Type of secret being requested'),
    label: z.string().describe('Human-readable label for the input field'),
    instructions: z.string().optional().describe('Brief instructions on how to get this secret'),
  }),
  execute: false, // Manual - needs user interaction
});
```

### Before: generate_image (JSON Schema)
```typescript
{
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image...',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '...' },
        useProfileAsReference: { type: 'boolean', description: '...' },
        // ... more properties
      },
      required: ['prompt'],
    },
  },
}
```

### After: generate_image (Zod + SDK)
```typescript
// tools/media.ts
import { tool } from '@openrouter/sdk';
import { z } from 'zod';
import * as media from '../services/media.js';
import * as mediaJobs from '../services/media-jobs.js';
import { ResolutionSchema, AspectRatioSchema } from './schemas.js';

export const generateImage = (agentId: string) => tool({
  name: 'generate_image',
  description: 'Generate an image using Nano Banana Pro. Async - returns job ID immediately.',
  inputSchema: z.object({
    prompt: z.string().describe('Description of the image to generate'),
    useProfileAsReference: z.boolean().default(true).describe('Use profile image as reference'),
    galleryImageIds: z.array(z.string()).optional().describe('Gallery image IDs for references'),
    referenceImageId: z.string().optional().describe('Reference image ID'),
    resolution: ResolutionSchema.default('2K').describe('Output resolution'),
    aspectRatio: AspectRatioSchema.default('1:1').describe('Image aspect ratio'),
  }),
  outputSchema: z.object({
    jobId: z.string(),
    status: z.string(),
    message: z.string(),
  }),
  execute: async (params) => {
    const job = await media.generateImage(agentId, params);
    return {
      jobId: job.jobId,
      status: 'pending',
      message: `Image generation started! Job ID: ${job.jobId}. Check status with get_job_status.`,
    };
  },
});
```

## Implementation Steps

### Phase 1: Setup & Schemas (1-2 hours)
1. [x] Install dependencies: `@openrouter/sdk`, `zod` (already installed)
2. [ ] Create `packages/admin-api/src/tools/` directory
3. [ ] Create `tools/schemas.ts` with shared Zod schemas
4. [ ] Create `tools/index.ts` exporter

### Phase 2: Convert Tools (3-4 hours)
Convert tools in batches, testing each:

**Batch 1: Simple read-only tools**
- [ ] `get_my_model_config`
- [ ] `get_my_wallets`
- [ ] `get_my_secrets`
- [ ] `get_pending_jobs`
- [ ] `get_job_status`
- [ ] `get_tool_credits`

**Batch 2: Model management**
- [ ] `list_available_models`
- [ ] `change_my_model`
- [ ] `request_model_selection` (manual)

**Batch 3: Secrets**
- [ ] `request_secret` (manual)
- [ ] `store_secret`

**Batch 4: Profile & wallets**
- [ ] `update_my_profile`
- [ ] `create_solana_wallet`
- [ ] `get_wallet_balance`

**Batch 5: Media generation**
- [ ] `set_profile_image`
- [ ] `get_profile_upload_url`
- [ ] `save_uploaded_profile_image`
- [ ] `generate_image`
- [ ] `generate_video`
- [ ] `generate_sticker`

**Batch 6: Reference images & gallery**
- [ ] `get_reference_image_upload_url`
- [ ] `save_reference_image`
- [ ] `list_reference_images`
- [ ] `delete_reference_image`
- [ ] `get_my_gallery`
- [ ] `search_gallery`

### Phase 3: Refactor chat.ts (2-3 hours)
1. [ ] Import OpenRouter SDK and new tools
2. [ ] Create OpenRouter client factory
3. [ ] Replace `callLLM()` with SDK's `callModel()`
4. [ ] Handle manual tools (check for pause-for-input)
5. [ ] Remove old `AGENT_TOOLS` array
6. [ ] Remove old `executeTool()` switch statement
7. [ ] Update `processChat()` to use SDK patterns

### Phase 4: Testing & Cleanup (1-2 hours)
1. [ ] Test each tool category manually
2. [ ] Verify pause-for-input tools work correctly
3. [ ] Run existing tests
4. [ ] Remove unused imports and dead code
5. [ ] Update types.ts if needed

## Key Considerations

### 1. Agent Context Injection
Tools need `agentId` and `session` context. Options:
- **Factory pattern**: Create tools with context: `createTools(agentId, session)`
- **TurnContext**: Use SDK's `TurnContext` to pass data through

Recommendation: **Factory pattern** - cleaner and more explicit.

```typescript
// tools/index.ts
export function createAgentTools(agentId: string, session: UserSession) {
  return [
    requestSecret, // Manual tool - no context needed
    storeSecret(agentId, session),
    updateMyProfile(agentId, session),
    generateImage(agentId),
    // ...
  ] as const;
}
```

### 2. Manual Tool Detection
Need to detect when SDK returns manual tool calls for user interaction:

```typescript
const result = openrouter.callModel({
  model: LLM_MODEL,
  input: fromChatMessages(messages),
  tools: agentTools,
  maxToolRounds: 10, // Auto-execute up to 10 rounds
});

// Check for manual tool calls
const manualCalls = await result.getToolCalls();
for (const call of manualCalls) {
  if (call.name === 'request_secret') {
    // Return to UI for user input
    return { pendingToolCall: call, ... };
  }
}
```

Keep the existing `pendingToolCall` behavior for upload URLs and `set_profile_image` with `source="upload"` so the UI can render the file picker before continuing.

### 3. Message History Format
SDK uses `fromChatMessages()` / `toChatMessage()` for format conversion:
- Input: OpenAI-style messages → SDK internal format
- Output: SDK response → OpenAI-style message

Keep existing `AdminChatMessage` type for storage, convert on-the-fly.

### 4. Error Handling
SDK handles tool execution errors gracefully - sends error back to model.
Add Zod validation errors to output for better debugging.

## Rollback Plan

If issues arise:
1. Keep old `AGENT_TOOLS` and `executeTool()` in a separate file
2. Feature flag to switch between old/new implementation
3. Can revert by changing imports

## Success Criteria

- [ ] All 26 tools converted to Zod schemas
- [ ] SDK handles tool execution loop
- [ ] Manual tools pause correctly for user input
- [ ] Type inference works in executors
- [ ] All existing tests pass
- [ ] Can switch models via OpenRouter without issues
- [ ] Bundle size increase < 100KB (Zod + SDK)

## Estimated Timeline

| Phase | Duration | Complexity |
|-------|----------|------------|
| Phase 1: Setup | 1-2 hours | Low |
| Phase 2: Convert Tools | 3-4 hours | Medium |
| Phase 3: Refactor chat.ts | 2-3 hours | High |
| Phase 4: Testing | 1-2 hours | Medium |
| **Total** | **7-11 hours** | |

## Notes

- The OpenRouter SDK is already installed (`@openrouter/sdk@0.3.12`)
- Zod is already installed as a dependency
- Consider adding unit tests for tool schemas (parse/safeParse)
- May want to add tool-level rate limiting in execute functions
