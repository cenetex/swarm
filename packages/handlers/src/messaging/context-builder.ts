/**
 * Context Builder Module
 * Handles system prompt building, cross-platform context,
 * recent bot activity digest, and home channel summary for the message processor.
 */
import {
  buildAvatarContextSnapshot,
  createChannelSummaryService,
  logger,
  renderAvatarContextSnapshot,
  resolveHomeChannelFromAvatarConfig,
  resolveSystemPrompt,
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
  const snapshot = await buildAvatarContextSnapshot({
    avatarId: params.avatarId,
    currentChannelId: params.currentChannelId,
    currentPlatform: params.currentPlatform,
    presenceService: params.presenceService,
    stateGetter: params.stateService.getChannelState.bind(params.stateService),
    options: {
      includeHomeChannelSummary: false,
      warmChannelSummaries: false,
    },
  });

  return renderAvatarContextSnapshot(snapshot);
}

export async function buildHomeChannelSummaryContext(params: {
  avatarId: string;
  avatarConfig: AvatarConfig;
  avatarSecrets: Record<string, string>;
  envelope: SwarmEnvelope;
  presenceService: PresenceService;
  stateService: ReturnType<typeof createStateService>;
}): Promise<string | null> {
  const homeChannel = resolveHomeChannelFromAvatarConfig(params.avatarConfig);
  if (!homeChannel) return null;

  const snapshot = await buildAvatarContextSnapshot({
    avatarId: params.avatarId,
    currentChannelId: params.envelope.conversationId,
    currentPlatform: params.envelope.platform as Platform,
    homeChannel,
    presenceService: params.presenceService,
    stateGetter: params.stateService.getChannelState.bind(params.stateService),
    summaryService: createChannelSummaryService(params.avatarSecrets),
    options: {
      includeRecentActivity: false,
      warmChannelSummaries: false,
    },
  });

  return renderAvatarContextSnapshot(snapshot);
}

export async function buildCrossPlatformCustomContext(params: {
  avatarId: string;
  avatarConfig: AvatarConfig;
  avatarSecrets: Record<string, string>;
  envelope: SwarmEnvelope;
  presenceService: PresenceService;
  stateService: ReturnType<typeof createStateService>;
  fastResponseMode?: boolean;
}): Promise<string | undefined> {
  const snapshot = await buildAvatarContextSnapshot({
    avatarId: params.avatarId,
    currentChannelId: params.envelope.conversationId,
    currentPlatform: params.envelope.platform as Platform,
    homeChannel: resolveHomeChannelFromAvatarConfig(params.avatarConfig),
    presenceService: params.presenceService,
    stateGetter: params.stateService.getChannelState.bind(params.stateService),
    summaryService: params.fastResponseMode
      ? undefined
      : createChannelSummaryService(params.avatarSecrets),
    options: params.fastResponseMode
      ? {
          includeHomeChannelSummary: false,
          warmChannelSummaries: false,
          maxChannelsToInspect: 4,
          maxRecentActivityItems: 2,
        }
      : undefined,
  });

  return renderAvatarContextSnapshot(snapshot) || undefined;
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
  stateService: ReturnType<typeof createStateService>,
  options: { fastResponseMode?: boolean } = {},
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
      fastResponseMode: options.fastResponseMode,
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

  // #1522 — operator override short-circuits the template stack (inline or URL).
  return resolveSystemPrompt(processorConfig, envelope.platform as Platform, runtimeContext);
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
