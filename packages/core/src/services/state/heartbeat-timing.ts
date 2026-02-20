import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Get the timestamp of the last heartbeat for an avatar on a specific platform
 */
export async function getLastHeartbeat(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  platform: string
): Promise<number> {
  const result = await docClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `HEARTBEAT#${platform}`,
    },
  }));
  return result.Item?.timestamp || 0;
}

/**
 * Set the timestamp of the last heartbeat for an avatar on a specific platform
 */
export async function setLastHeartbeat(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  platform: string,
  timestamp: number
): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AVATAR#${avatarId}`,
      sk: `HEARTBEAT#${platform}`,
      platform,
      timestamp,
      updatedAt: Date.now(),
    },
  }));
}
