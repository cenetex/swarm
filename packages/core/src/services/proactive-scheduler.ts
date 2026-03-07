/**
 * Proactive Participation Scheduler
 *
 * Decides whether an avatar should speak proactively in a room
 * (i.e. without being directly addressed). Enforces:
 *   - Room-level budgets (max proactive per hour)
 *   - Bot-density suppression
 *   - Silence windows
 *   - Avatar cooldowns (from overlay)
 *   - Bot-to-bot continuation budgets and delays
 */
import type { SharedRoomMessage, AvatarRoomOverlay } from '../types/shared-room.js';
import type { ProactiveConfig, ProactiveDecision } from '../types/proactive.js';

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  enabled: true,
  maxProactivePerHour: 4,
  silenceWindowMs: 60_000,
  botDensityThreshold: 0.5,
  botToBotDelayMs: 30_000,
  botToBotBudgetPerHour: 2,
};

// =============================================================================
// HELPERS
// =============================================================================

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Calculate bot density from recent messages.
 * Returns a ratio (0-1) of avatar messages to total messages.
 * An empty message list yields 0 (no bots present).
 */
export function calculateBotDensity(messages: SharedRoomMessage[]): number {
  if (messages.length === 0) return 0;
  const botCount = messages.filter((m) => m.senderType === 'avatar').length;
  return botCount / messages.length;
}

/**
 * Count how many proactive messages (from any avatar) were sent in the last hour.
 * We approximate this by counting avatar messages in the window.
 */
function countProactiveInLastHour(
  messages: SharedRoomMessage[],
  now: number,
): number {
  const cutoff = now - ONE_HOUR_MS;
  return messages.filter(
    (m) => m.senderType === 'avatar' && m.timestamp >= cutoff,
  ).length;
}

/**
 * Count how many bot-to-bot continuations occurred in the last hour.
 * A bot-to-bot continuation is an avatar message immediately following
 * another avatar message.
 */
function countBotToBotInLastHour(
  messages: SharedRoomMessage[],
  now: number,
): number {
  const cutoff = now - ONE_HOUR_MS;
  let count = 0;
  for (let i = 1; i < messages.length; i++) {
    if (
      messages[i].senderType === 'avatar' &&
      messages[i - 1].senderType === 'avatar' &&
      messages[i].timestamp >= cutoff
    ) {
      count++;
    }
  }
  return count;
}

// =============================================================================
// MAIN EVALUATOR
// =============================================================================

/**
 * Evaluate whether an avatar should proactively participate in a room.
 *
 * @param roomId         - Room being evaluated (for logging / future use)
 * @param avatarId       - Avatar being considered
 * @param config         - Proactive configuration (defaults applied if omitted)
 * @param recentMessages - Recent messages in the room (chronological order)
 * @param overlay        - The avatar's room overlay (for cooldown checking)
 * @param now            - Current timestamp in ms (injectable for testing)
 */
export function evaluateProactive(
  _roomId: string,
  avatarId: string,
  config?: Partial<ProactiveConfig>,
  recentMessages: SharedRoomMessage[] = [],
  overlay?: AvatarRoomOverlay | null,
  now: number = Date.now(),
): ProactiveDecision {
  const cfg: ProactiveConfig = { ...DEFAULT_PROACTIVE_CONFIG, ...config };

  // 1. Disabled check
  if (!cfg.enabled) {
    return { shouldSpeak: false, avatarId, reason: 'disabled' };
  }

  // 2. Cooldown check (from overlay)
  if (overlay?.cooldownUntil && overlay.cooldownUntil > now) {
    return { shouldSpeak: false, avatarId, reason: 'cooldown' };
  }

  // 3. Silence window check
  //    The last message must be older than silenceWindowMs ago.
  //    If there are no messages, the room is silent — eligible.
  if (recentMessages.length > 0) {
    const lastMessage = recentMessages[recentMessages.length - 1];
    const timeSinceLastMessage = now - lastMessage.timestamp;
    if (timeSinceLastMessage < cfg.silenceWindowMs) {
      return { shouldSpeak: false, avatarId, reason: 'silence-window' };
    }
  }

  // 4. Bot density check
  const density = calculateBotDensity(recentMessages);
  if (density > cfg.botDensityThreshold) {
    return { shouldSpeak: false, avatarId, reason: 'bot-density-high' };
  }

  // 5. Room budget check (max proactive per hour)
  const proactiveCount = countProactiveInLastHour(recentMessages, now);
  if (proactiveCount >= cfg.maxProactivePerHour) {
    return { shouldSpeak: false, avatarId, reason: 'budget-exceeded' };
  }

  // 6. Bot-to-bot continuation: if last message was from an avatar,
  //    check bot-to-bot budget and apply extra delay.
  let delayMs = 0;
  if (recentMessages.length > 0) {
    const lastMessage = recentMessages[recentMessages.length - 1];
    if (lastMessage.senderType === 'avatar') {
      const b2bCount = countBotToBotInLastHour(recentMessages, now);
      if (b2bCount >= cfg.botToBotBudgetPerHour) {
        return { shouldSpeak: false, avatarId, reason: 'budget-exceeded' };
      }
      delayMs = cfg.botToBotDelayMs;
    }
  }

  // 7. Eligible
  return {
    shouldSpeak: true,
    avatarId,
    delayMs,
    reason: 'eligible',
  };
}
