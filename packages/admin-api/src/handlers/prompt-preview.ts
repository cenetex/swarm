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
import { zodToJsonSchema } from 'zod-to-json-schema';
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

const PreviewRequestSchema = z.object({
  avatarId: z.string(),
  message: z.string().optional(),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string(),
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
  moltbook: ['moltbook'],
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
    const avatarRecord = await avatars.getAvatar(avatarId);
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

    // Get enabled toolsets from MCP config (or defaults if not configured)
    const mcpEnabledToolsets = await getEnabledToolsets(avatarId);
    const categoryToolsets = resolveAllowedToolsets(enabledCategories);

    // Merge: use MCP enabled toolsets if configured, otherwise use category-based defaults
    const effectiveToolsets = mcpEnabledToolsets.length > 1
      ? mcpEnabledToolsets
      : categoryToolsets;

    // Build tool registry
    const mcpServices = createMCPServices(avatarId, session);
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

    // Build tool previews
    const toolPreviews: ToolPreview[] = await Promise.all(
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

        return {
          name: tool.name,
          description,
          toolset: tool.toolset || 'core',
          parameters: zodToJsonSchema(tool.inputSchema, { target: 'openApi3' }) as Record<string, unknown>,
        };
      })
    );

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
      body: JSON.stringify(response),
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

    console.error('Prompt preview error:', error instanceof Error ? error.message : String(error));
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
