/**
 * Admin Chatbot Handler
 * Conversational interface for setting up agents with tool use
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { authenticateRequest, requireAdmin } from '../auth/cloudflare-access.js';
import * as chatHistory from '../services/chat-history.js';
import {
  ChatRequestSchema,
  type AdminChatMessage,
  type ToolCall,
  type ToolResult,
  type UserSession,
} from '../types.js';
import {
  ToolRegistry,
  createToolClient,
  registerAllTools,
} from '@swarm/mcp-server';
import { logger } from '@swarm/core';
import { createMCPServices } from '../services/mcp-adapter.js';
import { buildDynamicSystemPrompt, detectEnabledCategories, type ToolCategory } from '../services/dynamic-prompts.js';
import { recordError } from '../services/auto-issues.js';

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';

// Timeout settings
const LLM_TIMEOUT_MS = 60_000; // 60 seconds for LLM calls (can be slow)

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Cache the API key after first fetch
let cachedApiKey: string | null = null;

async function getLlmApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  
  if (!LLM_API_KEY_SECRET_ARN) {
    throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  }

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({
    SecretId: LLM_API_KEY_SECRET_ARN,
  }));

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  // Parse JSON secret (handles {"api_key": "..."} format)
  try {
    const parsed = JSON.parse(response.SecretString);
    cachedApiKey = parsed.api_key || parsed.apiKey || parsed.API_KEY;
    if (!cachedApiKey) {
      logger.error('LLM API key not found in parsed secret', undefined, { keysAvailable: Object.keys(parsed) });
      throw new Error('api_key not found in secret');
    }
  } catch (e) {
    // Plain string secret - check if it looks like an API key
    if (response.SecretString.startsWith('sk-')) {
      cachedApiKey = response.SecretString;
    } else {
      logger.error('Failed to parse LLM secret', e);
      throw new Error('Invalid LLM API key format');
    }
  }

  logger.info('LLM API key loaded', { keyPrefix: cachedApiKey.substring(0, 10) });
  return cachedApiKey!;
}

/**
 * Sanitize conversation history to ensure valid message format
 * Removes orphaned tool results and ensures proper message structure
 */
function sanitizeMessages(messages: AdminChatMessage[]): AdminChatMessage[] {
  const sanitized: AdminChatMessage[] = [];
  const validToolCallIds = new Set<string>();

  // First pass: collect valid tool call IDs from assistant messages
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          validToolCallIds.add(tc.id);
        }
      }
    }
  }

  // Second pass: filter and validate messages
  for (const msg of messages) {
    if (msg.role === 'tool') {
      // Only include tool results that have a matching tool call
      const toolCallId = (msg as ToolResult).tool_call_id;
      if (!toolCallId || !validToolCallIds.has(toolCallId)) {
        logger.info('Skipping orphaned tool result', { toolCallId });
        continue;
      }
    }
    sanitized.push(msg);
  }

  return sanitized;
}

interface AgentContext {
  id: string;
  name?: string;
  description?: string;
  persona?: string;
  enabledCategories?: ToolCategory[];
}

/**
 * Build system prompt dynamically based on enabled tool categories
 */
function buildSystemPrompt(agent?: AgentContext): string {
  if (agent) {
    // Use dynamic prompt builder with enabled categories
    const categories = agent.enabledCategories || [
      // Default categories if not specified
      'secrets', 'profile', 'media', 'gallery', 'wallets', 'diagnostics'
    ];
    
    return buildDynamicSystemPrompt({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      persona: agent.persona,
      enabledCategories: categories,
      platform: 'admin-ui',
    });
  }

  // Fallback for no agent context
  return `You are a Swarm agent assistant. Please select an agent to chat with.`;
}

/**
 * Execute a tool call using MCP ToolClient
 * Agent-centric: all operations use the agent's own ID from context
 */
async function executeTool(
  toolCall: ToolCall,
  toolClient: ReturnType<typeof createToolClient>,
  agentContext?: AgentContext
): Promise<ToolResult> {
  const { name, arguments: argsString } = toolCall.function;

  try {
    // Handle empty or undefined arguments (common for tools with no parameters)
    const args = argsString && argsString.trim() ? JSON.parse(argsString) : {};

    // Most tools require agent context
    if (!agentContext && !['request_secret'].includes(name)) {
      throw new Error('Agent context required for this operation');
    }

    const agentId = agentContext?.id;

    // Handle manual tools that need UI interaction (request_secret, set_profile_image with upload)
    if (name === 'request_secret') {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({
          type: 'secret_request',
          ...args,
          agentId,
        }, null, 2),
      };
    }

    if (name === 'set_profile_image' && args.source === 'upload') {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({
          type: 'profile_upload_request',
          agentId,
        }, null, 2),
      };
    }

    if (name === 'request_model_selection') {
      if (!toolClient || !agentId) {
        throw new Error('Tool client not initialized');
      }

      const family = typeof args.family === 'string'
        ? args.family
        : typeof args.preferredFamily === 'string'
          ? args.preferredFamily
          : undefined;

      const listResult = await toolClient.execute('list_available_models', family ? { family } : {}, { agentId });
      const configResult = await toolClient.execute('get_my_model_config', {}, { agentId });

      const models = listResult.success
        ? Array.isArray(listResult.data)
          ? listResult.data
          : Array.isArray((listResult.data as { models?: unknown })?.models)
            ? (listResult.data as { models: Array<{ id: string; name: string }> }).models
            : []
        : [];
      const currentModel = configResult.success
        ? typeof (configResult.data as { model?: string } | undefined)?.model === 'string'
          ? (configResult.data as { model?: string }).model
          : typeof (configResult.data as { config?: { model?: string } } | undefined)?.config?.model === 'string'
            ? (configResult.data as { config: { model?: string } }).config.model
            : undefined
        : undefined;

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({
          type: 'model_selector',
          models,
          currentModel,
          ...(family ? { instructions: `Showing models filtered by "${family}".` } : {}),
        }, null, 2),
      };
    }

    // Execute via MCP ToolClient
    const mcpResult = await toolClient.execute(name, args, { agentId: agentId || '' });

    // Handle pending async jobs specially - don't expose jobId to LLM
    // The jobId is hidden in metadata for the UI to extract
    if (mcpResult.pendingJob) {
      const friendlyType = mcpResult.pendingJob.type === 'video' ? 'video' : 'image';
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({
          success: true,
          message: `${friendlyType.charAt(0).toUpperCase() + friendlyType.slice(1)} generation started! I'll send it when it's ready.`,
          // Hidden metadata for UI extraction (prefixed with _ to indicate internal)
          _pendingJob: mcpResult.pendingJob,
        }, null, 2),
      };
    }

    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      content: JSON.stringify(mcpResult.success ? mcpResult.data : { error: true, message: mcpResult.error }, null, 2),
    };
  } catch (error) {
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      content: JSON.stringify({
        error: true,
        message: error instanceof Error ? error.message : 'Unknown error'
      }),
    };
  }
}

/**
 * Call the LLM API
 * Sanitizes messages to remove orphaned tool results that cause validation errors
 */
async function callLLM(
  messages: AdminChatMessage[],
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  agent?: AgentContext
): Promise<{
  message?: string;
  toolCalls?: ToolCall[];
}> {
  const apiKey = await getLlmApiKey();
  const systemPrompt = buildSystemPrompt(agent);

  // Sanitize messages to ensure valid format (remove orphaned tool results)
  const sanitizedMessages = sanitizeMessages(messages);

  // Build request body - only include tools if there are any
  const requestBody: Record<string, unknown> = {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...sanitizedMessages,
    ],
    max_tokens: 2048,
  };

  // Only add tools to request if we have some (empty array causes 400 errors)
  if (tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
  }

  logger.info('LLM request', {
    event: 'llm_request',
    model: LLM_MODEL,
    messageCount: sanitizedMessages.length,
    toolsIncluded: tools.length > 0,
    toolChoice: tools.length > 0 ? 'auto' : 'none',
  });

  const response = await fetchWithTimeout(
    LLM_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://swarm.admin',
        'X-Title': 'Swarm Admin',
      },
      body: JSON.stringify(requestBody),
    },
    LLM_TIMEOUT_MS
  );

  if (!response.ok) {
    const text = await response.text();
    logger.error('LLM API error', undefined, { status: response.status, responsePreview: text.slice(0, 500) });
    throw new Error(`LLM API error: ${response.status} ${text}`);
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: ToolCall[];
      };
    }>;
  };
  const choice = data.choices?.[0];
  
  if (!choice) {
    throw new Error('No response from LLM');
  }

  logger.info('LLM response', {
    event: 'llm_response',
    hasContent: !!choice.message?.content,
    contentLength: choice.message?.content?.length || 0,
    toolCallCount: choice.message?.tool_calls?.length || 0,
    toolNames: choice.message?.tool_calls?.map(tc => tc.function?.name) || [],
  });

  return {
    message: choice.message?.content,
    toolCalls: choice.message?.tool_calls,
  };
}

/** Media item generated during chat */
interface MediaItem {
  type: 'image' | 'video' | 'sticker';
  url: string;
  prompt?: string;
  id?: string;
}

/**
 * Extract media URLs from tool results
 */
function extractMediaFromToolResults(toolResults: ToolResult[]): MediaItem[] {
  const media: MediaItem[] = [];

  for (const result of toolResults) {
    try {
      const parsed = JSON.parse(result.content);

      // Get URL from either 'url' or 'resultUrl' field
      const mediaUrl = parsed.url || parsed.resultUrl;

      // Direct image/media generation result (check for success + url/resultUrl)
      // Also check for status === 'completed' as alternative success indicator
      const isSuccess = parsed.success || (parsed.status === 'completed' && mediaUrl);
      if (isSuccess && mediaUrl && typeof mediaUrl === 'string') {
        // Determine type from context, parsed.type, or file extension
        let mediaType: 'image' | 'video' | 'sticker' = parsed.type || 'image';
        if (mediaUrl.includes('.mp4') || mediaUrl.includes('.webm') || mediaUrl.includes('/video')) {
          mediaType = 'video';
        } else if (mediaUrl.includes('/sticker')) {
          mediaType = 'sticker';
        }

        media.push({
          type: mediaType,
          url: mediaUrl,
          prompt: parsed.prompt,
          id: parsed.id || parsed.jobId,
        });
      }

      // Gallery items
      if (Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (item.url) {
            media.push({
              type: item.type || 'image',
              url: item.url,
              prompt: item.prompt,
              id: item.id,
            });
          }
        }
      }
    } catch {
      // Not JSON, skip
    }
  }

  return media;
}

/**
 * Process a chat message, executing tools as needed
 */
async function processChat(
  userMessage: string,
  conversationHistory: AdminChatMessage[],
  session: UserSession,
  agent?: AgentContext
): Promise<{
  response: string;
  history: AdminChatMessage[];
  media?: MediaItem[];
  pendingJobs?: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }>;
  agentUpdates?: { profileImageUrl?: string };
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}> {
  // Create MCP ToolClient for this agent context
  const agentId = agent?.id;
  let toolClient: ReturnType<typeof createToolClient> | null = null;
  let enabledCategories: ToolCategory[] | undefined;
  
  if (agentId) {
    const registry = new ToolRegistry();
    const mcpServices = createMCPServices(agentId, session);
    registerAllTools(registry, mcpServices);
    toolClient = createToolClient(registry, 'admin-ui');
    
    // Detect which tool categories are enabled based on available services
    enabledCategories = detectEnabledCategories({
      voice: !!mcpServices.voice,
      memory: !!mcpServices.memory,
      telegram: !!mcpServices.telegram,
      twitter: !!mcpServices.twitter,
      discord: !!mcpServices.discord,
      nft: !!mcpServices.nft,
      property: !!mcpServices.property,
    });
    
    // Update agent context with enabled categories
    if (agent) {
      agent.enabledCategories = enabledCategories;
    }
    
    logger.info('Enabled tool categories', {
      event: 'enabled_categories',
      agentId,
      categories: enabledCategories,
    });
  }
  
  // Get OpenAI-formatted tools with injected context
  let openAITools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];
  if (toolClient && agentId) {
    try {
      openAITools = await toolClient.getOpenAIToolsWithContext(agentId);
    } catch (e) {
      logger.error('Failed to get tools with context', e);
      openAITools = toolClient.getOpenAITools();
    }
  }

  // Log tools available for debugging
  logger.info('Tools created', {
    event: 'tools_created',
    agentId,
    toolCount: openAITools.length,
    toolNames: openAITools.map(t => t.function.name),
  });

  const messages: AdminChatMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  let response: string | undefined;
  let pendingToolCall: { id: string; name: string; arguments: Record<string, unknown> } | undefined;
  const allMedia: MediaItem[] = [];
  const pendingJobs: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }> = [];
  const agentUpdates: { profileImageUrl?: string } = {};
  const failedTools = new Set<string>(); // Track failed tools to prevent infinite retry loops
  let iterations = 0;
  const maxIterations = 10; // Prevent infinite loops

  while (iterations < maxIterations) {
    iterations++;

    const llmResponse = await callLLM(messages, openAITools, agent);
    
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      // Check for manual/pause tools that need user input
      // These tools don't have execute functions and require UI interaction
      const manualToolNames = [
        'request_secret',
        'request_property_research',
        'confirm_action',
      ];
      const manualTool = llmResponse.toolCalls.find(tc =>
        manualToolNames.includes(tc.function.name)
      );

      if (manualTool) {
        // Don't execute manual tools - return to the frontend for user input
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(manualTool.function.arguments || '{}');
        } catch (e) {
          logger.error('Failed to parse tool arguments', e, { toolName: manualTool.function.name });
        }
        pendingToolCall = {
          id: manualTool.id,
          name: manualTool.function.name,
          arguments: args,
        };
        
        logger.info('Manual tool detected, setting pendingToolCall', {
          event: 'pending_tool_call_set',
          toolId: manualTool.id,
          toolName: manualTool.function.name,
          argsKeys: Object.keys(args),
        });

        // Add the assistant message with the tool call (but not executed)
        response = llmResponse.message || '';
        messages.push({
          role: 'assistant',
          content: response,
          tool_calls: llmResponse.toolCalls,
        });
        break;
      }

      // Check for upload URL tools - these need user interaction to upload
      const uploadUrlTool = llmResponse.toolCalls.find(tc => {
        if (tc.function.name === 'get_profile_upload_url' ||
            tc.function.name === 'get_reference_image_upload_url' ||
            tc.function.name === 'get_character_reference_upload_url' ||
            tc.function.name === 'request_model_selection') {
          return true;
        }
        // Also check for set_profile_image or set_character_reference with source='upload'
        if (tc.function.name === 'set_profile_image' || tc.function.name === 'set_character_reference') {
          try {
            const toolArgs = JSON.parse(tc.function.arguments || '{}');
            return toolArgs.source === 'upload';
          } catch {
            return false;
          }
        }
        return false;
      });

      if (uploadUrlTool) {
        // Execute the tool to get the UI payload (upload URL or model selector)
        if (!toolClient) {
          throw new Error('Tool client not initialized');
        }
        const toolResult = await executeTool(uploadUrlTool, toolClient, agent);
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(toolResult.content || '{}');
        } catch (e) {
          logger.error('Failed to parse tool result', e);
        }

        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: llmResponse.message || '',
          tool_calls: llmResponse.toolCalls,
        });

        // Return the upload URL result as a pending tool call for the UI
        pendingToolCall = {
          id: uploadUrlTool.id,
          name: uploadUrlTool.function.name,
          arguments: toolArgs,
        };
        
        // Use appropriate fallback message based on tool type
        if (uploadUrlTool.function.name === 'request_model_selection') {
          response = llmResponse.message || 'Please select a model:';
        } else {
          response = llmResponse.message || 'Please upload your image:';
        }
        break;
      }
      
      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: llmResponse.message || '',
        tool_calls: llmResponse.toolCalls,
      });

      // Execute all tool calls, but skip already-failed tools
      const toolResults = await Promise.all(
        llmResponse.toolCalls.map(async (tc) => {
          const toolName = tc.function.name;
          
          // Skip tools that have already failed to prevent infinite loops
          if (failedTools.has(toolName)) {
            logger.info('Skipping retry of failed tool', { toolName });
            return {
              tool_call_id: tc.id,
              role: 'tool' as const,
              content: JSON.stringify({ 
                error: true, 
                message: 'This tool already failed. Please inform the user and do not retry.' 
              }),
            };
          }
          
          if (!toolClient) {
            return {
              tool_call_id: tc.id,
              role: 'tool' as const,
              content: JSON.stringify({ error: true, message: 'Tool client not initialized' }),
            };
          }
          const result = await executeTool(tc, toolClient, agent);
          
          // Track failed tools, but not transient errors
          try {
            const parsed = JSON.parse(result.content);
            if (parsed.error) {
              const errorMsg = parsed.message || '';
              const isTransientError = 
                errorMsg.includes('Rate limited') ||
                errorMsg.includes('not found') ||
                errorMsg.includes('Gallery is empty');
              
              if (!isTransientError) {
                failedTools.add(toolName);
                logger.info('Tool added to failedTools', { toolName, errorMsg });
              } else {
                logger.info('Tool failed with transient error (not blocking)', { toolName, errorMsg });
              }
            }
          } catch {
            // Not JSON, skip
          }
          
          return result;
        })
      );

      // Extract any media from the tool results
      for (const result of toolResults) {
        logger.info('Tool result', { toolCallId: result.tool_call_id, contentLength: result.content?.length || 0 });

        // Extract pending jobs from _pendingJob metadata (hidden from LLM)
        if (result.content && typeof result.content === 'string') {
          try {
            const parsed = JSON.parse(result.content);
            if (parsed._pendingJob) {
              pendingJobs.push({
                jobId: parsed._pendingJob.jobId,
                type: parsed._pendingJob.type || 'image',
                prompt: parsed._pendingJob.prompt,
                purpose: parsed._pendingJob.purpose,
              });
            }
          } catch {
            // Not JSON, skip
          }
        }
      }

      const mediaFromResults = extractMediaFromToolResults(toolResults);
      logger.info('Extracted media items from tool results', { count: mediaFromResults.length });
      allMedia.push(...mediaFromResults);

      // Check for profile image updates from tool results
      for (const tc of llmResponse.toolCalls) {
        if (tc.function.name === 'set_profile_image' || tc.function.name === 'save_uploaded_profile_image') {
          const matchingResult = toolResults.find(r => r.tool_call_id === tc.id);
          if (matchingResult?.content && typeof matchingResult.content === 'string') {
            try {
              const parsed = JSON.parse(matchingResult.content);
              if (parsed.success && (parsed.data?.url || parsed.url)) {
                agentUpdates.profileImageUrl = parsed.data?.url || parsed.url;
                logger.info('Profile image updated', { profileImageUrl: agentUpdates.profileImageUrl });
              }
            } catch {
              // Not JSON, skip
            }
          }
        }
      }

      // Add tool results
      for (const result of toolResults) {
        messages.push(result as AdminChatMessage);
      }

      // Continue the loop to get the next response
      continue;
    }

    // No tool calls, we have a final response
    response = llmResponse.message || 'I apologize, but I couldn\'t generate a response.';
    messages.push({ role: 'assistant', content: response });
    break;
  }

  if (!response) {
    response = 'I apologize, but I exceeded the maximum number of tool calls. Please try again with a simpler request.';
    messages.push({ role: 'assistant', content: response });
  }

  logger.info('Final response', { 
    mediaCount: allMedia.length, 
    pendingJobCount: pendingJobs.length,
    hasPendingToolCall: !!pendingToolCall,
    pendingToolCallName: pendingToolCall?.name,
  });
  return { 
    response, 
    history: messages, 
    media: allMedia.length > 0 ? allMedia : undefined, 
    pendingJobs: pendingJobs.length > 0 ? pendingJobs : undefined,
    agentUpdates: agentUpdates.profileImageUrl ? agentUpdates : undefined,
    pendingToolCall,
  };
}

/**
 * Lambda handler for admin chat API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const resolveCorsOrigin = (): string => {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);
    const fallbackOrigin = allowedOrigins[0] || 'http://localhost:5173';
    const requestOrigin = event.headers['origin'] || event.headers['Origin'];
    if (!requestOrigin) return fallbackOrigin;
    const normalizedRequest = requestOrigin.replace(/\/$/, '');
    const match = allowedOrigins.find(allowed => normalizedRequest === allowed.replace(/\/$/, ''));
    return match || fallbackOrigin;
  };

  // CORS headers - restricted to configured admin domains
  const allowedOrigin = resolveCorsOrigin();
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate the request
    const session = await authenticateRequest(event);
    const requestId = event.requestContext.requestId;
    
    // Set logging context for this handler
    logger.setContext({ subsystem: 'chat', requestId });
    
    // Require admin access
    if (!requireAdmin(session)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    const method = event.requestContext.http.method;

    // GET /chat?agentId=xxx - Retrieve chat history
    if (method === 'GET') {
      const agentId = event.queryStringParameters?.agentId;
      const history = await chatHistory.getChatHistory(session, agentId);
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ history }),
      };
    }

    // DELETE /chat?agentId=xxx - Clear chat history
    if (method === 'DELETE') {
      const agentId = event.queryStringParameters?.agentId;
      await chatHistory.clearChatHistory(session, agentId);
      
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    }

    // POST /chat - Send a message
    // Parse and validate request body
    const parseResult = ChatRequestSchema.safeParse(JSON.parse(event.body || '{}'));
    if (!parseResult.success) {
      logger.error('Validation error', undefined, {
        event: 'validation_error',
        agentId: JSON.parse(event.body || '{}').agent?.id,
        requestId,
        errors: parseResult.error.errors,
        bodyPreview: event.body?.substring(0, 500),
      });
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid request',
          details: parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
        }),
      };
    }
    const { message, history, agent } = parseResult.data;

    // Log request entry
    logger.info('Request received', {
      event: 'request_received',
      agentId: agent?.id,
      requestId,
      messageLength: message.length,
      historyLength: history.length,
    });

    // Process the chat with agent context
    const result = await processChat(message, history, session, agent);

    // Save the updated history to DynamoDB for cross-device sync
    await chatHistory.saveChatHistory(session, result.history, agent?.id);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: result.response,
        history: result.history,
        // Include media generated during this response
        media: result.media,
        // Include pending jobs for async generation (image/video)
        pendingJobs: result.pendingJobs,
        // Include pending tool call if one needs user input
        pendingToolCall: result.pendingToolCall,
        // Include agent updates (e.g., profile image changes)
        agentUpdates: result.agentUpdates,
      }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('Handler error', error, {
      event: 'handler_error',
      requestId: event.requestContext.requestId,
    });

    // Record error in auto-issues system
    recordError({
      error: errorMessage,
      stack: errorStack,
      subsystem: 'chat',
      category: 'handler_error',
      requestId: event.requestContext.requestId,
    }).catch(() => {
      // Ignore recording failures
    });
    
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: errorMessage,
      }),
    };
  }
}
