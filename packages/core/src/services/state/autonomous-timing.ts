import { DynamoDBDocumentClient, GetCommand, PutCommand } from '../../commands/index.js';

export async function getLastAutonomousPostTime(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string
): Promise<number> {
  const result = await docClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'TWITTER#LAST_AUTO_POST',
    },
  }));
  return result.Item?.timestamp || 0;
}

export async function setLastAutonomousPostTime(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  timestamp: number
): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AVATAR#${avatarId}`,
      sk: 'TWITTER#LAST_AUTO_POST',
      timestamp,
      updatedAt: Date.now(),
    },
  }));
}
