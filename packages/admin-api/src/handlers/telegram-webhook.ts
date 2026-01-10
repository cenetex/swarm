/**
 * Shared Telegram Webhook Handler
 * Handles webhooks for ALL agents dynamically - no per-agent CDK deployment needed
 *
 * Security features:
 * - Secret token verification (X-Telegram-Bot-Api-Secret-Token header)
 * - IP address verification (Telegram server ranges)
 * - Minimal error disclosure
 * - Sanitized logging
 *
 * Response logic:
 * - Always responds to DMs
 * - Always responds to @mentions
 * - Responds to users with active attention (from recent mentions)
 * - Small random chance to respond to other messages
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

// === ATTENTION TRACKING CONFIG ===
const ATTENTION_DURATION_SECONDS = 300; // 5 minutes
const INITIAL_ATTENTION = 1.0;
const ATTENTION_DECAY = 0.7;
const MIN_ATTENTION_THRESHOLD = 0.2;
const RANDOM_REPLY_CHANCE = 0.05; // 5%

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

// === ATTENTION TRACKING ===

async function getAttention(agentId: string, chatId: number, userId: number): Promise<number> {
  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `ATTENTION#${agentId}#${chatId}`,
        sk: `USER#${userId}`,
      },
    }));

    if (!result.Item) return 0;

    // Check if expired (backup for TTL)
    if (Date.now() / 1000 > (result.Item.ttl as number)) return 0;

    return result.Item.attention as number;
  } catch {
    return 0;
  }
}

async function setAttention(
  agentId: string,
  chatId: number,
  userId: number,
  attention: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = now + ATTENTION_DURATION_SECONDS;

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk: `ATTENTION#${agentId}#${chatId}`,
        sk: `USER#${userId}`,
        attention,
        lastInteraction: now,
        ttl,
      },
    }));
  } catch (err) {
    console.warn('Failed to set attention:', err);
  }
}

async function decayAttention(agentId: string, chatId: number, userId: number): Promise<void> {
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `ATTENTION#${agentId}#${chatId}`,
        sk: `USER#${userId}`,
      },
      UpdateExpression: 'SET attention = attention * :decay, lastInteraction = :now',
      ExpressionAttributeValues: {
        ':decay': ATTENTION_DECAY,
        ':now': Math.floor(Date.now() / 1000),
      },
      ConditionExpression: 'attribute_exists(pk)',
    }));
  } catch {
    // Ignore - record may not exist
  }
}

function isBotMentioned(text: string, botUsername?: string): boolean {
  if (!botUsername) return false;
  const mentionPattern = new RegExp(`@${botUsername}\\b`, 'i');
  return mentionPattern.test(text);
}

async function shouldRespond(
  agentId: string,
  message: NonNullable<TelegramUpdate['message']>,
  botUsername?: string
): Promise<{ respond: boolean; reason: string; setAttention?: boolean }> {
  const chatType = message.chat.type;
  const userId = message.from?.id;
  const text = message.text || '';

  // Always respond to DMs
  if (chatType === 'private') {
    return { respond: true, reason: 'private_chat' };
  }

  // Always respond to direct mentions
  if (isBotMentioned(text, botUsername)) {
    return { respond: true, reason: 'mentioned', setAttention: true };
  }

  // Check if replying and has attention
  if (message.reply_to_message && userId) {
    const attention = await getAttention(agentId, message.chat.id, userId);
    if (attention > MIN_ATTENTION_THRESHOLD) {
      return { respond: true, reason: 'reply_with_attention' };
    }
  }

  // Check attention level for ongoing conversations
  if (userId) {
    const attention = await getAttention(agentId, message.chat.id, userId);
    if (attention >= MIN_ATTENTION_THRESHOLD) {
      return { respond: true, reason: 'has_attention' };
    }
  }

  // Random chance to reply (for engagement)
  if (Math.random() < RANDOM_REPLY_CHANCE) {
    return { respond: true, reason: 'random' };
  }

  return { respond: false, reason: 'no_trigger' };
}

function verifySecretToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}

function getClientIP(event: APIGatewayProxyEventV2): string | null {
  const cfConnectingIP = event.headers['cf-connecting-ip'];
  if (cfConnectingIP) return cfConnectingIP;

  const forwardedFor = event.headers['x-forwarded-for'];
  if (forwardedFor) {
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

  let systemPrompt = agent.persona || `You are ${agent.name}, a helpful AI assistant.`;

  if (agent.wallets && agent.wallets.length > 0) {
    systemPrompt += `\n\n## Your Solana Wallets\n`;
    for (const wallet of agent.wallets) {
      systemPrompt += `- ${wallet.name}: ${wallet.publicKey}\n`;
    }
    systemPrompt += `\nYou can share your wallet address when users ask about tipping, donations, or your wallet.`;
  }

  if (agent.profileImage?.url) {
    systemPrompt += `\n\n## Your Profile\n- Profile image: ${agent.profileImage.url}`;
  }

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
  const agentId = event.pathParameters?.agentId;
  const clientIP = getClientIP(event);
  console.log('Telegram webhook:', {
    agentId,
    clientIP,
    hasSecretHeader: !!event.headers['x-telegram-bot-api-secret-token'],
    method: event.requestContext.http.method,
  });

  const ok = () => ({ statusCode: 200, body: 'OK' });

  try {
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      console.warn('Invalid agent ID format');
      return ok();
    }

    if (ENFORCE_IP_CHECK && clientIP) {
      if (!isValidTelegramIP(clientIP)) {
        console.warn(`Request from non-Telegram IP: ${clientIP}`);
      }
    }

    const webhookSecret = await getWebhookSecret(agentId);
    const providedSecret = event.headers['x-telegram-bot-api-secret-token'];

    if (webhookSecret) {
      if (!verifySecretToken(providedSecret, webhookSecret)) {
        console.warn(`Invalid secret token for agent: ${agentId}`);
        return ok();
      }
    } else {
      console.warn(`No webhook secret configured for agent: ${agentId}`);
    }

    const agent = await getAgentConfig(agentId);
    if (!agent) {
      console.warn(`Agent not found: ${agentId}`);
      return ok();
    }

    if (!agent.platforms.telegram?.enabled) {
      console.warn(`Telegram not enabled for agent: ${agentId}`);
      return ok();
    }

    const token = await getTelegramToken(agentId);
    if (!token) {
      console.error(`Telegram token not configured for agent: ${agentId}`);
      return ok();
    }

    const body = event.body ? JSON.parse(event.body) : null;
    if (!body) {
      return ok();
    }

    const update: TelegramUpdate = body;

    if (!update.message?.text) {
      return ok();
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text!;
    const messageId = message.message_id;

    if (message.from?.username?.endsWith('bot')) {
      return ok();
    }

    const botUsername = agent.platforms.telegram?.botUsername;
    const userId = message.from?.id;

    // Check if we should respond
    const decision = await shouldRespond(agentId, message, botUsername);

    console.log('Processing message:', {
      agentId,
      chatId,
      messageId,
      fromUser: userId,
      textLength: text.length,
      chatType: message.chat.type,
      decision: decision.reason,
      willRespond: decision.respond,
    });

    if (!decision.respond) {
      return ok();
    }

    // Set attention if mentioned
    if (decision.setAttention && userId) {
      await setAttention(agentId, chatId, userId, INITIAL_ATTENTION);
    }

    // Generate and send response
    const response = await generateResponse(
      agent,
      text,
      message.reply_to_message?.text
    );

    await sendTelegramMessage(token, chatId, response, messageId);

    // Decay attention after responding (not in DMs)
    if (userId && decision.reason !== 'private_chat') {
      await decayAttention(agentId, chatId, userId);
    }

    return ok();
  } catch (error) {
    console.error('Webhook handler error:', error instanceof Error ? error.message : 'Unknown');
    return ok();
  }
}
