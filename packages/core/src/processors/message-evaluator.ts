/**
 * Message Evaluator Processor
 * Determines whether the avatar should respond to an incoming message
 */
import type {
  SwarmEnvelope,
  AvatarConfig,
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
  botUserIds?: string[]; // Bot user IDs for mention matching
  adminUserIds?: string[]; // Admin users who bypass cooldowns
}

export class MessageEvaluator {
  constructor(
    private readonly avatarConfig: AvatarConfig,
    private readonly stateService: StateService,
    private readonly evaluatorConfig: MessageEvaluatorConfig
  ) {}

  async evaluate(envelope: SwarmEnvelope): Promise<EvaluationResult> {
    // 1. Check if sender is a bot (and we should ignore bots)
    if (this.avatarConfig.behavior.ignoreBots && envelope.sender.isBot) {
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
      envelope.avatarId,
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
      case 'discord':
        return this.evaluateDiscord(envelope);
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
      envelope.avatarId,
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

    // Default: queue group messages at low priority so the channel
    // state machine can accumulate them and decide when to respond
    // (message threshold / conversation gap triggers).
    return {
      shouldRespond: true,
      reason: 'Group chat, queued for state machine evaluation',
      priority: 'low',
    };
  }

  /**
   * Discord-specific evaluation
   */
  private evaluateDiscord(envelope: SwarmEnvelope): EvaluationResult {
    const config = this.avatarConfig.platforms.discord;
    const chatType = envelope.metadata.chatType;

    // Global mode: selective response based on mention/name/channel
    if (config?.mode === 'global') {
      // Always respond if @mentioned
      if (envelope.metadata.isMention) {
        return { shouldRespond: true, reason: 'Mentioned in global mode', priority: 'high' };
      }
      // Respond if avatar's base name appears in the message text.
      // Strip emoji and special chars from avatar name, then match each word
      // so "Chamuel 😇" matches "chamuel", "chamuel silverlight", "hey chamuel", etc.
      const text = envelope.content.text?.toLowerCase() || '';
      const baseName = this.avatarConfig.name
        .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
        .trim()
        .toLowerCase();
      if (baseName && text.includes(baseName)) {
        return { shouldRespond: true, reason: 'Named in global mode', priority: 'normal' };
      }
      // If in an explicitly allowed channel, respond to all messages
      if (config.allowedChannels?.includes(envelope.conversationId)) {
        return { shouldRespond: true, reason: 'Allowed channel in global mode', priority: 'normal' };
      }
      return { shouldRespond: false, reason: 'Not addressed in global mode', priority: 'low' };
    }

    if (chatType === 'private') {
      if (config?.respondInDMs === false) {
        return {
          shouldRespond: false,
          reason: 'Discord DM responses disabled',
          priority: 'low',
        };
      }

      return {
        shouldRespond: true,
        reason: 'Discord DM',
        priority: 'normal',
      };
    }

    if (config?.respondToMentions === false) {
      return {
        shouldRespond: false,
        reason: 'Discord mentions disabled',
        priority: 'low',
      };
    }

    return {
      shouldRespond: false,
      reason: 'Discord guild message without mention',
      priority: 'low',
    };
  }

  /**
   * Twitter-specific evaluation (for mentions/replies)
   */
  private evaluateTwitter(_envelope: SwarmEnvelope): EvaluationResult {
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
    
    if (this.avatarConfig.platforms.web?.tokenGated?.enabled) {
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
    if (envelope.metadata.isMention) {
      return true;
    }

    // Check mentions array
    for (const mention of envelope.mentions) {
      if (this.evaluatorConfig.botUsernames.some(
        username => mention.username?.toLowerCase() === username.toLowerCase()
      )) {
        return true;
      }

      if (mention.userId && this.evaluatorConfig.botUserIds?.includes(mention.userId)) {
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
    if (!envelope.replyTo) {
      return false;
    }

    // Get channel state to check recent messages
    const channelState = await this.stateService.getChannelState(
      envelope.avatarId,
      envelope.conversationId
    );

    if (!channelState?.recentMessages) {
      return false;
    }

    // Look for the replied-to message in recent messages
    const repliedMessage = channelState.recentMessages.find(
      msg => msg.messageId === envelope.replyTo
    );

    // If found, check if it was from the bot
    if (repliedMessage) {
      return repliedMessage.isBot;
    }

    // Message not found in recent history - could be older
    // For Telegram, we can check the raw update for reply info
    if (envelope.platform === 'telegram') {
      const raw = envelope.raw as {
        message?: {
          reply_to_message?: {
            from?: { is_bot?: boolean; username?: string };
          };
        };
      };

      const replyFrom = raw?.message?.reply_to_message?.from;
      if (replyFrom) {
        // Check if it's a bot and matches our bot username
        if (replyFrom.is_bot && replyFrom.username) {
          return this.evaluatorConfig.botUsernames.some(
            name => name.toLowerCase() === replyFrom.username?.toLowerCase()
          );
        }
      }
    }

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
  avatarConfig: AvatarConfig,
  stateService: StateService,
  configOrBotUsernames: MessageEvaluatorConfig | string[],
  adminUserIds?: string[]
): MessageEvaluator {
  const config = Array.isArray(configOrBotUsernames)
    ? { botUsernames: configOrBotUsernames, adminUserIds }
    : configOrBotUsernames;

  return new MessageEvaluator(avatarConfig, stateService, config);
}
