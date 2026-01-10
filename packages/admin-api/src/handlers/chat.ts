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
import * as agents from '../services/agents.js';
import * as secrets from '../services/secrets.js';
import * as wallets from '../services/wallets.js';
import * as telegram from '../services/telegram.js';
import * as media from '../services/media.js';
import * as gallery from '../services/gallery.js';
import * as credits from '../services/credits.js';
import * as mediaJobs from '../services/media-jobs.js';
import * as chatHistory from '../services/chat-history.js';
import {
  ChatRequestSchema,
  type AdminChatMessage,
  type ToolCall,
  type ToolResult,
  type UserSession,
  type SecretType,
} from '../types.js';
import {
  createAgentTools,
  type ToolServices,
} from '../tools/index.js';
import {
  toOpenAITools,
  executeTool as executeToolWithValidation,
  type ToolDefinition,
} from '../tools/tool-helper.js';
import type { ZodObject, ZodRawShape } from 'zod';

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';

// Timeout settings
const LLM_TIMEOUT_MS = 60_000; // 60 seconds for LLM calls (can be slow)
const API_TIMEOUT_MS = 10_000; // 10 seconds for other API calls

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

/**
 * Build tool services for a specific agent context
 * These services encapsulate all business logic for tool execution
 */
function buildToolServices(
  agentId: string,
  session: UserSession
): ToolServices {
  return {
    // Agent config
    getAgentConfig: async () => {
      const agent = await agents.getAgent(agentId);
      if (!agent) return { error: 'Agent not found' };
      return {
        model: agent.llmConfig?.model || 'anthropic/claude-sonnet-4',
        temperature: agent.llmConfig?.temperature ?? 0.8,
        maxTokens: agent.llmConfig?.maxTokens || 1024,
        provider: agent.llmConfig?.provider || 'openrouter',
      };
    },
    updateAgentConfig: async (updates: unknown) => {
      await agents.updateAgent(agentId, updates as Record<string, unknown>, session);
    },

    // Wallets
    listWallets: async () => {
      const walletList = await wallets.listWallets(agentId);
      // Enrich with balances
      const enriched = await Promise.all(
        walletList
          .filter(w => w.walletType === 'solana')
          .map(async (w) => {
            try {
              const balance = await wallets.getSolanaBalance(w.publicKey, agentId);
              return { ...w, balance };
            } catch {
              return { ...w, balance: null };
            }
          })
      );
      return enriched;
    },
    createWallet: async (name: string) => {
      const result = await wallets.generateSolanaWallet(agentId, name, session);
      return { publicKey: result.publicKey, address: result.address };
    },
    getBalance: async (publicKey: string) => {
      const balance = await wallets.getSolanaBalance(publicKey, agentId);
      return { sol: (balance as { sol?: number })?.sol || 0, tokens: (balance as { tokens?: unknown[] })?.tokens || [] };
    },

    // Secrets
    listSecrets: async () => secrets.listSecrets(agentId),
    storeSecret: async (
      agentId: string,
      secretType: string,
      name: string,
      value: string,
      session: UserSession,
      description?: string
    ) => {
      await secrets.storeSecret(agentId, secretType as SecretType, name, value, session, description);

      // Special handling for Telegram bot tokens
      if (secretType === 'telegram_bot_token') {
        const validation = await telegram.validateTelegramToken(value);
        if (validation.valid) {
          // Enable Telegram platform on the agent
          await agents.updateAgent(agentId, {
            platforms: {
              telegram: {
                enabled: true,
                botUsername: validation.botInfo?.username
              }
            }
          }, session);

          // Register the webhook
          const webhookResult = await telegram.registerTelegramWebhook(value, agentId);
          if (webhookResult.success && webhookResult.secretToken) {
            // Store the webhook secret
            await secrets.storeSecret(
              agentId,
              'telegram_webhook_secret',
              'default',
              webhookResult.secretToken,
              session,
              `Telegram webhook secret for ${agentId}`
            );
          }
        }
      }
    },
    validateTelegramToken: telegram.validateTelegramToken,

    // Media jobs
    listPendingJobs: async () => {
      let pendingJobs = await mediaJobs.getPendingJobs(agentId);

      // Poll Replicate for processing jobs
      if (pendingJobs.length > 0) {
        const replicateKey = await media.getProviderApiKey(agentId, 'replicate');
        if (replicateKey) {
          for (const job of pendingJobs) {
            if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
              await mediaJobs.pollAndCompleteJob(job.jobId, replicateKey);
            }
          }
          pendingJobs = await mediaJobs.getPendingJobs(agentId);
        }
      }

      return pendingJobs.map(job => ({
        jobId: job.jobId,
        type: job.type,
        status: job.status,
        prompt: job.prompt,
        createdAt: new Date(job.createdAt).toISOString(),
        resultUrl: job.resultUrl,
        url: job.resultUrl,
        success: job.status === 'completed' && !!job.resultUrl,
      }));
    },
    getJob: async (jobId: string) => {
      let job = await mediaJobs.getJob(jobId);
      if (!job) return null;

      // Poll if still processing
      if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
        const replicateKey = await media.getProviderApiKey(job.agentId, 'replicate');
        if (replicateKey) {
          const polledJob = await mediaJobs.pollAndCompleteJob(job.jobId, replicateKey);
          if (polledJob) job = polledJob;
        }
      }

      return {
        jobId: job.jobId,
        type: job.type,
        status: job.status,
        prompt: job.prompt,
        createdAt: new Date(job.createdAt).toISOString(),
        updatedAt: new Date(job.updatedAt).toISOString(),
        completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : undefined,
        resultUrl: job.resultUrl,
        url: job.resultUrl,
        success: job.status === 'completed' && !!job.resultUrl,
        error: job.error,
      };
    },
    getCredits: async () => credits.getToolStatus(agentId),

    // Profile
    updateProfile: async (updates) => {
      await agents.updateAgent(agentId, updates, session);
    },
    getProfileUploadUrl: async () => media.getProfileImageUploadUrl(agentId),
    saveProfileImage: async (s3Key: string, publicUrl: string) => {
      await agents.updateAgent(agentId, {
        profileImage: { url: publicUrl, s3Key, updatedAt: Date.now() }
      }, session);
    },
    setProfileFromUrl: async (url: string) => {
      const result = await media.setProfileImage(agentId, { type: 'url', url });
      await agents.updateAgent(agentId, {
        profileImage: { url: result.url, s3Key: result.s3Key, updatedAt: Date.now() }
      }, session);
      return { success: true, url: result.url };
    },
    setProfileFromGallery: async (imageId: string) => {
      const result = await media.setProfileImage(agentId, { type: 'gallery', imageId });
      await agents.updateAgent(agentId, {
        profileImage: { url: result.url, s3Key: result.s3Key, updatedAt: Date.now() }
      }, session);
      return { success: true, url: result.url };
    },
    generateProfileImage: async (prompt: string) => {
      const result = await media.setProfileImage(agentId, { type: 'generate', prompt });
      // setProfileImage returns url/s3Key for generate, so we create a synthetic job response
      return { jobId: 'profile-' + Date.now(), status: result.url ? 'completed' : 'pending' };
    },

    // Media generation
    generateImage: async (params) => {
      // Check credits
      const canUse = await credits.canUseTool(agentId, 'generate_image');
      if (!canUse.allowed) {
        throw new Error(`Rate limited: ${canUse.reason}`);
      }

      // Build reference images
      const referenceImageUrls: string[] = [];

      if (params.useProfileAsReference !== false) {
        const agent = await agents.getAgent(agentId);
        if (agent?.profileImage?.url) {
          referenceImageUrls.push(agent.profileImage.url);
        } else {
          const refImages = await media.listReferenceImages(agentId);
          const profileRef = refImages.find(img => img.category === 'profile');
          const characterRef = refImages.find(img => img.category === 'character');
          if (profileRef?.url) referenceImageUrls.push(profileRef.url);
          else if (characterRef?.url) referenceImageUrls.push(characterRef.url);
        }
      }

      if (params.galleryImageIds) {
        for (const imageId of params.galleryImageIds) {
          const item = await gallery.getGalleryItem(agentId, imageId);
          if (item?.url) referenceImageUrls.push(item.url);
        }
      }

      if (params.referenceImageId) {
        const images = await media.listReferenceImages(agentId);
        const refImage = images.find(img => img.id === params.referenceImageId);
        if (refImage?.url) referenceImageUrls.push(refImage.url);
      }

      const job = await media.generateImageAsync({
        prompt: params.prompt,
        agentId,
        platform: 'admin-chat',
        referenceImageUrls,
        resolution: (params.resolution || '2K') as '1K' | '2K' | '4K',
        aspectRatio: (params.aspectRatio || '1:1') as '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9',
        conversationId: 'admin-chat-' + Date.now(),
      });

      await credits.consumeCredit(agentId, 'generate_image');

      return {
        jobId: job.jobId,
        status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
        resultUrl: undefined,
      };
    },
    generateVideo: async (params) => {
      const canUse = await credits.canUseTool(agentId, 'generate_video');
      if (!canUse.allowed) {
        throw new Error(`Rate limited: ${canUse.reason}`);
      }

      let referenceImageUrl: string | undefined;

      if (params.referenceImageId) {
        const images = await media.listReferenceImages(agentId);
        const refImage = images.find(img => img.id === params.referenceImageId);
        if (refImage) referenceImageUrl = refImage.url;
      } else if (params.useProfileAsReference !== false) {
        const agent = await agents.getAgent(agentId);
        if (agent?.profileImage?.url) {
          referenceImageUrl = agent.profileImage.url;
        } else {
          const refImages = await media.listReferenceImages(agentId);
          const profileRef = refImages.find(img => img.category === 'profile');
          const characterRef = refImages.find(img => img.category === 'character');
          referenceImageUrl = profileRef?.url || characterRef?.url;
        }
      }

      const job = await media.generateVideo({
        prompt: params.prompt,
        agentId,
        platform: 'admin-chat',
        conversationId: 'admin-chat-' + Date.now(),
        referenceImageUrl,
      });

      await credits.consumeCredit(agentId, 'generate_video');

      return {
        jobId: job.jobId,
        status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
        resultUrl: undefined,
      };
    },
    generateSticker: async (params) => {
      const canUse = await credits.canUseTool(agentId, 'generate_sticker');
      if (!canUse.allowed) {
        throw new Error(`Rate limited: ${canUse.reason}`);
      }

      const sticker = await media.generateSticker({
        prompt: params.prompt || 'sticker',
        agentId,
        platform: 'admin-chat',
        sourceImageId: params.sourceImageId,
      });

      await credits.consumeCredit(agentId, 'generate_sticker');

      return {
        jobId: sticker.id || 'direct',
        status: 'completed' as const,
        resultUrl: sticker.url,
      };
    },

    // Gallery
    listGallery: async (type?: string, limit?: number) => {
      const items = await gallery.getGallery(agentId, {
        type: type as 'image' | 'video' | 'sticker' | undefined,
        limit: limit || 20,
      });
      return items.map(item => ({
        id: item.id,
        type: item.type,
        url: item.url,
        prompt: item.prompt,
        createdAt: item.createdAt,
      }));
    },
    searchGallery: async (query: string, type?: string) => {
      const items = await gallery.findByDescription(
        agentId,
        query,
        type as 'image' | 'video' | 'sticker' | undefined
      );
      return items.map(item => ({
        id: item.id,
        type: item.type,
        url: item.url,
        prompt: item.prompt,
        createdAt: item.createdAt,
      }));
    },

    // Reference images
    getReferenceUploadUrl: async (category: string, name: string, _description?: string) => {
      type ReferenceCategory = 'profile' | 'character' | 'style' | 'background' | 'other';
      const result = await media.getReferenceImageUploadUrl(agentId, category as ReferenceCategory, name);
      return { uploadUrl: result.uploadUrl, s3Key: result.s3Key, publicUrl: result.publicUrl };
    },
    saveReferenceImage: async (data) => {
      type ReferenceCategory = 'profile' | 'character' | 'style' | 'background' | 'other';
      const result = await media.saveReferenceImage(
        agentId,
        data.category as ReferenceCategory,
        data.s3Key,
        data.publicUrl,
        data.name,
        data.description
      );
      return { id: result.id };
    },
    listReferenceImages: async (category?: string) => {
      type ReferenceCategory = 'profile' | 'character' | 'style' | 'background' | 'other';
      const images = await media.listReferenceImages(agentId, category as ReferenceCategory | undefined);
      return images.map(img => ({
        id: img.id,
        category: img.category,
        name: img.name,
        url: img.url,
        description: img.description,
      }));
    },
    deleteReferenceImage: async (imageId: string) => {
      await media.deleteReferenceImage(agentId, imageId);
    },

    // Models
    fetchModels: async (family?: string) => {
      const response = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/models',
        { headers: { 'Content-Type': 'application/json' } },
        API_TIMEOUT_MS
      );

      if (!response.ok) return [];

      const data = await response.json() as {
        data: Array<{
          id: string;
          name: string;
          pricing: { prompt: string; completion: string };
          context_length: number;
          top_provider?: { max_completion_tokens?: number };
        }>;
      };

      let models = data.data || [];

      if (family) {
        const f = family.toLowerCase();
        models = models.filter(m => m.id.toLowerCase().startsWith(f + '/'));
      }

      return models.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50);
    },
    updateModelConfig: async (config) => {
      const agent = await agents.getAgent(agentId);
      const newLlmConfig = { ...agent?.llmConfig, ...config };
      await agents.updateAgent(agentId, { llmConfig: newLlmConfig } as Record<string, unknown>, session);
    },
  };
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

Be friendly, helpful, and guide your owner through setup step by step.`;
  }

  // Fallback for no agent context
  return `You are a Swarm agent assistant. Please select an agent to chat with.`;
}

/**
 * Execute a tool call using Zod-based tools
 * Agent-centric: all operations use the agent's own ID from context
 */
async function executeTool(
  toolCall: ToolCall,
  _session: UserSession,
  agentTools: ToolDefinition<ZodObject<ZodRawShape>, unknown>[],
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

    // Find the matching tool definition
    const tool = agentTools.find(t => t.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Handle manual tools (execute === false)
    if (tool.execute === false) {
      // Manual tools return data for UI interaction
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({
          type: name === 'request_secret' ? 'secret_request' : 'manual_tool',
          ...args,
          agentId,
        }, null, 2),
      };
    }

    // Execute the tool with validated input
    const result = await executeToolWithValidation(tool, args);

    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      content: JSON.stringify(result, null, 2),
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
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...sanitizedMessages,
        ],
        tools,
        tool_choice: 'auto',
        max_tokens: 2048,
      }),
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
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}> {
  // Create tools for this agent context
  const agentId = agent?.id;
  const services = agentId ? buildToolServices(agentId, session) : null;
  const agentTools = agentId && services
    ? createAgentTools(agentId, session, services)
    : [];
  const openAITools = toOpenAITools(agentTools as ToolDefinition<ZodObject<ZodRawShape>, unknown>[]);

  const messages: AdminChatMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  let response: string | undefined;
  let pendingToolCall: { id: string; name: string; arguments: Record<string, unknown> } | undefined;
  const allMedia: MediaItem[] = [];
  const pendingJobs: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string }> = [];
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
        const toolResult = await executeTool(uploadUrlTool, session, agentTools as ToolDefinition<ZodObject<ZodRawShape>, unknown>[], agent);
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

      // Execute all tool calls
      const toolResults = await Promise.all(
        llmResponse.toolCalls.map(tc => executeTool(tc, session, agentTools as ToolDefinition<ZodObject<ZodRawShape>, unknown>[], agent))
      );

      // Extract any media from the tool results
      // Log tool results for debugging
      for (const result of toolResults) {
        console.log(`[Chat] Tool result: ${result.tool_call_id}`, result.content?.slice(0, 200));
        
        // Extract pending job IDs from generate_image/generate_video results
        try {
          const parsed = JSON.parse(result.content);
          if (parsed.jobId && parsed.status && (parsed.status === 'pending' || parsed.status === 'processing')) {
            pendingJobs.push({
              jobId: parsed.jobId,
              type: parsed.type || 'image',
              prompt: parsed.prompt,
            });
          }
        } catch {
          // Not JSON, skip
        }
      }

      const mediaFromResults = extractMediaFromToolResults(toolResults);
      console.log(`[Chat] Extracted ${mediaFromResults.length} media items from tool results`);
      allMedia.push(...mediaFromResults);

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
        // Include pending tool call if one needs user input
        pendingToolCall: result.pendingToolCall,
      }),
    };
  } catch (error) {
    console.error('Chat handler error:', error);
    
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
