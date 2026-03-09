/**
 * Chat types — admin chatbot schemas, tools, jobs
 */
import { z } from 'zod';

// Chat message schemas for the admin chatbot
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

// Sender identity for chat messages
export const MessageSenderSchema = z.object({
  walletAddress: z.string().optional(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export type MessageSender = z.infer<typeof MessageSenderSchema>;

export const AdminChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().nullish().transform(v => v ?? ''),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  sender: MessageSenderSchema.optional(),
  media: z.array(z.object({
    type: z.enum(['image', 'video', 'sticker']),
    url: z.string(),
    prompt: z.string().optional(),
    id: z.string().optional(),
    thumbnailUrl: z.string().optional(),
  })).optional(),
});

export const ToolResultSchema = z.object({
  tool_call_id: z.string(),
  role: z.literal('tool'),
  content: z.string(),
});

// Avatar context in chat request
// Uses .nullish() because DynamoDB stores missing values as null, and JSON.stringify
// preserves null (unlike undefined), causing z.string().optional() to reject valid requests.
const nullToUndef = <T,>(v: T | null | undefined): T | undefined => v ?? undefined;

export const AvatarContextSchema = z.object({
  id: z.string(),
  name: z.string().nullish().transform(nullToUndef),
  description: z.string().nullish().transform(nullToUndef),
  persona: z.string().nullish().transform(nullToUndef),
  enabledCategories: z.array(z.string()).nullish().transform(nullToUndef),
});

// Chat request body schema
export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  history: z.array(AdminChatMessageSchema).default([]),
  avatar: AvatarContextSchema.optional(),
  sender: MessageSenderSchema.optional(),
  systemPrompt: z.string().optional(), // Override default system prompt
  attachments: z.array(z.object({
    type: z.enum(['image', 'file', 'audio']),
    data: z.string(), // base64 data URL or public URL for audio
    name: z.string().optional(),
  })).optional(),
  model: z.string().optional(), // Override default LLM model (e.g., 'anthropic/claude-3-5-haiku-20241022')
});

// Infer types from schemas
export type AdminChatMessage = z.infer<typeof AdminChatMessageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// Admin chatbot tool definitions
export const AdminTools = {
  // Avatar Management
  create_avatar: z.object({
    name: z.string().describe('Name for the new avatar'),
    description: z.string().optional().describe('Description of the avatar'),
  }),

  update_avatar: z.object({
    avatarId: z.string().describe('ID of the avatar to update'),
    name: z.string().optional(),
    description: z.string().optional(),
    persona: z.string().optional(),
  }),

  list_avatars: z.object({}),

  get_avatar: z.object({
    avatarId: z.string().describe('ID of the avatar'),
  }),

  delete_avatar: z.object({
    avatarId: z.string().describe('ID of the avatar to delete'),
    confirm: z.boolean().describe('Must be true to confirm deletion'),
  }),

  // Platform Configuration
  configure_telegram: z.object({
    avatarId: z.string(),
    botToken: z.string().describe('Telegram bot token from @BotFather'),
    botUsername: z.string().optional(),
  }),

  configure_twitter: z.object({
    avatarId: z.string(),
    apiKey: z.string(),
    apiSecret: z.string(),
    accessToken: z.string(),
    accessSecret: z.string(),
    bearerToken: z.string().optional(),
    username: z.string().optional(),
  }),

  configure_discord: z.object({
    avatarId: z.string(),
    botToken: z.string(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    guildId: z.string().optional(),
    mode: z.enum(['webhook', 'bot', 'hybrid']).optional(),
    useGateway: z.boolean().optional(),
    intents: z.number().optional(),
    respondToMentions: z.boolean().optional(),
    respondInDMs: z.boolean().optional(),
    allowedChannels: z.array(z.string()).optional(),
    allowedGuilds: z.array(z.string()).optional(),
    applicationId: z.string().optional(),
    publicKey: z.string().optional(),
  }),

  // AI Provider Keys
  set_openrouter_key: z.object({
    apiKey: z.string().describe('OpenRouter API key'),
    avatarId: z.string().optional().describe('Avatar ID for per-avatar key, omit for global'),
  }),

  set_anthropic_key: z.object({
    apiKey: z.string().describe('Anthropic API key'),
    avatarId: z.string().optional(),
  }),

  set_openai_key: z.object({
    apiKey: z.string().describe('OpenAI API key'),
    avatarId: z.string().optional(),
  }),

  set_replicate_key: z.object({
    apiKey: z.string().describe('Replicate API key'),
    avatarId: z.string().optional(),
  }),

  // Wallet Management
  generate_solana_wallet: z.object({
    avatarId: z.string(),
    name: z.string().describe('Name for the wallet'),
  }),

  generate_ethereum_wallet: z.object({
    avatarId: z.string(),
    name: z.string().describe('Name for the wallet'),
  }),

  list_wallets: z.object({
    avatarId: z.string().optional().describe('Filter by avatar, omit for all'),
  }),

  get_wallet_balance: z.object({
    walletId: z.string(),
  }),

  // Secret Management (write-only)
  set_custom_secret: z.object({
    avatarId: z.string().optional().describe('Avatar ID or omit for global'),
    name: z.string().describe('Name of the secret'),
    value: z.string().describe('Secret value'),
    description: z.string().optional(),
  }),

  list_secrets: z.object({
    avatarId: z.string().optional().describe('Filter by avatar, omit for all'),
  }),

  delete_secret: z.object({
    avatarId: z.string().optional(),
    secretName: z.string(),
    confirm: z.boolean(),
  }),

  // Deployment
  deploy_avatar: z.object({
    avatarId: z.string(),
    environment: z.enum(['dev', 'staging', 'prod']).optional(),
  }),

  get_deployment_status: z.object({
    avatarId: z.string(),
  }),
};

export type AdminToolName = keyof typeof AdminTools;
