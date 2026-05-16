/**
 * Tool metadata schema and tag taxonomy.
 */
export const TOOLSETS = [
  'core',
  'media',
  'voice',
  'wallet',
  'profile',
  'gallery',
  'secrets',
  'jobs',
  'reference',
  'models',
  'config',
  'admin',
  'diagnostics',
  'telegram',
  'twitter',
  'discord',
  'property',
  'memory',
  'nft',
  'claude-code',
  'github',
  'signal-station',
] as const;

export type ToolsetId = typeof TOOLSETS[number];

export const TOOL_TAGS = [
  'image',
  'video',
  'sticker',
  'voice',
  'audio',
  'tts',
  'transcribe',
  'wallet',
  'solana',
  'ethereum',
  'balance',
  'profile',
  'persona',
  'secrets',
  'token',
  'gallery',
  'reference',
  'jobs',
  'credits',
  'energy',
  'config',
  'model',
  'admin',
  'diagnostics',
  'telegram',
  'twitter',
  'discord',
  'property',
  'listings',
  'assessor',
  'schools',
  'memory',
  'recall',
  'remember',
  'nft',
  'ownership',
  'claude-code',
  'coding',
  'avatar',
  'presence',
  'channels',
  'cross-platform',
  'github',
  'issue-tracking',
  'deployed',
  'signal',
  'station',
] as const;

export type ToolTag = typeof TOOL_TAGS[number];

export interface PromptGuidance {
  category: 'twitter' | 'gallery' | 'media' | 'voice' | 'memory' | 'core' | (string & {});
  summary: string;
  whenToUse?: string;
  examples?: string[];
}

export const CATEGORY_TOOLSET_MAP: Record<string, ToolsetId> = {
  media: 'media',
  wallet: 'wallet',
  profile: 'profile',
  config: 'config',
  gallery: 'gallery',
  secrets: 'secrets',
  readonly: 'core',
  diagnostics: 'diagnostics',
  telegram: 'telegram',
  property: 'property',
  nft: 'nft',
  github: 'github',
  'signal-station': 'signal-station',
};

export const TOOLSET_DEFAULT_TAGS: Record<ToolsetId, ToolTag[]> = {
  core: [],
  media: ['image', 'video', 'sticker'],
  voice: ['voice', 'audio', 'tts', 'transcribe'],
  wallet: ['wallet', 'solana', 'ethereum', 'balance'],
  profile: ['profile', 'persona'],
  gallery: ['gallery', 'reference', 'image'],
  secrets: ['secrets', 'token'],
  jobs: ['jobs', 'credits', 'energy'],
  reference: ['reference', 'image'],
  models: ['model', 'config'],
  config: ['config'],
  admin: ['admin'],
  diagnostics: ['diagnostics'],
  telegram: ['telegram'],
  twitter: ['twitter'],
  discord: ['discord'],
  property: ['property', 'listings', 'assessor', 'schools'],
  memory: ['memory', 'recall', 'remember'],
  nft: ['nft', 'ownership'],
  'claude-code': ['claude-code', 'coding', 'avatar'],
  github: ['github', 'issue-tracking', 'deployed'],
  'signal-station': ['signal', 'station'],
};

export const TOOLSET_PROMPT_GUIDANCE: Partial<Record<ToolsetId, PromptGuidance>> = {
  media: {
    category: 'media',
    summary: 'Generate and manage profile images, images, videos, and stickers with async continuations and media credits.',
    whenToUse: 'Use media tools when the user asks to create an image, video, sticker, or profile picture. Call the tool directly instead of describing what you would do; generate only one image or video per user message.',
    examples: [
      'generate_image({ prompt: "..." })',
      'generate_video({ prompt: "..." })',
      'generate_sticker({ prompt: "..." })',
      'set_profile_image({ source: "gallery", imageId: "..." })',
      'get_tool_credits()',
    ],
  },
  gallery: {
    category: 'gallery',
    summary: 'Browse, search, and send previously generated media from the avatar gallery.',
    whenToUse: 'Use gallery tools when the user asks to view generated media, search by prompt or description, or send an existing gallery item to a chat.',
    examples: [
      'get_my_gallery({ type: "image" })',
      'search_gallery({ query: "..." })',
      'send_gallery_media({ itemId: "..." })',
    ],
  },
  voice: {
    category: 'voice',
    summary: 'Create voice profiles and generate text-to-speech voice messages.',
    whenToUse: 'Use create_my_voice when the avatar needs a voice profile. Use send_voice_message when a spoken reply fits the conversation; audio transcription is handled by the platform flow.',
    examples: [
      'create_my_voice({ description: "..." })',
      'send_voice_message({ text: "..." })',
    ],
  },
  twitter: {
    category: 'twitter',
    summary: 'Post to Twitter/X, reply to mentions, inspect timelines, and manage Twitter presence.',
    whenToUse: 'Use twitter_status before posting when connection or character limit is uncertain. For images, pass gallery mediaIds from generated media to twitter_post or twitter_reply, not raw URLs. If validation fails, shorten the text and retry.',
    examples: [
      'twitter_status()',
      'twitter_post({ text: "...", mediaIds: ["..."] })',
      'twitter_reply({ tweetId: "...", text: "..." })',
      'twitter_get_mentions({ count: 20 })',
    ],
  },
};

export const TOOL_NAME_PROMPT_GUIDANCE: Record<string, PromptGuidance> = {
  set_profile_image: TOOLSET_PROMPT_GUIDANCE.media!,
  get_tool_credits: TOOLSET_PROMPT_GUIDANCE.media!,
};
