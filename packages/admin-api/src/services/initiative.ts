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

// Configuration - tuned for cosy, less spammy multi-agent chats
export const INITIATIVE_CONFIG = {
  // Round timeout - how long to wait for all agents to roll
  ROUND_TIMEOUT_MS: 8000,        // Increased from 5s for more staggered responses
  // Base difficulty class for interest check
  BASE_INTEREST_DC: 14,          // Raised from 10 - agents are pickier about responding
  // DC modifiers
  TOPIC_MATCH_BONUS: -2,         // Reduced from -3, less eager to jump in
  HIGH_ACTIVITY_PENALTY: 4,      // Increased from 2 - back off when busy
  RECENT_RESPONSE_PENALTY: 8,    // Increased from 5 - longer "thinking" time after responding
  // Bot-to-bot interaction penalties (new)
  BOT_MESSAGE_PENALTY: 6,        // Higher DC for responding to bot messages
  BOT_RESPONDED_RECENTLY_PENALTY: 10, // Very high DC if recently responded to a bot
  // TTL for initiative records
  ROUND_TTL_SECONDS: 300,        // 5 minutes
  // Stagger settings for cosy vibes
  MIN_RESPONSE_STAGGER_MS: 3000, // Minimum stagger between agents
  MAX_RESPONSE_STAGGER_MS: 10000, // Maximum stagger
};

/**
 * Check if an agent is interested in responding to a message.
 * Uses CHA for social contexts, WIS for reflective/thoughtful contexts.
 *
 * Direct mentions always pass (the mentioned agent handles it outside initiative).
 * Bot-to-bot interactions are allowed but with higher DC to prevent spam.
 *
 * @param stats - Agent's D&D stats
 * @param message - The triggering message
 * @param recentResponseAge - Time since this agent last responded (ms)
 * @param channelActivity - Number of recent messages in channel
 * @param lastBotResponseAge - Time since this agent last responded to a bot message (ms)
 */
export function checkInterest(
  stats: AgentStats,
  message: BufferedMessage,
  recentResponseAge: number | null,
  channelActivity: number,
  lastBotResponseAge?: number | null
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
  // Even higher penalty for very active channels
  if (channelActivity > 20) {
    dc += INITIATIVE_CONFIG.HIGH_ACTIVITY_PENALTY;
  }

  // Recent response raises DC (cooldown effect)
  if (recentResponseAge !== null && recentResponseAge < 60000) {
    dc += INITIATIVE_CONFIG.RECENT_RESPONSE_PENALTY;
  }
  // Extra penalty if responded very recently (within 30s)
  if (recentResponseAge !== null && recentResponseAge < 30000) {
    dc += 4;
  }

  // Bot-to-bot interaction handling - allow but make it harder
  if (message.isFromBot) {
    dc += INITIATIVE_CONFIG.BOT_MESSAGE_PENALTY;
    
    // If we recently responded to a bot, add extra penalty
    if (lastBotResponseAge !== null && lastBotResponseAge !== undefined && lastBotResponseAge < 120000) {
      dc += INITIATIVE_CONFIG.BOT_RESPONDED_RECENTLY_PENALTY;
    }
  }

  // Clamp DC to reasonable range (increased max for bot interactions)
  dc = Math.max(5, Math.min(28, dc));

  // Roll interest check
  const roll = rollD20();
  const total = roll + modifier;
  const interested = total >= dc;

  return {
    interested,
    roll: total,
    modifier,
    dc,
    reason: interested 
      ? (message.isFromBot ? 'bot_interaction_interest' : 'context_interest') 
      : (message.isFromBot ? 'bot_message_skipped' : 'not_interested'),
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
 * Includes structured logging for observability (P2):
 * - Round ID for correlation
 * - Interest check results
 * - Initiative rolls and outcomes
 *
 * @param chatId - Telegram chat ID
 * @param messageId - Triggering message ID
 * @param agentId - Agent ID
 * @param stats - Agent's D&D stats
 * @param message - The triggering message
 * @param recentResponseAge - Time since this agent last responded (ms)
 * @param channelActivity - Number of recent messages
 * @param lastBotResponseAge - Time since this agent last responded to a bot (ms)
 */
export async function coordinateInitiative(
  chatId: number,
  messageId: number,
  agentId: string,
  stats: AgentStats,
  message: BufferedMessage,
  recentResponseAge: number | null,
  channelActivity: number,
  lastBotResponseAge?: number | null
): Promise<InitiativeResult> {
  // Round ID for correlation in logs
  const roundId = `${chatId}#${messageId}`;
  
  // Step 1: Get or create the initiative round
  const round = await getOrCreateInitiativeRound(chatId, messageId);
  
  // Log round creation/join
  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'initiative',
    event: 'round_joined',
    roundId,
    agentId,
    chatId,
    messageId,
    roundPhase: round.phase,
    roundStartedAt: round.startedAt,
    isFromBot: message.isFromBot,
  }));

  // Step 2: Interest check (now includes bot interaction awareness)
  const interest = checkInterest(
    stats,
    message,
    recentResponseAge,
    channelActivity,
    lastBotResponseAge
  );
  
  // Log interest check result
  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'initiative',
    event: 'interest_check',
    roundId,
    agentId,
    interested: interest.interested,
    roll: interest.roll,
    dc: interest.dc,
    modifier: interest.modifier,
    reason: interest.reason,
    channelActivity,
    recentResponseAge,
    lastBotResponseAge,
    isFromBot: message.isFromBot,
  }));

  // Step 3: Record our roll
  const rollResult = await recordAgentRoll(
    chatId,
    messageId,
    agentId,
    interest,
    stats
  );

  if (!interest.interested || !rollResult) {
    // Log skip decision
    console.log(JSON.stringify({
      level: 'INFO',
      subsystem: 'initiative',
      event: 'agent_skipped',
      roundId,
      agentId,
      reason: 'not_interested',
      interestRoll: interest.roll,
      interestDC: interest.dc,
    }));
    
    return {
      action: 'skip',
      reason: 'not_interested',
    };
  }
  
  // Log initiative roll
  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'initiative',
    event: 'initiative_rolled',
    roundId,
    agentId,
    roll: rollResult.roll,
    total: rollResult.total,
    dexModifier: stats.modifiers.DEX,
  }));

  // Step 4: Attempt to claim winner
  const claimResult = await attemptWinnerClaim(
    chatId,
    messageId,
    agentId,
    rollResult.total
  );

  if (claimResult.isWinner) {
    // Log winner
    console.log(JSON.stringify({
      level: 'INFO',
      subsystem: 'initiative',
      event: 'initiative_won',
      roundId,
      agentId,
      myRoll: rollResult.total,
      action: 'respond',
    }));
    
    return {
      action: 'respond',
      reason: 'won_initiative',
      priority: 'primary',
      myRoll: rollResult.total,
    };
  }

  // Log loss
  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'initiative',
    event: 'initiative_lost',
    roundId,
    agentId,
    myRoll: rollResult.total,
    winnerId: claimResult.winnerId,
    winnerRoll: claimResult.winnerRoll,
    action: 'react',
  }));

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
