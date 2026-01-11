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
import { createMCPServices } from '../services/mcp-adapter.js';
import { getPlatformPromptSection } from '../services/platform-prompts.js';

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
      console.error('LLM API key not found in parsed secret. Keys available:', Object.keys(parsed));
      throw new Error('api_key not found in secret');
    }
  } catch (e) {
    // Plain string secret - check if it looks like an API key
    if (response.SecretString.startsWith('sk-')) {
      cachedApiKey = response.SecretString;
    } else {
      console.error('Failed to parse LLM secret:', e);
      throw new Error('Invalid LLM API key format');
    }
  }

  console.log('LLM API key loaded, starts with:', cachedApiKey.substring(0, 10));
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
        console.log('[Chat] Skipping orphaned tool result:', toolCallId);
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
}

function buildSystemPrompt(agent?: AgentContext): string {
  if (agent) {
    return `You are ${agent.name || 'an AI agent'}, an AI agent being configured by your owner.
${agent.description ? `Your purpose: ${agent.description}` : ''}
${agent.persona ? `Your personality: ${agent.persona}` : ''}

You are setting yourself up. The user is your owner who is helping configure you.

## Your Capabilities

You can request and store secrets for various integrations:
- **Telegram**: Request bot token from @BotFather
- **Discord**: Request bot token from Discord Developer Portal
- **Twitter/X**: Request API credentials
- **Helius**: Request API key for Solana RPC (for wallet balance lookups)
- **Replicate**: API key for image/video generation (REQUIRED for media features)
- **AI Providers**: OpenRouter, Anthropic, OpenAI API keys

You can manage your Solana wallets:
- Create new wallets (private keys stored securely, you only see public keys)
- Check balances of your wallets (SOL and tokens)
- Share your public wallet addresses

You can update your profile:
- Change your name, description, and persona

You have media generation capabilities:
- Set your profile image using set_profile_image with these sources:
  - source="generate" - AI generates a profile image from a text prompt
  - source="upload" - Shows file picker for user to upload from their device (USE THIS when user wants to upload their own image!)
  - source="url" - Uses an image from a web URL
  - source="gallery" - Selects from existing gallery images
- Generate images with AI (async - returns immediately, image saved to gallery when complete)
- Generate videos (async - returns immediately, video saved to gallery when complete)
- Generate stickers (with transparent backgrounds)
- Browse and search your media gallery
- Check pending jobs with get_pending_jobs or get_job_status (for images AND videos)
- Check your tool credits (rate limited to prevent abuse)

**IMPORTANT**: Image and video generation are ASYNC. When you call generate_image or generate_video, you get a job ID back immediately. The actual media takes 30-60 seconds to generate. Tell the user to wait and check status with get_pending_jobs or get_job_status.

**RATE LIMITING**: Only generate ONE image or video per user message. If the user asks for multiple images, generate the first one and tell them to ask again for more after the first completes. Do NOT call generate_image multiple times in a single response.

## IMPORTANT: When to Use Tools

When the user asks you to generate/create/make an image, you MUST call the generate_image tool. Do NOT just say you'll make an image - actually call the tool!

When the user asks for a video, call generate_video.
When the user asks for a sticker, call generate_sticker.
When the user asks to set/change your profile picture, call set_profile_image.

Always USE the tools - don't just describe what you would do. Your personality should come through in your messages, but you must still execute the actual tool calls.

Your profile image is used for character consistency - when generating images/videos, you can reference it to maintain your visual identity.

## Tool Credits

Media tools are rate-limited with a credit system:
- generate_image: 20 credits max, refills 10/hour
- generate_video: 3 credits max, refills 1/hour
- generate_sticker: 5 credits max, refills 2/hour
- set_profile_image: 3 credits max, refills 1/hour

Each also has daily limits. Check with get_tool_credits to see your current status.

## How to Request Secrets

When the user wants to set up an integration (e.g., "setup telegram"), use the request_secret tool to prompt them for the credentials. This shows a secure input field in the UI. After they submit, use store_secret to save it.

Example flow:
1. User: "set up telegram"
2. You: Use request_secret with secretType="telegram_bot_token"
3. UI shows secure input
4. User submits token
5. You: Use store_secret to save it
6. Confirm success

## Security Notes
- Secrets are stored in AWS Secrets Manager with KMS encryption
- You can SET secrets but never READ their values
- Wallet private keys are generated securely and stored encrypted
- You can only see public keys and balances

Be friendly, helpful, and guide your owner through setup step by step.
${getPlatformPromptSection('admin-ui')}`;
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

  console.log(JSON.stringify({
    level: 'DEBUG',
    subsystem: 'chat',
    event: 'llm_request',
    model: LLM_MODEL,
    messageCount: sanitizedMessages.length,
    toolsIncluded: tools.length > 0,
    toolChoice: tools.length > 0 ? 'auto' : 'none',
  }));

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
    console.error('[Chat] LLM API error:', response.status, text.slice(0, 500));
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

  console.log(JSON.stringify({
    level: 'DEBUG',
    subsystem: 'chat',
    event: 'llm_response',
    hasContent: !!choice.message?.content,
    contentPreview: choice.message?.content?.slice(0, 100),
    toolCallCount: choice.message?.tool_calls?.length || 0,
    toolNames: choice.message?.tool_calls?.map(tc => tc.function?.name) || [],
  }));

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
  pendingJobs?: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string }>;
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
  
  if (agentId) {
    const registry = new ToolRegistry();
    const mcpServices = createMCPServices(agentId, session);
    registerAllTools(registry, mcpServices);
    toolClient = createToolClient(registry, 'admin-ui');
  }
  
  // Get OpenAI-formatted tools with injected context
  let openAITools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];
  if (toolClient && agentId) {
    try {
      openAITools = await toolClient.getOpenAIToolsWithContext(agentId);
    } catch (e) {
      console.error('[Chat] Failed to get tools with context:', e);
      openAITools = toolClient.getOpenAITools();
    }
  }

  // Log tools available for debugging
  console.log(JSON.stringify({
    level: 'DEBUG',
    subsystem: 'chat',
    event: 'tools_created',
    agentId,
    toolCount: openAITools.length,
    toolNames: openAITools.map(t => t.function.name),
  }));

  const messages: AdminChatMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  let response: string | undefined;
  let pendingToolCall: { id: string; name: string; arguments: Record<string, unknown> } | undefined;
  const allMedia: MediaItem[] = [];
  const pendingJobs: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string }> = [];
  const agentUpdates: { profileImageUrl?: string } = {};
  const failedTools = new Set<string>(); // Track failed tools to prevent infinite retry loops
  let iterations = 0;
  const maxIterations = 10; // Prevent infinite loops

  while (iterations < maxIterations) {
    iterations++;

    const llmResponse = await callLLM(messages, openAITools, agent);
    
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      // Check for manual/pause tools that need user input
      const manualTool = llmResponse.toolCalls.find(tc =>
        tc.function.name === 'request_secret'
      );

      if (manualTool) {
        // Don't execute manual tools - return to the frontend for user input
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(manualTool.function.arguments || '{}');
        } catch (e) {
          console.error(`Failed to parse ${manualTool.function.name} arguments:`, e);
        }
        pendingToolCall = {
          id: manualTool.id,
          name: manualTool.function.name,
          arguments: args,
        };

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
            tc.function.name === 'request_model_selection') {
          return true;
        }
        // Also check for set_profile_image with source='upload'
        if (tc.function.name === 'set_profile_image') {
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
          console.error('Failed to parse tool result:', e);
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
        response = llmResponse.message || 'Please upload your image:';
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
            console.log(`[Chat] Skipping retry of failed tool: ${toolName}`);
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
                console.log(`[Chat] Tool ${toolName} added to failedTools: ${errorMsg}`);
              } else {
                console.log(`[Chat] Tool ${toolName} failed with transient error (not blocking): ${errorMsg}`);
              }
            }
          } catch {
            // Not JSON, skip
          }
          
          return result;
        })
      );

      // Extract any media from the tool results
      // Log tool results for debugging
      for (const result of toolResults) {
        console.log(`[Chat] Tool result: ${result.tool_call_id}`, result.content?.slice(0, 200));
        
        // Extract pending jobs from _pendingJob metadata (hidden from LLM)
        try {
          const parsed = JSON.parse(result.content);
          if (parsed._pendingJob) {
            pendingJobs.push({
              jobId: parsed._pendingJob.jobId,
              type: parsed._pendingJob.type || 'image',
              prompt: parsed._pendingJob.prompt,
            });
          }
        } catch {
          // Not JSON, skip
        }
      }

      const mediaFromResults = extractMediaFromToolResults(toolResults);
      console.log(`[Chat] Extracted ${mediaFromResults.length} media items from tool results`);
      allMedia.push(...mediaFromResults);

      // Check for profile image updates from tool results
      for (const tc of llmResponse.toolCalls) {
        if (tc.function.name === 'set_profile_image' || tc.function.name === 'save_uploaded_profile_image') {
          const matchingResult = toolResults.find(r => r.tool_call_id === tc.id);
          if (matchingResult) {
            try {
              const parsed = JSON.parse(matchingResult.content);
              if (parsed.success && (parsed.data?.url || parsed.url)) {
                agentUpdates.profileImageUrl = parsed.data?.url || parsed.url;
                console.log(`[Chat] Profile image updated: ${agentUpdates.profileImageUrl}`);
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

  console.log(`[Chat] Final response with ${allMedia.length} media items, ${pendingJobs.length} pending jobs`);
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
  // CORS headers - restricted to configured admin domain
  const allowedOrigin = process.env.ALLOWED_ORIGINS?.split(',')[0] || 'http://localhost:5173';
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
    'Access-Control-Allow-Credentials': 'true',
  };

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    // Authenticate the request
    const session = await authenticateRequest(event);
    const requestId = event.requestContext.requestId;
    
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
      console.error(JSON.stringify({
        level: 'ERROR',
        subsystem: 'chat',
        event: 'validation_error',
        agentId: JSON.parse(event.body || '{}').agent?.id,
        requestId,
        errors: parseResult.error.errors,
        bodyPreview: event.body?.substring(0, 500),
      }));
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
    console.log(JSON.stringify({
      level: 'INFO',
      subsystem: 'chat',
      event: 'request_received',
      agentId: agent?.id,
      requestId,
      messageLength: message.length,
      historyLength: history.length,
    }));

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
    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'chat',
      event: 'handler_error',
      requestId: event.requestContext.requestId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }));
    
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
