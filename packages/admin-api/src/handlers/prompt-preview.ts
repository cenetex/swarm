/**
 * Prompt Preview Handler
 *
 * Returns a preview of what would be sent to the LLM for a given avatar context.
 * Useful for debugging and understanding avatar behavior.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { z } from 'zod';
import { authenticateRequest } from '../auth/request-auth.js';
import { isAuthError } from '../auth/errors.js';
import { isRequestValidationError, validateRequestBody } from '../middleware/validate.js';
import { getCorsHeaders } from '../http/cors.js';
import {
  buildDynamicSystemPrompt,
  type ToolCategory,
  type ProcessorAvatarConfig,
} from '@swarm/core';
import {
  ToolRegistry,
  registerAllTools,
  type ToolContext,
  type ToolsetId,
} from '@swarm/mcp-server';
import { createMCPServices } from '../services/mcp-adapter.js';
import * as avatars from '../services/avatars.js';
import { getEnabledToolsets } from '../services/mcp-config.js';
import { createSystemLogger } from '../services/structured-logger.js';

const log = createSystemLogger('prompt-preview');

const PreviewRequestSchema = z.object({
  avatarId: z.string(),
  message: z.string().optional(),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string().nullish().transform(v => v ?? ''),
  })).optional(),
});

interface ToolPreview {
  name: string;
  description: string;
  toolset: string;
  parameters: Record<string, unknown>;
}

interface PromptPreviewResponse {
  systemPrompt: string;
  tools: ToolPreview[];
  toolCount: number;
  enabledToolsets: string[];
  enabledCategories: string[];
  messages: Array<{
    role: string;
    content: string;
  }>;
  tokenEstimate: {
    systemPrompt: number;
    tools: number;
    messages: number;
    total: number;
  };
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

function resolveAllowedToolsets(categories?: ToolCategory[]): ToolsetId[] {
  const toolsets = new Set<ToolsetId>(['core', 'admin', 'config', 'jobs', 'models']);

  if (categories) {
    for (const category of categories) {
      const mapped = CATEGORY_TOOLSETS[category] || [];
      for (const toolset of mapped) {
        toolsets.add(toolset);
      }
    }
  }

  return Array.from(toolsets);
}

// Rough token estimation (4 chars per token is a common approximation)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);

  // CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate
    const session = await authenticateRequest(event);

    const { avatarId, message, history = [] } = await validateRequestBody(PreviewRequestSchema)(event);

    // Get avatar config
    let avatarRecord;
    try {
      avatarRecord = await avatars.getAvatar(avatarId);
    } catch (e) {
      log.error('handler', 'avatar_lookup_failed', { avatarId, message: e instanceof Error ? e.message : String(e) });
      return {
        statusCode: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to load avatar', message: e instanceof Error ? e.message : 'Database error' }),
      };
    }
    if (!avatarRecord) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Avatar not found' }),
      };
    }

    // Determine enabled categories based on avatar configuration
    const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
    const mcpConfig = avatarRecord.mcpConfig;
    const enabledToolsets = mcpConfig?.enabledToolsets || [];

    const enabledCategories: ToolCategory[] = [
      'secrets', 'profile', 'media', 'gallery', 'wallets', 'diagnostics'
    ];
    // Voice enabled by default (unless env var disables it)
    if (voiceEnabled) enabledCategories.push('voice');
    // Platform categories based on platform config
    if (avatarRecord.platforms?.telegram?.enabled) enabledCategories.push('telegram');
    if (avatarRecord.platforms?.twitter?.enabled) enabledCategories.push('twitter');
    if (avatarRecord.platforms?.discord?.enabled) enabledCategories.push('discord');
    // NFT tools are enabled by default
    enabledCategories.push('nft');
    // Memory and property require explicit opt-in via mcpConfig
    if (enabledToolsets.includes('memory')) enabledCategories.push('memory');
    if (enabledToolsets.includes('property')) enabledCategories.push('property');

    // Build system prompt using unified prompt builder
    const avatarConfig: ProcessorAvatarConfig = {
      avatarId,
      name: avatarRecord.name,
      description: avatarRecord.description,
      persona: avatarRecord.persona,
      enabledCategories,
    };
    const systemPrompt = buildDynamicSystemPrompt(avatarConfig, 'admin-ui');

    // Get enabled toolsets (fallback to category defaults on failure)
    let mcpEnabledToolsets: ToolsetId[] = [];
    try {
      mcpEnabledToolsets = await getEnabledToolsets(avatarId);
    } catch (e) {
      log.warn('handler', 'mcp_config_lookup_failed', { avatarId, message: e instanceof Error ? e.message : String(e) });
    }
    const categoryToolsets = resolveAllowedToolsets(enabledCategories);

    // Merge: use MCP enabled toolsets if configured, otherwise use category-based defaults
    const effectiveToolsets = mcpEnabledToolsets.length > 1
      ? mcpEnabledToolsets
      : categoryToolsets;

    // Build tool registry — if this fails, return partial response with system prompt only
    let toolPreviews: ToolPreview[] = [];
    let toolError: string | undefined;
    try {
      const mcpServices = createMCPServices(avatarId, session, undefined, { readOnly: true });
      const toolRegistry = new ToolRegistry();
      registerAllTools(toolRegistry, mcpServices);

      const toolContext: ToolContext = {
        avatarId,
        platform: 'admin-ui',
        session: {
          email: session.email,
          isAdmin: session.isAdmin,
        },
      };

      // Get tools filtered by platform and toolsets
      const allTools = toolRegistry.getForPlatform(toolContext.platform);
      const toolsetFiltered = allTools.filter(tool =>
        effectiveToolsets.includes(tool.toolset || 'core')
      );

      // Filter out tools where shouldShow returns false
      const visibilityChecks = await Promise.all(
        toolsetFiltered.map(async (tool) => {
          if (tool.shouldShow) {
            try {
              return await tool.shouldShow(toolContext);
            } catch {
              return true; // Show on error
            }
          }
          return true; // No shouldShow = always visible
        })
      );
      const filteredTools = toolsetFiltered.filter((_, index) => visibilityChecks[index]);

      // Build tool previews — skip individual tools that fail schema conversion
      const results = await Promise.allSettled(
        filteredTools.map(async (tool) => {
          let description = tool.description;
          if (tool.contextBuilder) {
            try {
              const contextStr = await tool.contextBuilder(toolContext);
              if (contextStr) {
                description = `${description}\n\n📌 ${contextStr}`;
              }
            } catch {
              // Ignore context builder errors in preview
            }
          }

          let parameters: Record<string, unknown> = {};
          try {
            const { $schema: _, ...rest } = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
            parameters = rest;
          } catch (e) {
            log.warn('handler', 'tool_schema_conversion_failed', { tool: tool.name, message: e instanceof Error ? e.message : String(e) });
            parameters = { error: 'Schema conversion failed' };
          }

          return {
            name: tool.name,
            description,
            toolset: tool.toolset || 'core',
            parameters,
          };
        })
      );
      toolPreviews = (results as PromiseSettledResult<ToolPreview>[])
        .filter((r): r is PromiseFulfilledResult<ToolPreview> => r.status === 'fulfilled')
        .map(r => r.value);
    } catch (e) {
      toolError = e instanceof Error ? e.message : String(e);
      log.error('handler', 'tool_registry_failed', { avatarId, message: toolError });
    }

    // Build message preview
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
    ];
    if (message) {
      messages.push({ role: 'user', content: message });
    }

    // Estimate tokens
    const toolsJson = JSON.stringify(toolPreviews);
    const messagesText = messages.map(m => m.content).join('\n');

    const tokenEstimate = {
      systemPrompt: estimateTokens(systemPrompt),
      tools: estimateTokens(toolsJson),
      messages: estimateTokens(messagesText) - estimateTokens(systemPrompt), // Don't double count system
      total: 0,
    };
    tokenEstimate.total = tokenEstimate.systemPrompt + tokenEstimate.tools + tokenEstimate.messages;

    const response: PromptPreviewResponse = {
      systemPrompt,
      tools: toolPreviews,
      toolCount: toolPreviews.length,
      enabledToolsets: effectiveToolsets,
      enabledCategories,
      messages,
      tokenEstimate,
    };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...response, ...(toolError ? { toolError } : {}) }),
    };
  } catch (error) {
    if (isAuthError(error)) {
      return {
        statusCode: error.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message, details: error.details }),
      };
    }

    if (isRequestValidationError(error)) {
      return {
        statusCode: error.statusCode,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message, details: error.details }),
      };
    }

    log.error('handler', 'prompt_preview_error', { message: error instanceof Error ? error.message : String(error) });
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
