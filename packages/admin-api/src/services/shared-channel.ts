/**
 * Shared Channel Service
 *
 * Manages the registry of agents present in each Telegram channel.
 * Enables multi-agent coordination by tracking which agents are active
 * in a given chat.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SharedChannelRecord } from '../types.js';
import { generateAgentStats } from './agent-stats.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// TTL: 7 days of inactivity before cleanup
const CHANNEL_AGENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Register an agent in a channel.
 * Called when an agent first receives a message in a channel.
 *
 * @param chatId - Telegram chat ID
 * @param agentId - Agent ID
 * @param botUsername - Bot's Telegram username (for mention detection)
 * @param createdAt - Agent's creation timestamp (for stat generation)
 */
export async function registerAgentInChannel(
  chatId: number,
  agentId: string,
  botUsername: string,
  createdAt: number
): Promise<SharedChannelRecord> {
  const now = Date.now();
  const stats = generateAgentStats(createdAt, agentId);

  const record: SharedChannelRecord = {
    pk: `SHARED_CHANNEL#${chatId}`,
    sk: `AGENT#${agentId}`,
    chatId,
    agentId,
    botUsername,
    joinedAt: now,
    lastSeenAt: now,
    stats,
    ttl: Math.floor(now / 1000) + CHANNEL_AGENT_TTL_SECONDS,
  };

  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: record,
    })
  );

  return record;
}

/**
 * Get all agents registered in a channel.
 *
 * @param chatId - Telegram chat ID
 * @returns Array of agent records in this channel
 */
export async function getChannelAgents(
  chatId: number
): Promise<SharedChannelRecord[]> {
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `SHARED_CHANNEL#${chatId}`,
      },
    })
  );

  return (result.Items || []) as SharedChannelRecord[];
}

/**
 * Get a specific agent's record in a channel.
 *
 * @param chatId - Telegram chat ID
 * @param agentId - Agent ID
 * @returns Agent's channel record or null if not found
 */
export async function getAgentInChannel(
  chatId: number,
  agentId: string
): Promise<SharedChannelRecord | null> {
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: {
        ':pk': `SHARED_CHANNEL#${chatId}`,
        ':sk': `AGENT#${agentId}`,
      },
    })
  );

  return (result.Items?.[0] as SharedChannelRecord) || null;
}

/**
 * Update an agent's presence in a channel.
 * Called on each message to refresh TTL and lastSeenAt.
 *
 * @param chatId - Telegram chat ID
 * @param agentId - Agent ID
 */
export async function updateAgentPresence(
  chatId: number,
  agentId: string
): Promise<void> {
  const now = Date.now();

  await dynamoClient.send(
    new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `SHARED_CHANNEL#${chatId}`,
        sk: `AGENT#${agentId}`,
      },
      UpdateExpression: 'SET lastSeenAt = :now, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':now': now,
        ':ttl': Math.floor(now / 1000) + CHANNEL_AGENT_TTL_SECONDS,
      },
    })
  );
}

/**
 * Ensure an agent is registered in a channel, creating if needed.
 *
 * @param chatId - Telegram chat ID
 * @param agentId - Agent ID
 * @param botUsername - Bot's Telegram username
 * @param createdAt - Agent's creation timestamp
 * @returns The agent's channel record (existing or newly created)
 */
export async function ensureAgentInChannel(
  chatId: number,
  agentId: string,
  botUsername: string,
  createdAt: number
): Promise<SharedChannelRecord> {
  const existing = await getAgentInChannel(chatId, agentId);

  if (existing) {
    // Update presence and return existing
    await updateAgentPresence(chatId, agentId);
    return {
      ...existing,
      lastSeenAt: Date.now(),
    };
  }

  // Register new agent in channel
  return registerAgentInChannel(chatId, agentId, botUsername, createdAt);
}

/**
 * Remove an agent from a channel.
 * Called when an agent is deleted or disabled.
 *
 * @param chatId - Telegram chat ID
 * @param agentId - Agent ID
 */
export async function removeAgentFromChannel(
  chatId: number,
  agentId: string
): Promise<void> {
  await dynamoClient.send(
    new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `SHARED_CHANNEL#${chatId}`,
        sk: `AGENT#${agentId}`,
      },
    })
  );
}

/**
 * Check if a channel has multiple agents.
 * Quick check for multi-agent mode.
 *
 * @param chatId - Telegram chat ID
 * @returns True if channel has more than one agent
 */
export async function isMultiAgentChannel(chatId: number): Promise<boolean> {
  const agents = await getChannelAgents(chatId);
  return agents.length > 1;
}

/**
 * Find which agent (if any) is mentioned in a message.
 *
 * @param text - Message text
 * @param agents - Agents in the channel
 * @returns The mentioned agent's record, or null if no mention
 */
export function findMentionedAgent(
  text: string | undefined,
  agents: SharedChannelRecord[]
): SharedChannelRecord | null {
  if (!text) return null;

  for (const agent of agents) {
    if (text.includes(`@${agent.botUsername}`)) {
      return agent;
    }
  }

  return null;
}
