/**
 * Twitter Mention Poller Handler
 * Polls Twitter for mentions and sends them to the message queue for processing
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  TwitterAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  logger,
  type AgentConfig,
} from '@swarm/core';

// Environment variables
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AGENT_ID = process.env.AGENT_ID!;
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let sqsClient: SQSClient;
let twitterAdapter: TwitterAdapter;
let secrets: Record<string, string>;
let agentConfig: AgentConfig;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
  sqsClient = new SQSClient({});

  agentConfig = await stateService.getAgentConfig(AGENT_ID) || {
    id: AGENT_ID,
    name: AGENT_ID,
    version: '1.0.0',
    persona: '',
    platforms: {
      twitter: { enabled: true, username: '', features: ['mentions'] },
    },
    llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', temperature: 0.8, maxTokens: 1024 },
    media: { image: { provider: 'openrouter', model: 'openai/dall-e-3' } },
    scheduling: {},
    behavior: { responseDelayMs: [1000, 3000], typingIndicator: false, ignoreBots: true, cooldownMinutes: 5, maxContextMessages: 10 },
    tools: ['send_message', 'react', 'ignore'],
    secrets: [],
  };

  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AGENT_ID}/secrets`
  );

  twitterAdapter = new TwitterAdapter(agentConfig, {
    appKey: secrets.TWITTER_API_KEY,
    appSecret: secrets.TWITTER_API_SECRET,
    accessToken: secrets.TWITTER_ACCESS_TOKEN,
    accessSecret: secrets.TWITTER_ACCESS_SECRET,
  });
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  logger.setContext({
    agentId: AGENT_ID,
    platform: 'twitter',
    requestId: context.awsRequestId,
    handler: 'mention-poller',
  });

  try {
    await initialize();

    if (!twitterAdapter.isConfigured()) {
      logger.warn('Twitter adapter not configured, skipping mention poll');
      return;
    }

    logger.info('Polling for Twitter mentions');

    // Get the last processed mention ID from state
    const sinceId = await stateService.getLastMentionId(AGENT_ID);

    logger.info('Fetching mentions', { sinceId });

    // Get new mentions
    const mentions = await twitterAdapter.getMentions(sinceId);

    if (mentions.length === 0) {
      logger.info('No new mentions found');
      return;
    }

    logger.info('Found new mentions', { count: mentions.length });

    // Process mentions (oldest first)
    const sortedMentions = mentions.sort((a, b) => a.timestamp - b.timestamp);
    let newestMentionId = sinceId;

    for (const envelope of sortedMentions) {
      // Skip self-mentions (our own tweets)
      if (envelope.sender.username === agentConfig.platforms.twitter?.username) {
        logger.debug('Skipping self-mention', { messageId: envelope.messageId });
        continue;
      }

      // Log the mention
      await activityService.logMessageReceived(
        AGENT_ID,
        'twitter',
        envelope.sender.displayName || envelope.sender.username || 'Unknown',
        envelope.content.text || ''
      );

      // Send to message queue for processing
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: MESSAGE_QUEUE_URL,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: envelope.conversationId,
        MessageDeduplicationId: `twitter-mention-${envelope.messageId}`,
      }));

      logger.info('Queued mention for processing', {
        messageId: envelope.messageId,
        from: envelope.sender.username,
      });

      // Track the newest mention ID
      if (!newestMentionId || envelope.messageId > newestMentionId) {
        newestMentionId = envelope.messageId;
      }
    }

    // Update the last processed mention ID
    if (newestMentionId && newestMentionId !== sinceId) {
      await stateService.setLastMentionId(AGENT_ID, newestMentionId);
      logger.info('Updated last mention ID', { lastMentionId: newestMentionId });
    }

    logger.info('Mention polling complete', {
      processed: sortedMentions.length,
      lastMentionId: newestMentionId,
    });

  } catch (error) {
    logger.error('Failed to poll Twitter mentions', error);

    await activityService.logError(
      AGENT_ID,
      'twitter',
      error instanceof Error ? error.message : String(error)
    );

    throw error;
  }
};
