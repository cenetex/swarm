/**
 * Common/shared types used across multiple domains
 */
import { z } from 'zod';

// User session from first-party auth
export interface UserSession {
  email: string;
  userId: string;
  isAdmin: boolean;
  accessToken: string;
  accountId?: string;
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
  'discord_webhook_url',
  'openrouter_api_key',
  'anthropic_api_key',
  'replicate_api_key',
  'openai_api_key',
  'helius_api_key',
  'solana_wallet_key',
  'ethereum_wallet_key',
  'moltbook_api_key',
  'token_launch_api_key',
  'token_launch_partner_key',
  'token_launch_referral_code',
  'custom',
]);

export type SecretType = z.infer<typeof SecretType>;

// Secret metadata (stored in DynamoDB, NOT the actual secret)
export interface SecretMetadata {
  pk: string; // AVATAR#{avatarId} or GLOBAL
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
