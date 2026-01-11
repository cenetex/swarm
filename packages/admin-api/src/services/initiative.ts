/**
 * Initiative Service
 *
 * Implements D&D-style initiative coordination for multi-agent channels.
 * Agents first check interest (CHA/WIS), then roll initiative (1d20 + DEX).
 * Winner responds, others can react.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  AgentStats,
  BufferedMessage,
  InitiativeRoundRecord,
  InitiativePhase,
  InterestCheckResult,
  InitiativeResult,
} from '../types.js';

// Re-export types for consumers using namespace import
export type { InitiativeResult, InterestCheckResult } from '../types.js';
import { rollD20 } from './agent-stats.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Configuration
export const INITIATIVE_CONFIG = {
  // Round timeout - how long to wait for all agents to roll
  ROUND_TIMEOUT_MS: 5000,
  // Base difficulty class for interest check
  BASE_INTEREST_DC: 10,
  // DC modifiers
  TOPIC_MATCH_BONUS: -3,     // Lower DC if message matches agent interests
  HIGH_ACTIVITY_PENALTY: 2,  // Higher DC in busy channels
  RECENT_RESPONSE_PENALTY: 5, // Higher DC if agent responded recently
  // TTL for initiative records
  ROUND_TTL_SECONDS: 300,    // 5 minutes
};

/**
 * Check if an agent is interested in responding to a message.
 * Uses CHA for social contexts, WIS for reflective/thoughtful contexts.
 *
 * Direct mentions always pass (the mentioned agent handles it outside initiative).
 *
 * @param stats - Agent's D&D stats
 * @param message - The triggering message
 * @param recentResponseAge - Time since this agent last responded (ms)
 * @param channelActivity - Number of recent messages in channel
 */
export function checkInterest(
  stats: AgentStats,
  message: BufferedMessage,
  recentResponseAge: number | null,
  channelActivity: number
): InterestCheckResult {
  // Determine which stat to use based on message context
  // Social/conversational -> CHA, reflective/analytical -> WIS
  const useCHA = isConversationalContext(message.text || '');
  const modifier = useCHA ? stats.modifiers.CHA : stats.modifiers.WIS;

  // Calculate difficulty class
  let dc = INITIATIVE_CONFIG.BASE_INTEREST_DC;

  // High activity raises DC (prevent spam)
  if (channelActivity > 10) {
    dc += INITIATIVE_CONFIG.HIGH_ACTIVITY_PENALTY;
  }

  // Recent response raises DC (cooldown effect)
  if (recentResponseAge !== null && recentResponseAge < 60000) {
    dc += INITIATIVE_CONFIG.RECENT_RESPONSE_PENALTY;
  }

  // Clamp DC to reasonable range
  dc = Math.max(5, Math.min(20, dc));

  // Roll interest check
  const roll = rollD20();
  const total = roll + modifier;
  const interested = total >= dc;

  return {
    interested,
    roll: total,
    modifier,
    dc,
    reason: interested ? 'context_interest' : 'not_interested',
  };
}

/**
 * Determine if message context is conversational (CHA) vs reflective (WIS).
 * Simple heuristic based on message content.
 */
function isConversationalContext(text: string): boolean {
  const lowerText = text.toLowerCase();

  // Questions, greetings, social cues -> CHA
  const socialPatterns = [
    /^(hi|hey|hello|yo|sup)/,
    /\?$/,
    /(what do you|how do you|do you think)/,
    /(lol|lmao|haha|nice|cool|wow)/,
  ];

  for (const pattern of socialPatterns) {
    if (pattern.test(lowerText)) {
      return true;
    }
  }

  // Technical, analytical content -> WIS
  const analyticalPatterns = [
    /(explain|analyze|consider|think about)/,
    /(code|function|error|bug|fix)/,
    /(market|price|chart|trend)/,
  ];

  for (const pattern of analyticalPatterns) {
    if (pattern.test(lowerText)) {
      return false;
    }
  }

  // Default to CHA for most casual conversation
  return true;
}

/**
 * Get or create an initiative round for a message.
 * Uses conditional writes to handle concurrent creation.
 *
 * @param chatId - Telegram chat ID
 * @param messageId - Triggering message ID
 */
export async function getOrCreateInitiativeRound(
  chatId: number,
  messageId: number
): Promise<InitiativeRoundRecord> {
  const pk = `INITIATIVE#${chatId}#${messageId}`;
  const now = Date.now();

  // Try to get existing round
  const existing = await dynamoClient.send(
    new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk: 'META' },
    })
  );

  if (existing.Item) {
    return existing.Item as InitiativeRoundRecord;
  }

  // Create new round with conditional write
  const newRound: InitiativeRoundRecord = {
    pk,
    sk: 'META',
    chatId,
    messageId,
    phase: 'interest',
    startedAt: now,
    expiresAt: now + INITIATIVE_CONFIG.ROUND_TIMEOUT_MS,
    ttl: Math.floor(now / 1000) + INITIATIVE_CONFIG.ROUND_TTL_SECONDS,
  };

  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: ADMIN_TABLE,
        Item: newRound,
        ConditionExpression: 'attribute_not_exists(pk)',
      })
    );
    return newRound;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Another agent created it first, fetch the existing one
      const result = await dynamoClient.send(
        new GetCommand({
          TableName: ADMIN_TABLE,
          Key: { pk, sk: 'META' },
        })
      );
      return result.Item as InitiativeRoundRecord;
    }
    throw err;
  }
}

/**
 * Record an agent's interest check and initiative roll.
 *
 * @param chatId - Telegram chat ID
 * @param messageId - Triggering message ID
 * @param agentId - Agent ID
 * @param interest - Interest check result
 * @param stats - Agent's D&D stats (for initiative roll)
 */
export async function recordAgentRoll(
  chatId: number,
  messageId: number,
  agentId: string,
  interest: InterestCheckResult,
  stats: AgentStats
): Promise<{ roll: number; total: number } | null> {
  const pk = `INITIATIVE#${chatId}#${messageId}`;
  const now = Date.now();

  if (!interest.interested) {
    // Record that agent is not interested
    await dynamoClient.send(
      new PutCommand({
        TableName: ADMIN_TABLE,
        Item: {
          pk,
          sk: `ROLL#${agentId}`,
          chatId,
          messageId,
          agentId,
          interested: false,
          interestRoll: interest.roll,
          rolledAt: now,
          ttl: Math.floor(now / 1000) + INITIATIVE_CONFIG.ROUND_TTL_SECONDS,
        },
      })
    );
    return null;
  }

  // Roll initiative: 1d20 + DEX modifier
  const roll = rollD20();
  const modifier = stats.modifiers.DEX;
  const total = roll + modifier;

  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk,
        sk: `ROLL#${agentId}`,
        chatId,
        messageId,
        agentId,
        interested: true,
        interestRoll: interest.roll,
        initiativeRoll: roll,
        initiativeModifier: modifier,
        totalInitiative: total,
        rolledAt: now,
        ttl: Math.floor(now / 1000) + INITIATIVE_CONFIG.ROUND_TTL_SECONDS,
      },
    })
  );

  return { roll, total };
}

/**
 * Attempt to claim the winner slot for an initiative round.
 * Uses conditional writes to ensure only the highest roll wins.
 *
 * @param chatId - Telegram chat ID
 * @param messageId - Triggering message ID
 * @param agentId - Agent ID
 * @param totalInitiative - Agent's total initiative roll
 */
export async function attemptWinnerClaim(
  chatId: number,
  messageId: number,
  agentId: string,
  totalInitiative: number
): Promise<{ isWinner: boolean; winnerId?: string; winnerRoll?: number }> {
  const pk = `INITIATIVE#${chatId}#${messageId}`;

  try {
    // Try to claim winner with conditional write:
    // - No winner yet, OR
    // - Our roll is higher than current winner
    await dynamoClient.send(
      new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: { pk, sk: 'META' },
        UpdateExpression:
          'SET winnerId = :agentId, winnerRoll = :roll, phase = :phase',
        ConditionExpression:
          'attribute_not_exists(winnerId) OR winnerRoll < :roll',
        ExpressionAttributeValues: {
          ':agentId': agentId,
          ':roll': totalInitiative,
          ':phase': 'responding' as InitiativePhase,
        },
      })
    );

    return { isWinner: true };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Someone else has a higher roll
      const meta = await dynamoClient.send(
        new GetCommand({
          TableName: ADMIN_TABLE,
          Key: { pk, sk: 'META' },
        })
      );
      const round = meta.Item as InitiativeRoundRecord;
      return {
        isWinner: false,
        winnerId: round.winnerId,
        winnerRoll: round.winnerRoll,
      };
    }
    throw err;
  }
}

/**
 * Mark that the winner has responded.
 * Transitions round to 'reacting' phase.
 */
export async function markWinnerResponded(
  chatId: number,
  messageId: number
): Promise<void> {
  const pk = `INITIATIVE#${chatId}#${messageId}`;

  await dynamoClient.send(
    new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk: 'META' },
      UpdateExpression: 'SET winnerRespondedAt = :now, phase = :phase',
      ExpressionAttributeValues: {
        ':now': Date.now(),
        ':phase': 'reacting' as InitiativePhase,
      },
    })
  );
}

/**
 * Get the current state of an initiative round.
 */
export async function getInitiativeRound(
  chatId: number,
  messageId: number
): Promise<InitiativeRoundRecord | null> {
  const pk = `INITIATIVE#${chatId}#${messageId}`;

  const result = await dynamoClient.send(
    new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk: 'META' },
    })
  );

  return (result.Item as InitiativeRoundRecord) || null;
}

/**
 * Get all rolls for an initiative round.
 */
export async function getRoundRolls(
  chatId: number,
  messageId: number
): Promise<InitiativeRoundRecord[]> {
  const pk = `INITIATIVE#${chatId}#${messageId}`;

  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':prefix': 'ROLL#',
      },
    })
  );

  return (result.Items || []) as InitiativeRoundRecord[];
}

/**
 * Full initiative coordination flow for an agent.
 * Returns what action the agent should take.
 *
 * @param chatId - Telegram chat ID
 * @param messageId - Triggering message ID
 * @param agentId - Agent ID
 * @param stats - Agent's D&D stats
 * @param message - The triggering message
 * @param recentResponseAge - Time since this agent last responded (ms)
 * @param channelActivity - Number of recent messages
 */
export async function coordinateInitiative(
  chatId: number,
  messageId: number,
  agentId: string,
  stats: AgentStats,
  message: BufferedMessage,
  recentResponseAge: number | null,
  channelActivity: number
): Promise<InitiativeResult> {
  // Step 1: Get or create the initiative round
  await getOrCreateInitiativeRound(chatId, messageId);

  // Step 2: Interest check
  const interest = checkInterest(
    stats,
    message,
    recentResponseAge,
    channelActivity
  );

  // Step 3: Record our roll
  const rollResult = await recordAgentRoll(
    chatId,
    messageId,
    agentId,
    interest,
    stats
  );

  if (!interest.interested || !rollResult) {
    return {
      action: 'skip',
      reason: 'not_interested',
    };
  }

  // Step 4: Attempt to claim winner
  const claimResult = await attemptWinnerClaim(
    chatId,
    messageId,
    agentId,
    rollResult.total
  );

  if (claimResult.isWinner) {
    return {
      action: 'respond',
      reason: 'won_initiative',
      priority: 'primary',
      myRoll: rollResult.total,
    };
  }

  // Not the winner - can react
  return {
    action: 'react',
    reason: 'lost_initiative',
    priority: 'secondary',
    winnerId: claimResult.winnerId,
    winnerRoll: claimResult.winnerRoll,
    myRoll: rollResult.total,
  };
}
