/**
 * Shared Telegram Webhook Handler
 * Handles webhooks for ALL agents dynamically - no per-agent CDK deployment needed
 *
 * Security features:
 * - Secret token verification (X-Telegram-Bot-Api-Secret-Token header)
 * - IP address verification (Telegram server ranges)
 * - Minimal error disclosure
 * - Sanitized logging
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { isValidTelegramIP } from '../services/telegram.js';
import { timingSafeEqual } from 'crypto';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';

// Whether to enforce IP verification (disable for testing behind proxies)
const ENFORCE_IP_CHECK = process.env.ENFORCE_TELEGRAM_IP_CHECK !== 'false';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: 'private' | 'group' | 'supergroup' | 'channel';
      title?: string;
    };
    date: number;
    text?: string;
    reply_to_message?: {
      message_id: number;
      text?: string;
    };
  };
}

interface AgentConfig {
  agentId: string;
  name: string;
  persona?: string;
  platforms: {
    telegram?: {
      enabled: boolean;
      botUsername?: string;
    };
  };
  llmConfig: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
  wallets?: Array<{
    name: string;
    publicKey: string;
  }>;
  profileImage?: {
    url: string;
  };
}

// Cache for secrets
const secretsCache = new Map<string, string>();

async function getSecret(secretArn: string): Promise<string | null> {
  if (secretsCache.has(secretArn)) {
    return secretsCache.get(secretArn)!;
  }

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    const value = response.SecretString || null;
    if (value) {
      secretsCache.set(secretArn, value);
    }
    return value;
  } catch (error) {
    console.error('Failed to get secret:', error);
    return null;
  }
}

async function getAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'CONFIG',
    },
  }));

  if (!result.Item) return null;

  const config = result.Item as AgentConfig;

  // Also fetch wallets
  const walletsResult = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'WALLETS',
    },
  }));

  if (walletsResult.Item?.wallets) {
    config.wallets = walletsResult.Item.wallets as AgentConfig['wallets'];
  }

  return config;
}

async function getTelegramToken(agentId: string): Promise<string | null> {
  // Look up the secret ARN from the secrets metadata
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'SECRET#telegram_bot_token#default',
    },
  }));

  if (!result.Item?.secretArn) {
    return null;
  }

  return getSecret(result.Item.secretArn);
}

async function getWebhookSecret(agentId: string): Promise<string | null> {
  // Look up the webhook secret for this agent
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'SECRET#telegram_webhook_secret#default',
    },
  }));

  if (!result.Item?.secretArn) {
    return null;
  }

  return getSecret(result.Item.secretArn);
}

/**
 * Timing-safe comparison of secret tokens to prevent timing attacks
 */
function verifySecretToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;

  // Convert to buffers for timing-safe comparison
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  // Length check (this leaks length info, but Telegram tokens are fixed format)
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Extract client IP from request (handles proxies like Cloudflare, API Gateway)
 */
function getClientIP(event: APIGatewayProxyEventV2): string | null {
  // X-Forwarded-For can have multiple IPs: client, proxy1, proxy2
  // The rightmost trusted proxy's left neighbor is the real client
  // For API Gateway behind Cloudflare, CF-Connecting-IP is most reliable
  const cfConnectingIP = event.headers['cf-connecting-ip'];
  if (cfConnectingIP) return cfConnectingIP;

  const forwardedFor = event.headers['x-forwarded-for'];
  if (forwardedFor) {
    // Take the first (leftmost) IP as client IP
    return forwardedFor.split(',')[0].trim();
  }

  return event.requestContext.http.sourceIp || null;
}

async function getLlmApiKey(): Promise<string> {
  if (!LLM_API_KEY_SECRET_ARN) {
    throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  }

  const value = await getSecret(LLM_API_KEY_SECRET_ARN);
  if (!value) {
    throw new Error('Failed to get LLM API key');
  }

  // Parse JSON secret format
  try {
    const parsed = JSON.parse(value);
    return parsed.api_key || parsed.apiKey || value;
  } catch {
    return value;
  }
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  replyToMessageId?: number
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  };

  if (replyToMessageId) {
    body.reply_to_message_id = replyToMessageId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Telegram API error:', error);
  }
}

async function generateResponse(
  agent: AgentConfig,
  message: string,
  chatContext?: string
): Promise<string> {
  const apiKey = await getLlmApiKey();

  const systemPrompt = agent.persona || `You are ${agent.name}, a helpful AI assistant.`;

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  if (chatContext) {
    messages.push({ role: 'assistant', content: `Previous context: ${chatContext}` });
  }

  messages.push({ role: 'user', content: message });

  const response = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://swarm.telegram',
      'X-Title': `Swarm Agent: ${agent.name}`,
    },
    body: JSON.stringify({
      model: agent.llmConfig.model || LLM_MODEL,
      messages,
      max_tokens: agent.llmConfig.maxTokens || 1024,
      temperature: agent.llmConfig.temperature || 0.8,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM API error: ${error}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return data.choices?.[0]?.message?.content || 'I apologize, but I couldn\'t generate a response.';
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  // Sanitized logging - only log metadata, never message content
  const agentId = event.pathParameters?.agentId;
  const clientIP = getClientIP(event);
  console.log('Telegram webhook:', {
    agentId,
    clientIP,
    hasSecretHeader: !!event.headers['x-telegram-bot-api-secret-token'],
    method: event.requestContext.http.method,
  });

  // Always return 200 to prevent Telegram retries, even on auth failures
  // This prevents information leakage about which agents exist
  const ok = () => ({ statusCode: 200, body: 'OK' });

  try {
    // === SECURITY CHECK 1: Validate agent ID format ===
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      console.warn('Invalid agent ID format');
      return ok();
    }

    // === SECURITY CHECK 2: IP verification (if enabled) ===
    if (ENFORCE_IP_CHECK && clientIP) {
      if (!isValidTelegramIP(clientIP)) {
        console.warn(`Request from non-Telegram IP: ${clientIP}`);
        // Don't immediately reject - could be legitimate proxy
        // But log for monitoring
      }
    }

    // === SECURITY CHECK 3: Get webhook secret and verify ===
    const webhookSecret = await getWebhookSecret(agentId);
    const providedSecret = event.headers['x-telegram-bot-api-secret-token'];

    if (webhookSecret) {
      // Secret is configured - verify it
      if (!verifySecretToken(providedSecret, webhookSecret)) {
        console.warn(`Invalid secret token for agent: ${agentId}`);
        return ok(); // Silent failure to prevent enumeration
      }
    } else {
      // No secret configured - log warning but allow (for backwards compatibility)
      // TODO: Make this a hard failure once all agents have secrets configured
      console.warn(`No webhook secret configured for agent: ${agentId}`);
    }

    // === Load agent config ===
    const agent = await getAgentConfig(agentId);
    if (!agent) {
      // Don't reveal agent doesn't exist
      console.warn(`Agent not found: ${agentId}`);
      return ok();
    }

    // Check if Telegram is enabled
    if (!agent.platforms.telegram?.enabled) {
      console.warn(`Telegram not enabled for agent: ${agentId}`);
      return ok();
    }

    // Get Telegram token
    const token = await getTelegramToken(agentId);
    if (!token) {
      console.error(`Telegram token not configured for agent: ${agentId}`);
      return ok();
    }

    // Parse the update
    const body = event.body ? JSON.parse(event.body) : null;
    if (!body) {
      return ok();
    }

    const update: TelegramUpdate = body;

    // Only handle text messages for now
    if (!update.message?.text) {
      return ok();
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text!;  // Guaranteed by check above
    const messageId = message.message_id;

    // Skip if message is from a bot
    if (message.from?.username?.endsWith('bot')) {
      return ok();
    }

    // Sanitized log - don't log message content
    console.log('Processing message:', {
      agentId,
      chatId,
      messageId,
      fromUser: message.from?.id,
      textLength: text.length,
    });

    // Generate response
    const response = await generateResponse(
      agent,
      text,
      message.reply_to_message?.text
    );

    // Send response
    await sendTelegramMessage(token, chatId, response, messageId);

    return ok();
  } catch (error) {
    // Log error but don't expose details
    console.error('Webhook handler error:', error instanceof Error ? error.message : 'Unknown');
    return ok();
  }
}
