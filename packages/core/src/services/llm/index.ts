/**
 * LLM Service - Unified interface for multiple LLM providers
 * Supports AWS Bedrock, OpenRouter, and direct Anthropic API
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  Message as BedrockMessage,
  ToolConfiguration,
  Tool,
} from '@aws-sdk/client-bedrock-runtime';
import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type {
  LLMService,
  LLMConfig,
  LLMGenerateParams,
  LLMResponse,
  ToolDefinition,
  ToolCall,
} from '../../types/index.js';

/**
 * Convert a Zod schema to JSON Schema for LLM tool definitions
 */
function convertZodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: 'openApi3' }) as Record<string, unknown>;
}

export class BedrockLLMService implements LLMService {
  private client: BedrockRuntimeClient;

  constructor(region: string = 'us-east-1') {
    this.client = new BedrockRuntimeClient({ region });
  }

  async generateResponse(params: LLMGenerateParams): Promise<LLMResponse> {
    const { systemPrompt, messages, tools, config } = params;

    // Convert messages to Bedrock format
    const bedrockMessages: BedrockMessage[] = messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: [{ text: msg.content }],
    }));

    // Build tool configuration if tools provided
    let toolConfig: ToolConfiguration | undefined;
    if (tools && tools.length > 0) {
      toolConfig = {
        tools: tools.map(tool => this.convertToolDefinition(tool)),
      };
    }

    const command = new ConverseCommand({
      modelId: config.model,
      system: [{ text: systemPrompt }],
      messages: bedrockMessages,
      inferenceConfig: {
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      },
      toolConfig,
    });

    try {
      const response = await this.client.send(command);
      
      // Extract response content
      const outputContent = response.output?.message?.content || [];
      let textContent = '';
      const toolCalls: ToolCall[] = [];

      for (const block of outputContent) {
        if ('text' in block && block.text) {
          textContent += block.text;
        } else if ('toolUse' in block && block.toolUse) {
          toolCalls.push({
            id: block.toolUse.toolUseId || `tool_${Date.now()}`,
            name: block.toolUse.name || '',
            input: block.toolUse.input,
          });
        }
      }

      // Determine finish reason
      let finishReason: LLMResponse['finishReason'] = 'end_turn';
      if (response.stopReason === 'tool_use') {
        finishReason = 'tool_use';
      } else if (response.stopReason === 'max_tokens') {
        finishReason = 'max_tokens';
      }

      return {
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model: config.model,
        tokensUsed: (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0),
        finishReason,
      };
    } catch (error) {
      console.error('Bedrock API error:', error);
      throw error;
    }
  }

  private convertToolDefinition(tool: ToolDefinition): Tool {
    const jsonSchema = convertZodToJsonSchema(tool.parameters);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          json: jsonSchema,
        } as any,
      },
    };
  }
}

/**
 * OpenRouter LLM Service - Access to many models via OpenRouter API
 */
export class OpenRouterLLMService implements LLMService {
  private apiKey: string;
  private baseUrl = 'https://openrouter.ai/api/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateResponse(params: LLMGenerateParams): Promise<LLMResponse> {
    const { systemPrompt, messages, tools, config } = params;

    // Build messages array
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    // Build tools if provided
    const apiTools = tools?.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: convertZodToJsonSchema(tool.parameters),
      },
    }));

    const body: Record<string, unknown> = {
      model: config.model,
      messages: apiMessages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    };

    if (apiTools && apiTools.length > 0) {
      body.tools = apiTools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://swarm.ai',
        'X-Title': 'Swarm Agent',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: {
        total_tokens: number;
      };
    };

    const choice = data.choices[0];
    const toolCalls: ToolCall[] = [];

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    let finishReason: LLMResponse['finishReason'] = 'end_turn';
    if (choice.finish_reason === 'tool_calls') {
      finishReason = 'tool_use';
    } else if (choice.finish_reason === 'length') {
      finishReason = 'max_tokens';
    }

    return {
      content: choice.message.content || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model: config.model,
      tokensUsed: data.usage?.total_tokens || 0,
      finishReason,
    };
  }
}

/**
 * Anthropic LLM Service - Direct Anthropic API using official SDK
 */
export class AnthropicLLMService implements LLMService {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateResponse(params: LLMGenerateParams): Promise<LLMResponse> {
    const { systemPrompt, messages, tools, config } = params;

    // Convert messages to Anthropic format
    const anthropicMessages: Anthropic.MessageParam[] = messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    }));

    // Build tools if provided
    const anthropicTools: Anthropic.Tool[] | undefined = tools?.map(tool => {
      const schema = convertZodToJsonSchema(tool.parameters);
      return {
        name: tool.name,
        description: tool.description,
        input_schema: schema as Anthropic.Tool['input_schema'],
      };
    });

    try {
      const response = await this.client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools,
        temperature: config.temperature,
      });

      // Extract response content
      let textContent = '';
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      // Determine finish reason
      let finishReason: LLMResponse['finishReason'] = 'end_turn';
      if (response.stop_reason === 'tool_use') {
        finishReason = 'tool_use';
      } else if (response.stop_reason === 'max_tokens') {
        finishReason = 'max_tokens';
      }

      return {
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        model: config.model,
        tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
        finishReason,
      };
    } catch (error) {
      console.error('Anthropic API error:', error);
      throw error;
    }
  }
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: string[];
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableErrors: [
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

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: unknown, retryableErrors: string[]): boolean {
  const errorString = String(error);
  const errorMessage = error instanceof Error ? error.message : '';
  const errorName = error instanceof Error ? error.name : '';

  return retryableErrors.some(pattern =>
    errorString.includes(pattern) ||
    errorMessage.includes(pattern) ||
    errorName.includes(pattern)
  );
}

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 30% jitter
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * LLM Service with retry logic - wraps any LLM service with exponential backoff
 */
export class RetryableLLMService implements LLMService {
  constructor(
    private readonly primary: LLMService,
    private readonly fallback?: LLMService,
    private readonly config: RetryConfig = DEFAULT_RETRY_CONFIG
  ) {}

  async generateResponse(params: LLMGenerateParams): Promise<LLMResponse> {
    let lastError: unknown;

    // Try primary service with retries
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await this.primary.generateResponse(params);
      } catch (error) {
        lastError = error;
        console.warn(`LLM request failed (attempt ${attempt + 1}/${this.config.maxRetries + 1}):`, error);

        // Don't retry if error is not retryable
        if (!isRetryableError(error, this.config.retryableErrors)) {
          break;
        }

        // Don't sleep on the last attempt
        if (attempt < this.config.maxRetries) {
          const delay = calculateBackoff(attempt, this.config.baseDelayMs, this.config.maxDelayMs);
          console.info(`Retrying in ${delay}ms...`);
          await sleep(delay);
        }
      }
    }

    // Try fallback service if available
    if (this.fallback) {
      console.info('Primary LLM failed, trying fallback...');
      try {
        return await this.fallback.generateResponse(params);
      } catch (fallbackError) {
        console.error('Fallback LLM also failed:', fallbackError);
        // Throw the original error since that's more informative
      }
    }

    throw lastError;
  }
}

/**
 * Factory function to create the appropriate LLM service
 */
export function createLLMService(config: LLMConfig, secrets: Record<string, string>): LLMService {
  let primary: LLMService;

  switch (config.provider) {
    case 'bedrock':
      primary = new BedrockLLMService();
      break;

    case 'openrouter': {
      const openrouterKey = secrets['OPENROUTER_API_KEY'];
      if (!openrouterKey) {
        throw new Error('OPENROUTER_API_KEY not found in secrets');
      }
      primary = new OpenRouterLLMService(openrouterKey);
      break;
    }

    case 'anthropic': {
      const anthropicKey = secrets['ANTHROPIC_API_KEY'];
      if (!anthropicKey) {
        throw new Error('ANTHROPIC_API_KEY not found in secrets');
      }
      primary = new AnthropicLLMService(anthropicKey);
      break;
    }

    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }

  // Create fallback service if fallbackModel is specified
  let fallback: LLMService | undefined;
  if (config.fallbackModel) {
    // Use OpenRouter for fallback as it supports many models
    const openrouterKey = secrets['OPENROUTER_API_KEY'];
    if (openrouterKey) {
      fallback = new OpenRouterLLMService(openrouterKey);
      // Note: The fallback will use the fallbackModel from params when called
    }
  }

  // Wrap with retry logic
  return new RetryableLLMService(primary, fallback);
}
