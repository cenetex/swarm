/**
 * Platform Prompts Service
 * 
 * Loads platform-specific prompt snippets from markdown files.
 * These are bundled at build time and included in the Lambda deployment.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Cache for loaded prompts
const promptCache = new Map<string, string>();

// Get the directory where prompts are stored
// In Lambda, this will be relative to the handler
function getPromptsDir(): string {
  // Try multiple locations (dev vs Lambda)
  const possiblePaths = [
    // From packages/admin-api (development)
    join(process.cwd(), '..', '..', 'prompts', 'platforms'),
    // From Lambda root
    join(process.cwd(), 'prompts', 'platforms'),
    // Relative to this file (ESM)
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'prompts', 'platforms'),
    // Bundled with Lambda
    '/var/task/prompts/platforms',
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  // Fallback - will fail gracefully if not found
  return possiblePaths[0];
}

/**
 * Supported platforms for prompts
 */
export type PromptPlatform = 
  | 'telegram'
  | 'discord'
  | 'twitter'
  | 'farcaster'
  | 'admin-ui'
  | 'api'
  | 'replicate'
  | 'openrouter';

/**
 * Load a platform-specific prompt from markdown file
 * Returns empty string if not found (graceful fallback)
 */
export function loadPlatformPrompt(platform: PromptPlatform): string {
  // Check cache first
  if (promptCache.has(platform)) {
    return promptCache.get(platform)!;
  }

  try {
    const promptsDir = getPromptsDir();
    const filePath = join(promptsDir, `${platform}.md`);
    
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      promptCache.set(platform, content);
      console.log(`[PlatformPrompts] Loaded prompt for ${platform} (${content.length} chars)`);
      return content;
    } else {
      console.log(`[PlatformPrompts] No prompt file found for ${platform}`);
      promptCache.set(platform, '');
      return '';
    }
  } catch (error) {
    console.warn(`[PlatformPrompts] Error loading prompt for ${platform}:`, error);
    promptCache.set(platform, '');
    return '';
  }
}

/**
 * Load platform prompt and format it for injection into system prompt
 */
export function getPlatformPromptSection(platform: PromptPlatform): string {
  const prompt = loadPlatformPrompt(platform);
  if (!prompt) return '';
  
  return `\n\n## Platform Guidelines (${platform})\n\n${prompt}`;
}

/**
 * Clear the prompt cache (useful for testing or hot-reloading)
 */
export function clearPromptCache(): void {
  promptCache.clear();
}

/**
 * List all available platform prompts
 */
export function listAvailablePlatforms(): PromptPlatform[] {
  const available: PromptPlatform[] = [];
  const platforms: PromptPlatform[] = ['telegram', 'discord', 'twitter', 'farcaster', 'admin-ui', 'api', 'replicate', 'openrouter'];
  
  for (const platform of platforms) {
    const prompt = loadPlatformPrompt(platform);
    if (prompt) {
      available.push(platform);
    }
  }
  
  return available;
}
