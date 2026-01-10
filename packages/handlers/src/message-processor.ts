/**
 * Message Processor Handler
 * Processes messages from SQS and generates responses
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
  if (!_responseQueueUrl) _responseQueueUrl = getRequiredEnv('getResponseQueueUrl()');
  return _responseQueueUrl;
}

function getStateTable(): string {
  if (!_stateTable) _stateTable = getRequiredEnv('getStateTable()');
  return _stateTable;
}

function getAgentId(): string {
  if (!_agentId) _agentId = getRequiredEnv('getAgentId()');
  return _agentId;
}

// Services (lazy initialized)
let stateService: ReturnType<typeof createStateService>;
let secretsService: ReturnType<typeof createSecretsService>;
let secrets: Record<string, string>;
let agentConfig: AgentConfig;

/**
 * Standard tool definitions
 */
const standardTools: ToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a text message response to the user',
    parameters: z.object({
      text: z.string().describe('The message text to send'),
      reply_to: z.string().optional().describe('Message ID to reply to'),
    }),
    execute: async () => ({ success: true }),
  },
  {
    name: 'react',
    description: 'React to a message with an emoji',
    parameters: z.object({
      emoji: z.string().describe('The emoji to react with'),
      message_id: z.string().describe('The message ID to react to'),
    }),
    execute: async () => ({ success: true }),
  },
  {
    name: 'take_selfie',
    description: 'Generate a selfie image of yourself based on a prompt',
    parameters: z.object({
      prompt: z.string().describe('Description of the selfie to generate'),
      style: z.string().optional().describe('Art style for the image'),
    }),
    execute: async () => ({ success: true }),
  },
  {
    name: 'wait',
    description: 'Wait before responding to simulate thinking',
    parameters: z.object({
      seconds: z.number().describe('Number of seconds to wait'),
      reason: z.string().optional().describe('Reason for waiting'),
    }),
    execute: async () => ({ success: true }),
  },
  {
    name: 'ignore',
    description: 'Choose not to respond to this message',
    parameters: z.object({
      reason: z.string().describe('Reason for not responding'),
    }),
    execute: async () => ({ success: true }),
  },
];

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(getStateTable());
  secretsService = createSecretsService();

  // Load agent config
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
      image: { provider: 'openrouter', model: 'openai/dall-e-3' },
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 5,
      maxContextMessages: 20,
    },
    tools: ['send_message', 'react', 'ignore', 'wait', 'take_selfie'],
    secrets: ['OPENROUTER_API_KEY'],
  };

  // Load secrets
  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${getAgentId()}/secrets`
  );
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
      });

      // Create LLM service
      const llmService = createLLMService(agentConfig.llm, secrets);

      // Filter tools based on agent config
      const enabledTools = standardTools.filter(t => 
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

      // Set user cooldown if configured
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
