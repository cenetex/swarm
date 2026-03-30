/**
 * Integration Configuration Prompt
 * Shows a complete configuration panel for platform integrations (Telegram, Twitter, Discord)
 * Includes: enable/disable, credential input, test, status
 */
import { useState, useRef, useEffect } from 'react';
import { useActiveAvatar } from '../../store';
import { API_BASE, type ToolPromptProps } from './types';

// Model info for AI provider configuration
interface ModelOption {
  id: string;
  name: string;
  description: string;
  isDefault?: boolean;
}

type TelegramDiagnosis = {
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

type DiscordStatus = {
  connected: boolean;
  mode: 'webhook' | 'bot' | 'hybrid' | 'none';
  credentialsValid: boolean;
  runtimeHealthy: boolean;
  botUsername?: string;
  botId?: string;
  webhookConfigured?: boolean;
  guilds?: Array<{
    id: string;
    name: string;
    memberCount?: number;
  }>;
  gatewayWarning?: string;
};

// Types for username-based allowlists
type TelegramUserRef = {
  userId: string;
  username?: string;
  displayName?: string;
};

type TelegramChatRef = {
  chatId: string;
  username?: string;
  title?: string;
};

// Capability labels for display
const CAPABILITY_LABELS: Record<string, string> = {
  image_generation: 'Image Generation',
  video_generation: 'Video Generation',
  audio_generation: 'Audio Generation',
  voice_clone: 'Voice Cloning',
  text_to_speech: 'Text to Speech',
  transcription: 'Transcription',
};

export function IntegrationConfigPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const activeAgent = useActiveAvatar();
  const [token, setToken] = useState('');
  // New format: store full refs with display info
  const [allowedDmUsers, setAllowedDmUsers] = useState<TelegramUserRef[]>([]);
  const [allowedChats, setAllowedChats] = useState<TelegramChatRef[]>([]);
  const [newDmInput, setNewDmInput] = useState('');
  const [newGroupInput, setNewGroupInput] = useState('');
  const [dmInputError, setDmInputError] = useState<string | null>(null);
  const [groupInputError, setGroupInputError] = useState<string | null>(null);
  const [isResolvingGroup, setIsResolvingGroup] = useState(false);
  const [policyLoadError, setPolicyLoadError] = useState<string | null>(null);
  const initialPolicyRef = useRef<{ allowedDmUsers: TelegramUserRef[]; allowedChats: TelegramChatRef[] } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testResult, setTestResult] = useState<{ botUsername?: string; username?: string; message?: string; error?: string } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [useGlobalKey, setUseGlobalKey] = useState(true);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [globalKeyAvailable, setGlobalKeyAvailable] = useState<boolean | null>(null);
  const [hasAvatarKey, setHasAvatarKey] = useState<boolean | null>(null);
  const [availableModelsByCapability, setAvailableModelsByCapability] = useState<Record<string, ModelOption[]> | null>(null);
  const [modelsLoadError, setModelsLoadError] = useState<string | null>(null);
  const didInitFromStatus = useRef<string | null>(null);

  // Model search state
  const [modelSearchQueries, setModelSearchQueries] = useState<Record<string, string>>({});
  const [modelSearchResults, setModelSearchResults] = useState<Record<string, ModelOption[]>>({});
  const [modelSearchLoading, setModelSearchLoading] = useState<Record<string, boolean>>({});
  const searchTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Keyboard highlight index for model picker per capability
  const [pickerHighlight, setPickerHighlight] = useState<Record<string, number>>({});

  const [telegramDiagnosis, setTelegramDiagnosis] = useState<TelegramDiagnosis | null>(null);
  const [telegramDiagnosisError, setTelegramDiagnosisError] = useState<string | null>(null);
  const [telegramDiagnosisLoading, setTelegramDiagnosisLoading] = useState(false);
  const [telegramRepairLoading, setTelegramRepairLoading] = useState(false);
  const [telegramRepairError, setTelegramRepairError] = useState<string | null>(null);
  const [knownTelegramUsers, setKnownTelegramUsers] = useState<Array<{
    userId: number;
    username?: string;
    displayName: string;
    lastSeen: number;
    chatId: number;
    chatTitle?: string;
    chatType: 'private' | 'group' | 'supergroup' | 'channel';
  }>>([]);

  // Discord-specific state
  const [discordStatus, setDiscordStatus] = useState<DiscordStatus | null>(null);
  const [discordStatusError, setDiscordStatusError] = useState<string | null>(null);
  const [discordStatusLoading, setDiscordStatusLoading] = useState(false);
  const [discordSaveComplete, setDiscordSaveComplete] = useState(false);
  const pendingResultRef = useRef<Record<string, unknown> | null>(null);

  // Twitter-specific state
  const [twitterFeatures, setTwitterFeatures] = useState<string[]>(['mention_replies']);
  const [twitterAutonomousEnabled, setTwitterAutonomousEnabled] = useState(false);
  const [twitterMinInterval, setTwitterMinInterval] = useState(4);
  const [twitterMaxInterval, setTwitterMaxInterval] = useState(6);
  const [twitterImageChance, setTwitterImageChance] = useState(0.3);
  const [twitterTopics, setTwitterTopics] = useState<string[]>([]);
  const [newTwitterTopic, setNewTwitterTopic] = useState('');
  const [twitterCommunities, setTwitterCommunities] = useState<Array<{ id: string; name: string }>>([]);
  const [newCommunityId, setNewCommunityId] = useState('');
  const [newCommunityName, setNewCommunityName] = useState('');
  const [twitterConfigLoaded, setTwitterConfigLoaded] = useState(false);
  const initialTwitterConfigRef = useRef<{
    features: string[];
    autonomousPosts?: { enabled: boolean; minIntervalHours: number; maxIntervalHours: number; imageChance: number; topics?: string[] };
    communities?: Array<{ id: string; name: string }>;
  } | null>(null);

  const args = (toolCall.arguments ?? {}) as {
    integration?: 'telegram' | 'twitter' | 'discord' | 'replicate' | 'openai' | 'anthropic' | 'openrouter';
    reason?: string;
  };

  // After early return check, we know integration is defined - use type assertion for hook callbacks
  const integration = args.integration;

  // Tool prompts can be re-used across chat turns. Reset transient state when a new
  // tool call arrives so we always load the latest backend config.
  useEffect(() => {
    setSavedAt(null);
    setSaveError(null);
    setStatus('idle');
    setTestResult(null);
    setToken('');
    setGlobalKeyAvailable(null);
    setHasAvatarKey(null);
    setUseGlobalKey(true);
    setSelectedModels({});
    setTelegramDiagnosis(null);
    setTelegramDiagnosisError(null);
    setTelegramDiagnosisLoading(false);
    setTelegramRepairLoading(false);
    setTelegramRepairError(null);
    setKnownTelegramUsers([]);
    // Reset Discord state
    setDiscordStatus(null);
    setDiscordStatusError(null);
    setDiscordStatusLoading(false);
    setDiscordSaveComplete(false);
    pendingResultRef.current = null;
    // Reset Telegram policy state
    setAllowedDmUsers([]);
    setAllowedChats([]);
    setNewDmInput('');
    setNewGroupInput('');
    setDmInputError(null);
    setGroupInputError(null);
    setIsResolvingGroup(false);
    initialPolicyRef.current = null;
    didInitFromStatus.current = null;
    // Reset model search state
    setModelSearchQueries({});
    setModelSearchResults({});
    setModelSearchLoading({});
    for (const timer of Object.values(searchTimers.current)) clearTimeout(timer);
    searchTimers.current = {};
    // Reset Twitter state
    setTwitterFeatures(['mention_replies']);
    setTwitterAutonomousEnabled(false);
    setTwitterMinInterval(4);
    setTwitterMaxInterval(6);
    setTwitterImageChance(0.3);
    setTwitterTopics([]);
    setNewTwitterTopic('');
    setTwitterCommunities([]);
    setNewCommunityId('');
    setNewCommunityName('');
    setTwitterConfigLoaded(false);
    initialTwitterConfigRef.current = null;
  }, [toolCall.id]);

  // Debounced model search for Replicate
  const handleModelSearch = (capability: string, query: string) => {
    setModelSearchQueries(prev => ({ ...prev, [capability]: query }));

    // Clear previous timer
    if (searchTimers.current[capability]) {
      clearTimeout(searchTimers.current[capability]);
    }

    // Clear results if query is too short
    if (query.trim().length < 2) {
      setModelSearchResults(prev => {
        const next = { ...prev };
        delete next[capability];
        return next;
      });
      return;
    }

    // Debounce: 400ms
    searchTimers.current[capability] = setTimeout(async () => {
      setModelSearchLoading(prev => ({ ...prev, [capability]: true }));
      try {
        const params = new URLSearchParams({
          q: query.trim(),
          integration: integration || 'replicate',
          capability,
        });
        const response = await fetch(
          `${API_BASE}/integrations/models/search?${params.toString()}`,
          { method: 'GET', credentials: 'include' },
        );
        if (response.ok) {
          const payload = (await response.json()) as {
            results?: Array<{ id: string; name: string; description: string; isDefault?: boolean }>;
          };
          setModelSearchResults(prev => ({
            ...prev,
            [capability]: (payload.results || []).map(r => ({
              id: r.id,
              name: r.name,
              description: r.description,
              isDefault: r.isDefault,
            })),
          }));
        }
      } catch {
        // Silently fail — hardcoded models remain available
      } finally {
        setModelSearchLoading(prev => ({ ...prev, [capability]: false }));
      }
    }, 400);
  };

  const runTelegramDiagnostics = async (): Promise<TelegramDiagnosis | null> => {
    if (!activeAgent?.id) return null;
    setTelegramDiagnosisLoading(true);
    setTelegramDiagnosisError(null);
    try {
      const resp = await fetch(`${API_BASE}/avatars/${activeAgent.id}/telegram/diagnose`, {
        method: 'GET',
        credentials: 'include',
      });

      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const message = (payload as { error?: string; message?: string }).error
          || (payload as { error?: string; message?: string }).message
          || `Failed to run Telegram diagnostics (HTTP ${resp.status})`;
        setTelegramDiagnosis(null);
        setTelegramDiagnosisError(message);
        return null;
      }

      // Ensure issues array exists (API should always return it, but be defensive)
      const diagnosis = payload as TelegramDiagnosis;
      diagnosis.issues = diagnosis.issues ?? [];
      setTelegramDiagnosis(diagnosis);
      return diagnosis;
    } catch {
      setTelegramDiagnosis(null);
      setTelegramDiagnosisError('Failed to run Telegram diagnostics');
      return null;
    } finally {
      setTelegramDiagnosisLoading(false);
    }
  };

  const repairTelegramWebhook = async (): Promise<void> => {
    if (!activeAgent?.id) return;
    setTelegramRepairLoading(true);
    setTelegramRepairError(null);
    try {
      const resp = await fetch(`${API_BASE}/avatars/${activeAgent.id}/telegram/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          dryRun: false,
          repairOnPendingUpdates: true,
          repairOnLastError: true,
        }),
      });

      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const message = (payload as { error?: string; message?: string }).error
          || (payload as { error?: string; message?: string }).message
          || `Failed to repair webhook (HTTP ${resp.status})`;
        setTelegramRepairError(message);
        return;
      }

      const result = payload as { action?: string; reason?: string };
      if (result.action === 'repaired') {
        // Re-run diagnostics to show the fixed state
        await runTelegramDiagnostics();
      } else if (result.action === 'skipped') {
        setTelegramRepairError(`Skipped: ${result.reason || 'No repair needed'}`);
      }
    } catch {
      setTelegramRepairError('Failed to repair webhook');
    } finally {
      setTelegramRepairLoading(false);
    }
  };

  // When opening the Telegram integration panel (or switching avatars), show current
  // integration health and auto-repair fixable issues.
  useEffect(() => {
    if (integration !== 'telegram') return;
    if (!activeAgent?.id) return;

    const diagnoseAndRepair = async () => {
      const diagnosis = await runTelegramDiagnostics();
      if (!diagnosis) return;

      // Auto-repair if there are fixable webhook issues
      const hasFixableIssues = (diagnosis.issues ?? []).some(
        (i) =>
          i.code === 'webhook_url_mismatch' ||
          i.code === 'webhook_pending_updates' ||
          i.code === 'webhook_last_error'
      );

      if (hasFixableIssues) {
        await repairTelegramWebhook();
      }
    };

    const fetchKnownUsers = async () => {
      try {
        const resp = await fetch(`${API_BASE}/avatars/${activeAgent.id}/telegram/known-users`, {
          method: 'GET',
          credentials: 'include',
        });
        if (resp.ok) {
          const data = (await resp.json()) as { users: typeof knownTelegramUsers };
          setKnownTelegramUsers(data.users || []);
        }
      } catch {
        // Silently ignore - known users is a nice-to-have
      }
    };

    void diagnoseAndRepair();
    void fetchKnownUsers();
    // Intentionally omit functions from deps to avoid re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCall.id, integration, activeAgent?.id]);

  // When opening the Discord integration panel, fetch connection status.
  const runDiscordStatus = async (): Promise<DiscordStatus | null> => {
    if (!activeAgent?.id) return null;
    setDiscordStatusLoading(true);
    setDiscordStatusError(null);
    try {
      const resp = await fetch(`${API_BASE}/avatars/${activeAgent.id}/discord/status`, {
        method: 'GET',
        credentials: 'include',
      });

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        setDiscordStatus(null);
        setDiscordStatusError('Unable to check Discord status');
        return null;
      }

      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const message = (payload as { error?: string; message?: string }).error
          || (payload as { error?: string; message?: string }).message
          || `Failed to check Discord status (HTTP ${resp.status})`;
        setDiscordStatus(null);
        setDiscordStatusError(message);
        return null;
      }

      const status = payload as DiscordStatus;
      setDiscordStatus(status);
      return status;
    } catch {
      setDiscordStatus(null);
      setDiscordStatusError('Failed to check Discord status');
      return null;
    } finally {
      setDiscordStatusLoading(false);
    }
  };

  useEffect(() => {
    if (integration !== 'discord') return;
    if (!activeAgent?.id) return;

    void runDiscordStatus();
    // Intentionally omit functions from deps to avoid re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCall.id, integration, activeAgent?.id]);

  // When opening the Twitter integration panel, load current config
  useEffect(() => {
    if (integration !== 'twitter') return;
    if (!activeAgent?.id) return;
    if (twitterConfigLoaded) return;

    const loadTwitterConfig = async () => {
      try {
        const response = await fetch(`${API_BASE}/avatars/${activeAgent.id}`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => ({}))) as {
          platforms?: {
            twitter?: {
              features?: string[];
              autonomousPosts?: {
                enabled?: boolean;
                minIntervalHours?: number;
                maxIntervalHours?: number;
                imageChance?: number;
                useMemories?: boolean;
                topics?: string[];
              };
              communities?: Array<{ id: string; name: string }>;
            };
          };
        };
        const twitter = payload?.platforms?.twitter || {};

        const features = twitter.features || ['mention_replies'];
        const autonomousPosts = twitter.autonomousPosts;
        const communities = twitter.communities || [];

        setTwitterFeatures(features);
        if (autonomousPosts) {
          setTwitterAutonomousEnabled(autonomousPosts.enabled ?? false);
          setTwitterMinInterval(autonomousPosts.minIntervalHours ?? 4);
          setTwitterMaxInterval(autonomousPosts.maxIntervalHours ?? 6);
          setTwitterImageChance(autonomousPosts.imageChance ?? 0.3);
          setTwitterTopics(autonomousPosts.topics || []);
        }
        setTwitterCommunities(communities);

        initialTwitterConfigRef.current = {
          features,
          autonomousPosts: autonomousPosts ? {
            enabled: autonomousPosts.enabled ?? false,
            minIntervalHours: autonomousPosts.minIntervalHours ?? 4,
            maxIntervalHours: autonomousPosts.maxIntervalHours ?? 6,
            imageChance: autonomousPosts.imageChance ?? 0.3,
            topics: autonomousPosts.topics,
          } : undefined,
          communities,
        };
        setTwitterConfigLoaded(true);
      } catch {
        // Ignore errors loading config
      }
    };

    void loadTwitterConfig();
  }, [toolCall.id, integration, activeAgent?.id, twitterConfigLoaded]);

  // Auto-hide the "Saved" banner after a short delay.
  useEffect(() => {
    if (!savedAt) return;
    const timeout = window.setTimeout(() => setSavedAt(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [savedAt]);

  type IntegrationConfigType = {
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
    capabilities?: string[];
    testEndpoint?: string;
  };

  const integrationConfig: Record<string, IntegrationConfigType> = {
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
      capabilities: ['image_generation', 'video_generation', 'audio_generation', 'voice_clone', 'text_to_speech'],
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
      tokenLabel: 'API Key',
      tokenPlaceholder: 'Enter your OpenRouter API key',
      helpText: 'Get your API key from OpenRouter',
      helpUrl: 'https://openrouter.ai/keys',
      secretType: 'openrouter_api_key',
      isAiProvider: true,
      capabilities: [],
    },
  };

  const config = integration ? integrationConfig[integration] : undefined;

  const normalizeList = (values: unknown): string[] => {
    if (!Array.isArray(values)) return [];
    return values
      .map(v => String(v).trim())
      .filter(Boolean);
  };

  const stableSorted = (values: string[]) => [...values].map(v => v.trim()).filter(Boolean).sort();

  const hasTelegramPolicyChanges = (() => {
    if (integration !== 'telegram') return false;
    if (!initialPolicyRef.current) return false;
    // Compare by userId/chatId for stable comparison
    const currentDmIds = allowedDmUsers.map(u => u.userId).sort();
    const currentChatIds = allowedChats.map(c => c.chatId).sort();
    const initialDmIds = initialPolicyRef.current.allowedDmUsers.map(u => u.userId).sort();
    const initialChatIds = initialPolicyRef.current.allowedChats.map(c => c.chatId).sort();
    return JSON.stringify({ dm: currentDmIds, chat: currentChatIds }) !==
           JSON.stringify({ dm: initialDmIds, chat: initialChatIds });
  })();

  const hasTwitterConfigChanges = (() => {
    if (integration !== 'twitter') return false;
    if (!initialTwitterConfigRef.current) return false;
    const current = {
      features: stableSorted(twitterFeatures),
      autonomousPosts: {
        enabled: twitterAutonomousEnabled,
        minIntervalHours: twitterMinInterval,
        maxIntervalHours: twitterMaxInterval,
        imageChance: twitterImageChance,
        topics: stableSorted(twitterTopics),
      },
      communities: JSON.stringify(twitterCommunities),
    };
    const initial = {
      features: stableSorted(initialTwitterConfigRef.current.features),
      autonomousPosts: initialTwitterConfigRef.current.autonomousPosts ? {
        enabled: initialTwitterConfigRef.current.autonomousPosts.enabled,
        minIntervalHours: initialTwitterConfigRef.current.autonomousPosts.minIntervalHours,
        maxIntervalHours: initialTwitterConfigRef.current.autonomousPosts.maxIntervalHours,
        imageChance: initialTwitterConfigRef.current.autonomousPosts.imageChance,
        topics: stableSorted(initialTwitterConfigRef.current.autonomousPosts.topics || []),
      } : { enabled: false, minIntervalHours: 4, maxIntervalHours: 6, imageChance: 0.3, topics: [] as string[] },
      communities: JSON.stringify(initialTwitterConfigRef.current.communities || []),
    };
    return JSON.stringify(current) !== JSON.stringify(initial);
  })();

  useEffect(() => {
    if (integration !== 'telegram') return;
    if (!activeAgent?.id) return;

    const run = async () => {
      setPolicyLoadError(null);
      try {
        const response = await fetch(`${API_BASE}/avatars/${activeAgent.id}`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) {
          setPolicyLoadError(`Failed to load current Telegram settings (HTTP ${response.status})`);
          return;
        }
        const payload = (await response.json().catch(() => ({}))) as {
          platforms?: {
            telegram?: {
              allowedDmUserIds?: string[];
              allowedChatIds?: string[];
              allowedDmUsers?: TelegramUserRef[];
              allowedChats?: TelegramChatRef[];
            };
          };
        };
        const telegram = payload?.platforms?.telegram || {};

        // Handle new format (allowedDmUsers/allowedChats) with fallback to old format
        let dmUsers: TelegramUserRef[];
        let chats: TelegramChatRef[];

        if (telegram.allowedDmUsers && telegram.allowedDmUsers.length > 0) {
          dmUsers = telegram.allowedDmUsers;
        } else if (telegram.allowedDmUserIds && telegram.allowedDmUserIds.length > 0) {
          // Migrate from old format
          dmUsers = normalizeList(telegram.allowedDmUserIds).map(id => ({ userId: id }));
        } else {
          dmUsers = [];
        }

        if (telegram.allowedChats && telegram.allowedChats.length > 0) {
          chats = telegram.allowedChats;
        } else if (telegram.allowedChatIds && telegram.allowedChatIds.length > 0) {
          // Migrate from old format
          chats = normalizeList(telegram.allowedChatIds).map(id => ({ chatId: id }));
        } else {
          chats = [];
        }

        setAllowedDmUsers(dmUsers);
        setAllowedChats(chats);
        initialPolicyRef.current = { allowedDmUsers: dmUsers, allowedChats: chats };
      } catch {
        setPolicyLoadError('Failed to load current Telegram settings');
      }
    };

    void run();
    // Only re-run when switching avatars

  }, [integration, activeAgent?.id]);

  useEffect(() => {
    if (!config?.isAiProvider || !integration) return;

    const run = async () => {
      setModelsLoadError(null);
      setAvailableModelsByCapability(null);

      try {
        const response = await fetch(
          `${API_BASE}/integrations/models?integration=${encodeURIComponent(integration)}`,
          {
            method: 'GET',
            credentials: 'include',
          }
        );

        if (!response.ok) {
          setModelsLoadError(`Failed to load model catalog (HTTP ${response.status})`);
          return;
        }

        const payload = (await response.json().catch(() => ({}))) as {
          integration?: string;
          modelsByCapability?: Record<string, ModelOption[]>;
        };

        if (!payload.modelsByCapability) {
          setModelsLoadError('Model catalog unavailable');
          return;
        }

        setAvailableModelsByCapability(payload.modelsByCapability);
      } catch {
        setModelsLoadError('Failed to load model catalog');
      }
    };

    void run();
  }, [integration, config?.isAiProvider]);

  useEffect(() => {
    if (!activeAgent?.id || !config?.isAiProvider) return;

    const initKey = `${activeAgent.id}:${integration}`;
    if (didInitFromStatus.current === initKey) return;
    didInitFromStatus.current = initKey;

    // Default UI state until backend responds
    setGlobalKeyAvailable(null);
    setHasAvatarKey(null);
    setUseGlobalKey(true);
    setSelectedModels({});

    const run = async () => {
      try {
        const response = await fetch(`${API_BASE}/avatars/${activeAgent.id}/integrations`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) return;

        const payload = (await response.json().catch(() => ({}))) as {
          integrations?: Array<{
            type: string;
            hasApiKey: boolean;
            hasGlobalKey: boolean;
            useGlobalKey: boolean;
            models?: Record<string, string>;
          }>;
        };

        const match = payload.integrations?.find((s) => s.type === integration);
        if (!match) return;

        setGlobalKeyAvailable(Boolean(match.hasGlobalKey));

        // If backend says "use global" but there is no global/system key, force local key mode.
        setUseGlobalKey(match.useGlobalKey && match.hasGlobalKey);
        setHasAvatarKey(Boolean(match.hasApiKey));
        if (match.models) {
          setSelectedModels(match.models);
        }
      } catch {
        // Ignore status fetch errors; prompt remains usable.
      }
    };

    void run();
  }, [activeAgent?.id, integration, config?.isAiProvider]);

  // Guard: If integration type is unknown or missing, show fallback UI (after hooks)
  if (!integration || !config) {
    // When restored from history without full arguments, show graceful completion message
    if (!integration) {
      return (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4">
          <p className="text-[var(--color-text-tertiary)] text-sm">Integration configuration complete.</p>
        </div>
      );
    }
    return (
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4">
        <p className="text-[var(--color-text-secondary)]">
          Unknown integration type: {integration}
        </p>
      </div>
    );
  }

  // Extract bot token from pasted text (e.g., BotFather message)
  const extractBotToken = (input: string): { token: string; extracted: boolean } => {
    const match = input.match(/(\d{8,}:\S{35,})/);
    if (match) {
      return { token: match[1], extracted: match[1] !== input.trim() };
    }
    return { token: input.trim(), extracted: false };
  };

  // Parse t.me/ URLs to extract group username
  const parseTelegramUrl = (input: string): { type: 'username' | 'invite' | 'invalid'; value?: string } => {
    // Match t.me/groupname or t.me/+inviteHash
    const urlMatch = input.match(/(?:https?:\/\/)?t\.me\/([+@]?[\w]+)/);
    if (urlMatch) {
      const value = urlMatch[1];
      if (value.startsWith('+')) {
        return { type: 'invite', value };
      }
      return { type: 'username', value };
    }
    return { type: 'invalid' };
  };

  // Generate deep link approval URL for sharing
  const generateShareLink = (): string | null => {
    if (!activeAgent?.id) return null;
    const botStatus = testResult?.botUsername;
    if (!botStatus) return null;
    return `https://t.me/${botStatus}?start=approve_${activeAgent.id}`;
  };

  const handleTest = async () => {
    if (!token.trim() || isTesting) return;

    setIsTesting(true);
    setStatus('testing');
    setTestResult(null);

    try {
      // For AI providers, validate via backend to avoid browser CORS issues.
      if (config.isAiProvider) {
        if (!activeAgent?.id) {
          setStatus('error');
          setTestResult({ error: 'No active avatar selected' });
          return;
        }
        const response = await fetch(`${API_BASE}/avatars/${activeAgent?.id}/validate-ai-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ integration: integration, value: token.trim() }),
        });

        let result: Record<string, unknown>;
        try {
          result = await response.json();
        } catch {
          // JSON parsing failed - could be timeout, HTML error page, etc.
          setStatus('error');
          setTestResult({ error: `Server error (HTTP ${response.status}). Please try again.` });
          return;
        }
        const valid = Boolean((result as { valid?: boolean }).valid);
        const error = (result as { error?: string }).error;
        const warning = (result as { warning?: string }).warning;
        const accountType = (result as { accountType?: string }).accountType;

        if (!response.ok || !valid) {
          setStatus('error');
          setTestResult({ error: error || `Validation failed (HTTP ${response.status})` });
          return;
        }

        setStatus('success');
        setTestResult({
          message: warning || (accountType ? `Connected (${accountType})` : 'Connected'),
        });
        return;
      }

      // For platform integrations, use the backend validation endpoint
      const response = await fetch(`${API_BASE}/avatars/${activeAgent?.id}/validate-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          type: config.secretType,
          value: token.trim(),
        }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        setStatus('error');
        setTestResult({ error: result.error || result.message || `Validation failed (HTTP ${response.status})` });
        return;
      }

      if (result.valid) {
        setStatus('success');
        setTestResult({ botUsername: result.botInfo?.username });
      } else {
        setStatus('error');
        setTestResult({ error: result.error || 'Invalid token' });
      }
    } catch {
      setStatus('error');
      setTestResult({ error: 'Failed to validate token' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    if (isSubmitting || !activeAgent?.id) return;
    // For AI providers with global key, token is optional
    // For Twitter, allow save if config has changed even without token
    const allowTwitterSave = integration === 'twitter' && hasTwitterConfigChanges;
    if (!config.isAiProvider && !token.trim() && !(integration === 'telegram' && hasTelegramPolicyChanges) && !allowTwitterSave) return;
    if (config.isAiProvider && !useGlobalKey && !token.trim()) return;
    if (config.isAiProvider && useGlobalKey && globalKeyAvailable === false) {
      setSaveError('No system/global API key is configured for this provider. Turn off “Use System API Key” and provide your own key.');
      return;
    }

    setIsSubmitting(true);
    setSaveError(null);
    try {
      let telegramStatusFromSave: unknown | undefined;
      let telegramDiagnosisFromSave: TelegramDiagnosis | null = null;

      // Store the secret if provided (not using global key or platform integration)
      if (token.trim()) {
        const response = await fetch(`${API_BASE}/avatars/${activeAgent.id}/secrets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: config.secretType,
            value: token.trim(),
          }),
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(payload.error || payload.message || 'Failed to save');
        }

        if (integration === 'telegram') {
          telegramStatusFromSave = (payload as { telegramStatus?: unknown }).telegramStatus;
        }
      }

      // Persist Telegram policy (DM allowlist + allowed group chats)
      if (integration === 'telegram' && hasTelegramPolicyChanges) {
        // Save in new format with display info, and also old format for backwards compatibility
        const policyResponse = await fetch(`${API_BASE}/avatars/${activeAgent.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            platforms: {
              telegram: {
                // New format with display info
                allowedDmUsers: allowedDmUsers,
                allowedChats: allowedChats,
                // Old format for backwards compatibility with webhook handler
                allowedDmUserIds: allowedDmUsers.map(u => u.userId),
                allowedChatIds: allowedChats.map(c => c.chatId),
              },
            },
          }),
        });

        if (!policyResponse.ok) {
          const payload = await policyResponse.json().catch(() => ({}));
          throw new Error(payload.error || payload.message || `Failed to save Telegram policy (HTTP ${policyResponse.status})`);
        }
        initialPolicyRef.current = {
          allowedDmUsers: [...allowedDmUsers],
          allowedChats: [...allowedChats],
        };
      }

      if (integration === 'telegram' && (token.trim() || hasTelegramPolicyChanges)) {
        telegramDiagnosisFromSave = await runTelegramDiagnostics();
      }

      // Re-check Discord status after saving a token
      // (Skip — the /discord/status endpoint may return stale/HTML data via CloudFront)

      // Persist Twitter configuration (features, autonomous posts, communities)
      if (integration === 'twitter' && hasTwitterConfigChanges) {
        const twitterConfig: {
          features: string[];
          autonomousPosts?: {
            enabled: boolean;
            minIntervalHours: number;
            maxIntervalHours: number;
            imageChance: number;
            useMemories: boolean;
            topics?: string[];
          };
          communities?: Array<{ id: string; name: string }>;
        } = {
          features: twitterFeatures,
        };

        // Add autonomous posts config if the feature is enabled
        if (twitterFeatures.includes('autonomous_posts')) {
          twitterConfig.autonomousPosts = {
            enabled: twitterAutonomousEnabled,
            minIntervalHours: twitterMinInterval,
            maxIntervalHours: twitterMaxInterval,
            imageChance: twitterImageChance,
            useMemories: true,
            topics: twitterTopics.length > 0 ? twitterTopics : undefined,
          };
        }

        // Add communities if the feature is enabled
        if (twitterFeatures.includes('community_posts') && twitterCommunities.length > 0) {
          twitterConfig.communities = twitterCommunities;
        }

        const twitterResponse = await fetch(`${API_BASE}/avatars/${activeAgent.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            platforms: {
              twitter: twitterConfig,
            },
          }),
        });

        if (!twitterResponse.ok) {
          const payload = await twitterResponse.json().catch(() => ({}));
          throw new Error(payload.error || payload.message || `Failed to save Twitter config (HTTP ${twitterResponse.status})`);
        }

        // Update initial config ref to track further changes
        initialTwitterConfigRef.current = {
          features: [...twitterFeatures],
          autonomousPosts: twitterFeatures.includes('autonomous_posts') ? {
            enabled: twitterAutonomousEnabled,
            minIntervalHours: twitterMinInterval,
            maxIntervalHours: twitterMaxInterval,
            imageChance: twitterImageChance,
            topics: twitterTopics.length > 0 ? [...twitterTopics] : undefined,
          } : undefined,
          communities: twitterCommunities.length > 0 ? [...twitterCommunities] : [],
        };
      }

      // Build result with AI provider specific config
      const result: Record<string, unknown> = {
        configured: true,
        integration: integration,
      };

      if (config.isAiProvider) {
        result.useGlobalKey = useGlobalKey;

        // Persist the effective selections that the user sees in the UI.
        // If the user never touches the dropdown, selectedModels may be empty even though
        // the UI is displaying a default.
        if (config.capabilities && config.capabilities.length > 0) {
          const resolvedModels: Record<string, string> = {};
          for (const capability of config.capabilities) {
            const models = (availableModelsByCapability?.[capability] || []) as ModelOption[];
            const defaultModel = models.find(m => m.isDefault)?.id || models[0]?.id;
            const chosen = selectedModels[capability] || defaultModel;
            if (chosen) {
              resolvedModels[capability] = chosen;
            }
          }

          if (Object.keys(resolvedModels).length > 0) {
            result.models = resolvedModels;
          }
        } else if (Object.keys(selectedModels).length > 0) {
          result.models = selectedModels;
        }
      }

      if (integration === 'telegram') {
        if (telegramStatusFromSave) result.telegramStatus = telegramStatusFromSave;
        if (telegramDiagnosisFromSave) result.telegramDiagnosis = telegramDiagnosisFromSave;
      }

      // For Discord, defer onSubmit so the user can see status before panel closes
      if (integration === 'discord') {
        pendingResultRef.current = result;
        setDiscordSaveComplete(true);
        setSavedAt(Date.now());
      } else {
        await onSubmit(toolCall.id, result);
        setSavedAt(Date.now());
      }
      if (token.trim()) {
        setHasAvatarKey(true);
      }
      setToken(''); // Clear sensitive data
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDiscordDone = async () => {
    if (!pendingResultRef.current) return;
    await onSubmit(toolCall.id, pendingResultRef.current);
    pendingResultRef.current = null;
  };

  const handleSaveAndTest = async () => {
    if (isSubmitting || isTesting || !activeAgent?.id || !token.trim()) return;
    setIsSubmitting(true);
    setSaveError(null);
    setStatus('idle');
    setTestResult(null);

    try {
      // Step 1: Validate the token
      const valResponse = await fetch(`${API_BASE}/avatars/${activeAgent.id}/validate-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ type: config.secretType, value: token.trim() }),
      });
      const valResult = await valResponse.json().catch(() => ({}));

      if (!valResponse.ok || !valResult.valid) {
        setStatus('error');
        setTestResult({ error: valResult.error || 'Invalid token' });
        return; // Don't save invalid tokens
      }

      setStatus('success');
      setTestResult({ botUsername: valResult.botInfo?.username });

      // Step 2: Save the token
      const saveResponse = await fetch(`${API_BASE}/avatars/${activeAgent.id}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: config.secretType, value: token.trim() }),
      });
      const savePayload = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) {
        throw new Error(savePayload.error || savePayload.message || 'Failed to save');
      }

      // Step 3: Set optimistic Discord status from validation results
      // (The /discord/status endpoint can return stale/HTML data when CloudFront intercepts)
      setDiscordStatus({
        connected: true,
        mode: 'bot',
        credentialsValid: true,
        runtimeHealthy: true,
        botUsername: valResult.botInfo?.username,
        botId: valResult.botInfo?.id,
      });

      // Step 4: Build result and defer submission
      const result: Record<string, unknown> = {
        configured: true,
        integration: 'discord',
      };
      pendingResultRef.current = result;
      setDiscordSaveComplete(true);
      setSavedAt(Date.now());
      setHasAvatarKey(true);
      setToken('');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOAuth = () => {
    if (!activeAgent?.id) return;
    // Redirect to OAuth flow
    window.location.href = `${API_BASE}/oauth/${integration}/start?avatarId=${encodeURIComponent(activeAgent.id)}`;
  };

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <div className="flex items-center gap-2">
          <span className="text-lg">{config.icon}</span>
          <div>
            <h4 className="text-sm font-medium text-[var(--color-text)]">
              Configure {config.name}
            </h4>
            {args.reason && (
              <p className="text-xs text-[var(--color-text-secondary)]">{args.reason}</p>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-3 space-y-3">
        {savedAt && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-green-500/10 border border-green-500/30 rounded-lg">
            <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-xs text-green-300">Saved. You can keep editing and save again.</span>
          </div>
        )}

        {/* Telegram Health Status Indicator */}
        {integration === 'telegram' && (
          <div className="space-y-2">
            {telegramDiagnosisLoading ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg">
                <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-[var(--color-text-secondary)]">Checking connection...</span>
              </div>
            ) : telegramDiagnosisError ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                <span className="text-lg">🔴</span>
                <span className="text-sm text-red-300">Not configured</span>
              </div>
            ) : telegramDiagnosis ? (
              <div
                className={
                  (telegramDiagnosis.issues?.length ?? 0) === 0
                    ? 'flex items-center justify-between gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg'
                    : 'flex items-center justify-between gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg'
                }
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">{(telegramDiagnosis.issues?.length ?? 0) === 0 ? '🟢' : '🟡'}</span>
                  <span
                    className={
                      (telegramDiagnosis.issues?.length ?? 0) === 0
                        ? 'text-sm text-green-300'
                        : 'text-sm text-yellow-300'
                    }
                  >
                    {(telegramDiagnosis.issues?.length ?? 0) === 0
                      ? `Connected${telegramDiagnosis.bot?.username ? ` as @${telegramDiagnosis.bot.username}` : ''}`
                      : 'Webhook issues'}
                  </span>
                </div>
                {(telegramDiagnosis.issues?.length ?? 0) > 0 && !telegramRepairLoading && (
                  <button
                    type="button"
                    onClick={() => void repairTelegramWebhook()}
                    disabled={disabled || telegramRepairLoading}
                    className="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition-colors"
                  >
                    Repair
                  </button>
                )}
                {telegramRepairLoading && (
                  <div className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                    <div className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                    Fixing...
                  </div>
                )}
              </div>
            ) : null}
            {telegramRepairError && (
              <p className="text-xs text-red-400">{telegramRepairError}</p>
            )}
          </div>
        )}

        {/* Discord Health Status Indicator */}
        {integration === 'discord' && !discordSaveComplete && (
          <div className="space-y-2">
            {discordStatusLoading ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg">
                <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-[var(--color-text-secondary)]">Checking connection...</span>
              </div>
            ) : discordStatusError ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                <span className="text-lg">{'\u{1F534}'}</span>
                <span className="text-sm text-red-300">Not configured</span>
              </div>
            ) : discordStatus ? (
              <div
                className={
                  discordStatus.connected
                    ? 'flex items-center justify-between gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg'
                    : discordStatus.mode !== 'none'
                      ? 'flex items-center justify-between gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg'
                      : 'flex items-center justify-between gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg'
                }
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg">
                    {discordStatus.connected
                      ? '\u{1F7E2}'
                      : discordStatus.mode !== 'none'
                        ? '\u{1F7E1}'
                        : '\u{1F534}'}
                  </span>
                  <div className="flex flex-col">
                    <span
                      className={
                        discordStatus.connected
                          ? 'text-sm text-green-300'
                          : discordStatus.mode !== 'none'
                            ? 'text-sm text-yellow-300'
                            : 'text-sm text-red-300'
                      }
                    >
                      {discordStatus.connected
                        ? `Connected${discordStatus.botUsername ? ` as ${discordStatus.botUsername}` : ''}`
                        : discordStatus.mode !== 'none'
                          ? `Discord Configured (${discordStatus.mode} mode)${!discordStatus.credentialsValid ? ' — invalid credentials' : !discordStatus.runtimeHealthy ? ' — gateway offline' : ''}`
                          : 'Not connected'}
                    </span>
                    {discordStatus.connected && discordStatus.guilds && discordStatus.guilds.length > 0 && (
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {discordStatus.guilds.length} server{discordStatus.guilds.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>
                {discordStatus.gatewayWarning && (
                  <span className="text-xs text-yellow-400">{discordStatus.gatewayWarning}</span>
                )}
              </div>
            ) : null}
          </div>
        )}

        {config.usesOAuth ? (
          // OAuth-based integration (Twitter) with advanced config
          <div className="space-y-3">
            {/* OAuth Connection */}
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-[var(--color-text-secondary)]">
                Connect your {config.name} account to enable posting and interaction.
              </p>
              <button
                onClick={handleOAuth}
                disabled={disabled || !activeAgent?.id}
                className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors font-medium flex-shrink-0"
              >
                Connect {config.name}
              </button>
            </div>

            {/* Twitter-specific configuration */}
            {integration === 'twitter' && (
              <>
                {/* Features Selection */}
                <div className="p-2.5 bg-[var(--color-bg-tertiary)] rounded-lg border border-[var(--color-border)] space-y-2">
                  <div className="flex items-baseline gap-2">
                    <p className="text-xs font-medium text-[var(--color-text)]">Features</p>
                    <p className="text-[11px] text-[var(--color-text-muted)]">Select which to enable</p>
                  </div>
                  <div className="space-y-1.5">
                    {[
                      { id: 'mention_replies', label: 'Mention Replies', desc: 'Reply to @mentions' },
                      { id: 'autonomous_posts', label: 'Autonomous Posts', desc: 'Post automatically on a schedule' },
                      { id: 'community_posts', label: 'Community Posts', desc: 'Post to Twitter Communities' },
                    ].map((feature) => (
                      <label key={feature.id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={twitterFeatures.includes(feature.id)}
                          onChange={(e) => {
                            setSavedAt(null);
                            setSaveError(null);
                            if (e.target.checked) {
                              setTwitterFeatures((prev) => [...prev, feature.id]);
                            } else {
                              setTwitterFeatures((prev) => prev.filter((f) => f !== feature.id));
                            }
                          }}
                          disabled={disabled}
                          className="w-3.5 h-3.5 rounded border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-brand-600 focus:ring-brand-500"
                        />
                        <span className="text-xs text-[var(--color-text)]">{feature.label}</span>
                        <span className="text-[11px] text-[var(--color-text-muted)]">{feature.desc}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Autonomous Posts Configuration */}
                {twitterFeatures.includes('autonomous_posts') && (
                  <div className="p-3 bg-[var(--color-bg-tertiary)] rounded-lg border border-[var(--color-border)] space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-[var(--color-text)]">Autonomous Posting</p>
                        <p className="text-xs text-[var(--color-text-muted)]">Configure automatic posting schedule</p>
                      </div>
                      <button
                        onClick={() => {
                          setSavedAt(null);
                          setSaveError(null);
                          setTwitterAutonomousEnabled(!twitterAutonomousEnabled);
                        }}
                        disabled={disabled}
                        className={`relative w-12 h-6 rounded-full transition-colors ${
                          twitterAutonomousEnabled ? 'bg-brand-600' : 'bg-[var(--color-bg-elevated)]'
                        }`}
                      >
                        <span
                          className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                            twitterAutonomousEnabled ? 'left-7' : 'left-1'
                          }`}
                        />
                      </button>
                    </div>

                    {twitterAutonomousEnabled && (
                      <div className="space-y-3 pt-2 border-t border-[var(--color-border)]">
                        {/* Interval Settings */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                              Min Interval (hours)
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={24}
                              value={twitterMinInterval}
                              onChange={(e) => {
                                setSavedAt(null);
                                setSaveError(null);
                                setTwitterMinInterval(Math.max(1, Math.min(24, parseInt(e.target.value) || 4)));
                              }}
                              disabled={disabled}
                              className="w-full px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                              Max Interval (hours)
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={48}
                              value={twitterMaxInterval}
                              onChange={(e) => {
                                setSavedAt(null);
                                setSaveError(null);
                                setTwitterMaxInterval(Math.max(1, Math.min(48, parseInt(e.target.value) || 6)));
                              }}
                              disabled={disabled}
                              className="w-full px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] text-sm"
                            />
                          </div>
                        </div>

                        {/* Image Chance */}
                        <div>
                          <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                            Image Generation Chance: {Math.round(twitterImageChance * 100)}%
                          </label>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={twitterImageChance * 100}
                            onChange={(e) => {
                              setSavedAt(null);
                              setSaveError(null);
                              setTwitterImageChance(parseInt(e.target.value) / 100);
                            }}
                            disabled={disabled}
                            className="w-full h-2 bg-[var(--color-bg-secondary)] rounded-lg appearance-none cursor-pointer"
                          />
                          <p className="text-xs text-[var(--color-text-muted)] mt-1">
                            Probability of generating an image with each autonomous post
                          </p>
                        </div>

                        {/* Topics */}
                        <div className="space-y-2">
                          <label className="block text-xs font-medium text-[var(--color-text-secondary)]">
                            Content Topics (optional)
                          </label>
                          <div className="flex gap-2">
                            <input
                              value={newTwitterTopic}
                              onChange={(e) => setNewTwitterTopic(e.target.value)}
                              placeholder="e.g. crypto, AI, technology"
                              className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] text-sm"
                              disabled={disabled}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && newTwitterTopic.trim()) {
                                  e.preventDefault();
                                  setSavedAt(null);
                                  setSaveError(null);
                                  setTwitterTopics((prev) => [...new Set([...prev, newTwitterTopic.trim()])]);
                                  setNewTwitterTopic('');
                                }
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (!newTwitterTopic.trim()) return;
                                setSavedAt(null);
                                setSaveError(null);
                                setTwitterTopics((prev) => [...new Set([...prev, newTwitterTopic.trim()])]);
                                setNewTwitterTopic('');
                              }}
                              disabled={disabled || !newTwitterTopic.trim()}
                              className="px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 text-sm"
                            >
                              Add
                            </button>
                          </div>
                          {twitterTopics.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {twitterTopics.map((topic) => (
                                <span key={topic} className="inline-flex items-center gap-2 px-2 py-1 text-xs bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-full text-[var(--color-text-secondary)]">
                                  {topic}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSavedAt(null);
                                      setSaveError(null);
                                      setTwitterTopics((prev) => prev.filter((t) => t !== topic));
                                    }}
                                    className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                                    disabled={disabled}
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                          <p className="text-xs text-[var(--color-text-muted)]">
                            Topics help guide content generation based on avatar memories
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Communities Configuration */}
                {twitterFeatures.includes('community_posts') && (
                  <div className="p-3 bg-[var(--color-bg-tertiary)] rounded-lg border border-[var(--color-border)] space-y-3">
                    <p className="text-sm font-medium text-[var(--color-text)]">Twitter Communities</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Add communities for the avatar to post to. Find the community ID in the community URL.
                    </p>

                    <div className="flex gap-2">
                      <input
                        value={newCommunityId}
                        onChange={(e) => setNewCommunityId(e.target.value)}
                        placeholder="Community ID"
                        className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] text-sm"
                        disabled={disabled}
                      />
                      <input
                        value={newCommunityName}
                        onChange={(e) => setNewCommunityName(e.target.value)}
                        placeholder="Name (e.g. Crypto Twitter)"
                        className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] text-sm"
                        disabled={disabled}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!newCommunityId.trim() || !newCommunityName.trim()) return;
                          setSavedAt(null);
                          setSaveError(null);
                          setTwitterCommunities((prev) => [
                            ...prev.filter((c) => c.id !== newCommunityId.trim()),
                            { id: newCommunityId.trim(), name: newCommunityName.trim() },
                          ]);
                          setNewCommunityId('');
                          setNewCommunityName('');
                        }}
                        disabled={disabled || !newCommunityId.trim() || !newCommunityName.trim()}
                        className="px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 text-sm"
                      >
                        Add
                      </button>
                    </div>

                    {twitterCommunities.length > 0 && (
                      <div className="space-y-2">
                        {twitterCommunities.map((community) => (
                          <div key={community.id} className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] rounded-lg">
                            <div>
                              <span className="text-sm text-[var(--color-text)]">{community.name}</span>
                              <span className="text-xs text-[var(--color-text-muted)] ml-2">ID: {community.id}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setSavedAt(null);
                                setSaveError(null);
                                setTwitterCommunities((prev) => prev.filter((c) => c.id !== community.id));
                              }}
                              className="text-[var(--color-text-muted)] hover:text-red-400"
                              disabled={disabled}
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Save Button for Twitter config */}
                {hasTwitterConfigChanges && (
                  <div className="pt-2">
                    <button
                      onClick={handleSave}
                      disabled={disabled || isSubmitting}
                      className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                    >
                      {isSubmitting ? 'Saving...' : 'Save Configuration'}
                    </button>
                    {saveError && (
                      <div className="flex items-center gap-2 px-3 py-2 mt-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                        <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="text-sm text-red-300">{saveError}</span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : config.isAiProvider ? (
          // AI Provider integration (Replicate, OpenAI, etc.)
          <>
            {/* Global Key Toggle */}
            <div className="flex items-center justify-between p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
              <div>
                <p className="text-sm font-medium text-[var(--color-text)]">Use System API Key</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Use the shared system key instead of your own
                </p>
                {globalKeyAvailable === false && (
                  <p className="text-xs text-yellow-400 mt-1">
                    No system key detected for {config.name}. Add a key in the backend (env/Secrets Manager) or enter your own.
                  </p>
                )}
              </div>
              <button
                onClick={() => {
                  setSavedAt(null);
                  setSaveError(null);
                  setUseGlobalKey(!useGlobalKey);
                }}
                disabled={disabled}
                className={`relative w-12 h-6 rounded-full transition-colors ${
                  useGlobalKey ? 'bg-brand-600' : 'bg-[var(--color-bg-elevated)]'
                }`}
              >
                <span
                  className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                    useGlobalKey ? 'left-7' : 'left-1'
                  }`}
                />
              </button>
            </div>

            {/* API Key Input (only if not using global) */}
            {!useGlobalKey && (
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                  {config.tokenLabel}
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => {
                    setSavedAt(null);
                    setToken(e.target.value);
                    setStatus('idle');
                    setTestResult(null);
                    setSaveError(null);
                  }}
                  placeholder={config.tokenPlaceholder}
                  className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-brand-500"
                  disabled={disabled || isSubmitting}
                />
                {hasAvatarKey && (
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    An API key is already saved for this avatar. For security it isn’t shown; entering a value here will replace it.
                  </p>
                )}
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {config.helpText}
                  {config.helpUrl && (
                    <>
                      {' · '}
                      <a
                        href={config.helpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-400 hover:text-brand-300"
                      >
                        Get API Key →
                      </a>
                    </>
                  )}
                </p>
              </div>
            )}

            {/* Model Selection */}
            {config.capabilities && config.capabilities.length > 0 && (
              <div className="space-y-3">
                <h5 className="text-sm font-medium text-[var(--color-text)]">Model Preferences</h5>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Choose which AI models to use for each capability
                </p>
                {modelsLoadError && (
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {modelsLoadError} (you can still save; defaults will be used)
                  </div>
                )}
                {config.capabilities.map((capability) => {
                  const catalogModels = (availableModelsByCapability?.[capability] || []) as ModelOption[];
                  if (catalogModels.length === 0) return null;
                  const searchResults = (modelSearchResults[capability] || []) as ModelOption[];
                  const isSearching = modelSearchLoading[capability] || false;

                  // Merge: catalog models + search results (deduplicated)
                  const catalogIds = new Set(catalogModels.map(m => m.id));
                  const extraSearchResults = searchResults.filter(m => !catalogIds.has(m.id));
                  const allModels = [...catalogModels, ...extraSearchResults];

                  const defaultModel = catalogModels.find(m => m.isDefault)?.id || catalogModels[0]?.id;
                  // If a search result was selected that's not in catalog, ensure it stays in the list
                  const currentSelection = selectedModels[capability] || defaultModel;
                  const selectionInList = allModels.some(m => m.id === currentSelection);
                  if (!selectionInList && currentSelection) {
                    allModels.push({ id: currentSelection, name: currentSelection.split('/').pop() || currentSelection, description: 'Custom model' });
                  }

                  return (
                    <div key={capability} className="space-y-1">
                      <label className="block text-xs font-medium text-[var(--color-text-secondary)]">
                        {CAPABILITY_LABELS[capability] || capability}
                      </label>
                      {/* Scrollable grouped model picker */}
                      {(() => {
                        const searchQuery_ = modelSearchQueries[capability] || '';
                        const highlightIdx = pickerHighlight[capability] ?? -1;

                        // Filter catalog models locally by search text
                        const filterText = searchQuery_.toLowerCase();
                        const filteredCatalog = filterText
                          ? catalogModels.filter(m =>
                              m.id.toLowerCase().includes(filterText) ||
                              m.name.toLowerCase().includes(filterText) ||
                              m.description.toLowerCase().includes(filterText))
                          : catalogModels;

                        // Build flat option list for keyboard navigation: search results first, then catalog
                        const flatOptions: ModelOption[] = [];
                        if (extraSearchResults.length > 0) flatOptions.push(...extraSearchResults);
                        flatOptions.push(...filteredCatalog);

                        const selectModel = (model: ModelOption) => {
                          setSavedAt(null);
                          setSaveError(null);
                          setSelectedModels(prev => ({ ...prev, [capability]: model.id }));
                        };

                        return (
                          <div className="space-y-2">
                            {/* Search input */}
                            <div className="relative">
                              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                              </svg>
                              <input
                                type="text"
                                value={searchQuery_}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setModelSearchQueries(prev => ({ ...prev, [capability]: val }));
                                  setPickerHighlight(prev => ({ ...prev, [capability]: -1 }));
                                  if (integration === 'replicate') {
                                    handleModelSearch(capability, val);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setPickerHighlight(prev => ({ ...prev, [capability]: Math.min((prev[capability] ?? -1) + 1, flatOptions.length - 1) }));
                                  } else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setPickerHighlight(prev => ({ ...prev, [capability]: Math.max((prev[capability] ?? 0) - 1, 0) }));
                                  } else if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const idx = highlightIdx >= 0 && highlightIdx < flatOptions.length ? highlightIdx : -1;
                                    if (idx >= 0) {
                                      const model = flatOptions[idx];
                                      if (model) selectModel(model);
                                    }
                                  } else if (e.key === 'Escape') {
                                    (e.target as HTMLInputElement).blur();
                                  }
                                }}
                                placeholder={integration === 'replicate' ? 'Search models (e.g., flux, sdxl)...' : 'Filter models...'}
                                disabled={disabled}
                                className="w-full pl-10 pr-8 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-brand-500 text-sm"
                              />
                              {isSearching && (
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-muted)]">
                                  ...
                                </span>
                              )}
                            </div>

                            {/* Model count summary */}
                            <div className="text-xs text-[var(--color-text-muted)]">
                              {flatOptions.length} model{flatOptions.length !== 1 ? 's' : ''} available
                              {searchQuery_.length >= 2 && extraSearchResults.length > 0 && ` (${extraSearchResults.length} from search)`}
                            </div>

                            {/* Scrollable model list */}
                            <div
                              className="max-h-60 overflow-y-auto space-y-1 border border-[var(--color-border)] rounded-lg bg-[var(--color-bg)]"
                              role="listbox"
                              aria-label={`Models for ${CAPABILITY_LABELS[capability] || capability}`}
                            >
                              {/* Search Results section */}
                              {extraSearchResults.length > 0 && (
                                <div>
                                  <div className="sticky top-0 z-10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] border-b border-[var(--color-border)] select-none">
                                    Search Results
                                  </div>
                                  {extraSearchResults.map((model) => {
                                    const idx = flatOptions.indexOf(model);
                                    return (
                                      <button
                                        key={model.id}
                                        role="option"
                                        aria-selected={model.id === currentSelection}
                                        onClick={() => selectModel(model)}
                                        onMouseEnter={() => setPickerHighlight(prev => ({ ...prev, [capability]: idx }))}
                                        disabled={disabled}
                                        className={`w-full text-left px-3 py-2 transition-colors text-sm ${
                                          model.id === currentSelection
                                            ? 'bg-brand-600 text-white'
                                            : idx === highlightIdx
                                              ? 'bg-brand-500/20 text-[var(--color-text)]'
                                              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                                        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="font-medium truncate">{model.name}</span>
                                        </div>
                                        <div className="text-xs opacity-60 truncate">{model.id}</div>
                                        {model.description && (
                                          <div className="text-xs opacity-50 truncate mt-0.5">{model.description.slice(0, 80)}{model.description.length > 80 ? '...' : ''}</div>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Common Models section */}
                              {filteredCatalog.length > 0 && (
                                <div>
                                  <div className="sticky top-0 z-10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] border-b border-[var(--color-border)] select-none">
                                    {extraSearchResults.length > 0 ? 'Common Models' : 'Models'}
                                  </div>
                                  {filteredCatalog.map((model) => {
                                    const idx = flatOptions.indexOf(model);
                                    return (
                                      <button
                                        key={model.id}
                                        role="option"
                                        aria-selected={model.id === currentSelection}
                                        onClick={() => selectModel(model)}
                                        onMouseEnter={() => setPickerHighlight(prev => ({ ...prev, [capability]: idx }))}
                                        disabled={disabled}
                                        className={`w-full text-left px-3 py-2 transition-colors text-sm ${
                                          model.id === currentSelection
                                            ? 'bg-brand-600 text-white'
                                            : idx === highlightIdx
                                              ? 'bg-brand-500/20 text-[var(--color-text)]'
                                              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                                        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="font-medium truncate">{model.name}</span>
                                          {model.isDefault && (
                                            <span className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-brand-500/20 text-brand-400">
                                              Default
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-xs opacity-60 truncate">{model.id}</div>
                                        {model.description && (
                                          <div className="text-xs opacity-50 truncate mt-0.5">{model.description.slice(0, 80)}{model.description.length > 80 ? '...' : ''}</div>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Empty state */}
                              {filteredCatalog.length === 0 && extraSearchResults.length === 0 && (
                                <div className="text-center text-[var(--color-text-tertiary)] py-4 text-xs">
                                  {searchQuery_.length >= 2
                                    ? `No models found for "${searchQuery_}"`
                                    : 'No models available'}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Test Result */}
            {status === 'success' && testResult && (
              <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg">
                <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-green-300">
                  Connected! {(testResult.message || testResult.username) && `(${testResult.message || testResult.username})`}
                </span>
              </div>
            )}

            {status === 'error' && testResult && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-sm text-red-300">{testResult.error}</span>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              {!useGlobalKey && (
                <button
                  onClick={handleTest}
                  disabled={!token.trim() || disabled || isTesting}
                  className="flex-1 px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--color-text)] rounded-lg transition-colors"
                >
                  {isTesting ? 'Testing...' : 'Test Connection'}
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={(!useGlobalKey && !token.trim()) || disabled || isSubmitting}
                className={`${useGlobalKey ? 'w-full' : 'flex-1'} px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors`}
              >
                {isSubmitting ? 'Saving...' : 'Save & Enable'}
              </button>
            </div>

            {saveError && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-sm text-red-300">{saveError}</span>
              </div>
            )}
          </>
        ) : (
          // Token-based platform integration (Telegram, Discord)
          <>
            {integration === 'telegram' && (
              <div className="space-y-3">
                <div className="p-3 bg-[var(--color-bg-tertiary)] rounded-lg border border-[var(--color-border)]">
                  <p className="text-sm font-medium text-[var(--color-text)]">Telegram DM + Group Policy</p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-1">
                    Allow DMs only from specific Telegram user IDs, and restrict group chats by chat ID.
                  </p>
                  {policyLoadError && (
                    <p className="text-xs text-yellow-400 mt-2">{policyLoadError}</p>
                  )}
                </div>

                {/* DM allowlist */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
                    Users who can DM the bot
                  </label>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Enter @username or user ID. Users must have messaged the bot before they can be added by username.
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={newDmInput}
                      onChange={(e) => {
                        setSavedAt(null);
                        setSaveError(null);
                        setDmInputError(null);
                        setNewDmInput(e.target.value);
                      }}
                      placeholder="@username or User ID"
                      className="flex-1 px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)]"
                      disabled={disabled}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const input = newDmInput.trim();
                        if (!input) return;

                        // Check if already added
                        const existingIds = allowedDmUsers.map(u => u.userId);

                        // If starts with @, try to find in known users
                        if (input.startsWith('@')) {
                          const username = input.slice(1).toLowerCase();
                          const knownUser = knownTelegramUsers.find(
                            u => u.chatType === 'private' && u.username?.toLowerCase() === username
                          );
                          if (knownUser) {
                            if (existingIds.includes(String(knownUser.userId))) {
                              setDmInputError('User already added');
                              return;
                            }
                            setSavedAt(null);
                            setSaveError(null);
                            setAllowedDmUsers(prev => [...prev, {
                              userId: String(knownUser.userId),
                              username: knownUser.username,
                              displayName: knownUser.displayName,
                            }]);
                            setNewDmInput('');
                            setDmInputError(null);
                          } else {
                            setDmInputError('User must DM the bot first before they can be added');
                          }
                        } else {
                          // Treat as user ID
                          if (existingIds.includes(input)) {
                            setDmInputError('User already added');
                            return;
                          }
                          // Look up display name from known users if available
                          const knownUser = knownTelegramUsers.find(
                            u => u.chatType === 'private' && String(u.userId) === input
                          );
                          setSavedAt(null);
                          setSaveError(null);
                          setAllowedDmUsers(prev => [...prev, {
                            userId: input,
                            username: knownUser?.username,
                            displayName: knownUser?.displayName,
                          }]);
                          setNewDmInput('');
                          setDmInputError(null);
                        }
                      }}
                      disabled={disabled || !newDmInput.trim()}
                      className="px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                  {dmInputError && (
                    <p className="text-xs text-red-400">{dmInputError}</p>
                  )}
                  {/* Known users suggestions */}
                  {knownTelegramUsers.filter(u => u.chatType === 'private' && !allowedDmUsers.some(r => r.userId === String(u.userId))).length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs text-[var(--color-text-muted)] mb-1">Recently active:</p>
                      <div className="flex flex-wrap gap-1">
                        {knownTelegramUsers
                          .filter(u => u.chatType === 'private' && !allowedDmUsers.some(r => r.userId === String(u.userId)))
                          .slice(0, 10)
                          .map((u) => (
                            <button
                              key={u.userId}
                              type="button"
                              onClick={() => {
                                setSavedAt(null);
                                setSaveError(null);
                                setAllowedDmUsers(prev => [...prev, {
                                  userId: String(u.userId),
                                  username: u.username,
                                  displayName: u.displayName,
                                }]);
                              }}
                              disabled={disabled}
                              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-brand-600/20 hover:bg-brand-600/40 border border-brand-500/30 rounded-full text-brand-300 transition-colors"
                              title={`Add ${u.displayName} (ID: ${u.userId})`}
                            >
                              <span>+</span>
                              <span>{u.username ? `@${u.username}` : u.displayName}</span>
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                  {allowedDmUsers.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {allowedDmUsers.map((user) => (
                        <span key={user.userId} className="inline-flex items-center gap-2 px-2 py-1 text-xs bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-full text-[var(--color-text-secondary)]">
                          {user.username ? `@${user.username}` : user.displayName || user.userId}
                          <button
                            type="button"
                            onClick={() => {
                              setSavedAt(null);
                              setSaveError(null);
                              setAllowedDmUsers(prev => prev.filter(u => u.userId !== user.userId));
                            }}
                            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                            disabled={disabled}
                            aria-label={`Remove ${user.username || user.displayName || user.userId}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Group allowlist */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
                    Groups the bot can join
                  </label>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Enter @groupname (for public groups) or chat ID. The bot must be a member of the group.
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={newGroupInput}
                      onChange={(e) => {
                        setSavedAt(null);
                        setSaveError(null);
                        setGroupInputError(null);
                        setNewGroupInput(e.target.value);
                      }}
                      placeholder="@groupname or Chat ID"
                      className="flex-1 px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)]"
                      disabled={disabled || isResolvingGroup}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const input = newGroupInput.trim();
                        if (!input || !activeAgent?.id) return;

                        // Check if already added
                        const existingIds = allowedChats.map(c => c.chatId);

                        // Check if input is a t.me/ URL
                        const urlParse = parseTelegramUrl(input);
                        let usernameToResolve: string | null = null;

                        if (urlParse.type === 'invite') {
                          setGroupInputError('Invite links can\'t be resolved. Add the bot to the group first, then select it from "Recently active".');
                          return;
                        } else if (urlParse.type === 'username') {
                          usernameToResolve = urlParse.value;
                        } else if (input.startsWith('@')) {
                          usernameToResolve = input.slice(1);
                        }

                        // If we have a username to resolve, use API
                        if (usernameToResolve) {
                          setIsResolvingGroup(true);
                          setGroupInputError(null);
                          try {
                            const resp = await fetch(`${API_BASE}/avatars/${activeAgent.id}/telegram/resolve-group`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              credentials: 'include',
                              body: JSON.stringify({ username: usernameToResolve }),
                            });
                            const data = await resp.json() as { chatId?: string; title?: string; username?: string; error?: string };
                            if (!resp.ok || !data.chatId) {
                              setGroupInputError(data.error || 'Group not found or bot is not a member');
                              return;
                            }
                            if (existingIds.includes(data.chatId)) {
                              setGroupInputError('Group already added');
                              return;
                            }
                            setSavedAt(null);
                            setSaveError(null);
                            setAllowedChats(prev => [...prev, {
                              chatId: data.chatId!,
                              username: data.username,
                              title: data.title,
                            }]);
                            setNewGroupInput('');
                          } catch {
                            setGroupInputError('Failed to resolve group');
                          } finally {
                            setIsResolvingGroup(false);
                          }
                        } else {
                          // Treat as chat ID
                          if (existingIds.includes(input)) {
                            setGroupInputError('Group already added');
                            return;
                          }
                          // Look up title from known groups if available
                          const knownGroup = knownTelegramUsers.find(
                            u => (u.chatType === 'group' || u.chatType === 'supergroup') && String(u.chatId) === input
                          );
                          setSavedAt(null);
                          setSaveError(null);
                          setAllowedChats(prev => [...prev, {
                            chatId: input,
                            title: knownGroup?.chatTitle,
                          }]);
                          setNewGroupInput('');
                          setGroupInputError(null);
                        }
                      }}
                      disabled={disabled || !newGroupInput.trim() || isResolvingGroup}
                      className="px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
                    >
                      {isResolvingGroup ? '...' : 'Add'}
                    </button>
                  </div>
                  {groupInputError && (
                    <p className="text-xs text-red-400">{groupInputError}</p>
                  )}
                  {/* Known groups suggestions */}
                  {knownTelegramUsers.filter(u => (u.chatType === 'group' || u.chatType === 'supergroup') && !allowedChats.some(c => c.chatId === String(u.chatId))).length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs text-[var(--color-text-muted)] mb-1">Recently active:</p>
                      <div className="flex flex-wrap gap-1">
                        {knownTelegramUsers
                          .filter(u => (u.chatType === 'group' || u.chatType === 'supergroup') && !allowedChats.some(c => c.chatId === String(u.chatId)))
                          .reduce((acc, u) => {
                            // Deduplicate by chatId since multiple users may be from same group
                            if (!acc.find(x => x.chatId === u.chatId)) acc.push(u);
                            return acc;
                          }, [] as typeof knownTelegramUsers)
                          .slice(0, 10)
                          .map((u) => (
                            <button
                              key={u.chatId}
                              type="button"
                              onClick={() => {
                                setSavedAt(null);
                                setSaveError(null);
                                setAllowedChats(prev => [...prev, {
                                  chatId: String(u.chatId),
                                  title: u.chatTitle,
                                }]);
                              }}
                              disabled={disabled}
                              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-brand-600/20 hover:bg-brand-600/40 border border-brand-500/30 rounded-full text-brand-300 transition-colors"
                              title={`Add ${u.chatTitle || 'group'} (ID: ${u.chatId})`}
                            >
                              <span>+</span>
                              <span>{u.chatTitle || String(u.chatId)}</span>
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                  {allowedChats.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {allowedChats.map((chat) => (
                        <span key={chat.chatId} className="inline-flex items-center gap-2 px-2 py-1 text-xs bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-full text-[var(--color-text-secondary)]">
                          {chat.title || (chat.username ? `@${chat.username}` : chat.chatId)}
                          <button
                            type="button"
                            onClick={() => {
                              setSavedAt(null);
                              setSaveError(null);
                              setAllowedChats(prev => prev.filter(c => c.chatId !== chat.chatId));
                            }}
                            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                            disabled={disabled}
                            aria-label={`Remove ${chat.title || chat.username || chat.chatId}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {hasTelegramPolicyChanges && (
                  <div className="text-xs text-[var(--color-text-muted)]">
                    Policy changes pending — click Save to apply.
                  </div>
                )}

                {/* Share link for easy user approval */}
                {status === 'success' && testResult?.botUsername && (
                  <div className="space-y-2 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                    <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
                      Share link with friends
                    </label>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      Send this link to anyone you want to chat with your bot. When they tap it and start the bot, they'll be auto-approved.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={generateShareLink() || ''}
                        className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] cursor-pointer"
                        onClick={(e) => {
                          const input = e.currentTarget;
                          input.select();
                          navigator.clipboard.writeText(input.value).catch(() => {});
                        }}
                        title="Click to copy"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const link = generateShareLink();
                          if (link) {
                            navigator.clipboard.writeText(link).catch(() => {});
                          }
                        }}
                        className="px-2 py-1 text-xs bg-blue-600/40 hover:bg-blue-600/60 border border-blue-500/30 rounded-lg text-blue-300 transition-colors"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                {config.tokenLabel}
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => {
                  setSavedAt(null);
                  let newValue = e.target.value;
                  let showToast = false;

                  // For Telegram, try to extract bot token if pasting from BotFather
                  if (integration === 'telegram') {
                    const { token: extracted, extracted: wasExtracted } = extractBotToken(newValue);
                    if (wasExtracted) {
                      newValue = extracted;
                      showToast = true;
                    }
                  }

                  setToken(newValue);
                  setStatus('idle');
                  setTestResult(null);
                  setSaveError(null);

                  if (showToast && newValue) {
                    // Show toast notification - we'll use testResult as a temporary holder
                    setTestResult({ message: 'Extracted bot token from pasted text.' });
                    setTimeout(() => setTestResult(null), 3000);
                  }
                }}
                placeholder={config.tokenPlaceholder}
                className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-brand-500"
                disabled={disabled || isSubmitting}
              />
            </div>

            {/* Help text */}
            <p className="text-xs text-[var(--color-text-muted)]">
              {config.helpText}
              {config.helpUrl && (
                <>
                  {' · '}
                  <a
                    href={config.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-400 hover:text-brand-300"
                  >
                    Open →
                  </a>
                </>
              )}
            </p>

            {/* Test Result */}
            {status === 'success' && testResult && (
              <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg">
                <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-green-300">
                  Valid! {testResult.botUsername && `Connected to @${testResult.botUsername}`}
                </span>
              </div>
            )}

            {status === 'error' && testResult && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-sm text-red-300">{testResult.error}</span>
              </div>
            )}

            {/* Actions — Discord: single Save & Test / Done flow */}
            {integration === 'discord' && !discordSaveComplete && (
              <div className="pt-2">
                <button
                  onClick={handleSaveAndTest}
                  disabled={!token.trim() || disabled || isSubmitting || isTesting}
                  className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                >
                  {isSubmitting ? 'Saving...' : isTesting ? 'Validating...' : 'Save & Test'}
                </button>
              </div>
            )}

            {integration === 'discord' && discordSaveComplete && (
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg">
                  <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-sm text-green-300">
                    Saved!{testResult?.botUsername ? ` Connected as @${testResult.botUsername}` : ''}
                  </span>
                </div>
                <button
                  onClick={handleDiscordDone}
                  className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition-colors"
                >
                  Done
                </button>
              </div>
            )}

            {/* Actions — Non-Discord: keep existing two-button layout */}
            {integration !== 'discord' && (
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleTest}
                  disabled={!token.trim() || disabled || isTesting}
                  className="flex-1 px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--color-text)] rounded-lg transition-colors"
                >
                  {isTesting ? 'Testing...' : 'Test Connection'}
                </button>
                <button
                  onClick={handleSave}
                  disabled={!token.trim() || disabled || isSubmitting}
                  className="flex-1 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                >
                  {isSubmitting ? 'Saving...' : 'Save & Enable'}
                </button>
              </div>
            )}

            {saveError && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-sm text-red-300">{saveError}</span>
              </div>
            )}
          </>
        )}

        {/* Security note */}
        <p className="text-[11px] text-[var(--color-text-muted)] pt-2 border-t border-[var(--color-border)]">
          🔒 Credentials encrypted — never shared with the AI
        </p>
      </div>
    </div>
  );
}
