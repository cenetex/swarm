/**
 * Message Processor Handler
 * Processes messages from SQS and generates responses
 *
 * Kyro-style channel-aware processing:
 * - Buffers messages per channel
 * - Evaluates response triggers (direct engagement, threshold, gap)
 * - State machine: IDLE → ACTIVE → COOLDOWN
 */
import type { SQSEvent, SQSHandler, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  createStateService,
  createSecretsService,
  createLLMService,
  createResponseGenerator,
  logger,
  publicTools,
  defaultAgentTools,
  type AgentConfig,
  type MessageQueueItem,
  type ContextMessage,
  type SwarmEnvelope,
} from '@swarm/core';

const sqs = new SQSClient({});

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
      image: { provider: 'replicate', model: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db' }, // flux-schnell
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 5,
      maxContextMessages: 20,
    },
    tools: defaultAgentTools,
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
    // Extended fields for Kyro-style context
    userId: envelope.sender.id,
    username: envelope.sender.username,
    isMention: envelope.metadata.isMention,
    isReplyToBot: envelope.metadata.isReplyToBot,
    replyToMessageId: envelope.replyTo,
  };
}

export const handler: SQSHandler = async (event: SQSEvent, context: Context) => {
  logger.setContext({
    agentId: getAgentId(),
    requestId: context.awsRequestId,
  });

  await initialize();

  for (const record of event.Records) {
    try {
      const item: MessageQueueItem = JSON.parse(record.body);
      const envelope = item.envelope;

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

      // Ensure channel state exists (created if needed by addMessageToChannel)
      await stateService.getOrCreateChannelState(
        getAgentId(),
        envelope.conversationId,
        envelope.platform,
        envelope.metadata.chatType,
        envelope.metadata.chatTitle
      );

      // Add message to channel buffer with state machine updates
      const updatedState = await stateService.addMessageToChannel(
        getAgentId(),
        envelope.conversationId,
        envelope.platform,
        envelopeToContextMessage(envelope)
      );

      logger.info('Channel state updated', {
        state: updatedState.state,
        bufferSize: updatedState.recentMessages.length,
        chatType: updatedState.chatType,
      });

      // Evaluate if we should respond
      const decision = stateService.evaluateResponseTrigger(updatedState);

      logger.info('Response decision', {
        shouldRespond: decision.shouldRespond,
        trigger: decision.trigger,
        delay: decision.delay,
        priority: decision.priority,
      });

      if (!decision.shouldRespond) {
        logger.info('Skipping response', { reason: decision.trigger });
        continue; // Process next message in batch
      }

      // Apply delay if specified (makes responses feel more natural)
      if (decision.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, decision.delay));
      }

      // Transition to ACTIVE state before generating response
      await stateService.transitionState(getAgentId(), envelope.conversationId, 'ACTIVE');

      // =========================================================
      // GENERATE LLM RESPONSE
      // =========================================================

      // Create LLM service
      const llmService = createLLMService(agentConfig.llm, secrets);

      // Get enabled tools from the public tool set
      const enabledTools = publicTools.filter(t =>
        agentConfig.tools.includes(t.name)
      );

      // Create response generator
      const generator = createResponseGenerator(
        agentConfig,
        llmService,
        stateService,
        enabledTools,
        agentConfig.persona
      );

      // Generate response
      const response = await generator.generate(envelope);

      logger.info('Response generated', {
        actions: response.actions.length,
        tokensUsed: response.tokensUsed,
      });

      // Queue response for sending
      await sqs.send(new SendMessageCommand({
        QueueUrl: getResponseQueueUrl(),
        MessageBody: JSON.stringify(response),
        MessageGroupId: envelope.conversationId,
        MessageDeduplicationId: `resp_${envelope.messageId}_${Date.now()}`,
      }));

      // =========================================================
      // POST-RESPONSE STATE UPDATES
      // =========================================================

      // Mark response sent - transitions to COOLDOWN and clears buffer
      await stateService.markResponseSent(
        getAgentId(),
        envelope.conversationId,
        `resp_${envelope.messageId}_${Date.now()}`
      );

      // Set user cooldown if configured (legacy behavior)
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

      // The message will be retried or sent to DLQ based on SQS config
      throw error;
    }
  }
};
