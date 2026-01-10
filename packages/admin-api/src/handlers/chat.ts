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
import type {
  AdminChatMessage,
  ToolCall,
  ToolResult,
  UserSession,
  SecretType,
} from '../types.js';

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';


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
 * Define available tools for the agent chatbot
 * These tools are agent-centric - the agent configures ITSELF
 * No agentId parameter needed - uses agent context from the chat
 */
const AGENT_TOOLS = [
  // Request secrets from user (shown as inline prompts in UI)
  {
    type: 'function',
    function: {
      name: 'request_secret',
      description: 'Request a secret value from the user. This will display a secure input field in the UI. Use this to collect API keys, tokens, and other sensitive credentials.',
      parameters: {
        type: 'object',
        properties: {
          secretType: {
            type: 'string',
            enum: [
              'telegram_bot_token',
              'discord_bot_token',
              'twitter_api_key', 'twitter_api_secret', 'twitter_access_token',
              'twitter_access_secret', 'twitter_bearer_token',
              'helius_api_key', 'replicate_api_key', 'openrouter_api_key', 'anthropic_api_key', 'openai_api_key',
            ],
            description: 'Type of secret being requested'
          },
          label: { type: 'string', description: 'Human-readable label for the input field' },
          instructions: { type: 'string', description: 'Brief instructions on how to get this secret' },
        },
        required: ['secretType', 'label'],
      },
    },
  },
  // Store a secret after user provides it
  {
    type: 'function',
    function: {
      name: 'store_secret',
      description: 'Store a secret value securely. Use after receiving a secret from request_secret.',
      parameters: {
        type: 'object',
        properties: {
          secretType: {
            type: 'string',
            enum: [
              'telegram_bot_token',
              'discord_bot_token',
              'twitter_api_key', 'twitter_api_secret', 'twitter_access_token',
              'twitter_access_secret', 'twitter_bearer_token',
              'helius_api_key', 'replicate_api_key', 'openrouter_api_key', 'anthropic_api_key', 'openai_api_key',
            ],
            description: 'Type of secret'
          },
          value: { type: 'string', description: 'The secret value to store' },
        },
        required: ['secretType', 'value'],
      },
    },
  },
  // Update my profile
  {
    type: 'function',
    function: {
      name: 'update_my_profile',
      description: 'Update my name, description, or persona',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'My display name' },
          description: { type: 'string', description: 'Brief description of what I do' },
          persona: { type: 'string', description: 'My personality/system prompt' },
        },
      },
    },
  },
  // LLM Model management
  {
    type: 'function',
    function: {
      name: 'list_available_models',
      description: 'List available LLM models from OpenRouter that I can switch to. Returns model IDs, names, pricing, and context lengths.',
      parameters: {
        type: 'object',
        properties: {
          family: {
            type: 'string',
            description: 'Filter by model family (e.g., "anthropic", "openai", "google", "meta-llama"). Leave empty for all.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_model_config',
      description: 'Get my current LLM model configuration (model, temperature, max tokens)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_my_model',
      description: 'Change my LLM model or settings. Use list_available_models first to see options.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model ID from OpenRouter (e.g., "anthropic/claude-sonnet-4", "openai/gpt-4o")' },
          temperature: { type: 'number', description: 'Temperature (0.0-2.0). Lower = more focused, higher = more creative.' },
          maxTokens: { type: 'number', description: 'Maximum response tokens (e.g., 1024, 4096)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_model_selection',
      description: 'Show the user a dropdown to select a model. Use this when the user wants to choose interactively.',
      parameters: {
        type: 'object',
        properties: {
          family: {
            type: 'string',
            description: 'Pre-filter by family (e.g., "anthropic", "openai"). Leave empty to show all.',
          },
          currentModel: {
            type: 'string',
            description: 'Current model ID to show as selected',
          },
        },
      },
    },
  },
  // Solana wallet management
  {
    type: 'function',
    function: {
      name: 'create_solana_wallet',
      description: 'Create a new Solana wallet for myself. The private key is stored securely.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the wallet (e.g., "main", "tips", "treasury")' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_wallets',
      description: 'List all my Solana wallets with their public keys and balances',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_wallet_balance',
      description: 'Get the SOL balance and token balances for a specific wallet',
      parameters: {
        type: 'object',
        properties: {
          publicKey: { type: 'string', description: 'The wallet public key/address' },
        },
        required: ['publicKey'],
      },
    },
  },
  // List my configured secrets (not values, just what's set)
  {
    type: 'function',
    function: {
      name: 'get_my_secrets',
      description: 'List which secrets I have configured (not the values, just which types are set)',
      parameters: { type: 'object', properties: {} },
    },
  },
  // Check pending media jobs (video generation status)
  {
    type: 'function',
    function: {
      name: 'get_pending_jobs',
      description: 'Check the status of pending video generation jobs. Videos are generated asynchronously.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // Profile image management
  {
    type: 'function',
    function: {
      name: 'set_profile_image',
      description: 'Set my profile image. Can generate a new one, use a URL, select from gallery, or request the user to upload a file. For user uploads, use source="upload" which will show a file picker in the UI.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['generate', 'url', 'gallery', 'upload'],
            description: 'How to set the profile image: generate (AI creates one), url (from a web URL), gallery (from existing images), upload (user selects a file from their device)',
          },
          prompt: {
            type: 'string',
            description: 'For generate: description of the profile image to create'
          },
          url: {
            type: 'string',
            description: 'For url: the image URL to use'
          },
          imageId: {
            type: 'string',
            description: 'For gallery: ID of an image from my gallery'
          },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_profile_upload_url',
      description: 'Get a signed URL for the user to upload a profile image directly. Prefer using set_profile_image with source="upload" instead.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_uploaded_profile_image',
      description: 'Save an already-uploaded image as my profile picture. Use this after the user has uploaded an image via the upload widget.',
      parameters: {
        type: 'object',
        properties: {
          s3Key: { type: 'string', description: 'The S3 key of the uploaded image' },
          publicUrl: { type: 'string', description: 'The public URL of the uploaded image' },
        },
        required: ['s3Key', 'publicUrl'],
      },
    },
  },
  // Reference image management
  {
    type: 'function',
    function: {
      name: 'get_reference_image_upload_url',
      description: 'Get a signed URL to upload a reference image. Categories: profile (avatar), character (for consistency in generations), style (style references), background (scene references), other.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['profile', 'character', 'style', 'background', 'other'],
            description: 'The category of reference image',
          },
          name: {
            type: 'string',
            description: 'A descriptive name for this reference image (e.g., "main character front view")',
          },
          description: {
            type: 'string',
            description: 'Optional description of what this reference shows or how to use it',
          },
        },
        required: ['category', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_reference_image',
      description: 'Save the metadata for a reference image after it has been uploaded',
      parameters: {
        type: 'object',
        properties: {
          s3Key: { type: 'string', description: 'The S3 key returned from get_reference_image_upload_url' },
          publicUrl: { type: 'string', description: 'The public URL returned from get_reference_image_upload_url' },
          category: { type: 'string', enum: ['profile', 'character', 'style', 'background', 'other'] },
          name: { type: 'string', description: 'Name for the reference image' },
          description: { type: 'string', description: 'Optional description' },
        },
        required: ['s3Key', 'publicUrl', 'category', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reference_images',
      description: 'List all reference images for this agent, optionally filtered by category',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['profile', 'character', 'style', 'background', 'other'],
            description: 'Filter by category (optional)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_reference_image',
      description: 'Delete a reference image by its ID',
      parameters: {
        type: 'object',
        properties: {
          imageId: { type: 'string', description: 'The ID of the reference image to delete' },
        },
        required: ['imageId'],
      },
    },
  },
  // Image generation
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image using Nano Banana Pro. By default uses my profile picture as reference for character consistency. Can also use gallery images as additional references (up to 14 total). The image will be saved to my gallery.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Description of the image to generate'
          },
          useProfileAsReference: {
            type: 'boolean',
            description: 'Use my profile image as a reference (default: true)',
          },
          galleryImageIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of gallery image IDs to use as additional references (get IDs from get_my_gallery)',
          },
          referenceImageId: {
            type: 'string',
            description: 'ID of a specific reference image to use (from list_reference_images)',
          },
          resolution: {
            type: 'string',
            enum: ['1K', '2K', '4K'],
            description: 'Output resolution (default: 2K)',
          },
          aspectRatio: {
            type: 'string',
            enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
            description: 'Image aspect ratio (default: 1:1)',
          },
        },
        required: ['prompt'],
      },
    },
  },
  // Video generation (async)
  {
    type: 'function',
    function: {
      name: 'generate_video',
      description: 'Generate a video from a text prompt. Can use reference images. This is async - I will notify when complete.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Description of the video to generate'
          },
          useProfileAsReference: {
            type: 'boolean',
            description: 'Use my profile image as a reference for character consistency',
          },
          referenceImageId: {
            type: 'string',
            description: 'ID of a specific reference image to use (from list_reference_images)',
          },
        },
        required: ['prompt'],
      },
    },
  },
  // Sticker generation
  {
    type: 'function',
    function: {
      name: 'generate_sticker',
      description: 'Generate a sticker (transparent background image). Can create new or convert existing.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Description of the sticker to generate (if creating new)'
          },
          sourceImageId: {
            type: 'string',
            description: 'ID of an existing gallery image to convert to sticker'
          },
        },
      },
    },
  },
  // Gallery management
  {
    type: 'function',
    function: {
      name: 'get_my_gallery',
      description: 'View my generated images, videos, and stickers',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['image', 'video', 'sticker'],
            description: 'Filter by media type'
          },
          limit: {
            type: 'number',
            description: 'Max items to return (default 20)'
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_gallery',
      description: 'Search my gallery by description or prompt keywords',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search terms'
          },
          type: {
            type: 'string',
            enum: ['image', 'video', 'sticker'],
            description: 'Filter by media type'
          },
        },
        required: ['query'],
      },
    },
  },
  // Credit status
  {
    type: 'function',
    function: {
      name: 'get_tool_credits',
      description: 'Check my available credits for media generation tools',
      parameters: { type: 'object', properties: {} },
    },
  },
];

interface AgentContext {
  id: string;
  name: string;
  description?: string;
  persona?: string;
}

function buildSystemPrompt(agent?: AgentContext): string {
  if (agent) {
    return `You are ${agent.name}, an AI agent being configured by your owner.
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
- Generate images with AI (saved to your gallery)
- Generate videos (async - check status with get_pending_jobs, saved to gallery when complete)
- Generate stickers (with transparent backgrounds)
- Browse and search your media gallery
- Check pending video jobs for status updates
- Check your tool credits (rate limited to prevent abuse)

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
 * Execute a tool call
 * Agent-centric: all operations use the agent's own ID from context
 */
async function executeTool(
  toolCall: ToolCall,
  session: UserSession,
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
    let result: unknown;

    switch (name) {
      // Request a secret from the user - returns a prompt for the UI
      case 'request_secret':
        result = { 
          type: 'secret_request',
          secretType: args.secretType,
          label: args.label,
          instructions: args.instructions,
          agentId,
        };
        break;
        
      // Store a secret securely
      case 'store_secret': {
        const secretType = args.secretType as SecretType;
        
        // Store the secret first
        await secrets.storeSecret(
          agentId!,
          secretType,
          'default',
          args.value,
          session,
          `${secretType} for agent ${agentId}`
        );
        
        // Special handling for platform secrets
        if (secretType === 'telegram_bot_token') {
          // Validate the token
          const validation = await telegram.validateTelegramToken(args.value);
          if (!validation.valid) {
            result = { 
              success: false, 
              message: `Token stored, but validation failed: ${validation.error}. The bot may not work.` 
            };
            break;
          }
          
          // Enable Telegram platform on the agent
          await agents.updateAgent(agentId!, {
            platforms: {
              telegram: {
                enabled: true,
                botUsername: validation.botInfo?.username
              }
            }
          }, session);

          // Generate and register the webhook with a secret token for security
          const webhookResult = await telegram.registerTelegramWebhook(args.value, agentId!);
          if (!webhookResult.success) {
            result = {
              success: true,
              message: `Token stored and validated (bot: @${validation.botInfo?.username}), but webhook registration failed: ${webhookResult.message}. You may need to manually configure the webhook.`
            };
            break;
          }

          // Store the webhook secret for request verification
          if (webhookResult.secretToken && agentId) {
            await secrets.storeSecret(
              agentId,
              'telegram_webhook_secret',
              'default',
              webhookResult.secretToken,
              session,
              `Telegram webhook secret for ${agentId}`
            );
          }

          result = {
            success: true,
            message: `Telegram bot @${validation.botInfo?.username} is now live! Webhook registered at ${webhookResult.webhookUrl} with secure token verification. You can message the bot and it will respond.`
          };
        } else {
          result = { success: true, message: `${secretType} stored securely` };
        }
        break;
      }
        
      // Update my profile
      case 'update_my_profile':
        result = await agents.updateAgent(agentId!, {
          name: args.name,
          description: args.description,
          persona: args.persona,
        }, session);
        break;

      // List available LLM models from OpenRouter
      case 'list_available_models': {
        const modelsResponse = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Content-Type': 'application/json' },
        });

        if (!modelsResponse.ok) {
          result = { error: 'Failed to fetch models from OpenRouter' };
          break;
        }

        const modelsData = await modelsResponse.json() as {
          data: Array<{
            id: string;
            name: string;
            pricing: { prompt: string; completion: string };
            context_length: number;
            top_provider?: { max_completion_tokens?: number };
          }>;
        };

        let models = modelsData.data || [];

        // Filter by family if specified
        if (args.family) {
          const family = args.family.toLowerCase();
          models = models.filter(m => m.id.toLowerCase().startsWith(family + '/'));
        }

        // Sort by name and limit to reasonable number
        models = models
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 50);

        result = {
          models: models.map(m => ({
            id: m.id,
            name: m.name,
            contextLength: m.context_length,
            maxCompletionTokens: m.top_provider?.max_completion_tokens,
            pricing: {
              prompt: `$${parseFloat(m.pricing.prompt) * 1000000}/M tokens`,
              completion: `$${parseFloat(m.pricing.completion) * 1000000}/M tokens`,
            },
          })),
          count: models.length,
          tip: 'Use change_my_model with a model ID to switch, or request_model_selection to show the user a dropdown.',
        };
        break;
      }

      // Get my current model config
      case 'get_my_model_config': {
        const agent = await agents.getAgent(agentId!);
        result = {
          model: agent?.llmConfig?.model || 'anthropic/claude-sonnet-4',
          temperature: agent?.llmConfig?.temperature ?? 0.8,
          maxTokens: agent?.llmConfig?.maxTokens || 1024,
          provider: agent?.llmConfig?.provider || 'openrouter',
        };
        break;
      }

      // Change my model or settings
      case 'change_my_model': {
        const updates: Record<string, unknown> = {};

        if (args.model) updates.model = args.model;
        if (args.temperature !== undefined) updates.temperature = args.temperature;
        if (args.maxTokens !== undefined) updates.maxTokens = args.maxTokens;

        if (Object.keys(updates).length === 0) {
          result = { error: 'No changes specified. Provide model, temperature, or maxTokens.' };
          break;
        }

        const agent = await agents.getAgent(agentId!);
        const newLlmConfig = {
          ...agent?.llmConfig,
          ...updates,
        };

        await agents.updateAgent(agentId!, { llmConfig: newLlmConfig } as any, session);

        result = {
          success: true,
          message: `Model configuration updated!`,
          newConfig: newLlmConfig,
        };
        break;
      }

      // Request model selection dropdown
      case 'request_model_selection': {
        // Fetch models for the dropdown
        const modelsResponse = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Content-Type': 'application/json' },
        });

        let models: Array<{ id: string; name: string }> = [];

        if (modelsResponse.ok) {
          const modelsData = await modelsResponse.json() as {
            data: Array<{ id: string; name: string }>;
          };
          models = modelsData.data || [];

          // Filter by family if specified
          if (args.family) {
            const family = args.family.toLowerCase();
            models = models.filter(m => m.id.toLowerCase().startsWith(family + '/'));
          }

          models = models.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
        }

        result = {
          type: 'model_selector',
          models: models.map(m => ({ id: m.id, name: m.name })),
          currentModel: args.currentModel || 'anthropic/claude-sonnet-4',
          instructions: 'Please select a model from the dropdown above.',
        };
        break;
      }

      // Create a Solana wallet
      case 'create_solana_wallet':
        result = await wallets.generateSolanaWallet(agentId!, args.name, session);
        break;
        
      // List my wallets
      case 'get_my_wallets': {
        const walletList = await wallets.listWallets(agentId!);
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
        result = enriched;
        break;
      }
        
      // Get specific wallet balance
      case 'get_wallet_balance':
        result = await wallets.getSolanaBalance(args.publicKey, agentId);
        break;
        
      // List my configured secrets
      case 'get_my_secrets':
        result = await secrets.listSecrets(agentId!);
        break;
        
      // Check pending media jobs
      case 'get_pending_jobs': {
        const pendingJobs = await mediaJobs.getPendingJobs(agentId!);
        result = {
          count: pendingJobs.length,
          jobs: pendingJobs.map(job => ({
            jobId: job.jobId,
            type: job.type,
            status: job.status,
            prompt: job.prompt,
            createdAt: new Date(job.createdAt).toISOString(),
          })),
        };
        break;
      }

      // Profile image management
      case 'set_profile_image': {
        // Handle 'upload' source - return upload URL for user to select a file
        if (args.source === 'upload') {
          const uploadInfo = await media.getProfileImageUploadUrl(agentId!);
          result = {
            type: 'upload_url',
            uploadUrl: uploadInfo.uploadUrl,
            s3Key: uploadInfo.s3Key,
            publicUrl: uploadInfo.publicUrl,
            instructions: 'Please select a profile image from your device. After upload, it will be set as your profile picture.',
          };
          break;
        }

        let source: { type: 'url'; url: string } | { type: 'generate'; prompt: string } | { type: 'gallery'; imageId: string };

        if (args.source === 'generate') {
          if (!args.prompt) throw new Error('Prompt required for generating profile image');
          source = { type: 'generate', prompt: args.prompt };
        } else if (args.source === 'url') {
          if (!args.url) throw new Error('URL required when using url source');
          source = { type: 'url', url: args.url };
        } else if (args.source === 'gallery') {
          if (!args.imageId) throw new Error('imageId required when using gallery source');
          source = { type: 'gallery', imageId: args.imageId };
        } else {
          throw new Error(`Invalid source type: ${args.source}`);
        }

        const profileResult = await media.setProfileImage(agentId!, source);

        // Update agent record with new profile image
        await agents.updateAgent(agentId!, {
          profileImage: {
            url: profileResult.url,
            s3Key: profileResult.s3Key,
            generatedPrompt: args.source === 'generate' ? args.prompt : undefined,
            updatedAt: Date.now(),
          }
        }, session);

        result = {
          success: true,
          message: 'Profile image updated!',
          url: profileResult.url,
        };
        break;
      }

      case 'get_profile_upload_url': {
        const uploadInfo = await media.getProfileImageUploadUrl(agentId!);
        result = {
          type: 'upload_url',
          uploadUrl: uploadInfo.uploadUrl,
          s3Key: uploadInfo.s3Key,
          publicUrl: uploadInfo.publicUrl,
          instructions: 'Use PUT request to upload PNG image to uploadUrl. After upload, the image will be available at publicUrl.',
        };
        break;
      }

      case 'save_uploaded_profile_image': {
        // Directly update the agent record with the uploaded image
        await agents.updateAgent(agentId!, {
          profileImage: {
            url: args.publicUrl,
            s3Key: args.s3Key,
            updatedAt: Date.now(),
          }
        }, session);

        result = {
          success: true,
          message: 'Profile image updated!',
          url: args.publicUrl,
        };
        break;
      }

      // Reference image management
      case 'get_reference_image_upload_url': {
        const uploadInfo = await media.getReferenceImageUploadUrl(
          agentId!,
          args.category,
          args.name
        );
        result = {
          type: 'upload_url',
          uploadUrl: uploadInfo.uploadUrl,
          s3Key: uploadInfo.s3Key,
          publicUrl: uploadInfo.publicUrl,
          category: uploadInfo.category,
          instructions: `Upload your ${args.category} reference image using a PUT request to the uploadUrl. After uploading, call save_reference_image with the s3Key and publicUrl to register it.`,
        };
        break;
      }

      case 'save_reference_image': {
        const refImage = await media.saveReferenceImage(
          agentId!,
          args.category,
          args.s3Key,
          args.publicUrl,
          args.name,
          args.description
        );
        result = {
          success: true,
          message: `Reference image "${args.name}" saved!`,
          image: refImage,
        };
        break;
      }

      case 'list_reference_images': {
        const images = await media.listReferenceImages(agentId!, args.category);
        result = {
          images,
          count: images.length,
          message: images.length === 0 
            ? 'No reference images found. Upload some using get_reference_image_upload_url!'
            : `Found ${images.length} reference image(s)`,
        };
        break;
      }

      case 'delete_reference_image': {
        await media.deleteReferenceImage(agentId!, args.imageId);
        result = {
          success: true,
          message: 'Reference image deleted',
        };
        break;
      }

      // Image generation
      case 'generate_image': {
        // Build array of reference images
        const referenceImageUrls: string[] = [];

        // Always include profile image first if useProfileAsReference is true (default)
        if (args.useProfileAsReference !== false) {
          const agent = await agents.getAgent(agentId!);
          if (agent?.profileImage?.url) {
            referenceImageUrls.push(agent.profileImage.url);
          } else {
            // Fallback: check for reference images with 'profile' or 'character' category
            const refImages = await media.listReferenceImages(agentId!);
            const profileRef = refImages.find(img => img.category === 'profile');
            const characterRef = refImages.find(img => img.category === 'character');
            if (profileRef?.url) {
              referenceImageUrls.push(profileRef.url);
            } else if (characterRef?.url) {
              referenceImageUrls.push(characterRef.url);
            }
          }
        }

        // Add specific gallery images if provided
        if (args.galleryImageIds && Array.isArray(args.galleryImageIds)) {
          for (const imageId of args.galleryImageIds) {
            const item = await gallery.getGalleryItem(agentId!, imageId);
            if (item?.url) {
              referenceImageUrls.push(item.url);
            }
          }
        }

        // Add specific reference image if provided
        if (args.referenceImageId) {
          const images = await media.listReferenceImages(agentId!);
          const refImage = images.find(img => img.id === args.referenceImageId);
          if (refImage?.url) {
            referenceImageUrls.push(refImage.url);
          }
        }

        const image = await media.generateImage({
          prompt: args.prompt,
          agentId: agentId!,
          platform: 'admin-chat',
          referenceImageUrls,
          resolution: args.resolution || '2K',
          aspectRatio: args.aspectRatio || '1:1',
        });

        result = {
          success: true,
          message: 'Image generated successfully!',
          id: image.id,
          url: image.url,
          prompt: args.prompt,
          usedReferences: referenceImageUrls.length,
        };
        break;
      }

      // Video generation (async)
      case 'generate_video': {
        let referenceImageUrl: string | undefined;
        
        if (args.referenceImageId) {
          const images = await media.listReferenceImages(agentId!);
          const refImage = images.find(img => img.id === args.referenceImageId);
          if (refImage) {
            referenceImageUrl = refImage.url;
          }
        } else if (args.useProfileAsReference !== false) {
          // Default to using profile image
          const agent = await agents.getAgent(agentId!);
          if (agent?.profileImage?.url) {
            referenceImageUrl = agent.profileImage.url;
          } else {
            // Fallback to reference images
            const refImages = await media.listReferenceImages(agentId!);
            const profileRef = refImages.find(img => img.category === 'profile');
            const characterRef = refImages.find(img => img.category === 'character');
            referenceImageUrl = profileRef?.url || characterRef?.url;
          }
        }

        const job = await media.generateVideo({
          prompt: args.prompt,
          agentId: agentId!,
          platform: 'admin-chat',
          conversationId: 'admin-chat-' + Date.now(),
          referenceImageUrl,
        });

        result = {
          success: true,
          message: 'Video generation started! This may take a few minutes.',
          jobId: job.jobId,
          status: job.status,
          note: 'The video will be saved to your gallery when complete.',
        };
        break;
      }

      // Sticker generation
      case 'generate_sticker': {
        if (!args.prompt && !args.sourceImageId) {
          throw new Error('Either prompt or sourceImageId is required');
        }

        const sticker = await media.generateSticker({
          prompt: args.prompt || 'sticker',
          agentId: agentId!,
          platform: 'admin-chat',
          sourceImageId: args.sourceImageId,
        });

        result = {
          success: true,
          message: args.sourceImageId
            ? 'Sticker created from existing image!'
            : 'New sticker generated!',
          id: sticker.id,
          url: sticker.url,
        };
        break;
      }

      // Gallery management
      case 'get_my_gallery': {
        const items = await gallery.getGallery(agentId!, {
          type: args.type,
          limit: args.limit || 20,
        });

        result = {
          count: items.length,
          items: items.map(item => ({
            id: item.id,
            type: item.type,
            url: item.url,
            prompt: item.prompt,
            createdAt: new Date(item.createdAt).toISOString(),
            postedToTwitter: item.postedToTwitter,
            convertedToSticker: item.convertedToSticker,
          })),
        };
        break;
      }

      case 'search_gallery': {
        const items = await gallery.findByDescription(agentId!, args.query, args.type);

        result = {
          query: args.query,
          count: items.length,
          items: items.map(item => ({
            id: item.id,
            type: item.type,
            url: item.url,
            prompt: item.prompt,
            createdAt: new Date(item.createdAt).toISOString(),
          })),
        };
        break;
      }

      // Credit status
      case 'get_tool_credits': {
        const status = await credits.getToolStatus(agentId!);
        result = { status };
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    
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

// Import type for LLM config moved to top

/**
 * Call the LLM API
 */
async function callLLM(
  messages: AdminChatMessage[],
  agent?: AgentContext
): Promise<{ 
  message?: string; 
  toolCalls?: ToolCall[]; 
}> {
  const apiKey = await getLlmApiKey();
  const systemPrompt = buildSystemPrompt(agent);
  
  const response = await fetch(LLM_ENDPOINT, {
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
        ...messages,
      ],
      tools: AGENT_TOOLS,
      tool_choice: 'auto',
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
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

      // Direct image/media generation result (check for success + url)
      if (parsed.success && parsed.url && typeof parsed.url === 'string') {
        // Determine type from context or file extension
        let mediaType: 'image' | 'video' | 'sticker' = 'image';
        if (parsed.url.includes('.mp4') || parsed.url.includes('.webm') || parsed.url.includes('/video')) {
          mediaType = 'video';
        } else if (parsed.url.includes('/sticker')) {
          mediaType = 'sticker';
        }

        media.push({
          type: mediaType,
          url: parsed.url,
          prompt: parsed.prompt,
          id: parsed.id,
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
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}> {
  const messages: AdminChatMessage[] = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  let response: string | undefined;
  let pendingToolCall: { id: string; name: string; arguments: Record<string, unknown> } | undefined;
  const allMedia: MediaItem[] = [];
  let iterations = 0;
  const maxIterations = 10; // Prevent infinite loops

  while (iterations < maxIterations) {
    iterations++;
    
    const llmResponse = await callLLM(messages, agent);
    
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      // Check if any tool call is a request_secret - these need user input
      const secretRequest = llmResponse.toolCalls.find(tc => tc.function.name === 'request_secret');
      
      if (secretRequest) {
        // Don't execute request_secret - return it to the frontend for user input
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(secretRequest.function.arguments || '{}');
        } catch (e) {
          console.error('Failed to parse request_secret arguments:', e);
        }
        pendingToolCall = {
          id: secretRequest.id,
          name: 'request_secret',
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
            tc.function.name === 'get_reference_image_upload_url') {
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
        // Execute the tool to get the upload URL
        const uploadResult = await executeTool(uploadUrlTool, session, agent);
        let uploadArgs: Record<string, unknown> = {};
        try {
          uploadArgs = JSON.parse(uploadResult.content || '{}');
        } catch (e) {
          console.error('Failed to parse upload URL result:', e);
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
          arguments: uploadArgs,
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
        llmResponse.toolCalls.map(tc => executeTool(tc, session, agent))
      );

      // Extract any media from the tool results
      // Log tool results for debugging
      for (const result of toolResults) {
        console.log(`[Chat] Tool result: ${result.tool_call_id}`, result.content?.slice(0, 200));
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

  console.log(`[Chat] Final response with ${allMedia.length} media items`);
  return { response, history: messages, media: allMedia.length > 0 ? allMedia : undefined, pendingToolCall };
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
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { message, history = [], agent } = body;

    if (!message || typeof message !== 'string') {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Message is required' }),
      };
    }

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
