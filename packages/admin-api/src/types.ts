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

// Chat message for the admin chatbot
export interface AdminChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  content: string;
}

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
