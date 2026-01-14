import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock AWS SDK
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = vi.fn();
  return {
    DynamoDBDocumentClient: {
      from: vi.fn(() => ({
        send: mockSend
      }))
    },
    GetCommand: vi.fn(x => x),
    PutCommand: vi.fn(x => x),
    ScanCommand: vi.fn(x => x),
  };
});

// Mock agents service
vi.mock('./agents.js', () => ({
  createAgent: vi.fn(async (name, _session, desc) => ({
    agentId: 'new-agent',
    name,
    description: desc,
    status: 'draft',
    createdAt: Date.now()
  }))
}));

const mocked = <T>(value: T) => (typeof (vi as any).mocked === 'function' ? (vi as any).mocked(value) : value as any);

describe('TemplateService', () => {
  let templateService: typeof import('./templates.js');
  let DynamoDBDocumentClient: typeof import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  let mockDocClient: ReturnType<typeof mocked>;
  const session = { email: 'admin@example.com' };

  beforeAll(async () => {
    ({ DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb'));
    templateService = await import('./templates.js');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDocClient = mocked(DynamoDBDocumentClient.from(null as any));
  });

  it('export returns template metadata + config', async () => {
    const agent = {
      agentId: 'agent-1',
      name: 'Agent One',
      description: 'Test agent',
      persona: 'You are a test agent',
      platforms: { telegram: { enabled: true } },
      llmConfig: { provider: 'openai', model: 'gpt-4', temperature: 0.7, maxTokens: 1000, useGlobalKey: true }
    };

    mockDocClient.send.mockResolvedValueOnce({}); // PutCommand

    const template = await templateService.exportAgentAsTemplate(agent as any, 'Test Template', 'Template Description');

    expect(template.name).toBe('Test Template');
    expect(template.config.persona).toBe(agent.persona);
    expect(template.config.llmConfig?.model).toBe(agent.llmConfig.model);
    expect(mockDocClient.send).toHaveBeenCalledWith(expect.objectContaining({
      Item: expect.objectContaining({
         sk: 'TEMPLATE'
      })
    }));
  });

  it('list templates returns stored entries', async () => {
    mockDocClient.send.mockResolvedValueOnce({
      Items: [
        { templateId: 't1', name: 'T1', config: {} },
        { templateId: 't2', name: 'T2', config: {} }
      ]
    });

    const templates = await templateService.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates[0].templateId).toBe('t1');
  });

  it('import creates an agent from template', async () => {
    // 1. Get template
    mockDocClient.send.mockResolvedValueOnce({
      Item: {
        templateId: 't1',
        name: 'Template Name',
        config: { persona: 'From template', llmConfig: { model: 'gpt-X' } }
      }
    });

    // 2. PutCommand (for merged agent)
    mockDocClient.send.mockResolvedValueOnce({});

    const agent = await templateService.createAgentFromTemplate('t1', session as any, 'Custom Name');

    expect(agent.name).toBe('Custom Name');
    expect(agent.persona).toBe('From template');
    expect(agent.llmConfig.model).toBe('gpt-X');
    expect(mockDocClient.send).toHaveBeenCalledTimes(2);
  });
});
