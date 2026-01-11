/**
 * Admin API Types
 */
import { z } from 'zod';

// Cloudflare Access JWT claims
export interface CloudflareAccessClaims {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  nbf: number;
  iss: string;
  type: string;
  identity_nonce: string;
  sub: string;
  country: string;
}

// User session from Cloudflare Access
export interface UserSession {
  email: string;
  userId: string;
  isAdmin: boolean;
  accessToken: string;
}

// Secret types that can be managed
export const SecretType = z.enum([
  'telegram_bot_token',
  'telegram_webhook_secret',  // Secret token for webhook verification
  'twitter_api_key',
  'twitter_api_secret',
  'twitter_access_token',
  'twitter_access_secret',
  'twitter_bearer_token',
  'discord_bot_token',
  'discord_client_id',
  'discord_client_secret',
  'openrouter_api_key',
  'anthropic_api_key',
  'replicate_api_key',
  'openai_api_key',
  'helius_api_key',
  'solana_wallet_key',
  'ethereum_wallet_key',
  'custom',
]);

export type SecretType = z.infer<typeof SecretType>;

// Secret metadata (stored in DynamoDB, NOT the actual secret)
export interface SecretMetadata {
  pk: string; // AGENT#{agentId} or GLOBAL
  sk: string; // SECRET#{secretType}#{name}
  secretType: SecretType;
  name: string;
  description?: string;
  secretArn: string; // Reference to Secrets Manager
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  isGlobal: boolean;
  // For wallets
  publicKey?: string;
  walletType?: 'solana' | 'ethereum';
}

// Wallet info (public data only)
export interface WalletInfo {
  id: string;
  agentId: string;
  walletType: 'solana' | 'ethereum';
  publicKey: string;
  address: string;
  name: string;
  createdAt: number;
  createdBy: string;
}

// Agent configuration stored in DynamoDB
export interface AgentRecord {
  pk: string; // AGENT#{agentId}
  sk: string; // CONFIG
  agentId: string;
  name: string;
  description?: string;
  persona?: string;

  // Profile image for character consistency
  profileImage?: {
    url: string;           // S3/CDN URL
    s3Key: string;         // S3 key for reference
    generatedPrompt?: string; // If AI-generated, the prompt used
    updatedAt: number;
  };

  // Media configuration
  mediaConfig?: {
    image: {
      provider: 'openrouter' | 'replicate' | 'dalle' | 'gemini';
      model: string;
    };
    video?: {
      provider: 'replicate';
      model: string;
    };
    // Use profile image as reference for character consistency
    useProfileAsReference: boolean;
  };

  // Telegram sticker pack (if created)
  stickerPack?: {
    name: string;          // e.g., "agent_name_by_botusername"
    title: string;
    stickerCount: number;
    createdAt: number;
  };

  platforms: {
    telegram?: { enabled: boolean; botUsername?: string };
    twitter?: { enabled: boolean; username?: string };
    discord?: { enabled: boolean; guildId?: string };
    web?: { enabled: boolean };
  };
  llmConfig: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    useGlobalKey: boolean;
  };
  status: 'draft' | 'active' | 'paused' | 'deleted';
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

// Gallery item for tracking generated media
export interface GalleryItem {
  pk: string;              // AGENT#{agentId}
  sk: string;              // GALLERY#{timestamp}#{id}
  id: string;
  agentId: string;
  type: 'image' | 'video' | 'sticker';
  url: string;
  s3Key: string;
  prompt: string;
  caption?: string;
  model: string;
  platform?: string;       // Where it was generated for
  postedToTwitter: boolean;
  convertedToSticker: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

// Media generation job for async operations
export interface MediaJob {
  pk: string;              // MEDIAJOB#{jobId}
  sk: string;              // STATUS
  jobId: string;
  agentId: string;
  type: 'image' | 'video' | 'sticker';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt: string;

  // Callback info
  conversationId: string;
  platform: string;
  replyToMessageId?: string;

  // Provider tracking
  provider: string;
  externalId?: string;     // Replicate prediction ID, etc.

  // Results
  resultUrl?: string;
  resultS3Key?: string;
  error?: string;

  // Timestamps
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  ttl: number;             // DynamoDB TTL for auto-cleanup
}

// Credit bucket for rate limiting
export interface CreditBucket {
  pk: string;              // AGENT#{agentId}
  sk: string;              // CREDIT#{toolName}
  agentId: string;
  toolName: string;
  credits: number;
  maxCredits: number;
  lastRefillAt: number;
  dailyUsed: number;
  dailyLimit: number;
  dailyResetAt: number;
}

// Chat message schemas for the admin chatbot
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const AdminChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

export const ToolResultSchema = z.object({
  tool_call_id: z.string(),
  role: z.literal('tool'),
  content: z.string(),
});

// Agent context in chat request
export const AgentContextSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  persona: z.string().optional(),
});

// Chat request body schema
export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  history: z.array(AdminChatMessageSchema).default([]),
  agent: AgentContextSchema.optional(),
});

// Infer types from schemas
export type AdminChatMessage = z.infer<typeof AdminChatMessageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// Admin chatbot tool definitions
export const AdminTools = {
  // Agent Management
  create_agent: z.object({
    name: z.string().describe('Name for the new agent'),
    description: z.string().optional().describe('Description of the agent'),
  }),
  
  update_agent: z.object({
    agentId: z.string().describe('ID of the agent to update'),
    name: z.string().optional(),
    description: z.string().optional(),
    persona: z.string().optional(),
  }),
  
  list_agents: z.object({}),
  
  get_agent: z.object({
    agentId: z.string().describe('ID of the agent'),
  }),
  
  delete_agent: z.object({
    agentId: z.string().describe('ID of the agent to delete'),
    confirm: z.boolean().describe('Must be true to confirm deletion'),
  }),

  // Platform Configuration
  configure_telegram: z.object({
    agentId: z.string(),
    botToken: z.string().describe('Telegram bot token from @BotFather'),
    botUsername: z.string().optional(),
  }),
  
  configure_twitter: z.object({
    agentId: z.string(),
    apiKey: z.string(),
    apiSecret: z.string(),
    accessToken: z.string(),
    accessSecret: z.string(),
    bearerToken: z.string().optional(),
    username: z.string().optional(),
  }),
  
  configure_discord: z.object({
    agentId: z.string(),
    botToken: z.string(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    guildId: z.string().optional(),
  }),

  // AI Provider Keys
  set_openrouter_key: z.object({
    apiKey: z.string().describe('OpenRouter API key'),
    agentId: z.string().optional().describe('Agent ID for per-agent key, omit for global'),
  }),
  
  set_anthropic_key: z.object({
    apiKey: z.string().describe('Anthropic API key'),
    agentId: z.string().optional(),
  }),
  
  set_openai_key: z.object({
    apiKey: z.string().describe('OpenAI API key'),
    agentId: z.string().optional(),
  }),
  
  set_replicate_key: z.object({
    apiKey: z.string().describe('Replicate API key'),
    agentId: z.string().optional(),
  }),

  // Wallet Management
  generate_solana_wallet: z.object({
    agentId: z.string(),
    name: z.string().describe('Name for the wallet'),
  }),
  
  generate_ethereum_wallet: z.object({
    agentId: z.string(),
    name: z.string().describe('Name for the wallet'),
  }),
  
  list_wallets: z.object({
    agentId: z.string().optional().describe('Filter by agent, omit for all'),
  }),
  
  get_wallet_balance: z.object({
    walletId: z.string(),
  }),

  // Secret Management (write-only)
  set_custom_secret: z.object({
    agentId: z.string().optional().describe('Agent ID or omit for global'),
    name: z.string().describe('Name of the secret'),
    value: z.string().describe('Secret value'),
    description: z.string().optional(),
  }),
  
  list_secrets: z.object({
    agentId: z.string().optional().describe('Filter by agent, omit for all'),
  }),
  
  delete_secret: z.object({
    agentId: z.string().optional(),
    secretName: z.string(),
    confirm: z.boolean(),
  }),

  // Deployment
  deploy_agent: z.object({
    agentId: z.string(),
    environment: z.enum(['dev', 'staging', 'prod']).optional(),
  }),
  
  get_deployment_status: z.object({
    agentId: z.string(),
  }),
};

export type AdminToolName = keyof typeof AdminTools;

// === CHANNEL STATE (Kyro-style architecture) ===

// Channel state machine states
export type ChannelState = 'IDLE' | 'ACTIVE' | 'COOLDOWN';

// Buffered message in a channel
export interface BufferedMessage {
  messageId: number;
  userId: number;
  userName: string;
  username?: string;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
  replyToUserId?: number;
  isMention?: boolean;
  isReplyToBot?: boolean;
}

// Channel state record stored in DynamoDB
export interface ChannelStateRecord {
  pk: string;              // CHANNEL#{agentId}#{chatId}
  sk: string;              // STATE
  agentId: string;
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;

  // State machine
  state: ChannelState;
  stateChangedAt: number;

  // Message buffer (last N messages)
  messageBuffer: BufferedMessage[];
  bufferSize: number;

  // Response tracking
  lastResponseAt?: number;
  lastResponseMessageId?: number;
  pendingResponseAt?: number;  // Scheduled response time

  // Engagement tracking
  directEngagementAt?: number;  // Last mention/reply
  lastActivityAt: number;

  // TTL for cleanup
  ttl: number;
  updatedAt: number;
}

// Response trigger types
export type ResponseTrigger =
  | 'direct_engagement'    // Mention or reply to bot
  | 'message_threshold'    // N messages accumulated
  | 'conversation_gap'     // Silence after activity
  | 'scheduled'            // Scheduled evaluation
  | 'private_chat';        // Always respond in private

// Response decision
export interface ResponseDecision {
  shouldRespond: boolean;
  trigger: ResponseTrigger | 'none';
  delay: number;           // Delay in ms before responding (0 = immediate)
  priority: 'high' | 'normal' | 'low';
}

// ========================================
// Multi-Agent D&D Coordination Types
// ========================================

/**
 * D&D ability scores with computed modifiers
 * Generated deterministically from agent createdAt timestamp
 */
export interface AgentStats {
  STR: number; // Strength - reserved for future use
  DEX: number; // Dexterity - Initiative modifier
  CON: number; // Constitution - reserved for future use
  INT: number; // Intelligence - reserved for future use
  WIS: number; // Wisdom - Interest check (reflective contexts)
  CHA: number; // Charisma - Interest check (social contexts)
  modifiers: {
    STR: number;
    DEX: number;
    CON: number;
    INT: number;
    WIS: number;
    CHA: number;
  };
}

/**
 * Shared channel registry record
 * Tracks all agents present in a Telegram channel/group
 * Key: pk=SHARED_CHANNEL#{chatId}, sk=AGENT#{agentId}
 */
export interface SharedChannelRecord {
  pk: string;              // SHARED_CHANNEL#{chatId}
  sk: string;              // AGENT#{agentId}
  chatId: number;
  agentId: string;
  botUsername: string;     // For mention detection
  joinedAt: number;        // First seen in channel
  lastSeenAt: number;      // Last activity
  stats: AgentStats;       // D&D ability scores
  ttl: number;             // Auto-cleanup after inactivity
}

/**
 * Initiative round phases
 */
export type InitiativePhase = 'interest' | 'rolling' | 'responding' | 'reacting' | 'complete';

/**
 * Initiative round coordination record
 * Coordinates which agent responds to a message in multi-agent channels
 * Key: pk=INITIATIVE#{chatId}#{messageId}, sk=META or ROLL#{agentId}
 */
export interface InitiativeRoundRecord {
  pk: string;              // INITIATIVE#{chatId}#{messageId}
  sk: string;              // META or ROLL#{agentId}
  chatId: number;
  messageId: number;       // Triggering message ID

  // For META record (sk: META)
  phase?: InitiativePhase;
  startedAt?: number;
  expiresAt?: number;      // Round times out after this
  winnerId?: string;       // Agent who won initiative
  winnerRoll?: number;     // Winning roll total
  winnerRespondedAt?: number;

  // For ROLL records (sk: ROLL#{agentId})
  agentId?: string;
  interested?: boolean;    // Interest check result
  interestRoll?: number;   // CHA/WIS check roll
  initiativeRoll?: number; // d20 roll
  initiativeModifier?: number; // DEX modifier
  totalInitiative?: number; // roll + modifier
  rolledAt?: number;

  ttl: number;             // Auto-cleanup (5 min)
}

/**
 * Interest check result
 */
export interface InterestCheckResult {
  interested: boolean;
  roll: number;
  modifier: number;
  dc: number;
  reason: 'direct_engagement' | 'context_interest' | 'not_interested';
}

/**
 * Initiative coordination result
 */
export type InitiativeAction = 'respond' | 'react' | 'skip';

export interface InitiativeResult {
  action: InitiativeAction;
  reason: string;
  priority?: 'primary' | 'secondary';
  winnerId?: string;
  winnerRoll?: number;
  myRoll?: number;
}
