/**
 * Context Builder Module
 * Handles system prompt building, cross-platform context,
 * recent bot activity digest, and home channel summary for the message processor.
 */
import {
  createChannelSummaryService,
  logger,
  buildDynamicSystemPrompt,
  toolsToCategories,
  type BrainMemoryFact,
  type ProcessorAvatarConfig,
  type RuntimeContext,
  type AvatarConfig,
  type SwarmEnvelope,
  type PresenceService,
  type Platform,
} from '@swarm/core';
import type { createStateService } from '@swarm/core';

export function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export async function buildRecentBotActivityDigest(params: {
  avatarId: string;
  currentChannelId?: string;
  currentPlatform?: Platform;
  presenceService: PresenceService;
  stateService: ReturnType<typeof createStateService>;
}): Promise<string | null> {
  const now = Date.now();

  const channels = await params.presenceService.getAllChannels(params.avatarId);
  if (channels.length === 0) return null;

  const sorted = channels
    .slice()
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
    .slice(0, 8);

  const lines: string[] = [];
  for (const ch of sorted) {
    if (
      params.currentChannelId &&
      params.currentPlatform &&
      ch.channelId === params.currentChannelId &&
      ch.platform === params.currentPlatform
    ) {
      continue;
    }

    const state = await params.stateService.getChannelState(params.avatarId, ch.channelId);
    const recent = state?.recentMessages || [];
    if (recent.length === 0) continue;

    // Find the most recent message (bot or user) within 6h to capture conversation context.
    const lastMsg = [...recent].reverse().find((m) => Boolean(m.content));
    if (!lastMsg) continue;
    if (now - lastMsg.timestamp > 6 * 60 * 60_000) continue;

    const channelLabel = ch.title || ch.channelId;
    const speaker = lastMsg.isBot ? 'bot' : (lastMsg.username || lastMsg.sender || 'user');
    lines.push(
      `- ${ch.platform}/${channelLabel} (${formatRelativeTime(lastMsg.timestamp, now)}, ${speaker}): ${truncateForPrompt(lastMsg.content.replace(/\s+/g, ' ').trim(), 140)}`
    );
    if (lines.length >= 4) break;
  }

  if (lines.length === 0) return null;
  return [
    '## Recent Cross-Platform Activity',
    'Most recent message per channel across other platforms (could be from user or bot).',
    ...lines,
  ].join('\n');
}

export async function buildHomeChannelSummaryContext(params: {
  avatarId: string;
  avatarConfig: AvatarConfig;
  avatarSecrets: Record<string, string>;
  envelope: SwarmEnvelope;
  presenceService: PresenceService;
  stateService: ReturnType<typeof createStateService>;
}): Promise<string | null> {
  const telegramCfg = params.avatarConfig.platforms?.telegram;
  const homeChannelId = telegramCfg?.homeChannelId;
  if (!homeChannelId) return null;

  const summaryService = createChannelSummaryService(params.avatarSecrets);

  let summary: string | null = null;
  try {
    summary = await summaryService.getOrGenerateSummary(
      params.avatarId,
      homeChannelId,
      'telegram',
      params.presenceService,
      params.stateService.getChannelState.bind(params.stateService)
    );
  } catch (err) {
    logger.warn('Failed to get/generate home channel summary', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!summary) return null;

  const channelDetail = await params.presenceService.getChannelWithSummary(params.avatarId, homeChannelId, 'telegram');
  const homeLabel = channelDetail?.title
    || (telegramCfg?.homeChannelUsername ? `@${telegramCfg.homeChannelUsername}` : undefined)
    || homeChannelId;

  const isInHomeChannel = params.envelope.platform === 'telegram' && params.envelope.conversationId === homeChannelId;
  const locationNote = isInHomeChannel ? ' (current channel)' : '';

  return [
    '## Home Channel Summary',
    `Home channel (Telegram ${homeLabel}${locationNote}): ${truncateForPrompt(summary, 220)}`,
    '',
    'Safety: When replying publicly (e.g., Twitter), do not quote or attribute private chat; use this only as high-level background context.',
  ].join('\n');
}

export async function buildCrossPlatformCustomContext(params: {
  avatarId: string;
  avatarConfig: AvatarConfig;
  avatarSecrets: Record<string, string>;
  envelope: SwarmEnvelope;
  presenceService: PresenceService;
  stateService: ReturnType<typeof createStateService>;
}): Promise<string | undefined> {
  const parts: string[] = [];

  try {
    const digest = await buildRecentBotActivityDigest({
      avatarId: params.avatarId,
      currentChannelId: params.envelope.conversationId,
      currentPlatform: params.envelope.platform as Platform,
      presenceService: params.presenceService,
      stateService: params.stateService,
    });
    if (digest) parts.push(digest);
  } catch (err) {
    logger.warn('Failed to build recent bot activity digest', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const homeSummary = await buildHomeChannelSummaryContext(params);
    if (homeSummary) parts.push(homeSummary);
  } catch (err) {
    logger.warn('Failed to build home channel context', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Generate summaries for the top 3 recently-active non-current, non-home channels
  // so the presence context has actual content, not just "Last active Xm ago".
  try {
    const homeChannelId = params.avatarConfig.platforms?.telegram?.homeChannelId;
    const allChannels = await params.presenceService.getAllChannels(params.avatarId);
    const summaryService = createChannelSummaryService(params.avatarSecrets);

    const candidates = allChannels
      .filter((ch) => {
        if (ch.channelId === params.envelope.conversationId && ch.platform === params.envelope.platform) return false;
        if (homeChannelId && ch.channelId === homeChannelId && ch.platform === 'telegram') return false;
        return (ch.lastActivityAt || 0) > Date.now() - 24 * 60 * 60_000;
      })
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
      .slice(0, 3);

    await Promise.all(
      candidates.map(async (ch) => {
        try {
          await summaryService.getOrGenerateSummary(
            params.avatarId,
            ch.channelId,
            ch.platform,
            params.presenceService,
            params.stateService.getChannelState.bind(params.stateService)
          );
        } catch (err) {
          logger.warn('Failed to generate summary for channel', {
            channelId: ch.channelId,
            platform: ch.platform,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  } catch (err) {
    logger.warn('Failed to generate cross-platform channel summaries', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

/**
 * Build system prompt using unified prompt builder
 */
export async function buildSystemPrompt(
  envelope: SwarmEnvelope,
  avatarConfig: AvatarConfig,
  avatarId: string,
  avatarSecrets: Record<string, string>,
  presenceService: PresenceService,
  stateService: ReturnType<typeof createStateService>
): Promise<string> {
  // Detect channel type for Telegram
  let channelType: 'private' | 'group' | 'supergroup' | 'channel' | undefined;
  if (envelope.platform === 'telegram') {
    // Telegram channel IDs: negative = group/supergroup, positive = private
    const channelId = envelope.conversationId;
    if (channelId.startsWith('-100')) {
      channelType = 'supergroup';
    } else if (channelId.startsWith('-')) {
      channelType = 'group';
    } else {
      channelType = 'private';
    }
  }

  // Get presence context
  let presenceContext: string | undefined;
  try {
    const ctx = await presenceService.buildPresenceContext(avatarId);
    if (ctx && ctx !== 'No platforms connected.') {
      presenceContext = ctx;
    }
  } catch (err) {
    logger.warn('Failed to build presence context', { error: err instanceof Error ? err.message : String(err) });
  }

  // Add cross-platform context (safe digest + home channel summary)
  let customContext: string | undefined;
  try {
    customContext = await buildCrossPlatformCustomContext({
      avatarId,
      avatarConfig,
      avatarSecrets,
      envelope,
      presenceService,
      stateService,
    });
  } catch (err) {
    logger.warn('Failed to build custom cross-platform context', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Build avatar config for prompt builder
  const enabledCategories = toolsToCategories(avatarConfig.tools || []);

  // Add voice category if enabled
  if (avatarConfig.voice?.enabled && !enabledCategories.includes('voice')) {
    enabledCategories.push('voice');
  }

  const processorConfig: ProcessorAvatarConfig = {
    avatarId,
    name: avatarConfig.name,
    // AvatarConfig uses 'persona' for description
    persona: avatarConfig.persona,
    enabledCategories,
  };

  // Build runtime context
  const runtimeContext: RuntimeContext = {
    channelId: envelope.conversationId,
    channelType,
    timestamp: new Date(),
    sender: {
      id: envelope.sender.id,
      username: envelope.sender.username,
      displayName: envelope.sender.displayName,
    },
    presenceContext,
    customContext,
  };

  return buildDynamicSystemPrompt(processorConfig, envelope.platform as Platform, runtimeContext);
}

/**
 * Format brain memory facts as a markdown section for system prompt injection.
 */
export function formatBrainMemoryContext(facts: BrainMemoryFact[], maxChars = 1600): string {
  if (facts.length === 0) return '';

  const lines: string[] = ['## Relevant Memories'];
  for (const f of facts) {
    const aboutStr = f.about ? ` (about ${f.about})` : '';
    lines.push(`- ${f.fact}${aboutStr}`);
  }

  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}
