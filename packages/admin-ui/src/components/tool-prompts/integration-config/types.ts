/**
 * Shared types and constants for Integration Configuration sub-components.
 */

// ----- Domain types ----- //

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  isDefault?: boolean;
}

export type TelegramDiagnosis = {
  avatarId: string;
  platformEnabled: boolean;
  tokenPresent: boolean;
  webhookSecretPresent: boolean;
  bot?: {
    id?: number;
    username?: string;
    first_name?: string;
    is_bot?: boolean;
  };
  webhook: {
    expectedUrl: string;
    actualUrl?: string;
    isCorrectUrl?: boolean;
    pendingUpdateCount?: number;
    lastErrorDate?: number;
    lastErrorMessage?: string;
  };
  lastUpdate?: {
    secondsAgo?: number;
  };
  issues: Array<{ code: string; message: string }>;
};

export type TelegramUserRef = {
  userId: string;
  username?: string;
  displayName?: string;
};

export type TelegramChatRef = {
  chatId: string;
  username?: string;
  title?: string;
};

export type KnownTelegramUser = {
  userId: number;
  username?: string;
  displayName: string;
  lastSeen: number;
  chatId: number;
  chatTitle?: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
};

export type IntegrationKind =
  | 'telegram'
  | 'twitter'
  | 'discord'
  | 'replicate'
  | 'openai'
  | 'anthropic'
  | 'openrouter';

export interface IntegrationConfigType {
  name: string;
  icon: string;
  color: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  helpText: string;
  helpUrl: string | null;
  secretType: string;
  usesOAuth?: boolean;
  isAiProvider?: boolean;
  serverManagedKey?: boolean;
  capabilities?: string[];
  testEndpoint?: string;
}

// ----- Shared state types ----- //

export interface IntegrationCommonState {
  token: string;
  setToken: (v: string) => void;
  isSubmitting: boolean;
  isTesting: boolean;
  status: 'idle' | 'testing' | 'success' | 'error';
  testResult: { botUsername?: string; username?: string; message?: string; error?: string } | null;
  savedAt: number | null;
  saveError: string | null;
  setSavedAt: (v: number | null) => void;
  setSaveError: (v: string | null) => void;
}

// ----- Constants ----- //

export const CAPABILITY_LABELS: Record<string, string> = {
  image_generation: 'Image Generation',
  video_generation: 'Video Generation',
  audio_generation: 'Audio Generation',
  voice_clone: 'Voice Cloning',
  text_to_speech: 'Text to Speech',
  transcription: 'Transcription',
};

export const INTEGRATION_CONFIGS: Record<string, IntegrationConfigType> = {
  telegram: {
    name: 'Telegram',
    icon: '🤖',
    color: 'blue',
    tokenLabel: 'Bot Token',
    tokenPlaceholder: 'Enter bot token from @BotFather',
    helpText: 'Get a token from @BotFather on Telegram',
    helpUrl: 'https://t.me/BotFather',
    secretType: 'telegram_bot_token',
  },
  twitter: {
    name: 'Twitter/X',
    icon: '🐦',
    color: 'sky',
    tokenLabel: 'API Key',
    tokenPlaceholder: 'Enter API key',
    helpText: 'Uses OAuth - click Connect to authorize',
    helpUrl: null,
    secretType: 'twitter_api_key',
    usesOAuth: true,
  },
  discord: {
    name: 'Discord',
    icon: '💬',
    color: 'indigo',
    tokenLabel: 'Bot Token',
    tokenPlaceholder: 'Enter bot token from Discord Developer Portal',
    helpText: 'Get a token from the Discord Developer Portal',
    helpUrl: 'https://discord.com/developers/applications',
    secretType: 'discord_bot_token',
  },
  replicate: {
    name: 'Replicate',
    icon: '🎨',
    color: 'purple',
    tokenLabel: 'API Token',
    tokenPlaceholder: 'Enter your Replicate API token',
    helpText: 'Get your API token from Replicate dashboard',
    helpUrl: 'https://replicate.com/account/api-tokens',
    secretType: 'replicate_api_key',
    isAiProvider: true,
    capabilities: ['audio_generation', 'voice_clone', 'text_to_speech'],
    testEndpoint: 'https://api.replicate.com/v1/account',
  },
  openai: {
    name: 'OpenAI',
    icon: '🧠',
    color: 'emerald',
    tokenLabel: 'API Key',
    tokenPlaceholder: 'Enter your OpenAI API key (sk-...)',
    helpText: 'Get your API key from OpenAI platform',
    helpUrl: 'https://platform.openai.com/api-keys',
    secretType: 'openai_api_key',
    isAiProvider: true,
    capabilities: ['text_to_speech', 'transcription'],
    testEndpoint: 'https://api.openai.com/v1/models',
  },
  anthropic: {
    name: 'Anthropic',
    icon: '🔮',
    color: 'orange',
    tokenLabel: 'API Key',
    tokenPlaceholder: 'Enter your Anthropic API key (sk-ant-...)',
    helpText: 'Get your API key from Anthropic console',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    secretType: 'anthropic_api_key',
    isAiProvider: true,
    capabilities: [],
  },
  openrouter: {
    name: 'OpenRouter',
    icon: '🔀',
    color: 'cyan',
    tokenLabel: 'Server API Key',
    tokenPlaceholder: 'Managed server-side',
    helpText: 'OpenRouter requests use the server-side Swarm key',
    helpUrl: null,
    secretType: 'openrouter_api_key',
    isAiProvider: true,
    serverManagedKey: true,
    capabilities: ['image_generation', 'video_generation'],
  },
};
