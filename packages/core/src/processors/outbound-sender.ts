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

/**
 * Structured error object returned by OutboundSender.send().
 * Carries metadata about the action that failed, including whether
 * the error is retryable, so callers (e.g. response-sender) can
 * make informed retry decisions.
 */
export interface ActionError {
  action: string;
  message: string;
  statusCode?: number;
  isRetryable?: boolean;
}

/**
 * Record of a successfully delivered non-text artifact (image, video,
 * animation). Callers use this to write a marker into chat history so the
 * LLM knows the media was delivered — see #1487.
 */
export interface SentMediaRecord {
  mediaType: 'image' | 'video' | 'animation';
  url: string;
  caption?: string;
}

export class OutboundSender {
  constructor(
    private readonly platformRegistry: PlatformRegistry,
    private readonly activityService?: ActivityService
  ) {}

  /**
   * Execute all actions in a response
   */
  async send(response: SwarmResponse): Promise<{
    success: boolean;
    errors: ActionError[];
    sentMessages: string[];
    sentMedia: SentMediaRecord[];
  }> {
    const adapter = this.platformRegistry.get(response.platform);

    if (!adapter) {
      return {
        success: false,
        errors: [{ action: 'init', message: `No adapter found for platform: ${response.platform}`, isRetryable: false }],
        sentMessages: [],
        sentMedia: [],
      };
    }

    const errors: ActionError[] = [];
    let hasSuccessfulAction = false;
    const sentMessages: string[] = [];
    const sentMedia: SentMediaRecord[] = [];

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
          } else if (action.type === 'send_media') {
            sentMedia.push({
              mediaType: action.mediaType,
              url: action.url,
              caption: action.caption,
            });
          }
        } else {
          errors.push({ action: action.type, message: `Action ${action.type} failed`, isRetryable: true });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Extract structured metadata from PlatformError or similar typed errors.
        // Prefer the numeric `statusCode` property; `code` may be a string enum (SwarmErrorCode).
        const rawStatusCode = error instanceof Error
          ? (error as unknown as Record<string, unknown>).statusCode ??
            (error as unknown as Record<string, unknown>).code
          : undefined;
        const statusCode = typeof rawStatusCode === 'number' ? rawStatusCode : undefined;
        const retryable = (error as { retryable?: boolean })?.retryable;

        errors.push({
          action: action.type,
          message: `Action ${action.type} error: ${errorMessage}`,
          statusCode: typeof statusCode === 'number' ? statusCode : undefined,
          isRetryable: retryable ?? true, // default to retryable for unknown errors
        });
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
      sentMedia,
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
