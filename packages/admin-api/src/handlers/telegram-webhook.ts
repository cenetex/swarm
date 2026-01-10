/**
 * Shared Telegram Webhook Handler
 * Handles webhooks for ALL agents dynamically - no per-agent CDK deployment needed
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';

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

  return result.Item as AgentConfig | null;
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
  console.log('Telegram webhook received:', JSON.stringify(event, null, 2));

  try {
    // Extract agent ID from path: /webhook/telegram/{agentId}
    const agentId = event.pathParameters?.agentId;

    if (!agentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Agent ID required' }),
      };
    }

    // Get agent config
    const agent = await getAgentConfig(agentId);
    if (!agent) {
      console.error(`Agent not found: ${agentId}`);
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Agent not found' }),
      };
    }

    // Check if Telegram is enabled
    if (!agent.platforms.telegram?.enabled) {
      console.error(`Telegram not enabled for agent: ${agentId}`);
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Telegram not enabled for this agent' }),
      };
    }

    // Get Telegram token
    const token = await getTelegramToken(agentId);
    if (!token) {
      console.error(`Telegram token not found for agent: ${agentId}`);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Telegram token not configured' }),
      };
    }

    // Parse the update
    const body = event.body ? JSON.parse(event.body) : null;
    if (!body) {
      return { statusCode: 200, body: 'OK' };
    }

    const update: TelegramUpdate = body;

    // Only handle text messages for now
    if (!update.message?.text) {
      return { statusCode: 200, body: 'OK' };
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text!; // Already checked above
    const messageId = message.message_id;

    // Skip if message is from a bot
    if (message.from?.username?.endsWith('bot')) {
      return { statusCode: 200, body: 'OK' };
    }

    console.log(`Processing message from ${message.from?.username || 'unknown'}: ${text}`);

    // Generate response
    const response = await generateResponse(
      agent,
      text,
      message.reply_to_message?.text
    );

    // Send response
    await sendTelegramMessage(token, chatId, response, messageId);

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('Webhook handler error:', error);
    // Return 200 to prevent Telegram retries
    return { statusCode: 200, body: 'OK' };
  }
}
