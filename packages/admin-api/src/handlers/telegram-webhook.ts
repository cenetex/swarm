/**
 * Shared Telegram Webhook Handler
 * Full-featured agent with conversation history and tool support
 *
 * Features:
 * - Conversation history per chat (stored in DynamoDB)
 * - Tool support: image/video generation, wallet info, gallery
 * - Attention tracking for selective responses
 * - Media sending (photos, videos, stickers)
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { isValidTelegramIP } from '../services/telegram.js';
import { timingSafeEqual } from 'crypto';
import * as media from '../services/media.js';
import * as gallery from '../services/gallery.js';
import * as wallets from '../services/wallets.js';
import * as credits from '../services/credits.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';
const ENFORCE_IP_CHECK = process.env.ENFORCE_TELEGRAM_IP_CHECK !== 'false';

// === CONFIG ===
const ATTENTION_DURATION_SECONDS = 300;
const INITIAL_ATTENTION = 1.0;
const ATTENTION_DECAY = 0.7;
const MIN_ATTENTION_THRESHOLD = 0.2;
const RANDOM_REPLY_CHANCE = 0.05;
const MAX_HISTORY_MESSAGES = 20;
const HISTORY_TTL_SECONDS = 3600; // 1 hour

// === TYPES ===
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name: string; last_name?: string; username?: string };
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
    date: number;
    text?: string;
    reply_to_message?: { message_id: number; text?: string; from?: { id: number; username?: string } };
  };
}

interface AgentConfig {
  agentId: string;
  name: string;
  persona?: string;
  platforms: {
    telegram?: { enabled: boolean; botUsername?: string; botId?: number };
    twitter?: { enabled: boolean };
  };
  llmConfig: { provider: string; model: string; temperature: number; maxTokens: number };
  wallets?: Array<{ name: string; publicKey: string }>;
  profileImage?: { url: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// === TOOLS FOR TELEGRAM ===
const TELEGRAM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt. The image will be sent to the chat.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Description of the image to generate' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_video',
      description: 'Generate a short video from a text prompt. This takes time - I will send it when ready.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Description of the video to generate' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_gallery',
      description: 'View my generated images and videos',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['image', 'video', 'sticker'], description: 'Filter by type' },
          limit: { type: 'number', description: 'Max items (default 5)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_wallets',
      description: 'Get my Solana wallet addresses and balances',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_gallery_image',
      description: 'Send an image from my gallery to the chat',
      parameters: {
        type: 'object',
        properties: {
          imageId: { type: 'string', description: 'ID of the gallery image to send' },
        },
        required: ['imageId'],
      },
    },
  },
];

// === CACHES ===
const secretsCache = new Map<string, string>();

// === HELPER FUNCTIONS ===
async function getSecret(secretArn: string): Promise<string | null> {
  if (secretsCache.has(secretArn)) return secretsCache.get(secretArn)!;
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = response.SecretString || null;
    if (value) secretsCache.set(secretArn, value);
    return value;
  } catch (error) {
    console.error('Failed to get secret:', error);
    return null;
  }
}

async function getAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk: 'CONFIG' },
  }));
  if (!result.Item) return null;
  const config = result.Item as AgentConfig;

  // Fetch wallets
  const walletsResult = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: { ':pk': `AGENT#${agentId}`, ':sk': 'WALLET#' },
  }));
  if (walletsResult.Items?.length) {
    config.wallets = walletsResult.Items.map(w => ({ name: w.name, publicKey: w.publicKey }));
  }

  return config;
}

async function getTelegramToken(agentId: string): Promise<string | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk: 'SECRET#telegram_bot_token#default' },
  }));
  if (!result.Item?.secretArn) return null;
  return getSecret(result.Item.secretArn);
}

async function getWebhookSecret(agentId: string): Promise<string | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk: 'SECRET#telegram_webhook_secret#default' },
  }));
  if (!result.Item?.secretArn) return null;
  return getSecret(result.Item.secretArn);
}

async function getLlmApiKey(): Promise<string> {
  if (!LLM_API_KEY_SECRET_ARN) throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  const value = await getSecret(LLM_API_KEY_SECRET_ARN);
  if (!value) throw new Error('Failed to get LLM API key');
  try {
    const parsed = JSON.parse(value);
    return parsed.api_key || parsed.apiKey || value;
  } catch {
    return value;
  }
}

// === CONVERSATION HISTORY ===
async function getConversationHistory(agentId: string, chatId: number): Promise<ChatMessage[]> {
  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `TELEGRAM#${agentId}#${chatId}`, sk: 'HISTORY' },
    }));
    if (!result.Item?.messages) return [];
    // Check TTL
    if (result.Item.ttl && Date.now() / 1000 > result.Item.ttl) return [];
    return result.Item.messages as ChatMessage[];
  } catch {
    return [];
  }
}

async function saveConversationHistory(
  agentId: string,
  chatId: number,
  messages: ChatMessage[]
): Promise<void> {
  // Keep only recent messages
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  const ttl = Math.floor(Date.now() / 1000) + HISTORY_TTL_SECONDS;

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk: `TELEGRAM#${agentId}#${chatId}`,
        sk: 'HISTORY',
        messages: trimmed,
        ttl,
        updatedAt: Date.now(),
      },
    }));
  } catch (err) {
    console.warn('Failed to save conversation history:', err);
  }
}

// === ATTENTION TRACKING ===
async function getAttention(agentId: string, chatId: number, userId: number): Promise<number> {
  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `ATTENTION#${agentId}#${chatId}`, sk: `USER#${userId}` },
    }));
    if (!result.Item) return 0;
    if (Date.now() / 1000 > (result.Item.ttl as number)) return 0;
    return result.Item.attention as number;
  } catch {
    return 0;
  }
}

async function setAttention(agentId: string, chatId: number, userId: number, attention: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk: `ATTENTION#${agentId}#${chatId}`,
        sk: `USER#${userId}`,
        attention,
        lastInteraction: now,
        ttl: now + ATTENTION_DURATION_SECONDS,
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
      Key: { pk: `ATTENTION#${agentId}#${chatId}`, sk: `USER#${userId}` },
      UpdateExpression: 'SET attention = attention * :decay, lastInteraction = :now',
      ExpressionAttributeValues: { ':decay': ATTENTION_DECAY, ':now': Math.floor(Date.now() / 1000) },
      ConditionExpression: 'attribute_exists(pk)',
    }));
  } catch {
    // Ignore
  }
}

function isBotMentioned(text: string, botUsername?: string): boolean {
  if (!botUsername) return false;
  return new RegExp(`@${botUsername}\\b`, 'i').test(text);
}

async function shouldRespond(
  agentId: string,
  message: NonNullable<TelegramUpdate['message']>,
  agent: AgentConfig
): Promise<{ respond: boolean; reason: string; setAttention?: boolean }> {
  const chatType = message.chat.type;
  const userId = message.from?.id;
  const text = message.text || '';
  const botUsername = agent.platforms.telegram?.botUsername;
  const botId = agent.platforms.telegram?.botId;

  // Always respond to DMs
  if (chatType === 'private') {
    return { respond: true, reason: 'private_chat' };
  }

  // Always respond to direct mentions
  if (isBotMentioned(text, botUsername)) {
    return { respond: true, reason: 'mentioned', setAttention: true };
  }

  // Check if replying to bot's message
  if (message.reply_to_message) {
    const replyToId = message.reply_to_message.from?.id;
    const replyToUsername = message.reply_to_message.from?.username;
    if ((botId && replyToId === botId) || (botUsername && replyToUsername === botUsername)) {
      return { respond: true, reason: 'reply_to_bot', setAttention: true };
    }
    // Has attention and replying
    if (userId) {
      const attention = await getAttention(agentId, message.chat.id, userId);
      if (attention > MIN_ATTENTION_THRESHOLD) {
        return { respond: true, reason: 'reply_with_attention' };
      }
    }
  }

  // Check attention level
  if (userId) {
    const attention = await getAttention(agentId, message.chat.id, userId);
    if (attention >= MIN_ATTENTION_THRESHOLD) {
      return { respond: true, reason: 'has_attention' };
    }
  }

  // Random chance
  if (Math.random() < RANDOM_REPLY_CHANCE) {
    return { respond: true, reason: 'random' };
  }

  return { respond: false, reason: 'no_trigger' };
}

// === TELEGRAM API ===
async function sendTelegramMessage(token: string, chatId: number, text: string, replyTo?: number): Promise<number | null> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_to_message_id: replyTo,
    }),
  });
  if (!response.ok) {
    console.error('Telegram sendMessage error:', await response.text());
    return null;
  }
  const data = await response.json() as { result?: { message_id: number } };
  return data.result?.message_id || null;
}

async function sendTelegramPhoto(token: string, chatId: number, photoUrl: string, caption?: string, replyTo?: number): Promise<void> {
  console.log(`[Telegram] Sending photo to chat ${chatId}: ${photoUrl.slice(0, 80)}...`);

  // Download the image first, then send as buffer
  // This is more reliable than letting Telegram fetch the URL (which may be private S3)
  // Same approach as solanafirehorse implementation
  try {
    const imageResponse = await fetch(photoUrl);
    if (!imageResponse.ok) {
      console.error(`[Telegram] Failed to download image: ${imageResponse.status}`);
      // Fall back to URL-based send (might work for public CDN URLs)
      const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: photoUrl,
          caption: caption?.slice(0, 1024),
          parse_mode: 'Markdown',
          reply_to_message_id: replyTo,
        }),
      });
      if (!response.ok) {
        console.error(`[Telegram] sendPhoto (URL fallback) failed: ${response.status}`, await response.text());
      }
      return;
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    console.log(`[Telegram] Downloaded image: ${imageBuffer.length} bytes, sending as buffer`);

    // Send as multipart form data with the buffer
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('photo', imageBuffer, { filename: 'image.png', contentType: 'image/png' });
    if (caption) {
      form.append('caption', caption.slice(0, 1024));
      form.append('parse_mode', 'Markdown');
    }
    if (replyTo) {
      form.append('reply_to_message_id', replyTo.toString());
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form as any,
      headers: form.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Telegram] sendPhoto (buffer) failed: ${response.status}`, errorText);
    } else {
      console.log(`[Telegram] Photo sent successfully to chat ${chatId}`);
    }
  } catch (err) {
    console.error(`[Telegram] Error sending photo:`, err);
  }
}

async function sendTelegramVideo(token: string, chatId: number, videoUrl: string, caption?: string, replyTo?: number): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      video: videoUrl,
      caption,
      parse_mode: 'Markdown',
      reply_to_message_id: replyTo,
    }),
  });
  if (!response.ok) {
    console.error('Telegram sendVideo error:', await response.text());
  }
}

async function sendChatAction(token: string, chatId: number, action: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

// === TOOL EXECUTION ===
interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
  media?: { type: 'image' | 'video'; url: string; caption?: string };
}

async function executeTool(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  chatId: number,
  agent?: AgentConfig
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'generate_image': {
        const prompt = args.prompt as string;
        console.log(`[Telegram] generate_image called with prompt: ${prompt.slice(0, 50)}...`);

        const canUse = await credits.canUseTool(agentId, 'generate_image');
        if (!canUse.allowed) {
          console.log(`[Telegram] Rate limited: ${canUse.reason}`);
          return { success: false, error: `Rate limited: ${canUse.reason}` };
        }

        // Build reference images array - always include profile image
        const referenceImageUrls: string[] = [];
        if (agent?.profileImage?.url) {
          referenceImageUrls.push(agent.profileImage.url);
          console.log(`[Telegram] Using profile image as reference: ${agent.profileImage.url.slice(0, 50)}...`);
        } else {
          // Fallback: check for reference images with 'profile' or 'character' category
          console.log(`[Telegram] No profile image set, checking reference images...`);
          const refImages = await media.listReferenceImages(agentId);
          const profileRef = refImages.find(img => img.category === 'profile');
          const characterRef = refImages.find(img => img.category === 'character');
          if (profileRef?.url) {
            referenceImageUrls.push(profileRef.url);
            console.log(`[Telegram] Using 'profile' reference image: ${profileRef.url.slice(0, 50)}...`);
          } else if (characterRef?.url) {
            referenceImageUrls.push(characterRef.url);
            console.log(`[Telegram] Using 'character' reference image: ${characterRef.url.slice(0, 50)}...`);
          } else {
            console.log(`[Telegram] No profile or character reference images found`);
          }
        }

        await sendChatAction(token, chatId, 'upload_photo');

        try {
          const result = await media.generateImage({
            prompt,
            agentId,
            platform: 'telegram',
            referenceImageUrls,
          });

          // Use the actual CDN URL from the result
          // The media.generateImage() already returns the proper CDN URL
          console.log(`[Telegram] Image generated successfully: ${result.url}`);
          return {
            success: true,
            result: { id: result.id, url: result.url },
            media: { type: 'image', url: result.url, caption: prompt },
          };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[Telegram] Image generation failed:`, errorMsg);
          return { success: false, error: `Image generation failed: ${errorMsg}` };
        }
      }

      case 'generate_video': {
        const prompt = args.prompt as string;
        const canUse = await credits.canUseTool(agentId, 'generate_video');
        if (!canUse.allowed) {
          return { success: false, error: `Rate limited: ${canUse.reason}` };
        }

        // Video generation is async - just start it
        await sendChatAction(token, chatId, 'upload_video');
        const job = await media.generateVideo({
          prompt,
          agentId,
          platform: 'telegram',
          conversationId: `telegram-${chatId}`,
        });
        return {
          success: true,
          result: { jobId: job.jobId, status: 'started', message: 'Video generation started. I will send it when ready!' },
        };
      }

      case 'get_my_gallery': {
        const type = args.type as 'image' | 'video' | 'sticker' | undefined;
        const limit = (args.limit as number) || 5;
        const items = await gallery.getGallery(agentId, { type, limit });
        return {
          success: true,
          result: items.map(i => ({ id: i.id, type: i.type, url: i.url, prompt: i.prompt })),
        };
      }

      case 'get_my_wallets': {
        const walletList = await wallets.listWallets(agentId);
        const enriched = await Promise.all(
          walletList
            .filter(w => w.walletType === 'solana')
            .map(async (w) => {
              try {
                const balance = await wallets.getSolanaBalance(w.publicKey, agentId);
                return { ...w, solBalance: balance.solBalance };
              } catch {
                return { ...w, solBalance: null };
              }
            })
        );
        return { success: true, result: enriched };
      }

      case 'send_gallery_image': {
        const imageId = args.imageId as string;
        const item = await gallery.getGalleryItem(agentId, imageId);
        if (!item) {
          return { success: false, error: 'Image not found in gallery' };
        }
        return {
          success: true,
          result: { id: item.id, url: item.url },
          media: { type: 'image', url: item.url, caption: item.prompt },
        };
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    console.error(`Tool ${toolName} error:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// === LLM CALL WITH TOOLS ===
async function callLLM(
  messages: ChatMessage[],
  agent: AgentConfig,
  tools?: typeof TELEGRAM_TOOLS
): Promise<{ content?: string; toolCalls?: ToolCall[] }> {
  const apiKey = await getLlmApiKey();

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
      tools: tools?.length ? tools : undefined,
      max_tokens: agent.llmConfig.maxTokens || 1024,
      temperature: agent.llmConfig.temperature || 0.8,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${await response.text()}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }>;
  };

  const choice = data.choices?.[0]?.message;
  return { content: choice?.content || undefined, toolCalls: choice?.tool_calls };
}

// === MAIN PROCESSING ===
async function processMessage(
  agentId: string,
  agent: AgentConfig,
  message: NonNullable<TelegramUpdate['message']>,
  token: string
): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text || '';
  const messageId = message.message_id;
  const userName = message.from?.first_name || 'User';

  // Get conversation history
  const history = await getConversationHistory(agentId, chatId);

  // Build system prompt
  let systemPrompt = agent.persona || `You are ${agent.name}, a helpful AI assistant on Telegram.`;
  systemPrompt += `\n\nYou are chatting on Telegram. Keep responses concise and conversational.`;
  systemPrompt += `\nYou can generate images and videos when asked. Just use the tools available to you.`;

  if (agent.wallets?.length) {
    systemPrompt += `\n\n## Your Solana Wallets\n`;
    agent.wallets.forEach(w => { systemPrompt += `- ${w.name}: ${w.publicKey}\n`; });
  }

  if (agent.profileImage?.url) {
    systemPrompt += `\n\n## Your Profile Image\n${agent.profileImage.url}`;
  }

  // Build messages
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: `${userName}: ${text}` },
  ];

  // Tool loop
  let iterations = 0;
  const maxIterations = 5;
  const mediasToSend: Array<{ type: 'image' | 'video'; url: string; caption?: string }> = [];

  while (iterations++ < maxIterations) {
    await sendChatAction(token, chatId, 'typing');

    const llmResponse = await callLLM(messages, agent, TELEGRAM_TOOLS);

    if (llmResponse.toolCalls?.length) {
      // Add assistant message with tool calls
      messages.push({ role: 'assistant', content: '', tool_calls: llmResponse.toolCalls });

      // Execute tools
      for (const tc of llmResponse.toolCalls) {
        const args = JSON.parse(tc.function.arguments || '{}');
        const result = await executeTool(agentId, tc.function.name, args, token, chatId, agent);

        // Add tool result
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
        });

        // Collect media to send
        if (result.media) {
          mediasToSend.push(result.media);
        }
      }

      // Continue loop to get final response
      continue;
    }

    // No tool calls - we have final response
    if (llmResponse.content) {
      messages.push({ role: 'assistant', content: llmResponse.content });

      // Send text response
      await sendTelegramMessage(token, chatId, llmResponse.content, messageId);

      // Send any collected media
      for (const m of mediasToSend) {
        if (m.type === 'image') {
          await sendTelegramPhoto(token, chatId, m.url, m.caption);
        } else if (m.type === 'video') {
          await sendTelegramVideo(token, chatId, m.url, m.caption);
        }
      }
    }

    break;
  }

  // Save updated history (excluding system prompt)
  await saveConversationHistory(agentId, chatId, messages.slice(1));
}

// === SECURITY ===
function verifySecretToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function getClientIP(event: APIGatewayProxyEventV2): string | null {
  return event.headers['cf-connecting-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0].trim() ||
    event.requestContext.http.sourceIp || null;
}

// === HANDLER ===
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const agentId = event.pathParameters?.agentId;
  const clientIP = getClientIP(event);

  console.log('Telegram webhook:', { agentId, clientIP, method: event.requestContext.http.method });

  const ok = () => ({ statusCode: 200, body: 'OK' });

  try {
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      console.warn('Invalid agent ID');
      return ok();
    }

    if (ENFORCE_IP_CHECK && clientIP && !isValidTelegramIP(clientIP)) {
      console.warn(`Non-Telegram IP: ${clientIP}`);
    }

    // Verify webhook secret
    const webhookSecret = await getWebhookSecret(agentId);
    const providedSecret = event.headers['x-telegram-bot-api-secret-token'];
    if (webhookSecret && !verifySecretToken(providedSecret, webhookSecret)) {
      console.warn(`Invalid secret for: ${agentId}`);
      return ok();
    }

    // Load agent
    const agent = await getAgentConfig(agentId);
    if (!agent || !agent.platforms.telegram?.enabled) {
      console.warn(`Agent not found or Telegram disabled: ${agentId}`);
      return ok();
    }

    // Get token
    const token = await getTelegramToken(agentId);
    if (!token) {
      console.error(`No Telegram token for: ${agentId}`);
      return ok();
    }

    // Parse update
    const update: TelegramUpdate = event.body ? JSON.parse(event.body) : {};
    if (!update.message?.text) return ok();

    const message = update.message;
    const userId = message.from?.id;

    // Skip bot messages
    if (message.from?.username?.endsWith('bot')) return ok();

    // Check if should respond
    const decision = await shouldRespond(agentId, message, agent);

    console.log('Message decision:', {
      agentId,
      chatId: message.chat.id,
      fromUser: userId,
      chatType: message.chat.type,
      decision: decision.reason,
      willRespond: decision.respond,
    });

    if (!decision.respond) return ok();

    // Set attention if triggered by mention/reply
    if (decision.setAttention && userId) {
      await setAttention(agentId, message.chat.id, userId, INITIAL_ATTENTION);
    }

    // Process message with tools
    await processMessage(agentId, agent, message, token);

    // Decay attention
    if (userId && decision.reason !== 'private_chat') {
      await decayAttention(agentId, message.chat.id, userId);
    }

    return ok();
  } catch (error) {
    console.error('Webhook error:', error instanceof Error ? error.message : 'Unknown');
    return ok();
  }
}
