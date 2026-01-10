/**
 * Web Chat Platform Adapter
 * Handles REST API-based web chat with optional Solana wallet authentication
 */
import { PlatformAdapter } from './base.js';
import type {
  AgentConfig,
  SwarmEnvelope,
  ResponseAction,
  SenderInfo,
  MessageContent,
  WebConfig,
} from '../types/index.js';

export interface WebChatMessage {
  messageId: string;
  sessionId: string;
  userId: string;
  text: string;
  timestamp?: number;
  
  // Optional wallet authentication
  wallet?: {
    address: string;
    signature?: string;
    signedMessage?: string;
  };
  
  // Optional media
  media?: Array<{
    type: 'image' | 'video';
    url: string;
  }>;
}

export interface WebChatResponse {
  messageId: string;
  agentId: string;
  text: string;
  media?: Array<{
    type: 'image' | 'video';
    url: string;
  }>;
  timestamp: number;
}

export class WebAdapter extends PlatformAdapter {
  readonly platform = 'web' as const;
  private config: WebConfig;

  constructor(agentConfig: AgentConfig) {
    super(agentConfig);
    this.config = agentConfig.platforms.web!;
  }

  isConfigured(): boolean {
    return !!this.config?.enabled;
  }

  getDisplayName(): string {
    return 'Web Chat';
  }

  async verifyRequest(body: Buffer, headers: Record<string, string>): Promise<boolean> {
    // Check CORS origin
    const origin = headers['origin'] || headers['Origin'];
    if (origin && this.config.corsOrigins.length > 0) {
      if (!this.config.corsOrigins.includes(origin) && !this.config.corsOrigins.includes('*')) {
        return false;
      }
    }

    // Additional API key verification could be added here
    return true;
  }

  async parseMessage(body: unknown): Promise<SwarmEnvelope | null> {
    const message = body as WebChatMessage;
    
    if (!message.messageId || !message.text || !message.sessionId) {
      return null;
    }

    const sender = await this.extractSender(message);
    const content = this.extractContent(message);

    return this.createBaseEnvelope({
      messageId: message.messageId,
      conversationId: message.sessionId,
      timestamp: message.timestamp || Date.now(),
      sender,
      content,
      raw: message,
    });
  }

  async executeAction(
    action: ResponseAction,
    conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    // Web chat responses are returned directly via the API
    // This method is used for async processing scenarios
    
    switch (action.type) {
      case 'send_message':
        // Store response in DynamoDB for polling or WebSocket delivery
        console.log(`Web response for ${conversationId}:`, action.text);
        return true;

      case 'wait':
        await new Promise(resolve => setTimeout(resolve, action.durationMs));
        return true;

      case 'ignore':
        return true;

      default:
        return true;
    }
  }

  async sendTypingIndicator(conversationId: string): Promise<void> {
    // Could be implemented via WebSocket if using real-time connection
    console.log(`Typing indicator for web session: ${conversationId}`);
  }

  /**
   * Create a response object for synchronous API responses
   */
  createResponse(
    agentId: string,
    text: string,
    media?: Array<{ type: 'image' | 'video'; url: string }>
  ): WebChatResponse {
    return {
      messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      agentId,
      text,
      media,
      timestamp: Date.now(),
    };
  }

  /**
   * Verify Solana wallet signature for token gating
   */
  async verifyWalletSignature(
    address: string,
    signature: string,
    message: string
  ): Promise<boolean> {
    // Import nacl for signature verification
    // This is a placeholder - actual implementation needs @solana/web3.js
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const nacl = await import('tweetnacl');
      
      const publicKey = new PublicKey(address);
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = Buffer.from(signature, 'base64');
      
      return nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKey.toBytes()
      );
    } catch (error) {
      console.error('Wallet signature verification failed:', error);
      return false;
    }
  }

  /**
   * Extract sender info from web message
   */
  private async extractSender(message: WebChatMessage): Promise<SenderInfo> {
    const sender: SenderInfo = {
      id: message.userId,
      username: message.wallet?.address?.slice(0, 8),
      displayName: message.wallet?.address 
        ? `${message.wallet.address.slice(0, 4)}...${message.wallet.address.slice(-4)}`
        : `User ${message.userId.slice(0, 6)}`,
      isBot: false,
      platform: 'web',
      platformUserId: message.userId,
      walletAddress: message.wallet?.address,
    };

    return sender;
  }

  /**
   * Extract content from web message
   */
  private extractContent(message: WebChatMessage): MessageContent {
    const content: MessageContent = {
      text: message.text,
    };

    if (message.media && message.media.length > 0) {
      content.media = message.media.map(m => ({
        type: m.type === 'image' ? 'photo' : 'video',
        url: m.url,
      }));
    }

    return content;
  }

  /**
   * Get CORS headers for API responses
   */
  getCorsHeaders(origin?: string): Record<string, string> {
    const allowedOrigin = origin && this.config.corsOrigins.includes(origin)
      ? origin
      : this.config.corsOrigins[0] || '*';

    return {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wallet-Address',
      'Access-Control-Max-Age': '86400',
    };
  }
}
