/**
 * Channel Summary Service
 *
 * Generates LLM-powered summaries of channel activity using a fast model (haiku).
 * Summaries are cached and used for cross-platform presence awareness.
 */
import type { ContextMessage, ChannelState } from '../types/index.js';
import { DEFAULT_MODELS } from './media/types.js';
import type { ChannelInfo, PresenceService } from './presence.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export const SUMMARY_CONFIG = {
  // Model settings
  MODEL: process.env.SUMMARY_MODEL || DEFAULT_MODELS.llm,
  MAX_TOKENS: 100,
  TEMPERATURE: 0.3,

  // Summary generation
  MAX_MESSAGES_FOR_SUMMARY: 20,
  SUMMARY_TTL_MS: 5 * 60 * 1000, // 5 minutes
  MIN_MESSAGES_FOR_SUMMARY: 3,

  // API settings
  TIMEOUT_MS: 10_000,
  OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions',
};

// =============================================================================
// TYPES
// =============================================================================

export interface ChannelSummaryService {
  /**
   * Generate a summary for a channel's recent activity
   */
  generateSummary(
    channelInfo: ChannelInfo,
    messages: ContextMessage[]
  ): Promise<string>;

  /**
   * Get or generate summary for a channel (with caching)
   */
  getOrGenerateSummary(
    avatarId: string,
    channelId: string,
    platform: string,
    presenceService: PresenceService,
    stateGetter: (avatarId: string, channelId: string) => Promise<ChannelState | null>
  ): Promise<string | null>;

  /**
   * Generate a cross-platform activity summary
   */
  generatePresenceSummary(
    channels: Array<ChannelInfo & { recentMessages?: ContextMessage[] }>
  ): Promise<string>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class OpenRouterChannelSummaryService implements ChannelSummaryService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateSummary(
    channelInfo: ChannelInfo,
    messages: ContextMessage[]
  ): Promise<string> {
    if (messages.length < SUMMARY_CONFIG.MIN_MESSAGES_FOR_SUMMARY) {
      return 'Not enough activity to summarize';
    }

    // Take the most recent messages
    const recentMessages = messages.slice(-SUMMARY_CONFIG.MAX_MESSAGES_FOR_SUMMARY);

    // Format messages for the prompt
    const formattedMessages = recentMessages.map(m => {
      const sender = m.username ? `@${m.username}` : m.sender;
      return `${sender}: ${m.content.slice(0, 200)}`;
    }).join('\n');

    const prompt = `Summarize this chat in 1-2 short sentences. Focus on: topic of discussion, mood/tone, and any pending questions or requests.

Channel: ${channelInfo.title || channelInfo.channelId} (${channelInfo.platform}, ${channelInfo.type || 'chat'})
Recent messages:
${formattedMessages}

Summary:`;

    try {
      const response = await this.callLLM(prompt);
      return response.trim();
    } catch (error) {
      console.error('Failed to generate channel summary:', error instanceof Error ? error.message : String(error));
      return 'Summary unavailable';
    }
  }

  async getOrGenerateSummary(
    avatarId: string,
    channelId: string,
    platform: string,
    presenceService: PresenceService,
    stateGetter: (avatarId: string, channelId: string) => Promise<ChannelState | null>
  ): Promise<string | null> {
    // Get current channel info
    const channelDetail = await presenceService.getChannelWithSummary(
      avatarId,
      channelId,
      platform as 'telegram' | 'discord' | 'twitter' | 'web'
    );

    if (!channelDetail) {
      return null;
    }

    // Check if we have a recent summary
    const now = Date.now();
    if (
      channelDetail.summary &&
      channelDetail.summaryUpdatedAt &&
      now - channelDetail.summaryUpdatedAt < SUMMARY_CONFIG.SUMMARY_TTL_MS
    ) {
      return channelDetail.summary;
    }

    // Get channel state for messages
    const state = await stateGetter(avatarId, channelId);
    if (!state || state.recentMessages.length < SUMMARY_CONFIG.MIN_MESSAGES_FOR_SUMMARY) {
      return channelDetail.summary || null;
    }

    // Generate new summary
    const summary = await this.generateSummary(channelDetail, state.recentMessages);

    // Cache the summary
    await presenceService.updateChannelSummary(
      avatarId,
      channelId,
      platform as 'telegram' | 'discord' | 'twitter' | 'web',
      summary
    );

    return summary;
  }

  async generatePresenceSummary(
    channels: Array<ChannelInfo & { recentMessages?: ContextMessage[] }>
  ): Promise<string> {
    if (channels.length === 0) {
      return 'No active channels';
    }

    // Build a compact representation of all channels
    const channelSummaries = channels
      .filter(c => c.recentMessages && c.recentMessages.length > 0)
      .slice(0, 10) // Limit to 10 most relevant channels
      .map(c => {
        const lastMsg = c.recentMessages?.[c.recentMessages.length - 1];
        const preview = lastMsg ? lastMsg.content.slice(0, 100) : '';
        return `${c.platform}/${c.title || c.channelId}: ${c.summary || preview}`;
      })
      .join('\n');

    if (!channelSummaries) {
      return 'No recent activity across channels';
    }

    const prompt = `Generate a brief cross-platform activity overview (2-3 sentences) based on these channel summaries:

${channelSummaries}

Overview:`;

    try {
      const response = await this.callLLM(prompt);
      return response.trim();
    } catch (error) {
      console.error('Failed to generate presence summary:', error instanceof Error ? error.message : String(error));
      return 'Unable to generate cross-platform summary';
    }
  }

  private async callLLM(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SUMMARY_CONFIG.TIMEOUT_MS);

    try {
      const response = await fetch(SUMMARY_CONFIG.OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://swarm.platform',
          'X-Title': 'Swarm Channel Summary',
        },
        body: JSON.stringify({
          model: SUMMARY_CONFIG.MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: SUMMARY_CONFIG.TEMPERATURE,
          max_tokens: SUMMARY_CONFIG.MAX_TOKENS,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      return data.choices?.[0]?.message?.content || '';
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Simple fallback summary service that doesn't use LLM
 * Used when API key is not available
 */
export class SimpleChannelSummaryService implements ChannelSummaryService {
  async generateSummary(
    _channelInfo: ChannelInfo,
    messages: ContextMessage[]
  ): Promise<string> {
    if (messages.length === 0) {
      return 'No recent activity';
    }

    const uniqueSenders = new Set(messages.map(m => m.sender)).size;
    const lastMessage = messages[messages.length - 1];
    const lastSender = lastMessage.username ? `@${lastMessage.username}` : lastMessage.sender;

    return `${messages.length} messages from ${uniqueSenders} participant(s). Last: ${lastSender}`;
  }

  async getOrGenerateSummary(
    avatarId: string,
    channelId: string,
    platform: string,
    _presenceService: PresenceService,
    stateGetter: (avatarId: string, channelId: string) => Promise<ChannelState | null>
  ): Promise<string | null> {
    const state = await stateGetter(avatarId, channelId);
    if (!state) return null;

    const channelInfo: ChannelInfo = {
      channelId,
      platform: platform as 'telegram' | 'discord' | 'twitter' | 'web',
      title: state.chatTitle,
      type: state.chatType,
      lastActivityAt: state.lastActivityAt,
    };

    return this.generateSummary(channelInfo, state.recentMessages);
  }

  async generatePresenceSummary(
    channels: Array<ChannelInfo & { recentMessages?: ContextMessage[] }>
  ): Promise<string> {
    const activeChannels = channels.filter(c => c.recentMessages && c.recentMessages.length > 0);

    if (activeChannels.length === 0) {
      return 'No active channels';
    }

    const byPlatform = new Map<string, number>();
    for (const ch of activeChannels) {
      byPlatform.set(ch.platform, (byPlatform.get(ch.platform) || 0) + 1);
    }

    const platformSummary = Array.from(byPlatform.entries())
      .map(([platform, count]) => `${platform}: ${count}`)
      .join(', ');

    return `Active on ${activeChannels.length} channel(s) (${platformSummary})`;
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createChannelSummaryService(
  secrets: Record<string, string>
): ChannelSummaryService {
  const apiKey = secrets['OPENROUTER_API_KEY'] || secrets['openrouter_api_key'];

  if (apiKey) {
    return new OpenRouterChannelSummaryService(apiKey);
  }

  // Fallback to simple service if no API key
  console.warn('No OPENROUTER_API_KEY found, using simple channel summary service');
  return new SimpleChannelSummaryService();
}
