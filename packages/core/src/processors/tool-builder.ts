/**
 * Tool Builder
 *
 * Shared logic for building and filtering tools based on enabled categories.
 * Used by MessageProcessor to ensure consistent tool availability across all platforms.
 */

import type { ToolCategory, ToolsetId, ProcessorConfig } from './types.js';
import type { PromptGuidance } from '../types/index.js';

// =============================================================================
// CATEGORY TO TOOLSET MAPPING
// =============================================================================

/**
 * Maps tool categories to their corresponding toolset IDs.
 * This ensures consistent tool filtering across all platforms.
 */
export const CATEGORY_TOOLSETS: Record<ToolCategory, ToolsetId[]> = {
  secrets: ['secrets'],
  wallets: ['wallet'],
  profile: ['profile'],
  media: ['media'],
  gallery: ['gallery'],
  voice: ['voice'],
  telegram: ['telegram'],
  twitter: ['twitter'],
  discord: ['discord'],
  memory: ['memory'],
  nft: ['nft'],
  property: ['property'],
  diagnostics: ['diagnostics'],
  'signal-station': ['signal-station'],
};

/**
 * Base toolsets that are always included regardless of enabled categories.
 */
export const BASE_TOOLSETS: ToolsetId[] = ['core', 'admin', 'config', 'jobs', 'models'];

// =============================================================================
// CATEGORY DETECTION
// =============================================================================

/**
 * Default categories that are always enabled.
 */
export const DEFAULT_CATEGORIES: ToolCategory[] = [
  'secrets',
  'profile',
  'media',
  'gallery',
  'wallets',
  'diagnostics',
];

/**
 * Detect which tool categories should be enabled based on available services.
 * This is the canonical function for determining tool availability.
 */
export function detectEnabledCategories(availableServices: {
  voice?: boolean;
  memory?: boolean;
  telegram?: boolean;
  twitter?: boolean;
  discord?: boolean;
  nft?: boolean;
  property?: boolean;
  signalStation?: boolean;
}): ToolCategory[] {
  // Start with always-enabled categories
  const categories: ToolCategory[] = [...DEFAULT_CATEGORIES];

  // Conditionally add based on services
  if (availableServices.voice) categories.push('voice');
  if (availableServices.memory) categories.push('memory');
  if (availableServices.telegram) categories.push('telegram');
  if (availableServices.twitter) categories.push('twitter');
  if (availableServices.discord) categories.push('discord');
  if (availableServices.nft) categories.push('nft');
  if (availableServices.property) categories.push('property');
  if (availableServices.signalStation) categories.push('signal-station');

  return categories;
}

// =============================================================================
// TOOLSET RESOLUTION
// =============================================================================

/**
 * Resolve enabled categories to the full list of allowed toolset IDs.
 * Returns undefined if no filtering should be applied.
 */
export function resolveAllowedToolsets(categories?: ToolCategory[]): ToolsetId[] | undefined {
  if (!categories || categories.length === 0) {
    return undefined;
  }

  const toolsets = new Set<ToolsetId>(BASE_TOOLSETS);

  for (const category of categories) {
    const mapped = CATEGORY_TOOLSETS[category] || [];
    for (const toolset of mapped) {
      toolsets.add(toolset);
    }
  }

  return Array.from(toolsets);
}

// =============================================================================
// TOOL CONTEXT
// =============================================================================

/**
 * Context passed to tools during execution.
 * This is a platform-agnostic representation of the execution context.
 */
export interface ToolContext {
  avatarId: string;
  platform: ProcessorConfig['platform'];
  userId?: string;
  conversationId?: string;
  replyToMessageId?: string;
  session?: {
    email?: string;
    isAdmin?: boolean;
  };
}

/**
 * Create a tool context from processor config.
 */
export function createToolContext(config: ProcessorConfig): ToolContext {
  return {
    avatarId: config.avatarId,
    platform: config.platform,
    userId: config.userId,
    conversationId: config.conversationId,
    replyToMessageId: config.replyToMessageId,
    session: config.session,
  };
}

// =============================================================================
// TOOL FILTERING
// =============================================================================

/**
 * Generic tool definition for filtering purposes.
 */
export interface FilterableToolDefinition {
  name: string;
  toolset?: ToolsetId;
  promptGuidance?: PromptGuidance;
  platforms?: Array<'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api' | 'mcp'>;
  shouldShow?: (context: ToolContext) => Promise<boolean>;
}

/**
 * Filter tools by platform availability.
 */
export function filterByPlatform<T extends FilterableToolDefinition>(
  tools: T[],
  platform: ProcessorConfig['platform']
): T[] {
  return tools.filter(tool => {
    if (!tool.platforms) return true; // Default: available everywhere
    return tool.platforms.includes(platform as 'telegram' | 'discord' | 'twitter' | 'admin-ui' | 'api' | 'mcp');
  });
}

/**
 * Filter tools by enabled toolsets.
 */
export function filterByToolsets<T extends FilterableToolDefinition>(
  tools: T[],
  allowedToolsets?: ToolsetId[]
): T[] {
  if (!allowedToolsets) return tools;
  return tools.filter(tool => allowedToolsets.includes(tool.toolset || 'core'));
}

/**
 * Filter tools by shouldShow visibility checks.
 */
export async function filterByVisibility<T extends FilterableToolDefinition>(
  tools: T[],
  context: ToolContext
): Promise<T[]> {
  const visibilityChecks = await Promise.all(
    tools.map(async (tool) => {
      if (tool.shouldShow) {
        try {
          return await tool.shouldShow(context);
        } catch {
          return true; // Show on error
        }
      }
      return true; // No shouldShow = always visible
    })
  );
  return tools.filter((_, index) => visibilityChecks[index]);
}

/**
 * Apply all filters to get the final tool list.
 * This is the main function that should be used by the MessageProcessor.
 */
export async function filterTools<T extends FilterableToolDefinition>(
  tools: T[],
  context: ToolContext,
  enabledCategories?: ToolCategory[]
): Promise<T[]> {
  // 1. Filter by platform
  let filtered = filterByPlatform(tools, context.platform);

  // 2. Filter by enabled toolsets (from categories)
  const allowedToolsets = resolveAllowedToolsets(enabledCategories);
  filtered = filterByToolsets(filtered, allowedToolsets);

  // 3. Filter by visibility checks
  filtered = await filterByVisibility(filtered, context);

  return filtered;
}

// =============================================================================
// SUMMARY
// =============================================================================

/**
 * Get a summary of what capabilities are enabled (for debugging/logging).
 */
export function summarizeCapabilities(categories: ToolCategory[]): string {
  return categories.join(', ');
}
