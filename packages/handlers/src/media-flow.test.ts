import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SendMessageCommand } from '@aws-sdk/client-sqs';

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
  SendMessageCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({
       send: vi.fn().mockImplementation((_command) => {
         return Promise.resolve({ Attributes: {} });
       })
    })),
  },
  PutCommand: vi.fn().mockImplementation((input: any) => ({ input })),
}));

vi.mock('@swarm/core', async () => {
  const { z: zodLib } = await import('zod');

  // Create mock Zod schemas that match the structure expected by media-processor
  const MockResponseActionSchema = zodLib.object({
    type: zodLib.string(),
  }).passthrough();

  const MockSwarmResponseSchema = zodLib.object({
    agentId: zodLib.string(),
    platform: zodLib.string(),
    conversationId: zodLib.string(),
    actions: zodLib.array(zodLib.any()),
  }).passthrough();

  return {
    createMediaService: vi.fn(() => ({
      generateImage: vi.fn().mockResolvedValue({ url: 'https://example.com/img.png' }),
      generateVideo: vi.fn().mockResolvedValue({ url: 'https://example.com/vid.mp4' }),
    })),
    createSecretsService: vi.fn(() => ({
      getSecretJson: vi.fn().mockResolvedValue({ REPLICATE_API_KEY: 'test' }),
    })),
    createStateService: vi.fn(() => ({
      getAgentConfig: vi.fn().mockResolvedValue({
        id: 'agent-1',
        name: 'test',
        version: '1.0.0',
        persona: 'test',
        tools: [],
        secrets: [],
        media: { image: { provider: 'replicate', model: 'test' } },
        behavior: { responseDelayMs: [0, 0] },
        platforms: { telegram: { enabled: true, botUsername: 'test', webhookPath: 'test' } },
        llm: { provider: 'openrouter', model: 'test', temperature: 0, maxTokens: 0 },
        scheduling: {}
      }),
    })),
    logger: {
      setContext: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ResponseActionSchema: MockResponseActionSchema,
    SwarmResponseSchema: MockSwarmResponseSchema,
  };
});

const mocked = <T>(value: T) => (typeof (vi as any).mocked === 'function' ? (vi as any).mocked(value) : value as any);

import { handler } from './media-processor.js';

describe('Media Pipeline Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESPONSE_QUEUE_URL = 'https://sqs.test/responses';
    process.env.STATE_TABLE = 'test-table';
    process.env.AGENT_ID = 'agent-1';
    process.env.MEDIA_BUCKET = 'test-bucket';
  });

  it('should process a media job and send results to response queue', async () => {
    const event = {
      Records: [{
        messageId: 'msg-1',
        body: JSON.stringify({
          jobId: 'job-1',
          agentId: 'agent-1',
          conversationId: 'chat-1',
          action: { type: 'take_selfie', prompt: 'a photo' },
          response: {
            agentId: 'agent-1',
            platform: 'telegram',
            conversationId: 'chat-1',
            actions: [],
            generatedAt: Date.now(),
            llmModel: 'test',
            tokensUsed: 0
          }
        })
      }]
    } as any;

    await handler(event, {} as any);

    // Verify callback to response queue
    expect(SendMessageCommand).toHaveBeenCalled();
    const call = mocked(SendMessageCommand).mock.calls[0][0] as any;
    const body = JSON.parse(call.MessageBody);
    
    expect(body.platform).toBe('telegram');
    expect(body.actions[0].type).toBe('send_media');
    expect(body.actions[0].url).toBe('https://example.com/img.png');
  });
});
