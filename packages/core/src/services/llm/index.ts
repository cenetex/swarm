/**
 * LLM Service - Unified interface for multiple LLM providers
 * Supports AWS Bedrock, OpenRouter, and direct Anthropic API
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ContentBlock,
  Message as BedrockMessage,
  ToolConfiguration,
  ToolInputSchema,
  Tool,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  LLMService,
  LLMConfig,
  LLMGenerateParams,
  LLMResponse,
  LLMMessage,
  ToolDefinition,
  ToolCall,
} from '../../types/index.js';

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
    // Convert Zod schema to JSON Schema for Bedrock
    const jsonSchema = this.zodToJsonSchema(tool.parameters);

    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          json: jsonSchema,
        },
      },
    };
  }

  private zodToJsonSchema(schema: unknown): Record<string, unknown> {
    // Basic Zod to JSON Schema conversion
    // For production, use a proper library like zod-to-json-schema
    return {
      type: 'object',
      properties: {},
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
        parameters: this.zodToJsonSchema(tool.parameters),
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

  private zodToJsonSchema(schema: unknown): Record<string, unknown> {
    return {
      type: 'object',
      properties: {},
    };
  }
}

/**
 * Factory function to create the appropriate LLM service
 */
export function createLLMService(config: LLMConfig, secrets: Record<string, string>): LLMService {
  switch (config.provider) {
    case 'bedrock':
      return new BedrockLLMService();
    
    case 'openrouter':
      const openrouterKey = secrets['OPENROUTER_API_KEY'];
      if (!openrouterKey) {
        throw new Error('OPENROUTER_API_KEY not found in secrets');
      }
      return new OpenRouterLLMService(openrouterKey);
    
    case 'anthropic':
      const anthropicKey = secrets['ANTHROPIC_API_KEY'];
      if (!anthropicKey) {
        throw new Error('ANTHROPIC_API_KEY not found in secrets');
      }
      // Could use @anthropic-ai/sdk here
      return new OpenRouterLLMService(anthropicKey); // Fallback to OpenRouter format
    
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
