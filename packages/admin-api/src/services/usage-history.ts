/**
 * Usage History Service
 *
 * Queries historical daily usage records for an avatar.
 * Each day's usage is stored in DynamoDB with key pk=USAGE#{avatarId}, sk=DAY#{YYYY-MM-DD}.
 */
import { QueryCommand } from '@swarm/core';
import type { UsageRecord } from '../types.js';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

export interface DailyUsageSummary {
  date: string;
  messagesProcessed: number;
  mediaCreditsUsed: number;
  voiceMinutesUsed: number;
  toolCallsMade: number;
  imageGenerations: number;
  videoGenerations: number;
  stickerGenerations: number;
}

/**
 * Get usage history for the last N days.
 * Returns an array of daily summaries sorted by date ascending.
 */
export async function getUsageHistory(
  avatarId: string,
  days: number = 7,
): Promise<DailyUsageSummary[]> {
  // Build the date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days + 1);

  const startKey = `DAY#${formatDate(startDate)}`;
  const endKey = `DAY#${formatDate(endDate)}`;

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':pk': `USAGE#${avatarId}`,
      ':start': startKey,
      ':end': endKey,
    },
    ScanIndexForward: true,
  }));

  const records = (result.Items || []) as UsageRecord[];

  // Build complete daily array, filling gaps with zeros
  const summaries: DailyUsageSummary[] = [];
  const recordMap = new Map(records.map(r => [r.date, r]));

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = formatDate(d);
    const record = recordMap.get(dateStr);

    summaries.push({
      date: dateStr,
      messagesProcessed: record?.messagesProcessed ?? 0,
      mediaCreditsUsed: record?.mediaCreditsUsed ?? 0,
      voiceMinutesUsed: record?.voiceMinutesUsed ?? 0,
      toolCallsMade: record?.toolCallsMade ?? 0,
      imageGenerations: record?.imageGenerations ?? 0,
      videoGenerations: record?.videoGenerations ?? 0,
      stickerGenerations: record?.stickerGenerations ?? 0,
    });
  }

  return summaries;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}
