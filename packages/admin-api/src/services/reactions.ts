/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Reactions Service
 *
 * Handles emoji reactions for avatars who lose initiative.
 * Uses Telegram's setMessageReaction API.
 *
 * Uses SQS with DelaySeconds for reliable reaction delivery after Lambda completes.
 *
 * CONTROL-PLANE ONLY — this module is part of admin-api and is tied to the
 * initiative system (initiative.ts). It is NOT wired into the live message
 * processing pipeline. The runtime coordination lives in
 * packages/core/src/services/state/channel-state.ts.
 *
 * Retained for:
 *   - Future multi-avatar reaction support (when initiative is migrated)
 *   - Reference implementation of SQS-delayed reaction delivery
 *
 * @see docs/COORDINATION-OWNERSHIP.md for the full ownership model.
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqsClient = new SQSClient({});
const REACTION_QUEUE_URL = process.env.RESPONSE_QUEUE_URL; // Reuse response queue

// Common reaction emojis that work with Telegram
const REACTION_EMOJIS = [
  '👍', '👎', '❤️', '🔥', '🥰', '👏', '😁', '🤔',
  '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩',
  '🙏', '👌', '🕊️', '🤡', '🥱', '🥴', '😍', '🐳',
  '❤️‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆',
  '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈',
  '😇', '😨', '🤝', '✍️', '🤗', '🫡', '🎅', '🎄',
  '☃️', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄',
  '😘', '💊', '🙊', '😎', '👾', '🤷', '🤷‍♂️', '🤷‍♀️',
];

// Positive reaction emojis
const POSITIVE_EMOJIS = [
  '👍', '❤️', '🔥', '👏', '😁', '🎉', '🤩', '💯',
  '👌', '🙏', '🏆', '⚡', '🤗', '😇', '🤝', '🆒',
];

// Thinking/neutral emojis
const THINKING_EMOJIS = ['🤔', '🤨', '😐', '👀', '🤓', '✍️', '🤷'];

// Fun/playful emojis
const PLAYFUL_EMOJIS = [
  '🤯', '😱', '🤡', '🌚', '🐳', '🍌', '🎃', '👻',
  '👾', '🦄', '🗿', '🤪', '🙈', '🙉', '🙊',
];

export interface ReactionDecision {
  shouldReact: boolean;
  emoji?: string;
  delay: number; // Delay in ms before reacting
}

// Reaction configuration - tuned for cosy vibes
export const REACTION_CONFIG = {
  // Probability of reacting (0-1) - reduced for less spam
  REACTION_PROBABILITY: 0.15,
  // Min/max delay before reacting - increased for natural feel
  MIN_REACTION_DELAY_MS: 3000,
  MAX_REACTION_DELAY_MS: 12000,
  // Cooldown between reactions from same avatar - increased
  REACTION_COOLDOWN_MS: 60000,
};

/**
 * Decide whether an avatar should react and with what emoji.
 * Uses simple probability-based decision making.
 *
 * @param messageText - The message being reacted to
 * @param winnerResponse - The winner's response (if available)
 * @returns Reaction decision
 */
export function decideReaction(
  messageText: string,
  winnerResponse?: string
): ReactionDecision {
  // Random chance to react
  if (Math.random() > REACTION_CONFIG.REACTION_PROBABILITY) {
    return { shouldReact: false, delay: 0 };
  }

  // Choose emoji based on message sentiment (simple heuristic)
  const emoji = chooseEmoji(messageText, winnerResponse);

  // Random delay
  const delay =
    REACTION_CONFIG.MIN_REACTION_DELAY_MS +
    Math.random() *
      (REACTION_CONFIG.MAX_REACTION_DELAY_MS -
        REACTION_CONFIG.MIN_REACTION_DELAY_MS);

  return {
    shouldReact: true,
    emoji,
    delay: Math.floor(delay),
  };
}

/**
 * Choose an appropriate emoji based on message content.
 */
function chooseEmoji(messageText: string, winnerResponse?: string): string {
  const lowerText = (messageText + ' ' + (winnerResponse || '')).toLowerCase();

  // Check for positive sentiment
  if (
    /\b(good|great|awesome|nice|love|thanks|amazing|beautiful|perfect)\b/.test(
      lowerText
    )
  ) {
    return randomFrom(POSITIVE_EMOJIS);
  }

  // Check for questions or thinking
  if (/\?|think|wonder|maybe|perhaps|how|why|what/.test(lowerText)) {
    return randomFrom(THINKING_EMOJIS);
  }

  // Check for humor/fun
  if (/\b(lol|lmao|haha|funny|joke|meme)\b/.test(lowerText)) {
    return randomFrom(PLAYFUL_EMOJIS);
  }

  // Default: random from all
  return randomFrom(REACTION_EMOJIS);
}

function randomFrom<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * Send a reaction to a message via Telegram API.
 *
 * @param token - Bot token
 * @param chatId - Chat ID
 * @param messageId - Message ID to react to
 * @param emoji - Emoji to react with
 */
export async function sendTelegramReaction(
  token: string,
  chatId: number,
  messageId: number,
  emoji: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/setMessageReaction`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji }],
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      console.warn(
        `[reactions] Failed to send reaction: ${JSON.stringify(error)}`
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error('[reactions] Error sending reaction:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Handle reaction flow for an avatar who lost initiative.
 * Decides whether to react and queues the reaction via SQS with delay.
 *
 * Uses SQS DelaySeconds for reliable delivery after Lambda response.
 * Falls back to fire-and-forget if SQS queue is not configured.
 *
 * @param token - Bot token
 * @param chatId - Chat ID
 * @param messageId - Message ID to react to
 * @param messageText - Original message text
 * @param avatarId - Avatar ID (for queue message)
 * @param winnerResponse - Winner's response (if available)
 */
export async function handleReaction(
  token: string,
  chatId: number,
  messageId: number,
  messageText: string,
  avatarId?: string,
  winnerResponse?: string
): Promise<void> {
  const decision = decideReaction(messageText, winnerResponse);

  if (!decision.shouldReact || !decision.emoji) {
    return;
  }

  // Calculate delay in seconds for SQS (max 900 seconds = 15 minutes)
  const delaySeconds = Math.min(Math.ceil(decision.delay / 1000), 900);

  // Try SQS-based delivery for reliability
  if (REACTION_QUEUE_URL && avatarId) {
    try {
      const reactionMessage = {
        type: 'telegram_reaction',
        avatarId,
        chatId,
        messageId,
        emoji: decision.emoji,
        // Include token in message for processing (encrypted in transit via SQS)
        token,
      };

      await sqsClient.send(new SendMessageCommand({
        QueueUrl: REACTION_QUEUE_URL,
        MessageBody: JSON.stringify(reactionMessage),
        DelaySeconds: delaySeconds,
      }));

      console.log(`[reactions] Queued reaction ${decision.emoji} for message ${messageId} with ${delaySeconds}s delay`);
      return;
    } catch (err) {
      console.warn('[reactions] SQS queue failed, falling back to fire-and-forget:', err instanceof Error ? err.message : String(err));
    }
  }

  // Fallback: Fire-and-forget (best-effort, may not complete if Lambda freezes)
  setTimeout(() => {
    sendTelegramReaction(token, chatId, messageId, decision.emoji!)
      .catch((err) => console.warn('[reactions] Fire-and-forget reaction failed:', err instanceof Error ? err.message : String(err)));
  }, decision.delay);
}
