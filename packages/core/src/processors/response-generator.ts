/**
 * Response Generator Processor
 * Generates LLM responses using agent persona and conversation context
 */
import type {
  SwarmEnvelope,
  SwarmResponse,
  AgentConfig,
  ChannelState,
  LLMService,
  LLMMessage,
  ToolDefinition,
  ToolCall,
  ResponseAction,
  StateService,
} from '../types/index.js';

export interface ResponseGeneratorConfig {
  maxContextMessages: number;
  defaultSystemPrompt: string;
}

export class ResponseGenerator {
  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly llmService: LLMService,
    private readonly stateService: StateService,
    private readonly tools: ToolDefinition[],
    private readonly config: ResponseGeneratorConfig
  ) {}

  /**
   * Generate a response for an incoming message
   */
  async generate(envelope: SwarmEnvelope): Promise<SwarmResponse> {
    // 1. Get channel context
    const channelState = await this.stateService.getChannelState(
      envelope.agentId,
      envelope.conversationId
    );

    // 2. Build system prompt
    const systemPrompt = this.buildSystemPrompt(envelope, channelState);

    // 3. Build message history
    const messages = this.buildMessageHistory(envelope, channelState);

    // 4. Generate LLM response
    const llmResponse = await this.llmService.generateResponse({
      agentId: envelope.agentId,
      systemPrompt,
      messages,
      tools: this.tools,
      config: this.agentConfig.llm,
    });

    // 5. Process tool calls if any
    let actions: ResponseAction[] = [];

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      actions = await this.processToolCalls(llmResponse.toolCalls, envelope);
    } else if (llmResponse.content) {
      // No tool calls, just text response
      actions = [{
        type: 'send_message',
        text: llmResponse.content,
        replyToMessageId: envelope.messageId,
      }];
    }

    // 6. Apply response delay if configured
    if (this.agentConfig.behavior.responseDelayMs) {
      const [min, max] = this.agentConfig.behavior.responseDelayMs;
      const delay = Math.floor(Math.random() * (max - min + 1)) + min;
      
      if (delay > 0) {
        actions.unshift({
          type: 'wait',
          durationMs: delay,
          reason: 'Natural response delay',
        });
      }
    }

    return {
      agentId: envelope.agentId,
      platform: envelope.platform,
      conversationId: envelope.conversationId,
      replyToMessageId: envelope.messageId,
      actions,
      generatedAt: Date.now(),
      llmModel: llmResponse.model,
      tokensUsed: llmResponse.tokensUsed,
    };
  }

  /**
   * Build the system prompt from persona and context
   */
  private buildSystemPrompt(envelope: SwarmEnvelope, channelState: ChannelState | null): string {
    let prompt = this.agentConfig.persona || this.config.defaultSystemPrompt;

    // Add platform context
    prompt += `\n\n## Current Context
- Platform: ${envelope.platform}
- Channel: ${envelope.conversationId}
- Time: ${new Date().toISOString()}
`;

    // Add user context if available
    prompt += `\n## User Information
- User ID: ${envelope.sender.id}
- Username: ${envelope.sender.username || 'unknown'}
- Display Name: ${envelope.sender.displayName || 'unknown'}
`;

    // Add wallet info if available (for token-gated features)
    if (envelope.sender.walletAddress) {
      prompt += `- Wallet: ${envelope.sender.walletAddress}
- Token Balance: ${envelope.sender.tokenBalance || 0}
`;
    }

    // Add channel summary if available
    if (channelState?.summary) {
      prompt += `\n## Conversation Summary
${channelState.summary}
`;
    }

    // Add tool instructions
    if (this.tools.length > 0) {
      prompt += `\n## Available Actions
You can use the following tools to respond:
`;
      for (const tool of this.tools) {
        prompt += `- **${tool.name}**: ${tool.description}\n`;
      }
      
      prompt += `
Use tools naturally in conversation. You can use multiple tools in sequence.
If you want to respond with just text, use the send_message tool.
If the message doesn't warrant a response, use the ignore tool.
`;
    }

    return prompt;
  }

  /**
   * Build message history for context
   */
  private buildMessageHistory(
    envelope: SwarmEnvelope, 
    channelState: ChannelState | null
  ): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // Add recent messages from channel state
    if (channelState?.recentMessages) {
      const recentMessages = channelState.recentMessages
        .slice(-this.config.maxContextMessages);

      for (const msg of recentMessages) {
        messages.push({
          role: msg.isBot ? 'assistant' : 'user',
          content: `[${msg.sender}]: ${msg.content}`,
        });
      }
    }

    // Add current message
    const currentContent = this.formatMessageContent(envelope);
    messages.push({
      role: 'user',
      content: `[${envelope.sender.displayName || envelope.sender.username || envelope.sender.id}]: ${currentContent}`,
    });

    return messages;
  }

  /**
   * Format message content including any attachments
   */
  private formatMessageContent(envelope: SwarmEnvelope): string {
    let content = envelope.content.text || '';

    // Add media descriptions
    if (envelope.content.media && envelope.content.media.length > 0) {
      const mediaDescriptions = envelope.content.media.map(m => 
        `[${m.type}${m.mimeType ? `: ${m.mimeType}` : ''}]`
      );
      content += ` ${mediaDescriptions.join(' ')}`;
    }

    // Add sticker description
    if (envelope.content.sticker) {
      content += ` [sticker: ${envelope.content.sticker.emoji || 'unknown'}]`;
    }

    return content.trim();
  }

  /**
   * Process tool calls from LLM response
   */
  private async processToolCalls(
    toolCalls: ToolCall[],
    _envelope: SwarmEnvelope
  ): Promise<ResponseAction[]> {
    const actions: ResponseAction[] = [];

    for (const call of toolCalls) {
      const action = this.toolCallToAction(call);
      if (action) {
        actions.push(action);
      }
    }

    return actions;
  }

  /**
   * Convert a tool call to a response action
   */
  private toolCallToAction(call: ToolCall): ResponseAction | null {
    const input = call.input as Record<string, unknown>;

    switch (call.name) {
      case 'send_message':
        return {
          type: 'send_message',
          text: input.text as string,
          replyToMessageId: input.reply_to as string | undefined,
        };

      case 'react':
        return {
          type: 'react',
          emoji: input.emoji as string,
          messageId: input.message_id as string,
        };

      case 'take_selfie':
      case 'generate_image':
        return {
          type: 'take_selfie',
          prompt: input.prompt as string,
          style: input.style as string | undefined,
        };

      case 'generate_video':
        return {
          type: 'generate_video',
          prompt: input.prompt as string,
          duration: input.duration as number | undefined,
        };

      case 'send_sticker':
        return {
          type: 'send_sticker',
          emoji: input.emoji as string,
        };

      case 'wait':
        return {
          type: 'wait',
          durationMs: (input.seconds as number || 1) * 1000,
          reason: input.reason as string | undefined,
        };

      case 'ignore':
        return {
          type: 'ignore',
          reason: input.reason as string || 'No response needed',
        };

      // Wallet tools - these don't produce actions, they return data
      case 'get_my_wallet':
      case 'check_wallet_balance':
      case 'remember':
      case 'recall':
        // These tools need to execute and return data to the LLM
        // For now, return null (will be handled by tool executor)
        return null;

      default:
        console.warn(`Unknown tool: ${call.name}`);
        return null;
    }
  }
}

/**
 * Factory function
 */
export function createResponseGenerator(
  agentConfig: AgentConfig,
  llmService: LLMService,
  stateService: StateService,
  tools: ToolDefinition[],
  defaultSystemPrompt: string = 'You are a helpful AI assistant.'
): ResponseGenerator {
  return new ResponseGenerator(agentConfig, llmService, stateService, tools, {
    maxContextMessages: agentConfig.behavior.maxContextMessages || 20,
    defaultSystemPrompt,
  });
}
