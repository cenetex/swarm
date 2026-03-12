import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { MemoryFact } from '../../types/index.js';

export async function saveFact(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  fact: MemoryFact
): Promise<void> {
  // Create a deterministic ID from the fact content for deduplication
  // Use TextEncoder to properly handle Unicode (including emojis)
  const encoder = new TextEncoder();
  const bytes = encoder.encode(fact.fact.slice(0, 100));
  const factId = Buffer.from(bytes).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  const sortKey = `FACT#${fact.about || 'general'}#${factId}`;

  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AVATAR#${avatarId}`,
      sk: sortKey,
      fact: fact.fact,
      about: fact.about,
      userId: fact.userId,
      timestamp: fact.timestamp,
      // TTL: keep facts for 90 days
      ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60),
    },
  }));
}

export async function getFacts(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  query: string,
  userId?: string
): Promise<MemoryFact[]> {
  // Use Query on pk + sk prefix instead of Scan to avoid scanning the entire table.
  // Sort key format: FACT#<about>#<factId>
  // When query matches an about category exactly, use a tighter sk prefix.
  const lowerQuery = query.toLowerCase();
  const skPrefix = `FACT#${query}`;

  // First try an exact category match (e.g. query='posted_tweet' → sk prefix 'FACT#posted_tweet')
  let result = await docClient.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `AVATAR#${avatarId}`,
      ':prefix': skPrefix,
    },
    Limit: 20,
    ScanIndexForward: false,
  }));

  // If no exact category match, fall back to querying all facts with a content filter
  if (!result.Items || result.Items.length === 0) {
    result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :factPrefix)',
      FilterExpression: 'contains(fact, :query) OR contains(about, :query)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':factPrefix': 'FACT#',
        ':query': lowerQuery,
      },
      Limit: 50,
      ScanIndexForward: false,
    }));
  }

  const facts = (result.Items || [])
    .filter(item => {
      // If userId filter provided, only return facts from that user or general facts
      if (userId && item.userId && item.userId !== userId) {
        return false;
      }
      return true;
    })
    .map(item => ({
      fact: item.fact,
      about: item.about,
      userId: item.userId,
      timestamp: item.timestamp,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);

  return facts;
}
