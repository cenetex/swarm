/**
 * Raticross Platform Adapter (Outbound)
 *
 * Converts SwarmResponse actions into raticross Envelope format
 * and POSTs to the peer system's inbound endpoint.
 */
import { randomUUID } from 'crypto';
import {
  PlatformAdapter,
  logger,
  RATICROSS_PROTOCOL_VERSION,
  type AvatarConfig,
  type Platform,
  type SwarmEnvelope,
  type ResponseAction,
  type RaticrossEnvelope,
} from '@swarm/core';

export class RaticrossAdapter extends PlatformAdapter {
  readonly platform: Platform = 'raticross';
  private relayUrl: string;
  private relayKey?: string;
  private targetSystem: string;
  private targetAgentId?: string;

  constructor(
    avatarConfig: AvatarConfig,
    relayUrl: string,
    relayKey?: string,
    targetSystem = 'kyro',
    targetAgentId?: string,
  ) {
    super(avatarConfig);
    this.relayUrl = relayUrl.replace(/\/+$/, '');
    this.relayKey = relayKey;
    this.targetSystem = targetSystem;
    this.targetAgentId = targetAgentId;
  }

  async verifyRequest(_body: Buffer, _headers: Record<string, string>): Promise<boolean> {
    // Inbound verification is handled by the raticross-inbound handler
    return true;
  }

  async parseMessage(_body: unknown): Promise<SwarmEnvelope | null> {
    // Inbound parsing is handled by the raticross-inbound handler
    return null;
  }

  async executeAction(
    action: ResponseAction,
    conversationId: string,
    _replyToMessageId?: string,
  ): Promise<boolean> {
    if (action.type !== 'send_message') {
      // Only send_message actions are forwarded to raticross peers
      return true;
    }

    const text = 'text' in action ? action.text : undefined;
    if (!text) return true;

    const envelope: RaticrossEnvelope = {
      id: randomUUID(),
      protocol: RATICROSS_PROTOCOL_VERSION,
      timestamp: Date.now(),
      from: {
        system: 'swarm',
        agentId: this.avatarConfig.id,
      },
      to: {
        system: this.targetSystem,
        agentId: this.targetAgentId || conversationId,
      },
      type: 'message',
      conversationId,
      content: text,
    };

    try {
      const response = await fetch(`${this.relayUrl}/raticross/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.relayKey ? { 'x-raticross-key': this.relayKey } : {}),
        },
        body: JSON.stringify(envelope),
      });

      if (!response.ok) {
        logger.error('Raticross relay rejected message', undefined, {
          event: 'relay_rejected',
          subsystem: 'raticross-outbound',
          status: response.status,
          avatarId: this.avatarConfig.id,
          conversationId,
        });
        return false;
      }

      logger.info('Raticross message sent', {
        event: 'message_sent',
        subsystem: 'raticross-outbound',
        avatarId: this.avatarConfig.id,
        conversationId,
        targetSystem: this.targetSystem,
      });

      return true;
    } catch (err) {
      logger.error('Failed to send raticross message', err, {
        event: 'send_failed',
        subsystem: 'raticross-outbound',
        avatarId: this.avatarConfig.id,
        conversationId,
      });
      return false;
    }
  }

  async sendTypingIndicator(_conversationId: string): Promise<void> {
    // Raticross peers don't support typing indicators
  }

  getDisplayName(): string {
    return 'RATiCross';
  }

  isConfigured(): boolean {
    return Boolean(this.relayUrl);
  }
}
