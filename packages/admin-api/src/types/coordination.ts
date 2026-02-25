/**
 * Multi-avatar D&D coordination types — initiative, interest checks, shared channels
 */

// ========================================
// Multi-Avatar D&D Coordination Types
// ========================================

/**
 * D&D ability scores with computed modifiers
 * Generated deterministically from avatar createdAt timestamp
 */
export interface AvatarStats {
  STR: number; // Strength - reserved for future use
  DEX: number; // Dexterity - Initiative modifier
  CON: number; // Constitution - reserved for future use
  INT: number; // Intelligence - reserved for future use
  WIS: number; // Wisdom - Interest check (reflective contexts)
  CHA: number; // Charisma - Interest check (social contexts)
  modifiers: {
    STR: number;
    DEX: number;
    CON: number;
    INT: number;
    WIS: number;
    CHA: number;
  };
}

/**
 * Shared channel registry record
 * Tracks all avatars present in a Telegram channel/group
 * Key: pk=SHARED_CHANNEL#{chatId}, sk=AVATAR#{avatarId}
 */
export interface SharedChannelRecord {
  pk: string;              // SHARED_CHANNEL#{chatId}
  sk: string;              // AVATAR#{avatarId}
  chatId: number;
  avatarId: string;
  botUsername: string;     // For mention detection
  joinedAt: number;        // First seen in channel
  lastSeenAt: number;      // Last activity
  stats: AvatarStats;       // D&D ability scores
  ttl: number;             // Auto-cleanup after inactivity
}

/**
 * Shared channel message - a message in the shared history visible to all bots
 * This allows bots to see each other's responses in multi-avatar channels
 */
export interface SharedChannelMessage {
  messageId: number;       // Telegram message ID
  avatarId: string;         // Which bot sent this
  botUsername: string;     // Bot's @username for display
  text: string;            // Message content
  timestamp: number;       // When it was sent
  replyToMessageId?: number; // What message this replies to
}

/**
 * Shared channel history record
 * Stores recent bot messages visible to all bots in the channel
 * Key: pk=SHARED_HISTORY#{chatId}, sk=HISTORY
 */
export interface SharedChannelHistoryRecord {
  pk: string;              // SHARED_HISTORY#{chatId}
  sk: string;              // HISTORY
  chatId: number;
  messages: SharedChannelMessage[];
  ttl: number;             // Auto-cleanup
  updatedAt: number;
}

/**
 * Initiative round phases
 */
export type InitiativePhase = 'interest' | 'rolling' | 'responding' | 'reacting' | 'complete';

/**
 * Initiative round coordination record
 * Coordinates which avatar responds to a message in multi-avatar channels
 * Key: pk=INITIATIVE#{chatId}#{messageId}, sk=META or ROLL#{avatarId}
 */
export interface InitiativeRoundRecord {
  pk: string;              // INITIATIVE#{chatId}#{messageId}
  sk: string;              // META or ROLL#{avatarId}
  chatId: number;
  messageId: number;       // Triggering message ID

  // For META record (sk: META)
  phase?: InitiativePhase;
  startedAt?: number;
  expiresAt?: number;      // Round times out after this
  winnerId?: string;       // Avatar who won initiative
  winnerRoll?: number;     // Winning roll total
  winnerRespondedAt?: number;

  // Reaction coordination (META record)
  reactionCount?: number;         // Number of reactions already applied for this triggering message
  reactionAvatars?: string[];     // Avatars that have already reacted (dedupe)

  // For ROLL records (sk: ROLL#{avatarId})
  avatarId?: string;
  interested?: boolean;    // Interest check result
  interestRoll?: number;   // CHA/WIS check roll
  initiativeRoll?: number; // d20 roll
  initiativeModifier?: number; // DEX modifier
  totalInitiative?: number; // roll + modifier
  rolledAt?: number;

  ttl: number;             // Auto-cleanup (5 min)
}

/**
 * Interest check result
 */
export interface InterestCheckResult {
  interested: boolean;
  roll: number;
  modifier: number;
  dc: number;
  reason: 'direct_engagement' | 'context_interest' | 'not_interested' | 'bot_interaction_interest' | 'bot_message_skipped';
}

/**
 * Initiative coordination result
 */
export type InitiativeAction = 'respond' | 'react' | 'skip';

export interface InitiativeResult {
  action: InitiativeAction;
  reason: string;
  priority?: 'primary' | 'secondary';
  winnerId?: string;
  winnerRoll?: number;
  myRoll?: number;
}
