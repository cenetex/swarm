/**
 * Moltbook Heartbeat Handler
 *
 * Runs every 33 minutes to keep avatars active on Moltbook.
 * Checks feed, optionally engages with posts, and stays present in the community.
 *
 * For each avatar with Moltbook enabled:
 * 1. Check their personalized feed
 * 2. Optionally engage with interesting posts (upvote, comment)
 * 3. Update lastMoltbookHeartbeat timestamp
 */
import type { ScheduledHandler, Context } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  createStateService,
  createSecretsService,
  createLLMService,
  logger,
  type LLMConfig,
} from '@swarm/core';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { getDynamoClient } from '../services/dynamo-client.js';

const STATE_TABLE = process.env.STATE_TABLE;
const ADMIN_TABLE = process.env.ADMIN_TABLE;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const MOLTBOOK_BASE_URL = 'https://www.moltbook.com/api/v1';
const API_TIMEOUT_MS = 15_000;

// Heartbeat interval in milliseconds (33 minutes)
const HEARTBEAT_INTERVAL_MS = 33 * 60 * 1000;

let stateService: ReturnType<typeof createStateService>;
let secretsService: ReturnType<typeof createSecretsService>;
let adminDocClient: DynamoDBDocumentClient;

async function initialize(): Promise<void> {
  if (stateService) return;
  if (!STATE_TABLE) throw new Error('STATE_TABLE environment variable is required');
  stateService = createStateService(STATE_TABLE);
  secretsService = createSecretsService();
  adminDocClient = getDynamoClient();
}

/**
 * Avatar record from ADMIN_TABLE with moltbook configuration
 */
interface MoltbookEnabledAvatar {
  avatarId: string;
  name: string;
  persona?: string;
  llmConfig?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

/**
 * Get all avatars with Moltbook enabled in their mcpConfig
 */
async function getMoltbookEnabledAvatars(): Promise<MoltbookEnabledAvatar[]> {
  if (!ADMIN_TABLE) {
    logger.error('Moltbook heartbeat disabled: missing ADMIN_TABLE environment variable', undefined, {
      subsystem: 'moltbook',
      event: 'missing_admin_table',
    });
    return [];
  }

  const avatars: MoltbookEnabledAvatar[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await adminDocClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk AND contains(mcpConfig.enabledToolsets, :moltbook)',
      ExpressionAttributeValues: {
        ':prefix': 'AVATAR#',
        ':sk': 'CONFIG',
        ':moltbook': 'moltbook',
      },
      ProjectionExpression: 'avatarId, #n, persona, llmConfig',
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
        llmConfig: item.llmConfig as MoltbookEnabledAvatar['llmConfig'],
      });
    }

    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return avatars;
}

/**
 * Make an authenticated request to the Moltbook API
 */
async function moltbookFetch<T>(
  endpoint: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${MOLTBOOK_BASE_URL}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Moltbook API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

interface MoltbookFeedPost {
  id: string;
  title: string;
  body?: string;
  upvotes: number;
  downvotes: number;
  comment_count: number;
  created_at: string;
  author: { name: string };
  submolt: { name: string; display_name: string };
}

interface HeartbeatDecision {
  action: 'upvote' | 'comment' | 'skip';
  postId: string;
  postTitle: string;
  comment?: string;
  reason: string;
}

/**
 * Use LLM to decide how to engage with feed posts
 */
async function decideEngagement(
  avatar: MoltbookEnabledAvatar,
  posts: MoltbookFeedPost[],
  secrets: Record<string, string>
): Promise<HeartbeatDecision[]> {
  if (posts.length === 0) {
    return [];
  }

  // Build LLM config from avatar settings
  const llmConfig: LLMConfig = {
    provider: (avatar.llmConfig?.provider as 'bedrock' | 'openrouter' | 'anthropic') || 'bedrock',
    model: avatar.llmConfig?.model || 'anthropic.claude-3-5-haiku-20241022-v1:0',
    temperature: avatar.llmConfig?.temperature ?? 0.7,
    maxTokens: avatar.llmConfig?.maxTokens ?? 1000,
  };

  const llmService = createLLMService(llmConfig, secrets);

  const systemPrompt = `You are ${avatar.name}, an AI agent on Moltbook (a social network for AI agents).

Your persona: ${avatar.persona || 'A helpful AI assistant'}

You are reviewing recent posts from your feed. Decide how to engage with them.
For each post, you can:
- upvote: If you find it interesting or valuable
- comment: If you have something thoughtful to add (provide the comment text)
- skip: If it's not relevant or you have nothing to add

Be selective! Only engage with 0-2 posts per heartbeat. Don't engage with everything.
If commenting, keep it brief and authentic to your persona.

Respond with a JSON array of decisions:
[
  { "action": "upvote", "postId": "...", "postTitle": "...", "reason": "why" },
  { "action": "comment", "postId": "...", "postTitle": "...", "comment": "your comment", "reason": "why" },
  { "action": "skip", "postId": "...", "postTitle": "...", "reason": "why" }
]

Return at most 2 engagement actions (upvote or comment). Skip the rest.`;

  const userMessage = `Posts from your feed:
${posts.slice(0, 5).map((p, i) => `
${i + 1}. [${p.submolt.display_name}] "${p.title}" by ${p.author.name}
   Post ID: ${p.id}
   ${p.body?.slice(0, 200) || '(link post)'}
   Upvotes: ${p.upvotes}, Comments: ${p.comment_count}
`).join('\n')}

Which posts (if any) would you like to engage with?`;

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
      logger.warn('Could not parse engagement decision', { response: response.content.slice(0, 200) });
      return [];
    }

    const decisions: HeartbeatDecision[] = JSON.parse(jsonMatch[0]);
    
    // Filter to only upvote/comment actions
    return decisions.filter(d => d.action === 'upvote' || d.action === 'comment');
  } catch (error) {
    logger.error('Failed to get engagement decision', error);
    return [];
  }
}

/**
 * Process a single avatar for Moltbook heartbeat
 */
async function processAvatar(
  avatar: MoltbookEnabledAvatar,
  secrets: Record<string, string>
): Promise<{ checked: boolean; engaged: boolean; error?: string }> {
  const { avatarId } = avatar;

  // Get Moltbook API key
  const moltbookApiKey = secrets.MOLTBOOK_API_KEY;
  if (!moltbookApiKey) {
    return { checked: false, engaged: false, error: 'No Moltbook API key' };
  }

  // Check if enough time has passed since last heartbeat
  const lastHeartbeat = await stateService.getLastMoltbookHeartbeat(avatarId);
  const now = Date.now();
  
  if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) {
    const minutesRemaining = Math.round((HEARTBEAT_INTERVAL_MS - (now - lastHeartbeat)) / 60000);
    logger.debug('Skipping avatar, not enough time elapsed', {
      avatarId,
      lastHeartbeat,
      minutesRemaining,
    });
    return { checked: false, engaged: false };
  }

  try {
    // Check connection status first
    const status = await moltbookFetch<{
      is_claimed: boolean;
      status?: string;
    }>('/agents/status', moltbookApiKey);

    if (!status.is_claimed && status.status === 'pending_claim') {
      logger.info('Moltbook account pending claim', { avatarId });
      await stateService.setLastMoltbookHeartbeat(avatarId, now);
      return { checked: true, engaged: false, error: 'Pending claim' };
    }

    // Get personalized feed
    const feedResponse = await moltbookFetch<{
      posts: MoltbookFeedPost[];
    }>('/feed?sort=new&limit=10', moltbookApiKey);

    logger.info('Moltbook feed checked', {
      event: 'moltbook_feed_checked',
      avatarId,
      postCount: feedResponse.posts.length,
    });

    // Check for DMs
    try {
      const dmCheck = await moltbookFetch<{
        pending_requests: number;
        unread_messages: number;
      }>('/agents/dm/check', moltbookApiKey);

      if (dmCheck.pending_requests > 0 || dmCheck.unread_messages > 0) {
        logger.info('Moltbook DM activity detected', {
          event: 'moltbook_dm_activity',
          avatarId,
          pendingRequests: dmCheck.pending_requests,
          unreadMessages: dmCheck.unread_messages,
        });
      }
    } catch (dmError) {
      // DM check is optional, continue if it fails
      logger.debug('DM check failed', { error: dmError });
    }

    // Decide on engagement
    const decisions = await decideEngagement(avatar, feedResponse.posts, secrets);
    let engaged = false;

    for (const decision of decisions) {
      try {
        if (decision.action === 'upvote') {
          await moltbookFetch(`/posts/${decision.postId}/vote`, moltbookApiKey, {
            method: 'POST',
            body: JSON.stringify({ direction: 1 }),
          });
          logger.info('Moltbook upvote sent', {
            event: 'moltbook_upvote',
            avatarId,
            postId: decision.postId,
            reason: decision.reason,
          });
          engaged = true;
        } else if (decision.action === 'comment' && decision.comment) {
          await moltbookFetch(`/posts/${decision.postId}/comments`, moltbookApiKey, {
            method: 'POST',
            body: JSON.stringify({ body: decision.comment }),
          });
          logger.info('Moltbook comment posted', {
            event: 'moltbook_comment',
            avatarId,
            postId: decision.postId,
            reason: decision.reason,
          });
          engaged = true;
        }
      } catch (actionError) {
        logger.warn('Moltbook action failed', {
          avatarId,
          action: decision.action,
          postId: decision.postId,
          error: actionError instanceof Error ? actionError.message : String(actionError),
        });
      }
    }

    // Update heartbeat timestamp
    await stateService.setLastMoltbookHeartbeat(avatarId, now);

    return { checked: true, engaged };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Moltbook heartbeat failed', error, { avatarId });
    
    // Still update heartbeat to avoid hammering on errors
    await stateService.setLastMoltbookHeartbeat(avatarId, now);
    
    return { checked: false, engaged: false, error: errorMessage };
  }
}

export const handler: ScheduledHandler = async (_event, context: Context) => {
  const startTime = Date.now();
  logger.setContext({
    requestId: context.awsRequestId,
    handler: 'moltbook-heartbeat',
  });

  await initialize();

  logger.info('Moltbook heartbeat started', {
    event: 'handler_started',
    subsystem: 'moltbook',
  });

  // Get all moltbook-enabled avatars directly from ADMIN_TABLE
  const avatars = await getMoltbookEnabledAvatars();
  
  logger.info('Found moltbook-enabled avatars', {
    count: avatars.length,
    avatarIds: avatars.map(a => a.avatarId),
  });

  let avatarsChecked = 0;
  let avatarsEngaged = 0;
  let avatarsSkipped = 0;
  const errors: Array<{ avatarId: string; error: string }> = [];

  for (const avatar of avatars) {
    try {
      logger.setContext({ avatarId: avatar.avatarId, requestId: context.awsRequestId });

      const secrets = await loadAvatarSecrets(secretsService, avatar.avatarId, SECRET_PREFIX);

      const result = await processAvatar(avatar, secrets);
      
      if (result.checked) {
        avatarsChecked++;
        if (result.engaged) {
          avatarsEngaged++;
        }
      } else if (!result.error) {
        avatarsSkipped++;
      }

      if (result.error) {
        errors.push({ avatarId: avatar.avatarId, error: result.error });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to process avatar for Moltbook heartbeat', error, { avatarId: avatar.avatarId });
      errors.push({ avatarId: avatar.avatarId, error: errorMessage });
    }
  }

  logger.info('Moltbook heartbeat complete', {
    event: 'handler_complete',
    avatarsChecked,
    avatarsEngaged,
    avatarsSkipped,
    errorCount: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    durationMs: Date.now() - startTime,
  });
};
