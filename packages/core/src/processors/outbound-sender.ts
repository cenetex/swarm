/**
 * Outbound Sender Processor
 * Executes response actions on the appropriate platform
 */
import type {
  SwarmResponse,
  Platform,
} from '../types/index.js';
import type { PlatformRegistry } from '../platforms/base.js';
import type { ActivityService } from '../services/activity.js';
import { logger } from '../utils/logger.js';

export class OutboundSender {
  constructor(
    private readonly platformRegistry: PlatformRegistry,
    private readonly activityService?: ActivityService
  ) {}

  /**
   * Execute all actions in a response
   */
  async send(response: SwarmResponse): Promise<{ success: boolean; errors: string[]; sentMessages: string[] }> {
    const adapter = this.platformRegistry.get(response.platform);
    
    if (!adapter) {
      return {
        success: false,
        errors: [`No adapter found for platform: ${response.platform}`],
        sentMessages: [],
      };
    }

    const errors: string[] = [];
    let hasSuccessfulAction = false;
    const sentMessages: string[] = [];

    for (const action of response.actions) {
      try {
        // Skip ignore actions
        if (action.type === 'ignore') {
          console.log(`Ignoring: ${action.reason}`);
          continue;
        }

        // Handle wait actions
        if (action.type === 'wait') {
          await new Promise(resolve => setTimeout(resolve, action.durationMs));
          continue;
        }

        // Send typing indicator before sending message
        if (action.type === 'send_message') {
          await adapter.sendTypingIndicator(response.conversationId);
        }

        // Execute the action
        const success = await adapter.executeAction(
          action,
          response.conversationId,
          response.replyToMessageId
        );

        if (success) {
          hasSuccessfulAction = true;
          if (action.type === 'send_message') {
            sentMessages.push(action.text);
          }
        } else {
          errors.push(`Action ${action.type} failed`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const statusCode = error instanceof Error
          ? (error as unknown as Record<string, unknown>).code ??
            (error as unknown as Record<string, unknown>).statusCode
          : undefined;
        errors.push(`Action ${action.type} error: ${errorMessage}`);
        logger.error('Action execution failed', error instanceof Error ? error : undefined, {
          subsystem: 'outbound-sender',
          event: 'action_execution_failed',
          action: action.type,
          platform: response.platform,
          avatarId: response.avatarId,
          conversationId: response.conversationId,
          ...(typeof statusCode === 'number' ? { statusCode } : {}),
        });
      }
    }

    // Log activity
    if (this.activityService) {
      try {
        await this.activityService.logResponseSent(
          response.avatarId,
          response.platform,
          response.actions
        );
      } catch (error) {
        console.warn('Failed to log activity:', error instanceof Error ? error.message : String(error));
      }
    }

    return {
      success: hasSuccessfulAction || errors.length === 0,
      errors,
      sentMessages,
    };
  }

  /**
   * Send a simple text message
   */
  async sendMessage(
    _avatarId: string,
    platform: Platform,
    conversationId: string,
    text: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    const adapter = this.platformRegistry.get(platform);
    
    if (!adapter) {
      console.error(`No adapter found for platform: ${platform}`);
      return false;
    }

    return adapter.executeAction(
      { type: 'send_message', text },
      conversationId,
      replyToMessageId
    );
  }

  /**
   * Send typing indicator
   */
  async sendTyping(platform: Platform, conversationId: string): Promise<void> {
    const adapter = this.platformRegistry.get(platform);
    
    if (adapter) {
      await adapter.sendTypingIndicator(conversationId);
    }
  }
}

/**
 * Factory function
 */
export function createOutboundSender(
  platformRegistry: PlatformRegistry,
  activityService?: ActivityService
): OutboundSender {
  return new OutboundSender(platformRegistry, activityService);
}
