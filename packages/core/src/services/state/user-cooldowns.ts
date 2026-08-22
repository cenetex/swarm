import type { Platform, UserCooldown } from '../../types/index.js';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand } from '../../commands/index.js';

export async function getUserCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  platform: Platform,
  userId: string
): Promise<UserCooldown | null> {
  const result = await docClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `COOLDOWN#${platform}#${userId}`,
    },
  }));

  if (!result.Item) {
    return null;
  }

  // Check if cooldown is expired
  if (result.Item.cooldownUntil < Date.now()) {
    return null;
  }

  return {
    avatarId: result.Item.avatarId,
    platform: result.Item.platform,
    userId: result.Item.userId,
    cooldownUntil: result.Item.cooldownUntil,
    reason: result.Item.reason,
  };
}

export async function setUserCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  cooldown: UserCooldown
): Promise<void> {
  const ttl = Math.floor(cooldown.cooldownUntil / 1000) + 86400; // 1 day after expiry

  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AVATAR#${cooldown.avatarId}`,
      sk: `COOLDOWN#${cooldown.platform}#${cooldown.userId}`,
      ...cooldown,
      ttl,
    },
  }));
}

export async function clearUserCooldown(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  platform: Platform,
  userId: string
): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `COOLDOWN#${platform}#${userId}`,
    },
  }));
}
