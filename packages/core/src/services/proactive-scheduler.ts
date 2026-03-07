/**
 * Proactive Participation Scheduler
 *
 * Decides whether an avatar should speak proactively in a room
 * (i.e. without being directly addressed). Enforces:
 *   - Per-avatar per-room budgets (max proactive per hour, in-memory tracking)
 *   - Bot-density suppression
 *   - Silence windows
 *   - Avatar cooldowns (from overlay)
 *   - Bot-to-bot continuation budgets and delays
 *
 * Proactive messages are distinguishable in the shared room ledger via
 * the `isProactive: true` metadata flag (set by the caller when appending).
 *
 * Budget tracking is in-memory (Map with hourly reset) — does not need
 * to survive Lambda cold starts.
 */
import { logger } from '../utils/logger.js';
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
// PER-AVATAR IN-MEMORY BUDGET TRACKER
// =============================================================================

interface BudgetEntry {
  /** Timestamps of recorded proactive messages in the current window */
  timestamps: number[];
}

/**
 * In-memory budget tracker keyed by `roomKey:avatarId`.
 * Entries auto-prune expired timestamps on access.
 */
const budgetMap = new Map<string, BudgetEntry>();

function budgetKey(roomKey: string, avatarId: string): string {
  return `${roomKey}:${avatarId}`;
}

/**
 * Get the current budget entry for a room+avatar, pruning expired timestamps.
 */
function getBudgetEntry(roomKey: string, avatarId: string, now: number): BudgetEntry {
  const key = budgetKey(roomKey, avatarId);
  const existing = budgetMap.get(key);
  const cutoff = now - ONE_HOUR_MS;

  if (!existing) {
    const entry: BudgetEntry = { timestamps: [] };
    budgetMap.set(key, entry);
    return entry;
  }

  // Prune timestamps outside the current window
  existing.timestamps = existing.timestamps.filter((t) => t >= cutoff);
  return existing;
}

/**
 * Record that a proactive message was sent, consuming one budget slot.
 *
 * Call this AFTER the proactive message has been successfully sent
 * (not before, to avoid counting failed attempts).
 *
 * @param roomKey  - Canonical room key (e.g. "telegram:-1001234567890")
 * @param avatarId - Avatar identifier
 * @param now      - Current timestamp in ms (injectable for testing)
 */
export function recordProactiveMessage(
  roomKey: string,
  avatarId: string,
  now: number = Date.now(),
): void {
  const entry = getBudgetEntry(roomKey, avatarId, now);
  entry.timestamps.push(now);

  logger.info('proactive_record: message recorded', {
    subsystem: 'proactive-scheduler',
    roomKey,
    avatarId,
    budgetUsed: entry.timestamps.length,
  });
}

/**
 * Get the number of proactive messages recorded for an avatar in a room
 * within the current hourly window.
 *
 * @param roomKey  - Canonical room key
 * @param avatarId - Avatar identifier
 * @param now      - Current timestamp in ms (injectable for testing)
 */
export function getAvatarBudgetUsed(
  roomKey: string,
  avatarId: string,
  now: number = Date.now(),
): number {
  const entry = getBudgetEntry(roomKey, avatarId, now);
  return entry.timestamps.length;
}

/**
 * Reset all in-memory budget tracking. Test use only.
 */
export function _resetBudgets(): void {
  budgetMap.clear();
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

  // 5a. Room budget check (max proactive per hour across all avatars)
  const proactiveCount = countProactiveInLastHour(recentMessages, now);
  if (proactiveCount >= cfg.maxProactivePerHour) {
    return { shouldSpeak: false, avatarId, reason: 'budget-exceeded' };
  }

  // 5b. Per-avatar budget check (in-memory tracked via recordProactiveMessage)
  const avatarBudgetUsed = getAvatarBudgetUsed(_roomId, avatarId, now);
  if (avatarBudgetUsed >= cfg.maxProactivePerHour) {
    logger.info('proactive_eval: per-avatar budget exhausted', {
      subsystem: 'proactive-scheduler',
      roomKey: _roomId,
      avatarId,
      avatarBudgetUsed,
      limit: cfg.maxProactivePerHour,
    });
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
