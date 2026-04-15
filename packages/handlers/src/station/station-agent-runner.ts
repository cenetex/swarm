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
} from '@swarm/mcp-server';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { createRuntimeBrainService } from '../services/brain.js';
import { executeToolLoop } from '../messaging/tool-loop.js';

const SIGNAL_API_BASE = process.env.SIGNAL_API_URL || 'https://signal-ws.ratimics.com';
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

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
  };
}

const GOVERNANCE_PROMPT = `\
Check your station's current state using signal_station_state.
Based on what you observe:
- Update your hail message if conditions have changed (signal_set_hail)
- Adjust commodity prices if inventory levels warrant it (signal_set_price)
- Consider building a module if resources allow (signal_build_module)

Only take actions that make sense given current conditions.
If nothing needs changing, just observe and report briefly.`;

let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;

async function initialize(): Promise<void> {
  if (stateService) return;
  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();
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

  // Build messages
  const systemPrompt = [
    avatarConfig.persona || '',
    '',
    `You are governing station ${stationId}. You have tools to observe and command it.`,
    'Keep actions purposeful and in character. Be concise.',
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

  // Log activity
  const actionNames = result.allToolResults
    .filter(r => r.name !== 'signal_station_state')
    .map(r => r.name);

  await activityService.log({
    avatarId,
    timestamp: Date.now(),
    eventType: 'response_sent',
    platform: 'web',
    summary: actionNames.length > 0
      ? `Station ${stationId} governance: ${actionNames.join(', ')}`
      : `Station ${stationId} observation (no changes)`,
    details: {
      stationId,
      toolCalls: result.allToolResults.map(r => r.name),
      response: result.cleanFinalContent?.slice(0, 200),
    },
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
