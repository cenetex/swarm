/**
 * Tool router - selects a limited set of toolsets based on request text.
 */
import type { ToolDefinition } from './registry.js';
import type { ToolsetId } from './tool-metadata.js';

export interface ToolRoutingOptions {
  text?: string;
  maxToolsets?: number;
  includeToolsets?: ToolsetId[];
  excludeToolsets?: ToolsetId[];
}

export interface ToolRoutingResult {
  toolsets: ToolsetId[];
  tools: ToolDefinition[];
  scores: Record<string, number>;
}

const TOOLSET_KEYWORDS: Record<ToolsetId, string[]> = {
  core: [],
  media: ['image', 'photo', 'picture', 'selfie', 'video', 'sticker', 'art'],
  voice: ['voice', 'audio', 'speak', 'tts', 'transcribe', 'recording'],
  wallet: ['wallet', 'balance', 'solana', 'ethereum', 'airdrop', 'token'],
  profile: ['profile', 'persona', 'bio', 'name', 'description'],
  gallery: ['gallery', 'reference', 'image library'],
  secrets: ['secret', 'api key', 'token', 'credential'],
  jobs: ['job', 'queue', 'credits', 'usage', 'energy'],
  reference: ['reference', 'character', 'style'],
  models: ['model', 'temperature', 'max tokens', 'llm'],
  config: ['config', 'setting', 'toggle', 'enable'],
  admin: ['admin', 'avatar', 'template', 'deploy'],
  diagnostics: ['diagnostic', 'issue', 'error', 'log'],
  telegram: ['telegram', 'bot', 'chat', 'channel'],
  twitter: ['twitter', 'tweet', 'x.com', 'x account', 'x oauth', 'x api', 'x app', 'dm'],
  discord: ['discord', 'guild', 'server', 'channel', 'role'],
  property: ['property', 'real estate', 'listing', 'comps', 'assessor', 'schools', 'address'],
  memory: ['memory', 'remember', 'recall', 'note'],
  nft: ['nft', 'ownership', 'claim', 'lineage'],
  'claude-code': ['code', 'coding', 'implement', 'refactor', 'debug', 'fix bug', 'write code', 'programming'],
  github: ['github', 'issue', 'bug report', 'reported', 'tracking', 'deployed', 'fixed', 'status'],
  'signal-station': ['station', 'signal', 'hail', 'commodity', 'asteroid', 'mining', 'module'],
};

const TOOLSET_PRIORITY: ToolsetId[] = [
  'core',
  'media',
  'voice',
  'wallet',
  'property',
  'memory',
  'jobs',
  'profile',
  'secrets',
  'models',
  'gallery',
  'telegram',
  'discord',
  'twitter',
  'diagnostics',
  'admin',
  'config',
  'reference',
  'nft',
  'claude-code',
  'github',
];

function scoreToolset(text: string, keywords: string[]): number {
  if (!text) return 0;
  let score = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}

export function routeTools(
  tools: ToolDefinition[],
  options: ToolRoutingOptions = {}
): ToolRoutingResult {
  const text = (options.text || '').toLowerCase();
  const maxToolsets = options.maxToolsets ?? 3;
  const exclude = new Set(options.excludeToolsets || []);
  const include = new Set(options.includeToolsets || []);

  const availableToolsets = Array.from(new Set(
    tools.map(tool => tool.toolset || 'core')
  )).filter(toolset => !exclude.has(toolset));

  const scores: Record<string, number> = {};
  for (const toolset of availableToolsets) {
    const keywords = TOOLSET_KEYWORDS[toolset] || [];
    const tagKeywords = Array.from(new Set(
      tools
        .filter(tool => (tool.toolset || 'core') === toolset)
        .flatMap(tool => tool.tags || [])
    ));
    scores[toolset] = scoreToolset(text, [...keywords, ...tagKeywords]);
  }

  const sortedToolsets = [...availableToolsets].sort((a, b) => {
    const scoreDiff = (scores[b] || 0) - (scores[a] || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return TOOLSET_PRIORITY.indexOf(a) - TOOLSET_PRIORITY.indexOf(b);
  });

  const selected: ToolsetId[] = [];
  if (availableToolsets.includes('core')) {
    selected.push('core');
  }

  for (const toolset of include) {
    if (!selected.includes(toolset) && availableToolsets.includes(toolset)) {
      selected.push(toolset);
    }
  }

  for (const toolset of sortedToolsets) {
    if (selected.length >= maxToolsets) break;
    if (!selected.includes(toolset)) {
      selected.push(toolset);
    }
  }

  if (selected.length === 0) {
    for (const toolset of TOOLSET_PRIORITY) {
      if (availableToolsets.includes(toolset)) {
        selected.push(toolset);
      }
      if (selected.length >= maxToolsets) break;
    }
  }

  const filteredTools = tools.filter(tool => selected.includes(tool.toolset || 'core'));

  return {
    toolsets: selected,
    tools: filteredTools,
    scores,
  };
}
