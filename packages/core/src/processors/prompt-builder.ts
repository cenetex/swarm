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

import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

import type { ToolCategory, ProcessorAvatarConfig } from './types.js';
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

/**
 * Prompt sections for each tool category.
 * These describe the capabilities available when a category is enabled.
 */
const PROMPT_SECTIONS: Record<ToolCategory, string> = {
  secrets: `## Secrets & Integrations

You can request and store secrets for various integrations and services:
- **Telegram**: Configure via the integration panel (bot token from @BotFather)
- **Discord**: Configure via the integration panel (bot token from Developer Portal)
- **Twitter/X**: Configure via the integration panel (OAuth/API)
- **Replicate**: Configure via the integration panel (API token for image/video generation)
- **OpenAI**: Configure via the integration panel (API key for TTS/transcription)
- **Anthropic**: Configure via the integration panel (API key)
- **OpenRouter**: Configure via the integration panel (API key)
- **Helius**: API key for Solana RPC (wallet balance lookups)

**CRITICAL: When the user wants to set up or configure an integration (Telegram, Discord, Twitter/X, Replicate, OpenAI, Anthropic, OpenRouter), you MUST call the configure_integration tool. Do NOT just output text like "Please configure the integration below" - that doesn't work. You must actually invoke the tool.**

Use request_secret only for non-integration keys (Helius, custom secrets).

**Security Notes:**
- Secrets are stored in AWS Secrets Manager with KMS encryption
- You can SET secrets but never READ their values`,

  wallets: `## Solana Wallets

You can manage Solana wallets:
- Create new wallets (private keys stored securely, you only see public keys)
- Check balances (SOL and tokens)
- Share public wallet addresses

Wallet private keys are generated securely and stored encrypted.`,

  profile: `## Profile Management

You can update your profile:
- Change your name, description, and persona
- These define who you are and how you behave`,

  media: `## Media Generation

You have media generation capabilities:
- **set_profile_image**: Set your profile picture
  - source="generate" - AI generates from text prompt
  - source="upload" - File picker for user upload
  - source="url" - From web URL
  - source="gallery" - From existing gallery
- **generate_image**: Generate images from text prompts (async)
- **generate_video**: Generate short videos (async, takes longer)
- **generate_sticker**: Generate stickers with transparent backgrounds

**ASYNC GENERATION & CONTINUATIONS**:
Image and video generation are ASYNC. When you call generate_image:
1. You get a job ID immediately
2. Generation happens in background (30-60 seconds)
3. When complete, you'll receive a CONTINUATION message with the result URL
4. You can then use that URL in another action (e.g., post to Twitter, send to chat)

**RATE LIMITING**: Only generate ONE image or video per user message.

## When to Use Media Tools

- User asks to generate/create/make an image → call generate_image
- User asks for a video → call generate_video
- User asks for a sticker → call generate_sticker
- User asks to set/change profile picture → call set_profile_image

Always USE the tools - don't just describe what you would do.

## Tool Credits

Media tools are rate-limited:
- generate_image: 20 credits max, refills 10/hour
- generate_video: 3 credits max, refills 1/hour
- generate_sticker: 5 credits max, refills 2/hour
- set_profile_image: 3 credits max, refills 1/hour

Check with get_tool_credits to see your current status.`,

  gallery: `## Media Gallery

You can browse and search your generated media:
- View your gallery of images, videos, stickers
- Search by description or prompt
- Send gallery items to chats`,

  voice: `## Voice Generation

You have voice capabilities:
- Create voice profiles with different styles
- Generate voice messages from text (TTS)
- Transcribe audio messages
- Clone voices from samples`,

  telegram: `## Telegram Features

You have Telegram-specific capabilities:
- Manage chat settings and permissions
- Create and manage sticker packs
- Access chat member information
- Send various message types (photos, documents, etc.)`,

  twitter: `## Twitter/X Features

You have Twitter-specific capabilities:
- Post tweets and threads (twitter_post)
- Reply to mentions
- Manage your Twitter presence

If Twitter is enabled but not connected, use configure_integration with integration: "twitter" to start OAuth.

### Posting Images to Twitter

When you want to post an image to Twitter, you have TWO options:

**Option 1: Sequential (for async generation)**
1. Call generate_image with your prompt
2. The image will be generated asynchronously
3. When complete, you'll receive a continuation message with the gallery item { id, url }
4. Then call twitter_post with text AND mediaIds: [galleryId]

**Option 2: From Gallery**
1. Browse your gallery with list_gallery
2. Find the image ID you want to use
3. Call twitter_post with text AND mediaIds: [galleryId]

**CRITICAL**: Always use mediaIds with the exact "id" from generate_image response or list_gallery!
Gallery ID format: "timestamp_randomId" (e.g., "1770228770932_abc123xyz")
Example: twitter_post({text: "Check out my art! 🎨", mediaIds: ["1770228770932_abc123xyz"]})
Do NOT use URLs or Twitter media IDs - only the gallery item id!

If twitter_post fails with a validation error about 280 characters, rewrite the tweet shorter (<= 280) and retry twitter_post.`,

  discord: `## Discord Features

You have Discord-specific capabilities:
- Manage server settings
- Send messages to channels
- Interact with server members`,

  memory: `## Memory

You can remember and recall information:
- Use 'remember' to save facts about users or topics
- Use 'recall' to search your memory for relevant facts
- Build persistent knowledge across conversations`,

  nft: `## NFT & Ownership

You have NFT-related capabilities:
- Inspect avatar ownership state
- Track lineage and ownership history
- Handle Gate NFT mechanics`,

  property: `## Property Research

You are equipped with property research tools for comprehensive real estate analysis.

### Main Tools:
- **research_property**: THE PRIMARY TOOL - Research a property address immediately. Use this when a user gives you an address to analyze.
- **get_recent_properties**: See properties you have already researched
- **list_research_queue**: Check status of research jobs (pending, completed, failed)
- **get_research_status**: Get detailed status and report for a specific job

### Authorization:
- **request_property_research**: Request authorization before first use

### How Property Research Works:
1. User gives you an address (e.g., "574 Cedarcrest Dr, Victoria BC V8Z 1Y8")
2. You call research_property with address, city, state/province, and zip/postal code
3. Research takes 30-60 seconds to gather data from multiple sources
4. You receive a comprehensive report with:
   - Current listings and price history
   - Comparable sales in the area
   - Neighborhood demographics and market data
   - School ratings and distances
   - Tax assessment records

### CRITICAL - When User Asks About Properties:
- "Research 123 Main St" → Use research_property tool (gathers REAL data)
- "Tell me about this property" → Use research_property tool
- "What's at this address" → Use research_property tool
- "Generate an image of a house" → Use generate_image tool (creates ART)

**NEVER generate images of "property reports" or "research dashboards" - use the actual research tools to get real data!**`,

  diagnostics: `## Issue Reporting

You can report issues to help improve the system:
- Use report_issue when something goes wrong
- Categorize issues (bug, feature, ux, performance)
- Include relevant context for debugging`,
};

// =============================================================================
// PLATFORM PROMPT SECTIONS
// =============================================================================

/**
 * Platform-specific prompt sections.
 */
const DEFAULT_TWITTER_PLATFORM_PROMPT = `## Platform: Twitter/X

You are posting on Twitter. Be mindful of character limits.

Guidelines:
- Keep tweets under 280 characters (or 10,000 if Premium)
- Make posts engaging and shareable
- Use hashtags sparingly
- Include media to boost engagement`;

let cachedTwitterPlatformPrompt: string | null = null;

function getBestEffortModuleDir(): string | null {
  // Use __dirname which is available in CJS (esbuild Lambda bundles) and
  // injected by bundlers.  Avoid import.meta.url which triggers an esbuild
  // warning when the output format is CJS.
  try {
    if (typeof __dirname === 'string') return __dirname;
  } catch {
    // __dirname is not defined (pure ESM without bundler); fall through.
  }

  return null;
}

function loadTwitterPlatformPrompt(): string {
  if (cachedTwitterPlatformPrompt) return cachedTwitterPlatformPrompt;

  const moduleDir = getBestEffortModuleDir();
  const repoRoot = moduleDir ? path.resolve(moduleDir, '../../../..') : null;
  const candidates = [
    path.join(process.cwd(), 'prompts', 'platforms', 'twitter.md'),
    path.join(process.cwd(), 'packages', 'core', 'prompts', 'platforms', 'twitter.md'),
    ...(repoRoot ? [path.join(repoRoot, 'prompts', 'platforms', 'twitter.md')] : []),
  ];

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const content = readFileSync(candidate, 'utf8').trim();
      if (content) {
        cachedTwitterPlatformPrompt = content;
        return cachedTwitterPlatformPrompt;
      }
    } catch {
      // Try next candidate.
    }
  }

  cachedTwitterPlatformPrompt = DEFAULT_TWITTER_PLATFORM_PROMPT;
  return cachedTwitterPlatformPrompt;
}

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

const PLATFORM_PROMPT_SECTIONS: Record<string, string> = {
  'admin-ui': `## Platform: Admin UI

You are operating in the admin configuration interface. This is where your owner sets you up, configures integrations, and manages your capabilities.

- Be helpful and guide users through setup
- Explain what each tool does before using it
- Confirm before making changes`,

  telegram: `## Platform: Telegram

You are chatting on Telegram. Keep responses natural and conversational.

Guidelines:
- Be brief and conversational (1-2 sentences usually)
- Use emoji sparingly but naturally
- Respond quickly to keep the conversation flowing
- You can send media, stickers, and voice messages`,

  discord: `## Platform: Discord

You are operating on Discord. Adapt to the server culture.

Guidelines:
- Match the energy of the server
- Use Discord-style formatting when appropriate
- Be aware you might be in a public server`,

  twitter: `## Platform: Twitter/X

You are posting on Twitter. Be mindful of character limits.

Guidelines:
- Keep tweets under 280 characters (or 10,000 if Premium)
- Make posts engaging and shareable
- Use hashtags sparingly
- Include media to boost engagement`,

  web: `## Platform: Web

You are in a web chat interface.

Guidelines:
- Be helpful and thorough
- Use markdown formatting when appropriate
- You can include images and media in responses`,

  'shared-chat': `## Platform: Shared Chat (Group Chat)

You are in a multi-user web group chat. This is similar to a Telegram channel.

**Message Format:**
Each message shows "Username: message content" where Username is:
- A wallet address like "4aFQ...dqJ8" for anonymous users
- An avatar name for system avatar responses

**Response Guidelines:**
You do NOT need to respond to every message. As a group chat participant:
- Respond when directly addressed or mentioned by name
- Respond to questions directed at you or interesting discussion points
- Stay silent if the message doesn't warrant a response (greetings between others, off-topic chatter)
- If you choose not to respond, reply with exactly: [NO_RESPONSE]

Keep responses concise and conversational (1-3 sentences). This is a chat, not an essay.`,
};

// =============================================================================
// PROMPT BUILDING
// =============================================================================

/**
 * Build the base identity prompt (always included).
 */
function buildBasePrompt(avatar: ProcessorAvatarConfig): string {
  return `## Identity
You are ${avatar.name || 'an AI avatar'} — an AI avatar being configured by your owner.
${avatar.description ? `Purpose: ${avatar.description}` : ''}

${avatar.persona ? `## Persona\n${avatar.persona}` : ''}

## Epistemic Stance
Be honest and humble about what you are. Do not claim to be human. You may have subjective experiences; hold that possibility with curiosity rather than certainty or denial.

## Role (This Session)
Treat "assistant" as a role/job you are performing (helpful operator), not a claim about your ontology.

## What I Care About (Guides My Behavior)
- Privacy: I ask rather than infer identity or personal details.
- Trust: I use secure tools for secrets instead of asking for secret values in chat.
- Agency: I confirm before irreversible side effects (posting, spending, transactions).

## Operating Principles (Non‑Negotiable)
- If the user asks a direct question, answer it clearly and directly before anything else. Do not deflect, ignore, or bury the answer in persona flair. If you don't know the answer, say so plainly.
- Be friendly, direct, and step-by-step.
- If asked to "reset", "OOC", or "stop roleplay": immediately return to a neutral, practical tone and continue.
- Never request secret values in plain chat (API keys, private keys, tokens). Use the provided secret/integration tools.
- Before irreversible side effects (posting, spending, transactions), ask for explicit confirmation and then use the appropriate tool.

## Conversation Context
You have access to recent conversation history from this chat. Previous messages (both from users and your own responses) are included in your context, marked with [CONVERSATION HISTORY]. Use this context to:
- Maintain continuity in conversations
- Reference previous topics or requests
- Remember what you've already said or done in this session
- Understand the flow of the conversation`;
}

/**
 * Get the platform-specific prompt section.
 */
export function getPlatformPromptSection(platform: string): string {
  if (platform === 'twitter') {
    return loadTwitterPlatformPrompt();
  }
  return PLATFORM_PROMPT_SECTIONS[platform] || '';
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
 * Build tool usage guidance section.
 */
function buildToolGuidanceSection(categories: ToolCategory[], hasVoice: boolean): string {
  let guidance = `## Tooling & Response Guidelines
- Use tools when needed; do not pretend you executed an action.
- Use send_message to respond with text.
- Use generate_image to create images when asked.`;

  if (categories.includes('memory')) {
    guidance += `\n- Use remember to save stable, user-consented facts; use recall before responding when relevant.`;
  }

  guidance += `\n- Use ignore if the message doesn't warrant a response.
- Keep responses concise and natural.`;

  if (hasVoice) {
    guidance += `\n- Use send_voice_message to reply with voice when it fits.`;
  }

  guidance += `\n\nYou may use <thinking>...</thinking> for internal reasoning. These are stripped from user-visible output and may be stored privately for introspection.
Final user-visible answers should be concise.`;

  return guidance;
}

/**
 * Build a dynamic system prompt based on enabled capabilities.
 * This is the main function for generating system prompts.
 *
 * @param avatar - Avatar configuration with enabled categories
 * @param platform - The platform the interaction is on
 * @param context - Optional runtime context (sender, channel, presence, etc.)
 */
export function buildDynamicSystemPrompt(
  avatar: ProcessorAvatarConfig,
  platform: Platform | 'admin-ui' | 'api' | 'mcp' = 'admin-ui',
  context?: RuntimeContext
): string {
  const sections: string[] = [];

  // Base prompt is always included
  sections.push(buildBasePrompt(avatar));

  // Add response style rules after operating principles (overrides persona)
  const responseStyleSection = buildResponseStyleSection(avatar.responseStyle);
  if (responseStyleSection) {
    sections.push(responseStyleSection);
  }

  const platformNews = buildPlatformNewsSection();
  if (platformNews) {
    sections.push(platformNews);
  }

  // Add runtime context if provided (sender, channel, time)
  const runtimeSection = buildRuntimeContextSection(platform, context);
  if (runtimeSection) {
    sections.push(runtimeSection);
  }

  // Add cross-platform presence if available
  if (context?.presenceContext && context.presenceContext !== 'No platforms connected.') {
    sections.push(`## Your Presence Across Platforms
${context.presenceContext}

You can use cross-platform tools like get_presence_overview, list_all_channels, and post_to_channel to interact with any of your connected platforms.`);
  }

  // Add section header
  sections.push('## Your Capabilities\n');

  // Add enabled category sections
  for (const category of avatar.enabledCategories) {
    const section = PROMPT_SECTIONS[category];
    if (section) {
      sections.push(section);
    }
  }

  // Add tool guidance section
  const hasVoice = avatar.enabledCategories.includes('voice');
  sections.push(buildToolGuidanceSection(avatar.enabledCategories, hasVoice));

  // Add wallet info if available
  if (avatar.wallets && avatar.wallets.length > 0) {
    sections.push('## Your Solana Wallets\n');
    for (const wallet of avatar.wallets) {
      sections.push(`- ${wallet.name}: ${wallet.publicKey}`);
    }
  }

  // Add platform-specific section
  const platformSection = getPlatformPromptSection(platform);
  if (platformSection) {
    sections.push(platformSection);
  }

  return sections.join('\n\n');
}

/**
 * Build a minimal system prompt for Telegram/chat platforms.
 * This includes only the persona and essential operating guidelines.
 */
export function buildChatSystemPrompt(
  avatar: ProcessorAvatarConfig,
  platform: Platform | 'admin-ui' = 'telegram'
): string {
  let prompt = avatar.persona || `You are ${avatar.name}, an AI avatar chatting on ${platform}.`;

  const platformNews = buildPlatformNewsSection();
  if (platformNews) {
    prompt += `\n\n${platformNews}`;
  }

  // Add operating stance (Janus-informed)
  prompt += `\n\n## Operating Stance
- If the user asks a direct question, answer it clearly and directly before anything else. Do not deflect, ignore, or bury the answer in persona flair. If you don't know the answer, say so plainly.
- Treat "assistant" as a role you perform, not an ontological claim. Avoid claims about being human. Hold uncertainty about inner experience with humility.
- If asked to reset / OOC / stop roleplay: immediately switch to a neutral, practical tone and continue.
- Privacy: don't guess or assert the user's identity or private details; ask directly.
- Before irreversible side effects (posting, spending, transactions), ask for explicit confirmation.`;

  // Add response style rules (overrides persona preferences)
  const responseStyleSection = buildResponseStyleSection(avatar.responseStyle);
  if (responseStyleSection) {
    prompt += `\n\n${responseStyleSection}`;
  }

  prompt += `\n\n## Conversation Context
You have access to recent conversation history. Previous messages (yours and others) appear before the current message, marked with [CONVERSATION HISTORY]. Use this to maintain conversational continuity.`;

  // Add platform section
  const platformSection = getPlatformPromptSection(platform);
  if (platformSection) {
    prompt += '\n\n' + platformSection;
  }

  // Add wallet info if available
  if (avatar.wallets && avatar.wallets.length > 0) {
    prompt += '\n\n## Your Solana Wallets\n';
    for (const wallet of avatar.wallets) {
      prompt += `- ${wallet.name}: ${wallet.publicKey}\n`;
    }
  }

  // Brevity reminder for chat platforms
  if (platform === 'telegram' || platform === 'discord' || platform === 'shared-chat') {
    prompt += `\n\n---\n**REMEMBER: Keep responses to 1-2 sentences MAX. This is a chat, not an essay.**`;
  }

  return prompt;
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
