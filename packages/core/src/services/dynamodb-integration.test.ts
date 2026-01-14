import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>();
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: vi.fn().mockReturnValue({
        send: vi.fn().mockImplementation((command) => {
          if (command.input?.UpdateExpression) {
             return Promise.resolve({ 
               Attributes: { 
                 agentId: 'a1', 
                 channelId: 'c1', 
                 platform: 'telegram',
                 recentMessages: [],
                 state: 'IDLE'
               } 
             });
          }
          if (command.input?.Key && !command.input?.UpdateExpression) {
             return Promise.resolve({ Item: { agentId: 'a1', channelId: 'c1', platform: 'telegram' } });
          }
          return Promise.resolve({});
        }),
      }),
    },
    GetCommand: vi.fn().mockImplementation((input) => ({ input })),
    UpdateCommand: vi.fn().mockImplementation((input) => ({ input })),
    PutCommand: vi.fn().mockImplementation((input) => ({ input })),
    DeleteCommand: vi.fn().mockImplementation((input) => ({ input })),
  };
});

const mocked = <T>(value: T) => (typeof (vi as any).mocked === 'function' ? (vi as any).mocked(value) : value as any);

describe('DynamoDBStateService Integration', () => {
  let service: import('./state.js').DynamoDBStateService;
  let DynamoDBStateService: typeof import('./state.js').DynamoDBStateService;
  let DynamoDBDocumentClient: typeof import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  let GetCommand: typeof import('@aws-sdk/lib-dynamodb').GetCommand;
  let UpdateCommand: typeof import('@aws-sdk/lib-dynamodb').UpdateCommand;
  let _mockDocClient: ReturnType<typeof mocked>;

  beforeAll(async () => {
    ({ DynamoDBDocumentClient, GetCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb'));
    ({ DynamoDBStateService } = await import('./state.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DynamoDBStateService('test-table');
    _mockDocClient = mocked(DynamoDBDocumentClient.from(null as unknown as import('@aws-sdk/client-dynamodb').DynamoDBClient));
  });

  it('should call GetCommand for getChannelState', async () => {
    await service.getChannelState('a1', 'c1');

    expect(GetCommand).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'test-table',
      Key: { pk: 'AGENT#a1', sk: 'CHANNEL#c1#STATE' }
    }));
  });

  it('should call UpdateCommand for addMessageToChannel', async () => {
    await service.addMessageToChannel('a1', 'c1', 'telegram', {
      sender: 'u1',
      content: 'test',
      timestamp: 123,
      messageId: 'm1',
      isBot: false
    });

    expect(UpdateCommand).toHaveBeenCalled();
    const updateCall = mocked(UpdateCommand).mock.calls[0][0] as any;
    expect(updateCall.TableName).toBe('test-table');
    expect(updateCall.UpdateExpression).toContain('recentMessages = list_append');
  });
});
