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
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { isValidTelegramIP } from '../services/telegram.js';
import { timingSafeEqual } from 'crypto';
import * as media from '../services/media.js';
import * as gallery from '../services/gallery.js';
import * as wallets from '../services/wallets.js';
import * as credits from '../services/credits.js';
import * as channelState from '../services/channel-state.js';
import type { BufferedMessage, ChannelStateRecord } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';
const ENFORCE_IP_CHECK = process.env.ENFORCE_TELEGRAM_IP_CHECK !== 'false';

// === CONFIG ===
// NOTE: Channel-aware config is in services/channel-state.ts (CHANNEL_CONFIG)
const DEDUP_TTL_SECONDS = 300; // 5 minutes - prevent reprocessing same message on retries

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

// === MESSAGE DEDUPLICATION ===
// Prevents reprocessing the same message when Telegram retries due to Lambda timeout
async function isMessageProcessed(agentId: string, updateId: number): Promise<boolean> {
  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `TELEGRAM#${agentId}`, sk: `PROCESSED#${updateId}` },
    }));
    return !!result.Item;
  } catch {
    return false;
  }
}

async function markMessageProcessed(agentId: string, updateId: number): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS;
  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk: `TELEGRAM#${agentId}`,
        sk: `PROCESSED#${updateId}`,
        ttl,
        processedAt: Date.now(),
      },
    }));
  } catch (err) {
    console.warn('Failed to mark message as processed:', err);
  }
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

    // Use native FormData (Node.js 18+) with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'image.png');
    if (caption) {
      form.append('caption', caption.slice(0, 1024));
      form.append('parse_mode', 'Markdown');
    }
    if (replyTo) {
      form.append('reply_to_message_id', replyTo.toString());
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Telegram] sendPhoto (buffer) failed: ${response.status} ${errorText}`);
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

// === CHANNEL-AWARE PROCESSING ===

/**
 * Process a message using channel-aware architecture
 * - Buffers message in channel state
 * - Evaluates if response should be triggered
 * - Responds to CHANNEL with full context (not individual messages)
 */
async function processChannelMessage(
  agentId: string,
  agent: AgentConfig,
  message: NonNullable<TelegramUpdate['message']>,
  token: string
): Promise<{ responded: boolean; reason: string }> {
  const chatId = message.chat.id;
  const chatType = message.chat.type;
  const messageId = message.message_id;
  const text = message.text || '';
  const userId = message.from?.id || 0;
  const userName = message.from?.first_name || 'User';
  const username = message.from?.username;
  const botUsername = agent.platforms.telegram?.botUsername;
  const botId = agent.platforms.telegram?.botId;

  // Check if this is a mention or reply to bot
  const isMention = botUsername ? new RegExp(`@${botUsername}\\b`, 'i').test(text) : false;
  const isReplyToBot = !!(message.reply_to_message?.from?.id === botId ||
    (botUsername && message.reply_to_message?.from?.username === botUsername));

  // Create buffered message
  const bufferedMessage: BufferedMessage = {
    messageId,
    userId,
    userName,
    username,
    text,
    timestamp: Date.now(),
    replyToMessageId: message.reply_to_message?.message_id,
    replyToUserId: message.reply_to_message?.from?.id,
    isMention,
    isReplyToBot,
  };

  // Ensure channel state exists (will be created if needed by addMessageToBuffer)
  await channelState.getOrCreateChannelState(
    agentId,
    chatId,
    chatType,
    message.chat.title
  );

  // Add message to buffer and get updated state
  const updatedState = await channelState.addMessageToBuffer(
    agentId,
    chatId,
    bufferedMessage
  );

  console.log('[Telegram] Channel state:', {
    agentId,
    chatId,
    chatType,
    state: updatedState.state,
    bufferSize: updatedState.bufferSize,
    isMention,
    isReplyToBot,
  });

  // Evaluate if we should respond
  const decision = channelState.evaluateResponseTrigger(updatedState, botUsername, botId);

  console.log('[Telegram] Response decision:', {
    chatId,
    shouldRespond: decision.shouldRespond,
    trigger: decision.trigger,
    delay: decision.delay,
    priority: decision.priority,
  });

  if (!decision.shouldRespond) {
    return { responded: false, reason: `no_trigger:${updatedState.state}` };
  }

  // Apply delay if specified (makes responses feel more natural)
  if (decision.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, decision.delay));
  }

  // Transition to ACTIVE state
  await channelState.transitionState(agentId, chatId, 'ACTIVE');

  // Process and respond to the channel
  const responseMessageId = await processChannelResponse(
    agentId,
    agent,
    updatedState,
    token,
    decision.trigger
  );

  if (responseMessageId) {
    // Mark response sent and transition to COOLDOWN
    await channelState.markResponseSent(agentId, chatId, responseMessageId);
    return { responded: true, reason: decision.trigger };
  }

  return { responded: false, reason: 'response_failed' };
}

/**
 * Generate and send response to the channel
 * Uses full channel context (all buffered messages)
 */
async function processChannelResponse(
  agentId: string,
  agent: AgentConfig,
  state: ChannelStateRecord,
  token: string,
  trigger: string
): Promise<number | null> {
  const chatId = state.chatId;

  // Build conversation context from buffered messages
  const conversationContext = channelState.buildConversationContext(state);
  const participants = channelState.getActiveParticipants(state);
  const responseTarget = channelState.getResponseTarget(state);

  // Build system prompt
  let systemPrompt = agent.persona || `You are ${agent.name}, a helpful AI assistant on Telegram.`;
  systemPrompt += `\n\nYou are chatting on Telegram. Keep responses concise and conversational.`;
  systemPrompt += `\nYou can generate images and videos when asked. Just use the tools available to you.`;

  // Add channel context
  systemPrompt += `\n\n## Current Conversation`;
  systemPrompt += `\nYou're in a ${state.chatType === 'private' ? 'private chat' : `group chat${state.chatTitle ? ` called "${state.chatTitle}"` : ''}`}.`;

  if (participants.length > 0) {
    systemPrompt += `\n\nActive participants:`;
    for (const p of participants.slice(0, 5)) {
      systemPrompt += `\n- ${p.username ? `@${p.username}` : p.userName} (${p.messageCount} messages)`;
    }
  }

  if (trigger === 'direct_engagement') {
    systemPrompt += `\n\nSomeone just mentioned you or replied to you - respond to them directly!`;
  } else if (trigger === 'message_threshold') {
    systemPrompt += `\n\nThe conversation has been active - feel free to chime in naturally if you have something to add.`;
  }

  if (agent.wallets?.length) {
    systemPrompt += `\n\n## Your Solana Wallets\n`;
    agent.wallets.forEach(w => { systemPrompt += `- ${w.name}: ${w.publicKey}\n`; });
  }

  if (agent.profileImage?.url) {
    systemPrompt += `\n\n## Your Profile Image\n${agent.profileImage.url}`;
  }

  // Build messages array with conversation context
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add conversation history as a single user message with context
  if (conversationContext) {
    messages.push({
      role: 'user',
      content: `Here's the recent conversation:\n\n${conversationContext}\n\nRespond to the conversation naturally. If someone asked you a question or mentioned you, address them directly.`,
    });
  } else {
    messages.push({
      role: 'user',
      content: 'Start a conversation!',
    });
  }

  // Determine which message to reply to
  const replyToMessageId = responseTarget?.messageId;

  // Tool loop
  let iterations = 0;
  const maxIterations = 5;
  const mediasToSend: Array<{ type: 'image' | 'video'; url: string; caption?: string }> = [];
  const failedTools = new Set<string>();
  let responseMessageId: number | null = null;

  while (iterations++ < maxIterations) {
    await sendChatAction(token, chatId, 'typing');

    const llmResponse = await callLLM(messages, agent, TELEGRAM_TOOLS);

    if (llmResponse.toolCalls?.length) {
      messages.push({ role: 'assistant', content: '', tool_calls: llmResponse.toolCalls });

      for (const tc of llmResponse.toolCalls) {
        const toolName = tc.function.name;

        if (failedTools.has(toolName)) {
          console.log(`[Telegram] Skipping retry of failed tool: ${toolName}`);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: toolName,
            content: JSON.stringify({ error: 'This tool already failed. Please inform the user and do not retry.' }),
          });
          continue;
        }

        const args = JSON.parse(tc.function.arguments || '{}');
        const result = await executeTool(agentId, toolName, args, token, chatId, agent);

        if (!result.success) {
          failedTools.add(toolName);
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: toolName,
          content: JSON.stringify(result.success ? result.result : { error: result.error, doNotRetry: true }),
        });

        if (result.media) {
          mediasToSend.push(result.media);
        }
      }
      continue;
    }

    // Final response
    if (llmResponse.content) {
      messages.push({ role: 'assistant', content: llmResponse.content });
      responseMessageId = await sendTelegramMessage(token, chatId, llmResponse.content, replyToMessageId);
    }

    // Send media
    for (const m of mediasToSend) {
      if (m.type === 'image') {
        await sendTelegramPhoto(token, chatId, m.url, m.caption);
      } else if (m.type === 'video') {
        await sendTelegramVideo(token, chatId, m.url, m.caption);
      }
    }
    mediasToSend.length = 0;
    break;
  }

  // Fallback if max iterations reached
  if (!responseMessageId && iterations >= maxIterations) {
    console.warn(`[Telegram] Max iterations reached for chat ${chatId}`);
    responseMessageId = await sendTelegramMessage(
      token,
      chatId,
      "Sorry, I ran into some issues processing your request. Please try again!",
      replyToMessageId
    );
    for (const m of mediasToSend) {
      if (m.type === 'image') {
        await sendTelegramPhoto(token, chatId, m.url, m.caption);
      } else if (m.type === 'video') {
        await sendTelegramVideo(token, chatId, m.url, m.caption);
      }
    }
  }

  return responseMessageId;
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

    // Deduplication: Check if we already processed this update (prevents infinite loops on Lambda timeout/retry)
    if (await isMessageProcessed(agentId, update.update_id)) {
      console.log(`[Telegram] Skipping already processed update: ${update.update_id}`);
      return ok();
    }
    // Mark as processed BEFORE processing to prevent parallel executions
    await markMessageProcessed(agentId, update.update_id);

    const message = update.message;
    const userId = message.from?.id;

    // Skip bot messages
    if (message.from?.username?.endsWith('bot')) return ok();

    // Use channel-aware processing (Kyro-style architecture)
    // This buffers messages and responds to the channel, not individual messages
    const result = await processChannelMessage(agentId, agent, message, token);

    console.log('[Telegram] Channel processing result:', {
      agentId,
      chatId: message.chat.id,
      fromUser: userId,
      chatType: message.chat.type,
      responded: result.responded,
      reason: result.reason,
    });

    return ok();
  } catch (error) {
    console.error('Webhook error:', error instanceof Error ? error.message : 'Unknown');
    return ok();
  }
}
