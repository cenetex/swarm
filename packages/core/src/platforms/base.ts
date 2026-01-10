/**
 * Platform adapter base class and common utilities
 */
import type { 
  Platform, 
  SwarmEnvelope, 
  ResponseAction, 
  AgentConfig,
  SenderInfo,
  MessageContent 
} from '../types/index.js';

/**
 * Abstract base class for platform adapters
 * Each platform (Telegram, Twitter, Discord, Web) implements this interface
 */
export abstract class PlatformAdapter {
  abstract readonly platform: Platform;
  
  constructor(protected readonly agentConfig: AgentConfig) {}

  /**
   * Verify incoming webhook request authenticity
   */
  abstract verifyRequest(body: Buffer, headers: Record<string, string>): Promise<boolean>;

  /**
   * Parse platform-specific message into universal SwarmEnvelope
   */
  abstract parseMessage(body: unknown): Promise<SwarmEnvelope | null>;

  /**
   * Execute a response action on the platform
   */
  abstract executeAction(
    action: ResponseAction, 
    conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean>;

  /**
   * Send typing indicator (if supported)
   */
  abstract sendTypingIndicator(conversationId: string): Promise<void>;

  /**
   * Get display name for logging/activity feed
   */
  abstract getDisplayName(): string;

  /**
   * Check if this adapter is properly configured
   */
  abstract isConfigured(): boolean;

  /**
   * Generate idempotency key for a message
   */
  protected generateIdempotencyKey(
    platform: Platform,
    agentId: string,
    messageId: string
  ): string {
    return `${platform}:${agentId}:${messageId}`;
  }

  /**
   * Create base envelope with common fields
   */
  protected createBaseEnvelope(params: {
    messageId: string;
    conversationId: string;
    timestamp: number;
    sender: SenderInfo;
    content: MessageContent;
    raw: unknown;
  }): SwarmEnvelope {
    return {
      agentId: this.agentConfig.id,
      platform: this.platform,
      messageId: params.messageId,
      conversationId: params.conversationId,
      timestamp: params.timestamp,
      sender: params.sender,
      content: params.content,
      mentions: [],
      raw: params.raw,
      metadata: {
        receivedAt: Date.now(),
        priority: 'normal',
        idempotencyKey: this.generateIdempotencyKey(
          this.platform,
          this.agentConfig.id,
          params.messageId
        ),
      },
    };
  }
}

/**
 * Registry for platform adapters
 */
export class PlatformRegistry {
  private adapters: Map<Platform, PlatformAdapter> = new Map();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: Platform): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  getAll(): PlatformAdapter[] {
    return Array.from(this.adapters.values());
  }

  getConfigured(): PlatformAdapter[] {
    return this.getAll().filter(a => a.isConfigured());
  }
}
