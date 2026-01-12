/**
 * Message Processor Handler
 * Processes messages from SQS and generates responses using MCP tools
 *
 * Kyro-style channel-aware processing:
 * - Buffers messages per channel
 * - Evaluates response triggers (direct engagement, threshold, gap)
 * - State machine: IDLE → ACTIVE → COOLDOWN
 * 
 * MCP Tool Integration:
 * - Uses unified tool registry from @swarm/mcp-server
 * - Supports iterative tool execution (multi-step reasoning)
 * - Memory tools wired to state service
 */
import type { SQSEvent, SQSHandler, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  createStateService,
  createSecretsService,
  createMediaService,
  logger,
  MessageQueueItemSchema,
  extractThinking,
  type AgentConfig,
  type ContextMessage,
  type SwarmEnvelope,
  type SwarmResponse,
  type ResponseAction,
  type LLMConfig,
} from '@swarm/core';
import {
  ToolRegistry,
  createToolClient,
  registerAllTools,
  type ToolContext,
} from '@swarm/mcp-server';
import { createPlatformMCPServices } from './services/platform-mcp-adapter.js';

const sqs = new SQSClient({});

// LLM Configuration
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_TIMEOUT_MS = 60_000;
const MAX_TOOL_ITERATIONS = 5;

// Environment variable validation helper
function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

// Environment variables - validated on first use
let _responseQueueUrl: string | undefined;
let _stateTable: string | undefined;
let _agentId: string | undefined;
let _mediaBucket: string | undefined;
let _cdnUrl: string | undefined;

function getResponseQueueUrl(): string {
  if (!_responseQueueUrl) _responseQueueUrl = getRequiredEnv('RESPONSE_QUEUE_URL');
  return _responseQueueUrl;
}

function getStateTable(): string {
  if (!_stateTable) _stateTable = getRequiredEnv('STATE_TABLE');
  return _stateTable;
}

function getAgentId(): string {
  if (!_agentId) _agentId = getRequiredEnv('AGENT_ID');
  return _agentId;
}

function getMediaBucket(): string | undefined {
  if (_mediaBucket === undefined) _mediaBucket = process.env.MEDIA_BUCKET || '';
  return _mediaBucket || undefined;
}

function getCdnUrl(): string | undefined {
  if (_cdnUrl === undefined) _cdnUrl = process.env.CDN_URL || '';
  return _cdnUrl || undefined;
}

// Services (lazy initialized)
let stateService: ReturnType<typeof createStateService>;
let secretsService: ReturnType<typeof createSecretsService>;
let secrets: Record<string, string>;
let agentConfig: AgentConfig;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(getStateTable());
  secretsService = createSecretsService();

  // Load agent config from state (set via admin dashboard)
  agentConfig = await stateService.getAgentConfig(getAgentId()) || {
    id: getAgentId(),
    name: process.env.AGENT_NAME || getAgentId(),
    version: '1.0.0',
    persona: process.env.AGENT_PERSONA || 'You are a helpful AI assistant.',
    platforms: {},
    llm: {
      provider: (process.env.LLM_PROVIDER as 'openrouter') || 'openrouter',
      model: process.env.LLM_MODEL || 'anthropic/claude-sonnet-4',
      temperature: 0.8,
      maxTokens: 1024,
    },
    media: {
      image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' },
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 5,
      maxContextMessages: 20,
    },
    tools: [
      'send_message', 'react', 'wait', 'ignore',
      'generate_image', 'remember', 'recall',
    ],
    secrets: ['OPENROUTER_API_KEY', 'REPLICATE_API_KEY'],
  };

  // Load secrets
  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${getAgentId()}/secrets`
  );
}

/**
 * Convert SwarmEnvelope to ContextMessage for channel state
 */
function envelopeToContextMessage(envelope: SwarmEnvelope): ContextMessage {
  return {
    messageId: envelope.messageId,
    sender: envelope.sender.displayName || envelope.sender.username || 'Unknown',
    isBot: envelope.sender.isBot,
    content: envelope.content.text || '[media]',
    timestamp: envelope.timestamp,
    userId: envelope.sender.id,
    username: envelope.sender.username,
    isMention: envelope.metadata.isMention,
    isReplyToBot: envelope.metadata.isReplyToBot,
    replyToMessageId: envelope.replyTo,
  };
}

/**
 * LLM Message format
 */
interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Call the LLM API with tools
 */
async function callLLM(
  messages: LLMMessage[],
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  config: LLMConfig
): Promise<{
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}> {
  const apiKey = secrets['OPENROUTER_API_KEY'] || secrets['openrouter_api_key'];
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not found in secrets');
  }

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };

  if (tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://swarm.platform',
        'X-Title': 'Swarm Platform',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error: ${response.status} ${text.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices?.[0]?.message;
    if (!choice) {
      throw new Error('No response from LLM');
    }

    return {
      content: choice.content || undefined,
      toolCalls: choice.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || '{}'),
      })),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Build system prompt from agent persona and context
 */
function buildSystemPrompt(envelope: SwarmEnvelope): string {
  let prompt = agentConfig.persona;

  prompt += `\n\n## Current Context
- Platform: ${envelope.platform}
- Channel: ${envelope.conversationId}
- Time: ${new Date().toISOString()}
`;

  prompt += `\n## User
- Username: ${envelope.sender.username || 'unknown'}
- Display Name: ${envelope.sender.displayName || 'unknown'}
`;

  // Add tool usage guidance
  prompt += `\n## Response Guidelines
- Use send_message to respond with text
- Use generate_image to create images when asked
- Use remember to save important facts about users
- Use recall to remember things about users before responding
- Use ignore if the message doesn't warrant a response
- Keep responses concise and natural
`;
  if (agentConfig.voice?.enabled) {
    prompt += `- Use generate_voice_message to reply with voice when it fits\n`;
  }

  return prompt;
}

/**
 * Convert tool results to response actions
 */
function toolResultsToActions(
  toolResults: Array<{ name: string; result: { success: boolean; data?: unknown; media?: { type: string; url: string } } }>
): ResponseAction[] {
  const actions: ResponseAction[] = [];

  for (const { name, result } of toolResults) {
    if (!result.success) continue;

    switch (name) {
      case 'send_message': {
        const data = result.data as { text?: string } | undefined;
        if (data?.text) {
          actions.push({ type: 'send_message', text: data.text });
        }
        break;
      }

      case 'generate_image': {
        if (result.media) {
          actions.push({
            type: 'send_media',
            mediaType: 'image',
            url: result.media.url,
          });
        }
        break;
      }

      case 'generate_voice_message': {
        const data = result.data as { url?: string } | undefined;
        if (data?.url) {
          actions.push({
            type: 'send_voice',
            url: data.url,
          });
        }
        break;
      }

      case 'react': {
        const data = result.data as { emoji?: string; messageId?: string } | undefined;
        if (data?.emoji) {
          actions.push({ type: 'react', emoji: data.emoji, messageId: data.messageId || '' });
        }
        break;
      }

      case 'wait': {
        const data = result.data as { durationMs?: number } | undefined;
        if (data?.durationMs) {
          actions.push({ type: 'wait', durationMs: data.durationMs });
        }
        break;
      }

      case 'ignore': {
        const data = result.data as { reason?: string } | undefined;
        actions.push({ type: 'ignore', reason: data?.reason || 'No response needed' });
        break;
      }
    }
  }

  return actions;
}

async function maybeTranscribeAudio(
  envelope: SwarmEnvelope,
  toolClient: ReturnType<typeof createToolClient>,
  toolContext: ToolContext
): Promise<void> {
  const audioAttachment = envelope.content.media?.find(m => m.type === 'audio');
  if (!audioAttachment?.fileId) return;

  const shouldTranscribe = agentConfig.voice?.enabled || agentConfig.tools.includes('transcribe_audio');
  if (!shouldTranscribe) return;

  try {
    const result = await toolClient.execute('transcribe_audio', {
      platformFileId: audioAttachment.fileId,
    }, toolContext);

    if (result.success) {
      const data = result.data as { text?: string } | undefined;
      if (data?.text) {
        const prefix = envelope.content.text ? `${envelope.content.text}\n\n` : '';
        envelope.content.text = `${prefix}${data.text}`;
      }
    }
  } catch (error) {
    logger.warn('Voice transcription failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Generate response with iterative tool execution
 */
async function generateResponse(
  envelope: SwarmEnvelope,
  toolClient: ReturnType<typeof createToolClient>,
  toolContext: ToolContext
): Promise<SwarmResponse> {
  await maybeTranscribeAudio(envelope, toolClient, toolContext);
  const systemPrompt = buildSystemPrompt(envelope);
  const openAITools = toolClient.getOpenAITools();

  // Filter tools based on agent config
  const enabledTools = openAITools.filter(t => 
    agentConfig.tools.includes(t.function.name)
  );

  // Build initial messages
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: (() => {
      if (envelope.content.text) return envelope.content.text;
      const mediaTypes = envelope.content.media?.map(m => m.type) || [];
      if (mediaTypes.includes('audio')) return '[voice message received]';
      return '[media received]';
    })() },
  ];

  const allToolResults: Array<{ name: string; result: { success: boolean; data?: unknown; media?: { type: string; url: string } } }> = [];
  let finalContent: string | undefined;
  let cleanFinalContent: string | undefined; // Content without thinking tags
  let iterations = 0;
  let totalTokens = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const llmResponse = await callLLM(messages, enabledTools, agentConfig.llm);
    totalTokens += 100; // Approximate, would need actual count from API

    if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
      // No tool calls, we have a final response
      finalContent = llmResponse.content;
      
      // Extract thinking tags - save to memory, strip from output
      if (finalContent) {
        const { cleanContent, thinkingBlocks, hasThinking } = extractThinking(finalContent);
        cleanFinalContent = cleanContent;
        
        if (hasThinking && thinkingBlocks.length > 0) {
          // Save thinking to agent's memory
          for (const thinking of thinkingBlocks) {
            try {
              await stateService.saveFact(envelope.agentId, {
                fact: `[Internal thought in ${envelope.conversationId}]: ${thinking}`,
                about: 'thinking',
                timestamp: Date.now(),
              });
            } catch (err) {
              logger.error('Failed to save thinking to memory', { error: err });
            }
          }
          logger.info('Saved thinking blocks to memory', { 
            count: thinkingBlocks.length, 
            agentId: envelope.agentId 
          });
        }
      }
      break;
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: llmResponse.content || '',
      tool_calls: llmResponse.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    });

    // Execute tool calls
    for (const toolCall of llmResponse.toolCalls) {
      logger.info('Executing tool', { tool: toolCall.name, args: toolCall.arguments });

      const result = await toolClient.execute(toolCall.name, toolCall.arguments, toolContext);

      allToolResults.push({ name: toolCall.name, result });

      // Add tool result message
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.success ? result.data : { error: result.error }),
      });

      logger.info('Tool result', { tool: toolCall.name, success: result.success });
    }
  }

  // Build response actions
  let actions: ResponseAction[] = toolResultsToActions(allToolResults);

  // Use clean content (without thinking tags) for user-facing messages
  const outputContent = cleanFinalContent || finalContent;

  // If we got final content but no send_message action, add it
  if (outputContent && !actions.some(a => a.type === 'send_message')) {
    actions.push({ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId });
  }

  // If no actions at all, add the content as a message
  if (actions.length === 0 && outputContent) {
    actions = [{ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId }];
  }

  return {
    agentId: envelope.agentId,
    platform: envelope.platform,
    conversationId: envelope.conversationId,
    replyToMessageId: envelope.messageId,
    actions,
    generatedAt: Date.now(),
    llmModel: agentConfig.llm.model,
    tokensUsed: totalTokens,
  };
}

export const handler: SQSHandler = async (event: SQSEvent, context: Context) => {
  logger.setContext({
    agentId: getAgentId(),
    requestId: context.awsRequestId,
  });

  await initialize();

  // Create MCP services and tool client
  const mediaBucket = getMediaBucket();
  const mediaService = mediaBucket 
    ? createMediaService(secrets, mediaBucket, getCdnUrl())
    : undefined;

  const mcpServices = createPlatformMCPServices({
    agentId: getAgentId(),
    agentConfig,
    stateService,
    mediaService,
    secrets,
    mediaBucket,
    cdnUrl: getCdnUrl(),
  });

  const registry = new ToolRegistry();
  registerAllTools(registry, mcpServices);

  for (const record of event.Records) {
    try {
      const parseResult = MessageQueueItemSchema.safeParse(JSON.parse(record.body));
      if (!parseResult.success) {
        logger.error('Invalid message queue item', { error: parseResult.error.message });
        continue;
      }
      const item = parseResult.data;
      const envelope = item.envelope as SwarmEnvelope;

      logger.setContext({
        messageId: envelope.messageId,
        platform: envelope.platform,
        conversationId: envelope.conversationId,
      });

      logger.info('Processing message', {
        sender: envelope.sender.username,
        text: envelope.content.text?.slice(0, 50),
        isMention: envelope.metadata.isMention,
        isReplyToBot: envelope.metadata.isReplyToBot,
      });

      // =========================================================
      // KYRO-STYLE CHANNEL STATE MANAGEMENT
      // =========================================================

      await stateService.getOrCreateChannelState(
        getAgentId(),
        envelope.conversationId,
        envelope.platform,
        envelope.metadata.chatType,
        envelope.metadata.chatTitle
      );

      const updatedState = await stateService.addMessageToChannel(
        getAgentId(),
        envelope.conversationId,
        envelope.platform,
        envelopeToContextMessage(envelope),
        undefined,
        envelope.metadata.chatType,
        envelope.metadata.chatTitle
      );

      logger.info('Channel state updated', {
        state: updatedState.state,
        bufferSize: updatedState.recentMessages.length,
        chatType: updatedState.chatType,
      });

      const decision = stateService.evaluateResponseTrigger(updatedState);

      logger.info('Response decision', {
        shouldRespond: decision.shouldRespond,
        trigger: decision.trigger,
        delay: decision.delay,
        priority: decision.priority,
      });

      if (!decision.shouldRespond) {
        logger.info('Skipping response', { reason: decision.trigger });
        continue;
      }

      if (decision.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, decision.delay));
      }

      await stateService.transitionState(getAgentId(), envelope.conversationId, 'ACTIVE');

      // =========================================================
      // GENERATE RESPONSE WITH MCP TOOLS
      // =========================================================

      const toolClient = createToolClient(registry, envelope.platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api');
      
      const toolContext: ToolContext = {
        agentId: getAgentId(),
        platform: envelope.platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api',
        userId: envelope.sender.id,
        conversationId: envelope.conversationId,
        replyToMessageId: envelope.messageId,
      };

      const response = await generateResponse(envelope, toolClient, toolContext);

      logger.info('Response generated', {
        actions: response.actions.length,
        tokensUsed: response.tokensUsed,
      });

      // Queue response for sending
      await sqs.send(new SendMessageCommand({
        QueueUrl: getResponseQueueUrl(),
        MessageBody: JSON.stringify(response),
        MessageGroupId: envelope.conversationId,
        MessageDeduplicationId: `resp_${envelope.conversationId}_${envelope.messageId}`,
      }));

      // =========================================================
      // POST-RESPONSE STATE UPDATES
      // =========================================================

      if (agentConfig.behavior.cooldownMinutes > 0) {
        await stateService.setUserCooldown({
          agentId: getAgentId(),
          platform: envelope.platform,
          userId: envelope.sender.id,
          cooldownUntil: Date.now() + (agentConfig.behavior.cooldownMinutes * 60 * 1000),
        });
      }

    } catch (error) {
      logger.error('Failed to process message', error);
      throw error;
    }
  }
};
