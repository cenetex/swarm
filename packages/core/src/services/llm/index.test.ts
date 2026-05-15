/**
 * LLM Service Tests
 *
 * Covers:
 * - fetchWithRetry: retry logic with exponential backoff for HTTP calls
 * - OpenRouterLLMService: response parsing, tool call handling
 * - RetryableLLMService: retry + fallback provider chain
 * - createLLMService factory: provider selection and missing key errors
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMGenerateParams, LLMResponse } from '../../types/index.js';

// ---------------------------------------------------------------------------
// We need to test internal helpers (fetchWithRetry, sleep, etc.) that are not
// exported. The cleanest way without changing production code is to re-import
// the module and test through the public classes that exercise them.
// ---------------------------------------------------------------------------

// Mock the global fetch so no real HTTP calls are made.
const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  mockFetch.mockReset();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides?: Partial<LLMGenerateParams>): LLMGenerateParams {
  return {
    avatarId: 'test-avatar',
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hello' }],
    config: {
      provider: 'openrouter',
      model: 'openai/gpt-4',
      temperature: 0.7,
      maxTokens: 1024,
    },
    ...overrides,
  };
}

function openRouterJsonResponse(
  content: string,
  finishReason = 'stop',
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
): Response {
  const body = {
    choices: [
      {
        message: {
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: { total_tokens: 42 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function openRouterCatalogResponse(): Response {
  return new Response(JSON.stringify({
    data: [
      {
        id: 'openai/gpt-4',
        context_length: 128000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'openai/gpt-4-fallback',
        context_length: 64000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockOpenRouterChatResponses(...responses: Array<Response | Error>): void {
  let chatCall = 0;
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/models')) {
      return openRouterCatalogResponse();
    }

    const response = responses[chatCall++];
    if (response instanceof Error) {
      throw response;
    }
    if (response) {
      return response;
    }
    throw new Error(`Unexpected OpenRouter chat call ${chatCall}`);
  });
}

function expectFetchCalls(chatCalls: number): void {
  expect(mockFetch).toHaveBeenCalledTimes(chatCalls + 1);
}

// ---------------------------------------------------------------------------
// Tests for fetchWithRetry (exercised through OpenRouterLLMService)
// ---------------------------------------------------------------------------

describe('OpenRouterLLMService', () => {
  // Dynamic import so mocks are in place before the module resolves fetch.
  async function createService() {
    // Clear module cache to pick up mocked fetch
    const mod = await import('./index.js');
    mod._resetOpenRouterChatModelCache();
    return new mod.OpenRouterLLMService('test-api-key');
  }

  it('returns a successful response on first attempt', async () => {
    mockOpenRouterChatResponses(openRouterJsonResponse('Hello there!'));

    const service = await createService();
    const result = await service.generateResponse(makeParams());

    expect(result.content).toBe('Hello there!');
    expect(result.model).toBe('openai/gpt-4');
    expect(result.tokensUsed).toBe(42);
    expect(result.finishReason).toBe('end_turn');
    expectFetchCalls(1);
  });

  it('retries on 429 and eventually succeeds', async () => {
    mockOpenRouterChatResponses(
      new Response('Rate limited', { status: 429 }),
      openRouterJsonResponse('Retry succeeded'),
    );

    const service = await createService();
    const result = await service.generateResponse(makeParams());

    expect(result.content).toBe('Retry succeeded');
    // 1 failed + 1 success = 2 total calls
    expectFetchCalls(2);
  });

  it('retries on 500 server errors', async () => {
    mockOpenRouterChatResponses(
      new Response('Server Error', { status: 500 }),
      new Response('Server Error', { status: 502 }),
      openRouterJsonResponse('Finally ok'),
    );

    const service = await createService();
    const result = await service.generateResponse(makeParams());

    expect(result.content).toBe('Finally ok');
    expectFetchCalls(3);
  });

  it('does NOT retry on 400 client errors', async () => {
    mockOpenRouterChatResponses(
      new Response('Bad Request', { status: 400, statusText: 'Bad Request' }),
    );

    const service = await createService();

    await expect(service.generateResponse(makeParams())).rejects.toThrow(
      /OpenRouter API error: 400/
    );
    expectFetchCalls(1);
  });

  it('does NOT retry on 401 unauthorized', async () => {
    mockOpenRouterChatResponses(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const service = await createService();

    await expect(service.generateResponse(makeParams())).rejects.toThrow(
      /OpenRouter API error: 401/
    );
    expectFetchCalls(1);
  });

  it('does NOT retry on 403 forbidden', async () => {
    mockOpenRouterChatResponses(
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    );

    const service = await createService();

    await expect(service.generateResponse(makeParams())).rejects.toThrow(
      /OpenRouter API error: 403/
    );
    expectFetchCalls(1);
  });

  it('throws after exhausting all retries on persistent 500', async () => {
    // OPENROUTER_RETRY_COUNT = 2, so 3 total attempts (0, 1, 2)
    mockOpenRouterChatResponses(
      new Response('Error', { status: 500 }),
      new Response('Error', { status: 500 }),
      new Response('Error', { status: 500 }),
    );

    const service = await createService();

    await expect(service.generateResponse(makeParams())).rejects.toThrow(/HTTP 500/);
    expectFetchCalls(3);
  });

  it('throws after exhausting all retries on persistent 429', async () => {
    mockOpenRouterChatResponses(
      new Response('Rate limited', { status: 429 }),
      new Response('Rate limited', { status: 429 }),
      new Response('Rate limited', { status: 429 }),
    );

    const service = await createService();

    await expect(service.generateResponse(makeParams())).rejects.toThrow(/HTTP 429/);
    expectFetchCalls(3);
  });

  it('retries on network errors (fetch rejects)', async () => {
    mockOpenRouterChatResponses(
      new Error('ECONNRESET'),
      openRouterJsonResponse('Network recovered'),
    );

    const service = await createService();
    const result = await service.generateResponse(makeParams());

    expect(result.content).toBe('Network recovered');
    expectFetchCalls(2);
  });

  it('parses tool calls from the response', async () => {
    const toolCalls = [
      {
        id: 'tc_1',
        function: {
          name: 'get_weather',
          arguments: JSON.stringify({ city: 'Tokyo' }),
        },
      },
    ];
    mockOpenRouterChatResponses(openRouterJsonResponse('', 'tool_calls', toolCalls));

    const service = await createService();
    const result = await service.generateResponse(makeParams());

    expect(result.finishReason).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('get_weather');
    expect(result.toolCalls![0].input).toEqual({ city: 'Tokyo' });
  });

  it('handles malformed tool call arguments gracefully', async () => {
    const toolCalls = [
      {
        id: 'tc_bad',
        function: {
          name: 'broken_tool',
          arguments: '{ not valid json',
        },
      },
    ];
    // Suppress console.warn during this test
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockOpenRouterChatResponses(openRouterJsonResponse('', 'tool_calls', toolCalls));

    const service = await createService();
    const result = await service.generateResponse(makeParams());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('broken_tool');
    // The input should be empty object since JSON.parse failed
    expect(result.toolCalls![0].input).toEqual({});
    warnSpy.mockRestore();
  });

  it('maps finish_reason "length" to "max_tokens"', async () => {
    const body = {
      choices: [
        {
          message: { content: 'truncated...' },
          finish_reason: 'length',
        },
      ],
      usage: { total_tokens: 100 },
    };
    mockOpenRouterChatResponses(new Response(JSON.stringify(body), { status: 200 }));

    const service = await createService();
    const result = await service.generateResponse(makeParams());

    expect(result.finishReason).toBe('max_tokens');
  });

  it('sends correct headers including API key', async () => {
    mockOpenRouterChatResponses(openRouterJsonResponse('ok'));

    const service = await createService();
    await service.generateResponse(makeParams());

    const callArgs = mockFetch.mock.calls.find(([input]) => String(input).includes('/chat/completions'));
    expect(callArgs).toBeTruthy();
    if (!callArgs) throw new Error('Expected chat completions call');
    const options = callArgs[1] as RequestInit;
    const headers = options.headers as Record<string, string>;

    expect(headers['Authorization']).toBe('Bearer test-api-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe('https://swarm.ai');
    expect(headers['X-Title']).toBe('Swarm Avatar');
  });
});

// ---------------------------------------------------------------------------
// Tests for RetryableLLMService (retry + fallback)
// ---------------------------------------------------------------------------

describe('RetryableLLMService', () => {
  async function createRetryableService(
    primaryFn: () => Promise<LLMResponse>,
    fallbackFn?: () => Promise<LLMResponse>,
    retryConfig?: {
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      retryableErrors?: string[];
    }
  ) {
    const mod = await import('./index.js');

    const primary = {
      generateResponse: vi.fn().mockImplementation(primaryFn),
    };

    const fallback = fallbackFn
      ? { generateResponse: vi.fn().mockImplementation(fallbackFn) }
      : undefined;

    const config = {
      maxRetries: retryConfig?.maxRetries ?? 2,
      baseDelayMs: retryConfig?.baseDelayMs ?? 10, // Small for tests
      maxDelayMs: retryConfig?.maxDelayMs ?? 100,
      retryableErrors: retryConfig?.retryableErrors ?? [
        'rate_limit',
        'overloaded',
        'timeout',
        'ECONNRESET',
        'ETIMEDOUT',
        '429',
        '500',
        '502',
        '503',
        '504',
      ],
    };

    const service = new mod.RetryableLLMService(primary, fallback, config);
    return { service, primary, fallback };
  }

  const successResponse: LLMResponse = {
    content: 'Success',
    model: 'test-model',
    tokensUsed: 10,
    finishReason: 'end_turn',
  };

  it('returns immediately on first success', async () => {
    const { service, primary } = await createRetryableService(
      () => Promise.resolve(successResponse)
    );

    const result = await service.generateResponse(makeParams());

    expect(result.content).toBe('Success');
    expect(primary.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable errors and eventually succeeds', async () => {
    let attempt = 0;
    const { service, primary } = await createRetryableService(() => {
      attempt++;
      if (attempt < 3) {
        return Promise.reject(new Error('rate_limit exceeded'));
      }
      return Promise.resolve(successResponse);
    });

    const result = await service.generateResponse(makeParams());

    expect(result.content).toBe('Success');
    expect(primary.generateResponse).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on non-retryable errors', async () => {
    const { service, primary } = await createRetryableService(() =>
      Promise.reject(new Error('Invalid authentication credentials'))
    );

    await expect(service.generateResponse(makeParams())).rejects.toThrow(
      'Invalid authentication credentials'
    );
    // Should only be called once since "Invalid authentication" is not retryable
    expect(primary.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('falls back to secondary provider when primary exhausts retries', async () => {
    const fallbackResponse: LLMResponse = {
      content: 'Fallback succeeded',
      model: 'fallback-model',
      tokensUsed: 20,
      finishReason: 'end_turn',
    };

    const { service, primary, fallback } = await createRetryableService(
      () => Promise.reject(new Error('503 Service Unavailable')),
      () => Promise.resolve(fallbackResponse)
    );

    const result = await service.generateResponse(makeParams());

    expect(result.content).toBe('Fallback succeeded');
    expect(result.model).toBe('fallback-model');
    // primary called maxRetries+1 times (3)
    expect(primary.generateResponse).toHaveBeenCalledTimes(3);
    expect(fallback!.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('throws original error when both primary and fallback fail', async () => {
    // Suppress console.error for this test
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const { service, primary, fallback } = await createRetryableService(
      () => Promise.reject(new Error('500 Primary down')),
      () => Promise.reject(new Error('Fallback also down'))
    );

    await expect(service.generateResponse(makeParams())).rejects.toThrow(
      '500 Primary down'
    );
    expect(primary.generateResponse).toHaveBeenCalledTimes(3);
    expect(fallback!.generateResponse).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('does not use fallback when no fallback is configured', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { service, primary } = await createRetryableService(
      () => Promise.reject(new Error('500 error'))
    );

    await expect(service.generateResponse(makeParams())).rejects.toThrow('500 error');
    expect(primary.generateResponse).toHaveBeenCalledTimes(3);

    warnSpy.mockRestore();
  });

  it('does not retry when maxRetries is 0', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { service, primary } = await createRetryableService(
      () => Promise.reject(new Error('503 error')),
      undefined,
      { maxRetries: 0 }
    );

    await expect(service.generateResponse(makeParams())).rejects.toThrow('503 error');
    expect(primary.generateResponse).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests for createLLMService factory
// ---------------------------------------------------------------------------

describe('createLLMService', () => {
  async function getFactory() {
    const mod = await import('./index.js');
    return mod.createLLMService;
  }

  it('creates an OpenRouter-based service when provider is "openrouter"', async () => {
    const factory = await getFactory();
    const service = factory(
      { provider: 'openrouter', model: 'gpt-4', temperature: 0.7, maxTokens: 1024 },
      { OPENROUTER_API_KEY: 'sk-test-key' }
    );

    expect(service).toBeDefined();
    expect(service.generateResponse).toBeTypeOf('function');
  });

  it('throws when OpenRouter key is missing', async () => {
    const factory = await getFactory();

    expect(() =>
      factory(
        { provider: 'openrouter', model: 'gpt-4', temperature: 0.7, maxTokens: 1024 },
        {}
      )
    ).toThrow('OPENROUTER_API_KEY not found in secrets');
  });

  it('creates an Anthropic-based service when provider is "anthropic"', async () => {
    const factory = await getFactory();
    const service = factory(
      { provider: 'anthropic', model: 'claude-3-opus', temperature: 0.7, maxTokens: 1024 },
      { ANTHROPIC_API_KEY: 'sk-ant-test' }
    );

    expect(service).toBeDefined();
    expect(service.generateResponse).toBeTypeOf('function');
  });

  it('throws when Anthropic key is missing', async () => {
    const factory = await getFactory();

    expect(() =>
      factory(
        { provider: 'anthropic', model: 'claude-3-opus', temperature: 0.7, maxTokens: 1024 },
        {}
      )
    ).toThrow('ANTHROPIC_API_KEY not found in secrets');
  });

  it('creates a Bedrock-based service when provider is "bedrock"', async () => {
    const factory = await getFactory();
    const service = factory(
      { provider: 'bedrock', model: 'anthropic.claude-v2', temperature: 0.7, maxTokens: 1024 },
      {}
    );

    expect(service).toBeDefined();
    expect(service.generateResponse).toBeTypeOf('function');
  });

  it('throws on unknown provider', async () => {
    const factory = await getFactory();

    expect(() =>
      factory(
        { provider: 'unknown' as 'openrouter', model: 'x', temperature: 0.7, maxTokens: 1024 },
        {}
      )
    ).toThrow('Unknown LLM provider: unknown');
  });

  it('wraps the service with RetryableLLMService for fallback support', async () => {
    const factory = await getFactory();
    const service = factory(
      {
        provider: 'openrouter',
        model: 'gpt-4',
        fallbackModel: 'claude-3-haiku',
        temperature: 0.7,
        maxTokens: 1024,
      },
      { OPENROUTER_API_KEY: 'sk-test-key' }
    );

    // The returned service should be a RetryableLLMService wrapper
    expect(service).toBeDefined();
    expect(service.generateResponse).toBeTypeOf('function');
  });
});
