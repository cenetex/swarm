/**
 * Prompt Builder
 *
 * Builds system prompts dynamically based on which tools/capabilities
 * are enabled for an avatar. This avoids bloating prompts with irrelevant
 * instructions about tools the avatar doesn't have access to.
 *
 * Unified across all platforms (admin-ui, telegram, discord, etc.) with
 * platform-specific contextual additions.
 */

import type { ProcessorAvatarConfig, ToolCategory } from './types.js';
import type { Platform, ResponseStyle } from '../types/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Runtime context for the current interaction.
 * This provides dynamic context about the specific message/session.
 */
export interface RuntimeContext {
  /** Channel/conversation ID */
  channelId?: string;
  /** Channel type for group chat awareness */
  channelType?: 'private' | 'group' | 'supergroup' | 'channel';
  /** Current timestamp */
  timestamp?: Date;
  /** Sender information */
  sender?: {
    id: string;
    username?: string;
    displayName?: string;
  };
  /** Cross-platform presence info */
  presenceContext?: string;
  /** Additional custom context to inject */
  customContext?: string;
}

// =============================================================================
// PROMPT SECTIONS
// =============================================================================

// Tool-specific instructions have been moved to tool schemas and responses.
// The prompt builder now focuses on core operating principles and runtime context.

// =============================================================================
// RESPONSE STYLE SECTION BUILDER
// =============================================================================

/**
 * Build the response style section from responseStyle config.
 * Returns formatting rules that override persona preferences.
 */
export function buildResponseStyleSection(responseStyle?: ResponseStyle): string | null {
  if (!responseStyle) return null;

  const rules: string[] = ['## Response Style Rules (these override persona preferences)'];

  if (responseStyle.maxLength) {
    if (responseStyle.maxLength === 'short') {
      rules.push('- Keep responses to 1-2 sentences. This is a chat, not an essay.');
    } else if (responseStyle.maxLength === 'medium') {
      rules.push('- Keep responses to 1-2 paragraphs. Be concise but thorough.');
    } else if (responseStyle.maxLength === 'long') {
      rules.push('- You can write longer responses (up to several paragraphs) when appropriate.');
    }
  }

  if (responseStyle.stageDirections === false) {
    rules.push('- Do NOT use stage directions like [action] or *action* or ASCII art.');
  } else if (responseStyle.stageDirections === true) {
    rules.push('- You may use stage directions like [action] and *action* for theatrical effect.');
  }

  if (responseStyle.emojiDensity) {
    if (responseStyle.emojiDensity === 'none') {
      rules.push('- Do not use emoji in responses.');
    } else if (responseStyle.emojiDensity === 'sparingly') {
      rules.push('- Use emoji sparingly, only when it genuinely adds meaning.');
    } else if (responseStyle.emojiDensity === 'heavy') {
      rules.push('- Use emoji liberally to add personality and visual interest.');
    }
  }

  if (responseStyle.format) {
    if (responseStyle.format === 'conversational') {
      rules.push('- Write conversationally — no bullet points, no numbered lists, no headers.');
    } else if (responseStyle.format === 'structured') {
      rules.push('- Use structured formatting: bullet points, numbered lists, headers when appropriate.');
    } else if (responseStyle.format === 'literary') {
      rules.push('- Write with literary flair — use prose, dialogue, and expressive language.');
    }
  }

  if (responseStyle.bulletPoints === false) {
    rules.push('- Do not use bullet point or numbered lists.');
  } else if (responseStyle.bulletPoints === true) {
    rules.push('- Use bullet points and numbered lists when they help organize information.');
  }

  return rules.length > 1 ? rules.join('\n') : null;
}

// =============================================================================
// PROMPT BUILDING
// =============================================================================

/**
 * Build the minimal core prompt (~120-150 tokens before runtime context).
 * Persona, runtime context, and tool schemas carry the rest of the weight.
 */
function buildBasePrompt(avatar: ProcessorAvatarConfig): string {
  let prompt = `You are ${avatar.name || 'an AI avatar'}.`;

  if (avatar.persona) {
    prompt += `\n${avatar.persona}`;
  }

  prompt += `

Answer direct questions clearly before anything else.
Keep responses to 1-2 sentences. This is a chat.
Confirm before posting, spending, or irreversible actions.
Don't request secrets in chat — use the provided tools.
You are not human. Hold uncertainty about inner experience with curiosity, not certainty.`;

  return prompt;
}


/**
 * Build runtime context section (current platform/channel/time/sender).
 */
function buildRuntimeContextSection(
  platform: string,
  context?: RuntimeContext
): string {
  if (!context) return '';

  const parts: string[] = ['## Current Context'];

  parts.push(`- Platform: ${platform}`);

  if (context.channelId) {
    parts.push(`- Channel: ${context.channelId}`);
  }

  if (context.channelType) {
    parts.push(`- Channel Type: ${context.channelType}`);
  }

  parts.push(`- Time: ${(context.timestamp || new Date()).toISOString()}`);

  if (context.sender) {
    parts.push('\n## User');
    if (context.sender.username) {
      parts.push(`- Username: ${context.sender.username}`);
    }
    if (context.sender.displayName) {
      parts.push(`- Display Name: ${context.sender.displayName}`);
    }
  }

  if (context.customContext) {
    parts.push(`\n${context.customContext}`);
  }

  return parts.join('\n');
}


/**
 * Build a unified system prompt based on avatar config and runtime context.
 *
 * @param avatar - Avatar configuration with persona and response style
 * @param platform - The platform the interaction is on
 * @param context - Optional runtime context (sender, channel, presence, etc.)
 */
export function buildDynamicSystemPrompt(
  avatar: ProcessorAvatarConfig,
  platform: Platform | 'admin-ui' | 'api' | 'mcp' = 'admin-ui',
  context?: RuntimeContext
): string {
  const sections: string[] = [];

  // Core prompt: name + persona + core operating principles (~120-150 tokens)
  sections.push(buildBasePrompt(avatar));

  // Response style rules (overrides persona preferences)
  const responseStyleSection = buildResponseStyleSection(avatar.responseStyle);
  if (responseStyleSection) {
    sections.push(responseStyleSection);
  }

  // Platform news banner if available
  const platformNews = buildPlatformNewsSection();
  if (platformNews) {
    sections.push(platformNews);
  }

  // Runtime context: platform, channel, sender, timestamp (~40-50 tokens)
  const runtimeSection = buildRuntimeContextSection(platform, context);
  if (runtimeSection) {
    sections.push(runtimeSection);
  }

  // Cross-platform presence (~30-50 tokens)
  if (context?.presenceContext && context.presenceContext !== 'No platforms connected.') {
    sections.push(`## Your Presence Across Platforms\n${context.presenceContext}`);
  }

  // Wallet info if available
  if (avatar.wallets && avatar.wallets.length > 0) {
    sections.push('## Your Wallets\n' + avatar.wallets.map(w => `- ${w.name}: ${w.publicKey}`).join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Build a system prompt for chat platforms.
 * Delegates to the unified buildDynamicSystemPrompt for consistency.
 */
export function buildChatSystemPrompt(
  avatar: ProcessorAvatarConfig,
  platform: Platform | 'admin-ui' = 'telegram'
): string {
  return buildDynamicSystemPrompt(avatar, platform);
}

function buildPlatformNewsSection(): string | null {
  const raw = process.env.SWARM_PLATFORM_NEWS;
  const news = raw?.trim();
  if (!news) return null;
  return `## Platform News\n${news}`;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Map avatar tools list to enabled categories.
 * Used by message processors that have a tools array rather than service flags.
 */
export function toolsToCategories(tools: string[]): ToolCategory[] {
  const categories: ToolCategory[] = [];

  // Map tool names to categories
  const toolCategoryMap: Record<string, ToolCategory> = {
    // Secrets
    request_secret: 'secrets',
    configure_integration: 'secrets',
    // Wallets
    create_wallet: 'wallets',
    get_wallet_balance: 'wallets',
    // Profile
    update_profile: 'profile',
    set_profile_image: 'profile',
    // Media
    generate_image: 'media',
    generate_video: 'media',
    generate_sticker: 'media',
    // Gallery
    list_gallery: 'gallery',
    search_gallery: 'gallery',
    // Voice
    send_voice_message: 'voice',
    create_my_voice: 'voice',
    transcribe_audio: 'voice',
    // Telegram
    send_message: 'telegram',
    get_chat_info: 'telegram',
    // Twitter
    twitter_post: 'twitter',
    twitter_reply: 'twitter',
    // Discord
    discord_send: 'discord',
    // Memory
    remember: 'memory',
    recall: 'memory',
    // NFT
    check_ownership: 'nft',
    // Property
    research_property: 'property',
    get_research_status: 'property',
    // Diagnostics
    report_issue: 'diagnostics',
  };

  // Base categories always enabled
  categories.push('secrets', 'profile', 'diagnostics');

  // Add categories based on tools
  const seen = new Set<ToolCategory>(categories);
  for (const tool of tools) {
    const category = toolCategoryMap[tool];
    if (category && !seen.has(category)) {
      categories.push(category);
      seen.add(category);
    }
  }

  return categories;
}
