import type { AvatarConfig, DiscordMessage } from '@swarm/core';

export const INTENT_GUILD_VOICE_STATES = 1 << 7;

export interface DiscordVoiceStateUpdate {
  guild_id?: string;
  channel_id?: string | null;
  user_id: string;
}

export interface DiscordVoiceBehavior {
  enabled: boolean;
  autoJoinOnMention: boolean;
  maxSessionSeconds: number;
  allowedVoiceChannelIds?: string[];
}

type DiscordVoiceSkipReason =
  | 'voice_disabled'
  | 'not_guild_message'
  | 'bot_message'
  | 'not_mentioned'
  | 'sender_not_in_voice'
  | 'voice_channel_not_allowed';

export type DiscordVoiceLaunchDecision =
  | {
      shouldLaunch: false;
      reason: DiscordVoiceSkipReason;
      voiceChannelId?: string;
    }
  | {
      shouldLaunch: true;
      reason: 'ready';
      voiceChannelId: string;
      maxSessionSeconds: number;
    };

type EnvLike = Record<string, string | undefined>;

export class DiscordVoiceStateTracker {
  private readonly userVoiceChannels = new Map<string, string>();

  record(update: DiscordVoiceStateUpdate): void {
    if (!update.guild_id) return;
    const key = this.key(update.guild_id, update.user_id);
    if (update.channel_id) {
      this.userVoiceChannels.set(key, update.channel_id);
    } else {
      this.userVoiceChannels.delete(key);
    }
  }

  getUserVoiceChannel(guildId: string | undefined, userId: string): string | undefined {
    if (!guildId) return undefined;
    return this.userVoiceChannels.get(this.key(guildId, userId));
  }

  private key(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }
}

export function resolveDiscordVoiceBehavior(
  config: NonNullable<AvatarConfig['platforms']['discord']>,
  env: EnvLike = process.env,
): DiscordVoiceBehavior {
  const envEnabled = env.DISCORD_VOICE_DEFAULT_ENABLED === 'true';
  const enabled = config.voice?.enabled ?? envEnabled;
  const envAutoJoin = env.DISCORD_VOICE_AUTO_JOIN_ON_MENTION;
  const autoJoinOnMention = config.voice?.autoJoinOnMention
    ?? (envAutoJoin === undefined ? enabled : envAutoJoin === 'true');

  return {
    enabled,
    autoJoinOnMention: enabled && autoJoinOnMention,
    maxSessionSeconds: config.voice?.maxSessionSeconds
      ?? parsePositiveInt(env.DISCORD_VOICE_SESSION_SECONDS)
      ?? 600,
    allowedVoiceChannelIds: config.voice?.allowedVoiceChannelIds,
  };
}

export function isDiscordVoiceMention(message: DiscordMessage, botUserId?: string): boolean {
  if (!botUserId) return false;
  const mentioned = message.mentions.some((mention) => mention.id === botUserId);
  const repliedToBot = message.referenced_message?.author.id === botUserId;
  return mentioned || repliedToBot;
}

export function decideDiscordVoiceLaunch(params: {
  message: DiscordMessage;
  avatarConfig: AvatarConfig;
  botUserId?: string;
  tracker: DiscordVoiceStateTracker;
  env?: EnvLike;
}): DiscordVoiceLaunchDecision {
  const { message, avatarConfig, botUserId, tracker, env } = params;
  const discordConfig = avatarConfig.platforms.discord;
  if (!discordConfig?.enabled) {
    return { shouldLaunch: false, reason: 'voice_disabled' };
  }

  const behavior = resolveDiscordVoiceBehavior(discordConfig, env);
  if (!behavior.enabled || !behavior.autoJoinOnMention) {
    return { shouldLaunch: false, reason: 'voice_disabled' };
  }

  if (!message.guild_id) {
    return { shouldLaunch: false, reason: 'not_guild_message' };
  }
  if (message.author.bot) {
    return { shouldLaunch: false, reason: 'bot_message' };
  }
  if (!isDiscordVoiceMention(message, botUserId)) {
    return { shouldLaunch: false, reason: 'not_mentioned' };
  }

  const voiceChannelId = tracker.getUserVoiceChannel(message.guild_id, message.author.id);
  if (!voiceChannelId) {
    return { shouldLaunch: false, reason: 'sender_not_in_voice' };
  }

  if (
    behavior.allowedVoiceChannelIds?.length &&
    !behavior.allowedVoiceChannelIds.includes(voiceChannelId)
  ) {
    return { shouldLaunch: false, reason: 'voice_channel_not_allowed', voiceChannelId };
  }

  return {
    shouldLaunch: true,
    reason: 'ready',
    voiceChannelId,
    maxSessionSeconds: behavior.maxSessionSeconds,
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
