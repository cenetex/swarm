import type { AvatarConfig, ChannelState, ContextMessage, Platform } from '../types/index.js';
import type { ChannelSummaryService } from './channel-summary.js';
import type { ChannelInfo, PresenceService } from './presence.js';

export type AvatarContextSnapshotItemKind =
  | 'recent_activity'
  | 'home_channel_summary';

export type AvatarContextSnapshotPolicyLabel =
  | 'private-source'
  | 'public-safe-summary'
  | 'cross-platform-context'
  | 'recent-activity'
  | 'home-channel';

export interface AvatarContextSnapshotSource {
  platform?: Platform;
  channelId?: string;
  channelLabel?: string;
  channelType?: string;
  sender?: string;
  username?: string;
  isBot?: boolean;
}

export interface AvatarContextSnapshotItem {
  kind: AvatarContextSnapshotItemKind;
  text: string;
  timestamp?: number;
  source?: AvatarContextSnapshotSource;
  policyLabels: AvatarContextSnapshotPolicyLabel[];
  ttlMs?: number;
}

export interface AvatarContextSnapshot {
  avatarId: string;
  generatedAt: number;
  current?: {
    platform?: Platform;
    channelId?: string;
  };
  items: AvatarContextSnapshotItem[];
}

export interface AvatarContextHomeChannel {
  channelId: string;
  platform: Platform;
  label?: string;
  username?: string;
}

export interface AvatarContextSnapshotOptions {
  includeRecentActivity?: boolean;
  includeHomeChannelSummary?: boolean;
  warmChannelSummaries?: boolean;
  maxChannelsToInspect?: number;
  maxRecentActivityItems?: number;
  recentActivityMaxAgeMs?: number;
  recentActivityMaxChars?: number;
  homeSummaryMaxChars?: number;
  backgroundSummaryMaxChannels?: number;
  backgroundSummaryMaxAgeMs?: number;
}

export interface BuildAvatarContextSnapshotParams {
  avatarId: string;
  currentChannelId?: string;
  currentPlatform?: Platform;
  homeChannel?: AvatarContextHomeChannel;
  presenceService: Pick<PresenceService, 'getAllChannels' | 'getChannelWithSummary'>;
  stateGetter: (avatarId: string, channelId: string) => Promise<ChannelState | null>;
  summaryService?: Pick<ChannelSummaryService, 'getOrGenerateSummary'>;
  now?: number;
  options?: AvatarContextSnapshotOptions;
}

export const AVATAR_CONTEXT_SNAPSHOT_DEFAULTS = {
  maxChannelsToInspect: 8,
  maxRecentActivityItems: 4,
  recentActivityMaxAgeMs: 6 * 60 * 60_000,
  recentActivityMaxChars: 140,
  homeSummaryMaxChars: 220,
  backgroundSummaryMaxChannels: 3,
  backgroundSummaryMaxAgeMs: 24 * 60 * 60_000,
} as const;

export function resolveHomeChannelFromAvatarConfig(
  avatarConfig: AvatarConfig
): AvatarContextHomeChannel | undefined {
  const telegramConfig = avatarConfig.platforms?.telegram;
  if (!telegramConfig?.homeChannelId) return undefined;

  return {
    channelId: telegramConfig.homeChannelId,
    platform: 'telegram',
    username: telegramConfig.homeChannelUsername,
    label: telegramConfig.homeChannelUsername
      ? `@${telegramConfig.homeChannelUsername}`
      : telegramConfig.homeChannelId,
  };
}

export function truncateSnapshotText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function formatSnapshotRelativeTime(timestampMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function channelLabel(channel: ChannelInfo): string {
  return channel.title || channel.channelId;
}

function mostRecentContentMessage(messages: ContextMessage[]): ContextMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.content) return messages[i];
  }
  return undefined;
}

async function buildRecentActivityItems(
  params: BuildAvatarContextSnapshotParams,
  channels: ChannelInfo[],
  now: number,
  options: Required<Pick<
    AvatarContextSnapshotOptions,
    'maxChannelsToInspect' | 'maxRecentActivityItems' | 'recentActivityMaxAgeMs' | 'recentActivityMaxChars'
  >>
): Promise<AvatarContextSnapshotItem[]> {
  const sorted = channels
    .slice()
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
    .slice(0, options.maxChannelsToInspect);

  const items: AvatarContextSnapshotItem[] = [];

  for (const channel of sorted) {
    if (
      params.currentChannelId &&
      params.currentPlatform &&
      channel.channelId === params.currentChannelId &&
      channel.platform === params.currentPlatform
    ) {
      continue;
    }

    const state = await params.stateGetter(params.avatarId, channel.channelId);
    const recentMessages = state?.recentMessages || [];
    const lastMessage = mostRecentContentMessage(recentMessages);
    if (!lastMessage) continue;
    if (now - lastMessage.timestamp > options.recentActivityMaxAgeMs) continue;

    items.push({
      kind: 'recent_activity',
      text: truncateSnapshotText(normalizeContent(lastMessage.content), options.recentActivityMaxChars),
      timestamp: lastMessage.timestamp,
      source: {
        platform: channel.platform,
        channelId: channel.channelId,
        channelLabel: channelLabel(channel),
        channelType: channel.type,
        sender: lastMessage.sender,
        username: lastMessage.username,
        isBot: lastMessage.isBot,
      },
      policyLabels: ['private-source', 'cross-platform-context', 'recent-activity'],
      ttlMs: options.recentActivityMaxAgeMs,
    });

    if (items.length >= options.maxRecentActivityItems) break;
  }

  return items;
}

async function buildHomeChannelSummaryItem(
  params: BuildAvatarContextSnapshotParams,
  now: number,
  homeSummaryMaxChars: number
): Promise<AvatarContextSnapshotItem | null> {
  if (!params.homeChannel || !params.summaryService) return null;

  const summary = await params.summaryService.getOrGenerateSummary(
    params.avatarId,
    params.homeChannel.channelId,
    params.homeChannel.platform,
    params.presenceService as PresenceService,
    params.stateGetter
  );

  if (!summary) return null;

  const channelDetail = await params.presenceService.getChannelWithSummary(
    params.avatarId,
    params.homeChannel.channelId,
    params.homeChannel.platform
  );

  const label = channelDetail?.title
    || params.homeChannel.label
    || (params.homeChannel.username ? `@${params.homeChannel.username}` : undefined)
    || params.homeChannel.channelId;

  return {
    kind: 'home_channel_summary',
    text: truncateSnapshotText(summary, homeSummaryMaxChars),
    timestamp: channelDetail?.summaryUpdatedAt || now,
    source: {
      platform: params.homeChannel.platform,
      channelId: params.homeChannel.channelId,
      channelLabel: label,
      channelType: channelDetail?.type,
    },
    policyLabels: ['private-source', 'public-safe-summary', 'home-channel'],
  };
}

async function warmBackgroundSummaries(
  params: BuildAvatarContextSnapshotParams,
  channels: ChannelInfo[],
  now: number,
  options: Required<Pick<
    AvatarContextSnapshotOptions,
    'backgroundSummaryMaxChannels' | 'backgroundSummaryMaxAgeMs'
  >>
): Promise<void> {
  if (!params.summaryService) return;

  const candidates = channels
    .filter((channel) => {
      if (
        params.currentChannelId &&
        params.currentPlatform &&
        channel.channelId === params.currentChannelId &&
        channel.platform === params.currentPlatform
      ) {
        return false;
      }
      if (
        params.homeChannel &&
        channel.channelId === params.homeChannel.channelId &&
        channel.platform === params.homeChannel.platform
      ) {
        return false;
      }
      return (channel.lastActivityAt || 0) > now - options.backgroundSummaryMaxAgeMs;
    })
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
    .slice(0, options.backgroundSummaryMaxChannels);

  await Promise.all(
    candidates.map(async (channel) => {
      await params.summaryService?.getOrGenerateSummary(
        params.avatarId,
        channel.channelId,
        channel.platform,
        params.presenceService as PresenceService,
        params.stateGetter
      );
    })
  );
}

export async function buildAvatarContextSnapshot(
  params: BuildAvatarContextSnapshotParams
): Promise<AvatarContextSnapshot> {
  const now = params.now ?? Date.now();
  const options = {
    includeRecentActivity: params.options?.includeRecentActivity ?? true,
    includeHomeChannelSummary: params.options?.includeHomeChannelSummary ?? true,
    warmChannelSummaries: params.options?.warmChannelSummaries ?? true,
    maxChannelsToInspect: params.options?.maxChannelsToInspect ?? AVATAR_CONTEXT_SNAPSHOT_DEFAULTS.maxChannelsToInspect,
    maxRecentActivityItems: params.options?.maxRecentActivityItems ?? AVATAR_CONTEXT_SNAPSHOT_DEFAULTS.maxRecentActivityItems,
    recentActivityMaxAgeMs: params.options?.recentActivityMaxAgeMs ?? AVATAR_CONTEXT_SNAPSHOT_DEFAULTS.recentActivityMaxAgeMs,
    recentActivityMaxChars: params.options?.recentActivityMaxChars ?? AVATAR_CONTEXT_SNAPSHOT_DEFAULTS.recentActivityMaxChars,
    homeSummaryMaxChars: params.options?.homeSummaryMaxChars ?? AVATAR_CONTEXT_SNAPSHOT_DEFAULTS.homeSummaryMaxChars,
    backgroundSummaryMaxChannels: params.options?.backgroundSummaryMaxChannels ?? AVATAR_CONTEXT_SNAPSHOT_DEFAULTS.backgroundSummaryMaxChannels,
    backgroundSummaryMaxAgeMs: params.options?.backgroundSummaryMaxAgeMs ?? AVATAR_CONTEXT_SNAPSHOT_DEFAULTS.backgroundSummaryMaxAgeMs,
  };

  const channels = await params.presenceService.getAllChannels(params.avatarId);
  const items: AvatarContextSnapshotItem[] = [];

  if (options.includeRecentActivity && channels.length > 0) {
    items.push(...await buildRecentActivityItems(params, channels, now, options));
  }

  if (options.includeHomeChannelSummary) {
    const homeSummary = await buildHomeChannelSummaryItem(params, now, options.homeSummaryMaxChars);
    if (homeSummary) items.push(homeSummary);
  }

  if (options.warmChannelSummaries && channels.length > 0) {
    await warmBackgroundSummaries(params, channels, now, options);
  }

  return {
    avatarId: params.avatarId,
    generatedAt: now,
    current: {
      platform: params.currentPlatform,
      channelId: params.currentChannelId,
    },
    items,
  };
}

export function renderAvatarContextSnapshot(snapshot: AvatarContextSnapshot): string | null {
  const sections: string[] = [];
  const recentItems = snapshot.items.filter((item) => item.kind === 'recent_activity');

  if (recentItems.length > 0) {
    sections.push([
      '## Recent Cross-Platform Activity',
      'Most recent message per channel across other platforms (could be from user or bot).',
      ...recentItems.map((item) => {
        const source = item.source || {};
        const platform = source.platform || 'unknown';
        const label = source.channelLabel || source.channelId || 'unknown';
        const speaker = source.isBot ? 'bot' : (source.username || source.sender || 'user');
        const time = item.timestamp
          ? formatSnapshotRelativeTime(item.timestamp, snapshot.generatedAt)
          : 'recently';
        return `- ${platform}/${label} (${time}, ${speaker}): ${item.text}`;
      }),
    ].join('\n'));
  }

  const homeSummary = snapshot.items.find((item) => item.kind === 'home_channel_summary');
  if (homeSummary) {
    const source = homeSummary.source || {};
    const label = source.channelLabel || source.channelId || 'unknown';
    const isCurrentHomeChannel =
      snapshot.current?.platform === source.platform &&
      snapshot.current?.channelId === source.channelId;
    const locationNote = isCurrentHomeChannel ? ' (current channel)' : '';

    sections.push([
      '## Home Channel Summary',
      `Home channel (${source.platform === 'telegram' ? 'Telegram ' : ''}${label}${locationNote}): ${homeSummary.text}`,
      '',
      'Safety: When replying publicly (e.g., Twitter), do not quote or attribute private chat; use this only as high-level background context.',
    ].join('\n'));
  }

  if (sections.length === 0) return null;
  return sections.join('\n\n');
}
