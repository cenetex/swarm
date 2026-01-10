/**
 * Web Chat Handler
 * Handles REST API requests for web chat interface
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  WebAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  createLLMService,
  createSolanaService,
  createResponseGenerator,
  logger,
  type AgentConfig,
  type ToolDefinition,
  type WebChatMessage,
  type ResponseAction,
} from '@swarm/core';
import { z } from 'zod';

// Environment variables
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AGENT_ID = process.env.AGENT_ID!;

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let webAdapter: WebAdapter;
let secrets: Record<string, string>;
let agentConfig: AgentConfig;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  agentConfig = await stateService.getAgentConfig(AGENT_ID) || {
    id: AGENT_ID,
    name: AGENT_ID,
    version: '1.0.0',
    persona: 'You are a helpful AI assistant.',
    platforms: {
      web: {
        enabled: true,
        corsOrigins: ['*'],
        rateLimit: { windowMs: 60000, maxRequests: 20 },
      },
    },
    llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', temperature: 0.8, maxTokens: 1024 },
    media: { image: { provider: 'replicate', model: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db' } }, // flux-schnell
    scheduling: {},
    behavior: { responseDelayMs: [0, 0], typingIndicator: false, ignoreBots: true, cooldownMinutes: 0, maxContextMessages: 20 },
    tools: ['send_message'],
    secrets: [],
  };

  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AGENT_ID}/secrets`
  );

  webAdapter = new WebAdapter(agentConfig);
}

// Simple tool for web chat (direct response)
const webTools: ToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a response message',
    parameters: z.object({
      text: z.string().describe('The message text to send'),
    }),
    execute: async () => ({ success: true }),
  },
];

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.setContext({
    agentId: AGENT_ID,
    platform: 'web',
    requestId: context.awsRequestId,
  });

  try {
    await initialize();

    const origin = event.headers.origin || event.headers.Origin;
    const corsHeaders = webAdapter.getCorsHeaders(origin);

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: '',
      };
    }

    // Verify request
    const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8') : Buffer.from('');
    const headers = Object.fromEntries(
      Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v || ''])
    );

    const isValid = await webAdapter.verifyRequest(body, headers);
    if (!isValid) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Forbidden' }),
      };
    }

    // Parse message
    const message: WebChatMessage = JSON.parse(body.toString());

    // Token gating check
    if (agentConfig.platforms.web?.tokenGated?.enabled) {
      if (!message.wallet?.address) {
        return {
          statusCode: 401,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Wallet connection required' }),
        };
      }

      // Verify token balance
      if (agentConfig.solana?.enabled) {
        const solanaService = createSolanaService(agentConfig.solana);
        const hasBalance = await solanaService.verifyTokenHolder(
          message.wallet.address,
          agentConfig.platforms.web.tokenGated.tokenMint,
          agentConfig.platforms.web.tokenGated.minBalance
        );

        if (!hasBalance) {
          return {
            statusCode: 403,
            headers: corsHeaders,
            body: JSON.stringify({ 
              error: 'Insufficient token balance',
              required: agentConfig.platforms.web.tokenGated.minBalance,
            }),
          };
        }
      }
    }

    // Parse into envelope
    const envelope = await webAdapter.parseMessage(message);
    if (!envelope) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid message format' }),
      };
    }

    // Log received message
    await activityService.logMessageReceived(
      AGENT_ID,
      'web',
      envelope.sender.displayName || 'Web User',
      envelope.content.text || ''
    );

    // Generate response synchronously for web chat
    const llmService = createLLMService(agentConfig.llm, secrets);
    const generator = createResponseGenerator(
      agentConfig,
      llmService,
      stateService,
      webTools,
      agentConfig.persona
    );

    const response = await generator.generate(envelope);

    // Extract text response
    const messageAction = response.actions.find((a: ResponseAction) => a.type === 'send_message');
    const responseText = messageAction && 'text' in messageAction 
      ? messageAction.text 
      : 'I apologize, but I was unable to generate a response.';

    // Update channel state
    await stateService.addMessageToChannel(
      AGENT_ID,
      envelope.conversationId,
      'web',
      {
        messageId: envelope.messageId,
        sender: envelope.sender.displayName || 'User',
        isBot: false,
        content: envelope.content.text || '',
        timestamp: envelope.timestamp,
      }
    );

    await stateService.addMessageToChannel(
      AGENT_ID,
      envelope.conversationId,
      'web',
      {
        messageId: `bot_${Date.now()}`,
        sender: agentConfig.name,
        isBot: true,
        content: responseText,
        timestamp: Date.now(),
      }
    );

    // Log response
    await activityService.logResponseSent(AGENT_ID, 'web', response.actions);

    // Return response
    const webResponse = webAdapter.createResponse(AGENT_ID, responseText);

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(webResponse),
    };

  } catch (error) {
    logger.error('Web chat error', error);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
