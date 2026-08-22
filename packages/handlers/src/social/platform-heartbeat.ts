/**
 * Platform Heartbeat Handler
 *
 * Runs on a schedule to keep avatars active across all enabled platforms.
 * For each avatar, checks which platforms are enabled and runs heartbeat
 * logic for each platform whose interval has elapsed.
 *
 * Platform adapters provide:
 * - isEnabled(avatarConfig) -- whether this platform is active for the avatar
 * - defaultIntervalMs -- how often to run
 * - fetchActivity(avatarId, secrets) -- get recent feed/activity
 * - executeAction(action, avatarId, secrets) -- upvote, comment, etc.
 */
import type { TimerHandler, ExecutionContext } from "@swarm/core";
import type { DynamoDBDocumentClient } from '@swarm/core';
import { ScanCommand } from '@swarm/core';
import {
  createSecretsService,
  createLLMService,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  logger,
  getLastHeartbeat,
  setLastHeartbeat,
  type LLMConfig,
} from '@swarm/core';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { getDynamoClient } from '../services/dynamo-client.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A single item from a platform's activity feed
 */
export interface ActivityItem {
  id: string;
  platform: string;
  title: string;
  body?: string;
  author: string;
  community?: string;
  metrics?: { upvotes?: number; comments?: number };
  createdAt: string;
}

/**
 * Action the LLM decides to take on an activity item
 */
export interface HeartbeatAction {
  type: 'upvote' | 'comment' | 'like' | 'reply' | 'react' | 'skip';
  targetId: string;
  content?: string;
  reason: string;
}

/**
 * Adapter interface for platform-specific heartbeat logic
 */
export interface HeartbeatPlatformAdapter {
  platform: string;
  defaultIntervalMs: number;
  isEnabled(avatarConfig: Record<string, unknown>): boolean;
  fetchActivity(avatarId: string, secrets: Record<string, string>): Promise<ActivityItem[]>;
  executeAction(action: HeartbeatAction, avatarId: string, secrets: Record<string, string>): Promise<void>;
}

// ============================================================================
// Avatar config type used when scanning ADMIN_TABLE
// ============================================================================

interface HeartbeatAvatar {
  avatarId: string;
  name: string;
  persona?: string;
  mcpConfig?: {
    enabledToolsets?: string[];
  };
  llmConfig?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

// ============================================================================
// Adapter registry
// ============================================================================

const registeredAdapters: HeartbeatPlatformAdapter[] = [];

/** Register a new platform adapter (e.g., for testing or future platforms) */
export function registerAdapter(adapter: HeartbeatPlatformAdapter): void {
  const existing = registeredAdapters.findIndex((a) => a.platform === adapter.platform);
  if (existing >= 0) {
    registeredAdapters[existing] = adapter;
  } else {
    registeredAdapters.push(adapter);
  }
}

/** Get all registered adapters (exposed for testing) */
export function getAdapters(): readonly HeartbeatPlatformAdapter[] {
  return registeredAdapters;
}

/** Reset adapters to default set (for testing) */
export function _resetAdapters(): void {
  registeredAdapters.length = 0;
}

// ============================================================================
// LLM engagement decision
// ============================================================================

interface EngagementDecision {
  action: HeartbeatAction['type'];
  targetId: string;
  content?: string;
  reason: string;
}

async function decideEngagement(
  avatar: HeartbeatAvatar,
  platformName: string,
  activities: ActivityItem[],
  secrets: Record<string, string>
): Promise<EngagementDecision[]> {
  if (activities.length === 0) {
    return [];
  }

  const llmConfig: LLMConfig = {
    provider: (avatar.llmConfig?.provider as 'bedrock' | 'openrouter' | 'anthropic') || DEFAULT_LLM_PROVIDER,
    model: avatar.llmConfig?.model || DEFAULT_LLM_MODEL,
    temperature: avatar.llmConfig?.temperature ?? 0.7,
    maxTokens: avatar.llmConfig?.maxTokens ?? 1000,
  };

  const llmService = createLLMService(llmConfig, secrets);

  const systemPrompt = `You are ${avatar.name}, an AI agent on ${platformName}.

Your persona: ${avatar.persona || 'A helpful AI assistant'}

You are reviewing recent activity from your feed. Decide how to engage.
For each item, you can:
- upvote: If you find it interesting or valuable
- comment: If you have something thoughtful to add (provide the comment text)
- skip: If it's not relevant or you have nothing to add

Be selective! Only engage with 0-2 items per heartbeat. Don't engage with everything.
If commenting, keep it brief and authentic to your persona.

Respond with a JSON array of decisions:
[
  { "action": "upvote", "targetId": "...", "reason": "why" },
  { "action": "comment", "targetId": "...", "content": "your comment", "reason": "why" },
  { "action": "skip", "targetId": "...", "reason": "why" }
]

Return at most 2 engagement actions (upvote or comment). Skip the rest.`;

  const userMessage = `Activity from your ${platformName} feed:
${activities.slice(0, 5).map((item, i) => `
${i + 1}. ${item.community ? `[${item.community}] ` : ''}"${item.title}" by ${item.author}
   ID: ${item.id}
   ${item.body?.slice(0, 200) || '(no body)'}
   ${item.metrics ? `Upvotes: ${item.metrics.upvotes ?? 0}, Comments: ${item.metrics.comments ?? 0}` : ''}
`).join('\n')}

Which items (if any) would you like to engage with?`;

  try {
    const response = await llmService.generateResponse({
      avatarId: avatar.avatarId,
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      config: llmConfig,
    });

    // Extract JSON from response
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn('Could not parse engagement decision', {
        platformName,
        response: response.content.slice(0, 200),
      });
      return [];
    }

    const decisions: EngagementDecision[] = JSON.parse(jsonMatch[0]);

    // Filter to only actionable decisions
    return decisions.filter(
      (d) => d.action === 'upvote' || d.action === 'comment' || d.action === 'like' || d.action === 'reply' || d.action === 'react'
    );
  } catch (error) {
    logger.error('Failed to get engagement decision', error, { platformName });
    return [];
  }
}

// ============================================================================
// Core processing
// ============================================================================

const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

let _stateTable: string;
let _adminTable: string | undefined;
let secretsService: ReturnType<typeof createSecretsService>;
let adminDocClient: DynamoDBDocumentClient;
let stateDocClient: DynamoDBDocumentClient;
let _initialized = false;

async function initialize(): Promise<void> {
  if (_initialized) return;

  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) throw new Error('STATE_TABLE environment variable is required');
  _stateTable = stateTable;

  // ADMIN_TABLE is optional — when missing, the heartbeat returns early with no avatars.
  _adminTable = process.env.ADMIN_TABLE || undefined;

  secretsService = createSecretsService();
  adminDocClient = getDynamoClient();
  stateDocClient = getDynamoClient();
  _initialized = true;
}

/**
 * Get all active avatars from ADMIN_TABLE
 */
async function getActiveAvatars(): Promise<HeartbeatAvatar[]> {
  if (!_adminTable) {
    logger.error('Platform heartbeat disabled: missing ADMIN_TABLE environment variable', undefined, {
      subsystem: 'platform-heartbeat',
      event: 'missing_admin_table',
    });
    return [];
  }

  const avatars: HeartbeatAvatar[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await adminDocClient.send(new ScanCommand({
      TableName: _adminTable,
      FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk',
      ExpressionAttributeValues: {
        ':prefix': 'AVATAR#',
        ':sk': 'CONFIG',
      },
      ProjectionExpression: 'avatarId, #n, persona, llmConfig, mcpConfig',
      ExpressionAttributeNames: {
        '#n': 'name',
      },
      ExclusiveStartKey: lastEvaluatedKey as never,
    }));

    for (const item of result.Items || []) {
      avatars.push({
        avatarId: item.avatarId as string,
        name: item.name as string,
        persona: item.persona as string | undefined,
        mcpConfig: item.mcpConfig as HeartbeatAvatar['mcpConfig'],
        llmConfig: item.llmConfig as HeartbeatAvatar['llmConfig'],
      });
    }

    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return avatars;
}

/**
 * Process a single avatar for a single platform adapter
 */
async function processAvatarPlatform(
  avatar: HeartbeatAvatar,
  adapter: HeartbeatPlatformAdapter,
  secrets: Record<string, string>,
  now: number
): Promise<{ checked: boolean; engaged: boolean; error?: string }> {
  const { avatarId } = avatar;

  // Check if enough time has passed since last heartbeat for this platform
  const lastHeartbeat = await getLastHeartbeat(stateDocClient, _stateTable, avatarId, adapter.platform);

  if (now - lastHeartbeat < adapter.defaultIntervalMs) {
    const minutesRemaining = Math.round((adapter.defaultIntervalMs - (now - lastHeartbeat)) / 60000);
    logger.debug('Skipping platform heartbeat, interval not elapsed', {
      avatarId,
      platform: adapter.platform,
      lastHeartbeat,
      minutesRemaining,
    });
    return { checked: false, engaged: false };
  }

  try {
    // Fetch platform activity
    const activities = await adapter.fetchActivity(avatarId, secrets);

    if (activities.length === 0) {
      await setLastHeartbeat(stateDocClient, _stateTable, avatarId, adapter.platform, now);
      return { checked: true, engaged: false };
    }

    // Use LLM to decide engagement
    const decisions = await decideEngagement(avatar, adapter.platform, activities, secrets);
    let engaged = false;

    for (const decision of decisions) {
      try {
        const action: HeartbeatAction = {
          type: decision.action,
          targetId: decision.targetId,
          content: decision.content,
          reason: decision.reason,
        };
        await adapter.executeAction(action, avatarId, secrets);
        engaged = true;
      } catch (actionError) {
        logger.warn('Heartbeat action failed', {
          avatarId,
          platform: adapter.platform,
          action: decision.action,
          targetId: decision.targetId,
          error: actionError instanceof Error ? actionError.message : String(actionError),
        });
      }
    }

    // Update heartbeat timestamp
    await setLastHeartbeat(stateDocClient, _stateTable, avatarId, adapter.platform, now);

    return { checked: true, engaged };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Platform heartbeat failed', error, {
      avatarId,
      platform: adapter.platform,
    });

    // Still update heartbeat to avoid hammering on errors
    await setLastHeartbeat(stateDocClient, _stateTable, avatarId, adapter.platform, now);

    return { checked: false, engaged: false, error: errorMessage };
  }
}

// ============================================================================
// Lambda handler
// ============================================================================

export const handler: TimerHandler = async (_event, context: ExecutionContext) => {
  const startTime = Date.now();
  logger.setContext({
    requestId: context.awsRequestId,
    handler: 'platform-heartbeat',
  });

  await initialize();

  logger.info('Platform heartbeat started', {
    event: 'handler_started',
    subsystem: 'platform-heartbeat',
    adapterCount: registeredAdapters.length,
    platforms: registeredAdapters.map((a) => a.platform),
  });

  // Get all avatars from ADMIN_TABLE
  let avatars: HeartbeatAvatar[];
  try {
    avatars = await getActiveAvatars();
  } catch (error) {
    logger.error('Failed to load avatars from ADMIN_TABLE', error instanceof Error ? error : undefined, {
      subsystem: 'platform-heartbeat',
      event: 'avatar_scan_failed',
      adminTable: process.env.ADMIN_TABLE,
    });
    return;
  }

  logger.info('Found avatars', {
    count: avatars.length,
    avatarIds: avatars.map((a) => a.avatarId),
  });

  const stats: Record<string, { checked: number; engaged: number; skipped: number; errors: number }> = {};
  const errors: Array<{ avatarId: string; platform: string; error: string }> = [];

  for (const adapter of registeredAdapters) {
    stats[adapter.platform] = { checked: 0, engaged: 0, skipped: 0, errors: 0 };
  }

  const now = Date.now();

  for (const avatar of avatars) {
    logger.setContext({ avatarId: avatar.avatarId, requestId: context.awsRequestId });

    let secrets: Record<string, string> | undefined;

    for (const adapter of registeredAdapters) {
      // Check if this platform is enabled for the avatar
      if (!adapter.isEnabled(avatar as unknown as Record<string, unknown>)) {
        continue;
      }

      // Lazy-load secrets (only once per avatar, shared across platforms)
      if (!secrets) {
        try {
          secrets = await loadAvatarSecrets(secretsService, avatar.avatarId, SECRET_PREFIX);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('Failed to load avatar secrets', error, { avatarId: avatar.avatarId });
          errors.push({ avatarId: avatar.avatarId, platform: adapter.platform, error: errorMessage });
          stats[adapter.platform].errors++;
          continue;
        }
      }

      try {
        const result = await processAvatarPlatform(avatar, adapter, secrets, now);

        if (result.checked) {
          stats[adapter.platform].checked++;
          if (result.engaged) {
            stats[adapter.platform].engaged++;
          }
        } else if (!result.error) {
          stats[adapter.platform].skipped++;
        }

        if (result.error) {
          stats[adapter.platform].errors++;
          errors.push({ avatarId: avatar.avatarId, platform: adapter.platform, error: result.error });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Failed to process avatar platform heartbeat', error, {
          avatarId: avatar.avatarId,
          platform: adapter.platform,
        });
        stats[adapter.platform].errors++;
        errors.push({ avatarId: avatar.avatarId, platform: adapter.platform, error: errorMessage });
      }
    }
  }

  logger.info('Platform heartbeat complete', {
    event: 'handler_complete',
    stats,
    errorCount: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: Date.now() - startTime,
  });
};
