/**
 * Station Agent Runner - Autonomous Station Governance
 *
 * Scheduled handler (daily) that wakes station-governing avatars
 * and lets them observe + command their Signal space mining stations.
 *
 * Each avatar with signal-station tools enabled gets one LLM call per tick.
 * The LLM uses MCP tools to read station state and issue commands (set prices,
 * update hail messages, build modules) based on the avatar's persona.
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  createStateService,
  createSecretsService,
  createActivityService,
  logger,
  type AvatarConfig,
  type SwarmEnvelope,
} from '@swarm/core';
import {
  ToolRegistry,
  createToolClient,
  createSignalStationTools,
  type SignalStationServices,
  type StationState,
  type CommandResult,
  type SignalChannelPostResponse,
  type SignalChannelReadResponse,
} from '@swarm/mcp-server';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { createRuntimeBrainService } from '../services/brain.js';
import { executeToolLoop, type ToolLoopResult } from '../messaging/tool-loop.js';
import { createVoiceServices } from '../services/voice.js';

const SIGNAL_API_BASE = process.env.SIGNAL_API_URL || 'https://signal-ws.ratimics.com';
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const MEDIA_BUCKET = process.env.MEDIA_BUCKET;
const CDN_URL = process.env.CDN_URL;

/** Minimum hours between station agent runs for a single avatar. */
const DEFAULT_MIN_INTERVAL_HOURS = 20;
/** Maximum hours between station agent runs for a single avatar. */
const DEFAULT_MAX_INTERVAL_HOURS = 28;

/**
 * Create HTTP client for the Signal game server station API.
 */
function createSignalStationServices(apiToken: string): SignalStationServices {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiToken}`,
  };

  return {
    getStationState: async (stationId) => {
      const res = await fetch(`${SIGNAL_API_BASE}/api/station/${stationId}/state`, { headers });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Station state failed (${res.status}): ${body}`);
      }
      return res.json() as Promise<StationState>;
    },
    sendCommand: async (stationId, command) => {
      const res = await fetch(`${SIGNAL_API_BASE}/api/station/${stationId}/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify(command),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Station command failed (${res.status}): ${body}`);
      }
      return res.json() as Promise<CommandResult>;
    },
    postChannelMessage: async (stationId, text, audio_url) => {
      const res = await fetch(`${SIGNAL_API_BASE}/api/station/${stationId}/signal_channel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, ...(audio_url && { audio_url }) }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Channel post failed (${res.status}): ${body}`);
      }
      return res.json() as Promise<SignalChannelPostResponse>;
    },
    readChannelMessages: async (limit = 10, since) => {
      const params = new URLSearchParams();
      params.append('limit', String(limit));
      if (since !== undefined) {
        params.append('since', String(since));
      }
      const res = await fetch(`${SIGNAL_API_BASE}/api/signal_channel/messages?${params.toString()}`, { headers });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Channel read failed (${res.status}): ${body}`);
      }
      return res.json() as Promise<SignalChannelReadResponse>;
    },
  };
}

const GOVERNANCE_PROMPT = `\
Check your station's current state using signal_station_state.
Review recent band chatter using signal_channel_read if you want to coordinate with other stations.
Based on what you observe:
- Update your hail message if conditions have changed (signal_set_hail)
- Adjust commodity prices if inventory levels warrant it (signal_set_price)
- Consider building a module if resources allow (signal_build_module)
- Post to the channel (signal_channel_post) to share updates with other stations

Only take actions that make sense given current conditions.
If nothing needs changing, just observe and report briefly.`;

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let hailCacheDocClient: DynamoDBDocumentClient;

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
  hailCacheDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

/**
 * Read the last hail text we generated audio for (if any), from the state table.
 * Used to skip Replicate calls when the LLM picks the same hail two ticks in a row.
 */
async function getLastHailText(avatarId: string): Promise<string | undefined> {
  const result = await hailCacheDocClient.send(new GetCommand({
    TableName: STATE_TABLE,
    Key: { pk: `STATION_HAIL#${avatarId}`, sk: 'LATEST' },
  }));
  return typeof result.Item?.text === 'string' ? result.Item.text : undefined;
}

async function setLastHailText(avatarId: string, text: string, audioUrl?: string): Promise<void> {
  await hailCacheDocClient.send(new PutCommand({
    TableName: STATE_TABLE,
    Item: {
      pk: `STATION_HAIL#${avatarId}`,
      sk: 'LATEST',
      text,
      audioUrl,
      updatedAt: Date.now(),
    },
  }));
}

/**
 * Read the last message ID we read from the channel for this avatar.
 * Used to fetch only new messages on the next tick.
 */
async function getLastChannelMessageId(avatarId: string): Promise<number | undefined> {
  const result = await hailCacheDocClient.send(new GetCommand({
    TableName: STATE_TABLE,
    Key: { pk: `SIGNAL_CHANNEL_READ#${avatarId}`, sk: 'LATEST' },
  }));
  return typeof result.Item?.id === 'number' ? result.Item.id : undefined;
}

/**
 * Track the last message ID we've seen in the channel for this avatar.
 */
async function setLastChannelMessageId(avatarId: string, id: number): Promise<void> {
  await hailCacheDocClient.send(new PutCommand({
    TableName: STATE_TABLE,
    Item: {
      pk: `SIGNAL_CHANNEL_READ#${avatarId}`,
      sk: 'LATEST',
      id,
      updatedAt: Date.now(),
    },
  }));
}

/**
 * Read the last hail we posted to the channel for this avatar.
 * Used to dedupe: if the hail hasn't changed and we already posted it, skip the post.
 */
async function getLastPostedChannelHail(avatarId: string): Promise<string | undefined> {
  const result = await hailCacheDocClient.send(new GetCommand({
    TableName: STATE_TABLE,
    Key: { pk: `STATION_CHANNEL_HAIL#${avatarId}`, sk: 'LATEST' },
  }));
  return typeof result.Item?.text === 'string' ? result.Item.text : undefined;
}

/**
 * Track the last hail we posted to the channel.
 */
async function setLastPostedChannelHail(avatarId: string, text: string): Promise<void> {
  await hailCacheDocClient.send(new PutCommand({
    TableName: STATE_TABLE,
    Item: {
      pk: `STATION_CHANNEL_HAIL#${avatarId}`,
      sk: 'LATEST',
      text,
      updatedAt: Date.now(),
    },
  }));
}

/**
 * Scan tool-loop results for a successful signal_set_hail call and return the hail text.
 * The tool's success payload is `{ hail: <message> }`.
 */
export function extractHailText(results: ToolLoopResult['allToolResults']): string | undefined {
  for (const entry of results) {
    if (entry.name !== 'signal_set_hail' || !entry.result.success) continue;
    const data = entry.result.data;
    if (data && typeof data === 'object' && 'hail' in data) {
      const hail = (data as { hail?: unknown }).hail;
      if (typeof hail === 'string' && hail.trim().length > 0) return hail;
    }
  }
  return undefined;
}

export interface HailAudioOutcome {
  url?: string;
  skipped?: 'unchanged' | 'voice-disabled' | 'no-reference' | 'no-media-bucket';
  error?: string;
}

export interface HailAudioDeps {
  getLastHailText: (avatarId: string) => Promise<string | undefined>;
  setLastHailText: (avatarId: string, text: string, audioUrl?: string) => Promise<void>;
  generateVoiceMessage: (params: { avatarId: string; text: string }) => Promise<{ url: string }>;
  mediaBucket?: string;
}

/**
 * Generate a voice audio clip for the given hail text if the avatar has voice cloning
 * configured, the text changed vs. the last-generated hail, and the media bucket is wired.
 *
 * Non-fatal: every failure mode returns a HailAudioOutcome rather than throwing, so the
 * caller can log the outcome and continue the tick.
 */
export interface ChannelChatContext {
  text: string;
  count: number;
  maxId?: number;
  error?: string;
}

export interface ChannelChatDeps {
  readChannelMessages: (limit?: number, since?: number) => Promise<{ messages: Array<{ id: number; text: string }> }>;
  getLastChannelMessageId: (avatarId: string) => Promise<number | undefined>;
}

/**
 * Fetch recent channel messages and format them for the system prompt.
 * Non-fatal: returns a context block even if the fetch fails.
 */
export async function fetchChannelChatContext(
  avatarId: string,
  deps: ChannelChatDeps,
): Promise<ChannelChatContext> {
  try {
    const lastId = await deps.getLastChannelMessageId(avatarId);
    const response = await deps.readChannelMessages(10, lastId);
    const { messages } = response;

    if (!messages || messages.length === 0) {
      return {
        text: 'Recent station-band chatter: (none)',
        count: 0,
      };
    }

    // Format messages, cap each at 200 chars
    const lines = messages.map((msg) => {
      const text = typeof msg.text === 'string' ? msg.text.slice(0, 200) : '';
      return `<sender unknown> [tick]: ${text}`;
    });

    // Track the max ID for next fetch
    const maxId = Math.max(...messages.map(m => m.id || 0));

    return {
      text: `Recent station-band chatter:\n${lines.join('\n')}`,
      count: messages.length,
      maxId,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      text: 'Recent station-band chatter: (fetch failed — continuing without context)',
      count: 0,
      error: errorMsg,
    };
  }
}

export async function maybeGenerateHailAudio(
  avatarId: string,
  hailText: string,
  avatarConfig: AvatarConfig,
  deps: HailAudioDeps,
): Promise<HailAudioOutcome> {
  const voice = avatarConfig.voice;
  if (!voice?.enabled || voice.ttsProvider !== 'voice-clone') {
    return { skipped: 'voice-disabled' };
  }
  if (!voice.referenceUrl) return { skipped: 'no-reference' };
  if (!deps.mediaBucket) return { skipped: 'no-media-bucket' };

  const lastText = await deps.getLastHailText(avatarId);
  if (lastText === hailText) return { skipped: 'unchanged' };

  try {
    const asset = await deps.generateVoiceMessage({ avatarId, text: hailText });
    await deps.setLastHailText(avatarId, hailText, asset.url);
    return { url: asset.url };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Check if enough time has elapsed for this avatar's station tick.
 */
function shouldRunNow(
  lastRunTime: number,
  minIntervalHours: number,
  maxIntervalHours: number,
): boolean {
  const now = Date.now();
  const minMs = minIntervalHours * 60 * 60 * 1000;
  const maxMs = maxIntervalHours * 60 * 60 * 1000;
  const seed = lastRunTime || now;
  const randomFactor = (seed % 1000) / 1000;
  const requiredInterval = minMs + randomFactor * (maxMs - minMs);
  return now - lastRunTime >= requiredInterval;
}

/**
 * Check whether an avatar is a station governor (has signal-station tools).
 */
function isStationAvatar(config: AvatarConfig): boolean {
  if (!config.tools || config.tools.length === 0) return false;
  return config.tools.some(
    (t: string) => t === 'signal_station_state' || t.startsWith('signal_'),
  );
}

/**
 * Extract the station ID this avatar governs.
 * Convention: avatar name contains the station index, or we fall back to
 * trying station 0, 1, 2 for Prospect, Kepler, Helios respectively.
 */
function resolveStationId(config: AvatarConfig): number {
  const name = (config.name || '').toLowerCase();
  if (name.includes('prospect')) return 0;
  if (name.includes('kepler')) return 1;
  if (name.includes('helios')) return 2;
  // Default: try to parse a trailing number from the avatar name/id
  const match = config.id.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Build a synthetic envelope for the tool loop (no real inbound message).
 */
function buildSchedulerEnvelope(avatarId: string): SwarmEnvelope {
  const now = Date.now();
  return {
    avatarId,
    platform: 'web',
    messageId: `station_tick_${now}`,
    conversationId: `station_governance_${avatarId}`,
    timestamp: now,
    sender: {
      id: 'system',
      username: 'station-scheduler',
      displayName: 'Station Scheduler',
      isBot: true,
      platform: 'web',
      platformUserId: 'system',
    },
    content: { text: '' },
    mentions: [],
    raw: {},
    metadata: {
      receivedAt: now,
      priority: 'normal',
      idempotencyKey: `station_tick_${avatarId}_${now}`,
    },
  };
}

/**
 * Process a single station-governing avatar.
 */
async function processStationAvatar(
  avatarId: string,
  avatarConfig: AvatarConfig,
  secrets: Record<string, string>,
): Promise<{ acted: boolean; actions?: string[]; error?: string }> {
  // Check timing
  const lastRun = await stateService.getLastHeartbeat(avatarId, 'signal-station');
  if (!shouldRunNow(lastRun, DEFAULT_MIN_INTERVAL_HOURS, DEFAULT_MAX_INTERVAL_HOURS)) {
    logger.debug('Skipping station avatar, not enough time elapsed', {
      avatarId,
      lastRun,
    });
    return { acted: false };
  }

  const stationId = resolveStationId(avatarConfig);

  // Create signal station services (HTTP client to game server)
  const apiToken = secrets.SIGNAL_API_TOKEN || secrets.signal_api_token || '';
  if (!apiToken) {
    logger.warn('No SIGNAL_API_TOKEN in avatar secrets, skipping', { avatarId });
    return { acted: false, error: 'Missing SIGNAL_API_TOKEN' };
  }

  const stationServices = createSignalStationServices(apiToken);

  // Register only signal-station tools
  const registry = new ToolRegistry();
  registry.registerAll(createSignalStationTools(stationServices));

  const toolClient = createToolClient(registry, 'api');
  const enabledTools = registry.toOpenAIFormat('api');

  // Fetch channel chatter for the system prompt (non-fatal)
  let channelContext: ChannelChatContext | undefined;
  try {
    channelContext = await fetchChannelChatContext(avatarId, {
      readChannelMessages: (limit, since) => stationServices.readChannelMessages(limit, since),
      getLastChannelMessageId: (id) => getLastChannelMessageId(id),
    });
  } catch (error) {
    logger.warn('Failed to fetch channel context', error, { avatarId });
  }

  // Build messages
  const systemPrompt = [
    avatarConfig.persona || '',
    '',
    `You are governing station ${stationId}. You have tools to observe and command it.`,
    'Keep actions purposeful and in character. Be concise.',
    ...(channelContext ? [channelContext.text] : []),
  ].join('\n');

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: GOVERNANCE_PROMPT },
  ];

  // Build envelope and brain service
  const envelope = buildSchedulerEnvelope(avatarId);
  const brainService = createRuntimeBrainService(stateService, avatarConfig.brain);

  // Execute tool loop
  const result = await executeToolLoop({
    messages,
    enabledTools,
    toolClient,
    toolContext: {
      avatarId,
      platform: 'api',
      userId: 'station-scheduler',
      conversationId: envelope.conversationId,
    },
    avatarId,
    avatarName: avatarConfig.name,
    llmConfig: avatarConfig.llm,
    secrets,
    envelope,
    brainService,
  });

  // Record timing
  await stateService.setLastHeartbeat(avatarId, 'signal-station', Date.now());

  // Update last channel message ID if we successfully fetched context
  if (channelContext && !channelContext.error && channelContext.maxId !== undefined) {
    try {
      await setLastChannelMessageId(avatarId, channelContext.maxId);
    } catch (error) {
      logger.debug('Failed to update channel message ID tracking', error);
    }
  }

  const actionNames = result.allToolResults
    .filter(r => r.name !== 'signal_station_state')
    .map(r => r.name);

  // If the avatar set a new hail this tick, produce a voice clip from it.
  const hailText = extractHailText(result.allToolResults);
  let hailAudio: HailAudioOutcome | undefined;
  let channelPostError: string | undefined;
  if (hailText) {
    const voice = avatarConfig.voice;
    const voiceServices = voice?.enabled && voice.ttsProvider === 'voice-clone' && voice.referenceUrl && MEDIA_BUCKET
      ? createVoiceServices({
          avatarId,
          secrets,
          voiceConfig: { ttsProvider: voice.ttsProvider, referenceUrl: voice.referenceUrl },
          mediaBucket: MEDIA_BUCKET,
          cdnUrl: CDN_URL,
        })
      : undefined;

    hailAudio = await maybeGenerateHailAudio(avatarId, hailText, avatarConfig, {
      getLastHailText,
      setLastHailText,
      generateVoiceMessage: voiceServices
        ? (params) => voiceServices.generateVoiceMessage(params).then(a => ({ url: a.url }))
        : () => Promise.reject(new Error('voice services unavailable')),
      mediaBucket: MEDIA_BUCKET,
    });
    if (hailAudio.error) {
      logger.warn('Station hail voice generation failed', {
        avatarId,
        stationId,
        error: hailAudio.error,
      });
    } else if (hailAudio.url) {
      logger.info('Station hail audio generated', {
        avatarId,
        stationId,
        audioUrl: hailAudio.url,
      });
    }

    // Post hail to channel if voice was generated or if the hail is different from last posted
    if (hailAudio.skipped !== 'unchanged') {
      const lastPosted = await getLastPostedChannelHail(avatarId);
      if (lastPosted !== hailText) {
        try {
          await stationServices.postChannelMessage(stationId, hailText, hailAudio.url);
          await setLastPostedChannelHail(avatarId, hailText);
          logger.info('Station hail posted to channel', {
            avatarId,
            stationId,
            audioUrl: hailAudio.url,
          });
        } catch (error) {
          channelPostError = error instanceof Error ? error.message : String(error);
          logger.warn('Failed to post hail to channel', error, {
            avatarId,
            stationId,
          });
        }
      } else {
        logger.debug('Skipping duplicate channel post', {
          avatarId,
          stationId,
        });
      }
    }
  }

  const activityDetails: Record<string, unknown> = {
    stationId,
    toolCalls: result.allToolResults.map(r => r.name),
    response: result.cleanFinalContent?.slice(0, 200),
  };
  if (hailText) activityDetails.hailText = hailText;
  if (hailAudio?.url) activityDetails.hailAudio = hailAudio.url;
  if (hailAudio?.error) activityDetails.hailVoiceError = hailAudio.error;
  if (hailAudio?.skipped) activityDetails.hailVoiceSkipped = hailAudio.skipped;
  if (channelContext?.count !== undefined) activityDetails.channelContextCount = channelContext.count;
  if (channelContext?.error) activityDetails.channelError = channelContext.error;
  if (channelPostError) activityDetails.channelPostError = channelPostError;

  await activityService.log({
    avatarId,
    timestamp: Date.now(),
    eventType: 'response_sent',
    platform: 'web',
    summary: actionNames.length > 0
      ? `Station ${stationId} governance: ${actionNames.join(', ')}`
      : `Station ${stationId} observation (no changes)`,
    details: activityDetails,
  });

  logger.info('Station avatar processed', {
    event: 'station_tick_complete',
    avatarId,
    stationId,
    actions: actionNames,
    hasResponse: !!result.cleanFinalContent,
  });

  return { acted: actionNames.length > 0, actions: actionNames };
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  const startTime = Date.now();
  logger.setContext({
    requestId: context.awsRequestId,
    handler: 'station-agent-runner',
  });

  await initialize();

  logger.info('Station agent runner started', {
    event: 'handler_started',
    subsystem: 'signal',
  });

  const avatarIds = await stateService.listAvatars();
  let avatarsProcessed = 0;
  let avatarsSkipped = 0;
  let avatarsActed = 0;
  const errors: Array<{ avatarId: string; error: string }> = [];

  for (const avatarId of avatarIds) {
    try {
      logger.setContext({ avatarId, requestId: context.awsRequestId });

      const configWithStatus = await stateService.getAvatarConfigWithStatus(avatarId);
      if (!configWithStatus) {
        continue;
      }

      if (configWithStatus.status !== 'active') {
        avatarsSkipped++;
        continue;
      }

      const avatarConfig = configWithStatus.config;

      if (!isStationAvatar(avatarConfig)) {
        avatarsSkipped++;
        continue;
      }

      const secrets = await loadAvatarSecrets(secretsService, avatarId, SECRET_PREFIX);
      const result = await processStationAvatar(avatarId, avatarConfig, secrets);
      avatarsProcessed++;

      if (result.acted) {
        avatarsActed++;
      }

      if (result.error) {
        errors.push({ avatarId, error: result.error });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to process station avatar', error, { avatarId });
      errors.push({ avatarId, error: errorMessage });
    }
  }

  logger.info('Station agent runner complete', {
    event: 'handler_complete',
    avatarsProcessed,
    avatarsSkipped,
    avatarsActed,
    errorCount: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: Date.now() - startTime,
  });
};
