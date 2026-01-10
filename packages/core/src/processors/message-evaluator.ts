/**
 * Message Evaluator Processor
 * Determines whether the agent should respond to an incoming message
 */
import type {
  SwarmEnvelope,
  AgentConfig,
  ChannelState,
  UserCooldown,
  StateService,
} from '../types/index.js';

export interface EvaluationResult {
  shouldRespond: boolean;
  reason: string;
  priority: 'high' | 'normal' | 'low';
  skipQueue?: boolean; // For direct responses (e.g., commands)
}

export interface MessageEvaluatorConfig {
  botUsernames: string[]; // Bot's usernames on different platforms
  adminUserIds?: string[]; // Admin users who bypass cooldowns
}

export class MessageEvaluator {
  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly stateService: StateService,
    private readonly evaluatorConfig: MessageEvaluatorConfig
  ) {}

  async evaluate(envelope: SwarmEnvelope): Promise<EvaluationResult> {
    // 1. Check if sender is a bot (and we should ignore bots)
    if (this.agentConfig.behavior.ignoreBots && envelope.sender.isBot) {
      return {
        shouldRespond: false,
        reason: 'Sender is a bot',
        priority: 'low',
      };
    }

    // 2. Check for commands (always respond to commands)
    if (envelope.content.command) {
      return this.evaluateCommand(envelope);
    }

    // 3. Check if user is on cooldown
    const cooldown = await this.stateService.getUserCooldown(
      envelope.agentId,
      envelope.platform,
      envelope.sender.id
    );

    if (cooldown && !this.isAdmin(envelope.sender.id)) {
      return {
        shouldRespond: false,
        reason: `User on cooldown until ${new Date(cooldown.cooldownUntil).toISOString()}`,
        priority: 'low',
      };
    }

    // 4. Check for direct mention of bot
    const isMentioned = this.isBotMentioned(envelope);
    if (isMentioned) {
      return {
        shouldRespond: true,
        reason: 'Bot was directly mentioned',
        priority: 'high',
      };
    }

    // 5. Check if replying to bot's message
    if (envelope.replyTo && await this.isReplyToBot(envelope)) {
      return {
        shouldRespond: true,
        reason: 'Reply to bot message',
        priority: 'high',
      };
    }

    // 6. Platform-specific evaluation
    switch (envelope.platform) {
      case 'telegram':
        return this.evaluateTelegram(envelope);
      case 'twitter':
        return this.evaluateTwitter(envelope);
      case 'web':
        return this.evaluateWeb(envelope);
      default:
        return {
          shouldRespond: false,
          reason: 'Unknown platform',
          priority: 'low',
        };
    }
  }

  /**
   * Evaluate command messages
   */
  private evaluateCommand(envelope: SwarmEnvelope): EvaluationResult {
    const command = envelope.content.command!.command.toLowerCase();

    // Known commands that should always get a response
    const knownCommands = ['start', 'help', 'status', 'selfie', 'imagine'];

    if (knownCommands.includes(command)) {
      return {
        shouldRespond: true,
        reason: `Command: /${command}`,
        priority: 'high',
        skipQueue: command === 'start' || command === 'help', // Direct response for simple commands
      };
    }

    return {
      shouldRespond: true,
      reason: `Unknown command: /${command}`,
      priority: 'normal',
    };
  }

  /**
   * Telegram-specific evaluation
   */
  private async evaluateTelegram(envelope: SwarmEnvelope): Promise<EvaluationResult> {
    const raw = envelope.raw as { message?: { chat?: { type?: string } } };
    const chatType = raw?.message?.chat?.type;

    // Private chats always get responses
    if (chatType === 'private') {
      return {
        shouldRespond: true,
        reason: 'Private chat',
        priority: 'normal',
      };
    }

    // Group chats - use probabilistic response or context-based
    // Get channel state to check recent activity
    const channelState = await this.stateService.getChannelState(
      envelope.agentId,
      envelope.conversationId
    );

    // If recently active in channel, higher chance to respond
    if (channelState) {
      const timeSinceLastActivity = Date.now() - channelState.lastActivityAt;
      const recentlyActive = timeSinceLastActivity < 5 * 60 * 1000; // 5 minutes

      if (recentlyActive) {
        // Check if the message seems conversational
        const text = envelope.content.text?.toLowerCase() || '';
        const conversationalIndicators = ['?', 'what', 'why', 'how', 'when', 'who'];
        
        if (conversationalIndicators.some(ind => text.includes(ind))) {
          return {
            shouldRespond: true,
            reason: 'Recent activity + conversational message',
            priority: 'normal',
          };
        }
      }
    }

    // Default: don't respond in groups unless mentioned
    return {
      shouldRespond: false,
      reason: 'Group chat, not mentioned',
      priority: 'low',
    };
  }

  /**
   * Twitter-specific evaluation (for mentions/replies)
   */
  private evaluateTwitter(envelope: SwarmEnvelope): EvaluationResult {
    // Twitter messages are usually pre-filtered to mentions
    // So if we got here, we should probably respond
    return {
      shouldRespond: true,
      reason: 'Twitter mention or reply',
      priority: 'normal',
    };
  }

  /**
   * Web chat evaluation (always respond)
   */
  private evaluateWeb(envelope: SwarmEnvelope): EvaluationResult {
    // Token gating check could be done here
    const sender = envelope.sender;
    
    if (this.agentConfig.platforms.web?.tokenGated?.enabled) {
      if (!sender.walletAddress) {
        return {
          shouldRespond: false,
          reason: 'Wallet not connected (token-gated)',
          priority: 'low',
        };
      }

      // Token balance check would be done via Solana service
      // For now, trust the wallet address presence
    }

    return {
      shouldRespond: true,
      reason: 'Web chat',
      priority: 'normal',
    };
  }

  /**
   * Check if bot was mentioned in the message
   */
  private isBotMentioned(envelope: SwarmEnvelope): boolean {
    // Check mentions array
    for (const mention of envelope.mentions) {
      if (this.evaluatorConfig.botUsernames.some(
        username => mention.username?.toLowerCase() === username.toLowerCase()
      )) {
        return true;
      }
    }

    // Also check text content for @mentions
    const text = envelope.content.text?.toLowerCase() || '';
    for (const username of this.evaluatorConfig.botUsernames) {
      if (text.includes(`@${username.toLowerCase()}`)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if message is a reply to the bot
   */
  private async isReplyToBot(envelope: SwarmEnvelope): Promise<boolean> {
    // This would require looking up the original message
    // For now, assume replies to bot are handled at the platform level
    // TODO: Implement message lookup
    return false;
  }

  /**
   * Check if user is an admin
   */
  private isAdmin(userId: string): boolean {
    return this.evaluatorConfig.adminUserIds?.includes(userId) || false;
  }
}

/**
 * Factory function
 */
export function createMessageEvaluator(
  agentConfig: AgentConfig,
  stateService: StateService,
  botUsernames: string[],
  adminUserIds?: string[]
): MessageEvaluator {
  return new MessageEvaluator(agentConfig, stateService, {
    botUsernames,
    adminUserIds,
  });
}
