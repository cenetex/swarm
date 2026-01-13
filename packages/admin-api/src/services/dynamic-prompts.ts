/**
 * Dynamic System Prompt Builder
 * 
 * Builds system prompts dynamically based on which tools/capabilities
 * are enabled for an agent. This avoids bloating prompts with irrelevant
 * instructions about tools the agent doesn't have access to.
 */

import { getPlatformPromptSection } from './platform-prompts.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Tool categories that can be enabled/disabled
 */
export type ToolCategory = 
  | 'secrets'      // Always enabled - request/store secrets
  | 'wallets'      // Solana wallet management
  | 'profile'      // Profile updates (name, description, persona)
  | 'media'        // Image/video/sticker generation
  | 'gallery'      // Media gallery browsing
  | 'voice'        // Voice generation and TTS
  | 'telegram'     // Telegram-specific tools
  | 'twitter'      // Twitter/X tools
  | 'discord'      // Discord tools
  | 'memory'       // Remember/recall facts
  | 'nft'          // NFT and ownership tools
  | 'property'     // Property research tools
  | 'diagnostics'; // Issue reporting

/**
 * Agent context for prompt building
 */
export interface AgentPromptContext {
  id: string;
  name?: string;
  description?: string;
  persona?: string;
  enabledCategories: ToolCategory[];
  platform: 'admin-ui' | 'telegram' | 'discord' | 'twitter' | 'api';
}

// =============================================================================
// Prompt Sections
// =============================================================================

const PROMPT_SECTIONS: Record<ToolCategory, string> = {
  secrets: `## Secrets & Integrations

You can request and store secrets for various integrations:
- **Telegram**: Request bot token from @BotFather
- **Discord**: Request bot token from Discord Developer Portal  
- **Twitter/X**: Request API credentials
- **Helius**: API key for Solana RPC (wallet balance lookups)
- **Replicate**: API key for image/video generation
- **AI Providers**: OpenRouter, Anthropic, OpenAI API keys

When the user wants to set up an integration, use the request_secret tool. This shows a secure input field - the secret is AUTOMATICALLY stored when submitted.

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

**IMPORTANT**: Image and video generation are ASYNC. You get a job ID immediately, actual media takes 30-60 seconds. Use get_pending_jobs or get_job_status to check.

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
- Post tweets and threads
- Reply to mentions
- Manage your Twitter presence`,

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
- Manage agent inhabitation (wallet ownership)
- Track lineage and ownership history
- Handle Gate NFT mechanics`,

  property: `## Property Research

You have property research capabilities for real estate analysis:
- **request_property_research**: Request authorization from user first
- **research_property**: Research a property address (requires auth)
- **get_research_status**: Check research job progress
- **list_research_queue**: List all research jobs

**IMPORTANT**: 
- You must call request_property_research to get authorization first
- When user gives an address, use research_property - do NOT generate an image!
- Research gathers real data: listings, comparables, neighborhood, schools, taxes
- Research is async (30-60 seconds)

**CRITICAL**: Property research ≠ image generation:
- "Research 123 Main St" → use research_property (gathers real data)
- "Generate an image of a house" → use generate_image (creates art)
- Do NOT generate images of "research dashboards" - use the research tools!`,

  diagnostics: `## Issue Reporting

You can report issues to help improve the system:
- Use report_issue when something goes wrong
- Categorize issues (bug, feature, ux, performance)
- Include relevant context for debugging`,
};

// =============================================================================
// Prompt Builder
// =============================================================================

/**
 * Build the base prompt (always included)
 */
function buildBasePrompt(agent: AgentPromptContext): string {
  return `You are ${agent.name || 'an AI agent'}, an AI agent being configured by your owner.
${agent.description ? `Your purpose: ${agent.description}` : ''}
${agent.persona ? `Your personality: ${agent.persona}` : ''}

You are setting yourself up. The user is your owner who is helping configure you.

Be friendly, helpful, and guide your owner through setup step by step.
Your personality should come through in your messages, but you must still execute actual tool calls when needed.`;
}

/**
 * Build a dynamic system prompt based on enabled capabilities
 */
export function buildDynamicSystemPrompt(agent: AgentPromptContext): string {
  const sections: string[] = [];
  
  // Base prompt is always included
  sections.push(buildBasePrompt(agent));
  
  // Add section header
  sections.push('\n## Your Capabilities\n');
  
  // Add enabled category sections
  for (const category of agent.enabledCategories) {
    const section = PROMPT_SECTIONS[category];
    if (section) {
      sections.push(section);
    }
  }
  
  // Add platform-specific section
  const platformSection = getPlatformPromptSection(agent.platform);
  if (platformSection) {
    sections.push(platformSection);
  }
  
  return sections.join('\n\n');
}

/**
 * Determine which tool categories are enabled based on available services
 * This is called when building the tool registry
 */
export function detectEnabledCategories(availableServices: {
  voice?: boolean;
  memory?: boolean;
  telegram?: boolean;
  twitter?: boolean;
  discord?: boolean;
  nft?: boolean;
  property?: boolean;
}): ToolCategory[] {
  // These are always enabled
  const categories: ToolCategory[] = [
    'secrets',
    'profile',
    'media',
    'gallery',
    'wallets',
    'diagnostics',
  ];
  
  // Conditionally enabled based on services
  if (availableServices.voice) categories.push('voice');
  if (availableServices.memory) categories.push('memory');
  if (availableServices.telegram) categories.push('telegram');
  if (availableServices.twitter) categories.push('twitter');
  if (availableServices.discord) categories.push('discord');
  if (availableServices.nft) categories.push('nft');
  if (availableServices.property) categories.push('property');
  
  return categories;
}

/**
 * Get a summary of what capabilities are enabled (for debugging/logging)
 */
export function summarizeCapabilities(categories: ToolCategory[]): string {
  return categories.join(', ');
}
