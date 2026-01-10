/**
 * Chat History Service
 * Persists chat history per user/agent for cross-device sync
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AdminChatMessage, UserSession } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Max messages to store per chat (older messages will be trimmed)
const MAX_MESSAGES = 100;

export interface ChatHistoryRecord {
  pk: string; // CHAT#<userEmail>
  sk: string; // AGENT#<agentId> or GLOBAL
  messages: AdminChatMessage[];
  updatedAt: number;
}

/**
 * Build the partition key for a user's chat
 */
function buildChatKey(email: string): string {
  return `CHAT#${email}`;
}

/**
 * Build the sort key for a specific agent or global chat
 */
function buildAgentKey(agentId?: string): string {
  return agentId ? `AGENT#${agentId}` : 'GLOBAL';
}

/**
 * Get chat history for a user/agent combination
 */
export async function getChatHistory(
  session: UserSession,
  agentId?: string
): Promise<AdminChatMessage[]> {
  const result = await dynamoClient.send(
    new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: buildChatKey(session.email),
        sk: buildAgentKey(agentId),
      },
    })
  );

  if (!result.Item) {
    return [];
  }

  const record = result.Item as ChatHistoryRecord;
  return record.messages || [];
}

/**
 * Save chat history for a user/agent combination
 */
export async function saveChatHistory(
  session: UserSession,
  messages: AdminChatMessage[],
  agentId?: string
): Promise<void> {
  // Trim to max messages (keep most recent)
  const trimmedMessages = messages.slice(-MAX_MESSAGES);

  const record: ChatHistoryRecord = {
    pk: buildChatKey(session.email),
    sk: buildAgentKey(agentId),
    messages: trimmedMessages,
    updatedAt: Date.now(),
  };

  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: record,
    })
  );
}

/**
 * Clear chat history for a user/agent combination
 */
export async function clearChatHistory(
  session: UserSession,
  agentId?: string
): Promise<void> {
  await dynamoClient.send(
    new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: buildChatKey(session.email),
        sk: buildAgentKey(agentId),
      },
    })
  );
}
