/**
 * Agent Management Service
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AgentRecord, UserSession } from '../types.js';
import { syncAgentConfig } from './config-sync.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/**
 * Generate a URL-safe agent ID from name
 */
function generateAgentId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}-${suffix}`;
}

/**
 * Create a new agent
 */
export async function createAgent(
  name: string,
  session: UserSession,
  description?: string
): Promise<AgentRecord> {
  const agentId = generateAgentId(name);
  const now = Date.now();

  const agent: AgentRecord = {
    pk: `AGENT#${agentId}`,
    sk: 'CONFIG',
    agentId,
    name,
    description,
    platforms: {},
    llmConfig: {
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      temperature: 0.8,
      maxTokens: 1024,
      useGlobalKey: true,
    },
    status: 'draft',
    createdAt: now,
    createdBy: session.email,
    updatedAt: now,
    updatedBy: session.email,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: agent,
    ConditionExpression: 'attribute_not_exists(pk)',
  }));

  // Sync to state table so handlers can access it
  await syncAgentConfig(agent);

  return agent;
}

/**
 * Get an agent by ID
 */
export async function getAgent(agentId: string): Promise<AgentRecord | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'CONFIG',
    },
  }));

  return result.Item as AgentRecord | null;
}

/**
 * Update an agent
 */
export async function updateAgent(
  agentId: string,
  updates: Partial<Pick<AgentRecord, 'name' | 'description' | 'persona' | 'platforms' | 'llmConfig' | 'status' | 'profileImage' | 'mediaConfig' | 'stickerPack'>>,
  session: UserSession
): Promise<AgentRecord> {
  const existing = await getAgent(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  // Filter out undefined values to avoid overwriting existing fields
  const cleanUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, v]) => v !== undefined)
  );

  const updated: AgentRecord = {
    ...existing,
    ...cleanUpdates,
    updatedAt: Date.now(),
    updatedBy: session.email,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: updated,
  }));

  // Sync to state table so handlers can access it
  await syncAgentConfig(updated);

  return updated;
}

/**
 * List all agents
 */
export async function listAgents(): Promise<AgentRecord[]> {
  // Use a scan with filter for CONFIG records
  // In production, use a GSI for better performance
  const result = await dynamoClient.send(new ScanCommand({
    TableName: ADMIN_TABLE,
    FilterExpression: 'sk = :sk AND #status <> :deleted',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':sk': 'CONFIG',
      ':deleted': 'deleted',
    },
  }));

  return (result.Items as AgentRecord[]) || [];
}

/**
 * Delete an agent (soft delete)
 */
export async function deleteAgent(
  agentId: string,
  session: UserSession
): Promise<void> {
  await updateAgent(agentId, { status: 'deleted' }, session);
}

/**
 * Configure Telegram for an agent
 */
export async function configureTelegram(
  agentId: string,
  botUsername: string,
  session: UserSession
): Promise<AgentRecord> {
  const existing = await getAgent(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  return updateAgent(agentId, {
    platforms: {
      ...existing.platforms,
      telegram: {
        enabled: true,
        botUsername,
      },
    },
  }, session);
}

/**
 * Configure Twitter for an agent
 */
export async function configureTwitter(
  agentId: string,
  username: string,
  session: UserSession
): Promise<AgentRecord> {
  const existing = await getAgent(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  return updateAgent(agentId, {
    platforms: {
      ...existing.platforms,
      twitter: {
        enabled: true,
        username,
      },
    },
  }, session);
}

/**
 * Configure Discord for an agent
 */
export async function configureDiscord(
  agentId: string,
  guildId: string | undefined,
  session: UserSession
): Promise<AgentRecord> {
  const existing = await getAgent(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  return updateAgent(agentId, {
    platforms: {
      ...existing.platforms,
      discord: {
        enabled: true,
        guildId,
      },
    },
  }, session);
}
