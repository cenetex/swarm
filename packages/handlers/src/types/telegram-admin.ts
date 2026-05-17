/**
 * Telegram Admin Bot Types
 * Types for the in-Telegram bot creation and admin feature
 */

/** Minimal avatar record shape for admin tool results */
type AvatarRecord = Record<string, unknown>;

// =============================================================================
// SESSION STATES
// =============================================================================

/**
 * Session states for multi-step flows in the Telegram admin bot
 */
export type AdminSessionState =
  | 'idle'                    // No active flow
  | 'onboarding_token'        // Waiting for BotFather token forward
  | 'onboarding_name'         // Asking for bot name
  | 'onboarding_description'  // Asking for bot description
  | 'onboarding_persona'      // Asking for personality
  | 'editing_name'            // Updating existing bot name
  | 'editing_description'     // Updating existing bot description
  | 'editing_persona'         // Updating existing persona
  | 'uploading_image'         // Waiting for image upload
  | 'generating_image'        // Generating profile image from prompt
  | 'configuring_integration' // Multi-step integration setup
  | 'awaiting_secret'         // Waiting for API key input
  | 'confirming_action';      // Waiting for confirmation (yes/no)

// =============================================================================
// SESSION DATA
// =============================================================================

/**
 * Admin session stored in DynamoDB
 * Tracks user state and data for multi-step flows
 */
export interface TelegramAdminSession {
  /** Partition key: TG_ADMIN#{telegramUserId} */
  pk: string;
  /** Sort key: SESSION */
  sk: string;
  /** Telegram user ID */
  telegramUserId: string;
  /** Telegram username (without @) */
  telegramUsername?: string;
  /** Display name (first name + last name) */
  telegramDisplayName?: string;
  /** User's created bot avatar ID (if any) */
  avatarId?: string;
  /** Current session state */
  state: AdminSessionState;
  /** State-specific data for multi-step flows */
  stateData?: Record<string, unknown>;
  /** Last message ID sent by bot (for updating inline keyboards) */
  lastBotMessageId?: number;
  /** When the session started */
  startedAt: number;
  /** When the session was last updated */
  updatedAt: number;
  /** DynamoDB TTL (auto-expire inactive sessions) */
  ttl: number;
}

/**
 * Onboarding state data - stored in session.stateData during onboarding
 */
export interface OnboardingStateData extends Record<string, unknown> {
  /** Bot token from BotFather */
  botToken?: string;
  /** Bot username (parsed from token validation) */
  botUsername?: string;
  /** Bot ID (from getMe validation) */
  botId?: number;
  /** Chosen name for the bot */
  name?: string;
  /** Optional description */
  description?: string;
  /** Optional persona/personality */
  persona?: string;
  /** How the bot token entered the onboarding flow */
  provisioningSource?: 'manual_token' | 'managed_bot';
}

/**
 * Integration setup state data
 */
export interface IntegrationStateData {
  /** Integration type being configured */
  integrationType: 'twitter' | 'discord' | 'telegram_settings';
  /** Step in the integration flow */
  step: number;
  /** Accumulated configuration */
  config: Record<string, unknown>;
}

/**
 * Image upload/generation state data
 */
export interface ImageStateData {
  /** Purpose of the image */
  purpose: 'profile' | 'character_reference';
  /** If generating, the prompt */
  prompt?: string;
}

/**
 * Confirmation state data
 */
export interface ConfirmationStateData {
  /** Action being confirmed */
  action: 'delete_bot' | 'reset_settings' | 'disconnect_integration';
  /** Additional context */
  context?: Record<string, unknown>;
}

// =============================================================================
// USER BOT REGISTRY
// =============================================================================

/**
 * User bot registry record.
 * Key (new): pk=TELEGRAM_USER#{telegramUserId}, sk=CREATED_BOT#{avatarId}
 * Key (legacy/back-compat): pk=TELEGRAM_USER#{telegramUserId}, sk=CREATED_BOT
 */
export interface TelegramUserBotRecord {
  pk: string;
  sk: string;
  telegramUserId: string;
  telegramUsername?: string;
  avatarId: string;
  botUsername: string;
  createdAt: number;
  updatedAt: number;
}

// =============================================================================
// ADMIN BOT CONFIG
// =============================================================================

/**
 * Configuration for the admin bot itself
 */
export interface TelegramAdminBotConfig {
  /** Whether this avatar is the admin bot */
  isAdminBot: boolean;
  /** Allow DMs from all users (for admin bot) */
  allowAllDms: boolean;
  /** Bot username for the admin bot */
  botUsername: string;
}

// =============================================================================
// CALLBACK QUERY DATA
// =============================================================================

/**
 * Callback data prefix for inline keyboard buttons
 */
export type CallbackAction =
  | 'main_menu'
  | 'manual_token'
  | 'profile_menu'
  | 'edit_name'
  | 'edit_description'
  | 'edit_persona'
  | 'upload_image'
  | 'generate_image'
  | 'integrations_menu'
  | 'connect_twitter'
  | 'connect_discord'
  | 'telegram_settings'
  | 'media_menu'
  | 'generate_media'
  | 'view_gallery'
  | 'status'
  | 'help'
  | 'cancel'
  | 'confirm_yes'
  | 'confirm_no';

/**
 * Parsed callback data from inline keyboard
 */
export interface ParsedCallbackData {
  action: CallbackAction;
  data?: Record<string, string>;
}

// =============================================================================
// COMMAND TYPES
// =============================================================================

/**
 * Supported commands for the admin bot
 */
export type AdminCommand =
  | 'start'
  | 'status'
  | 'profile'
  | 'image'
  | 'connect'
  | 'generate'
  | 'help'
  | 'cancel';

// =============================================================================
// MESSAGE TEMPLATES
// =============================================================================

/**
 * Message template IDs for consistent messaging
 */
export type MessageTemplateId =
  | 'welcome_new_user'
  | 'welcome_existing_user'
  | 'onboarding_instructions'
  | 'token_received'
  | 'name_prompt'
  | 'description_prompt'
  | 'persona_prompt'
  | 'creation_success'
  | 'creation_failed'
  | 'invalid_token'
  | 'token_already_used'
  | 'already_has_bot'
  | 'main_menu'
  | 'profile_menu'
  | 'integrations_menu'
  | 'status_overview'
  | 'help_text'
  | 'operation_cancelled'
  | 'error_generic';

// =============================================================================
// ADMIN TOOL RESULTS
// =============================================================================

/**
 * Result from an admin tool operation
 */
export interface AdminToolResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  /** Updated avatar record (if applicable) */
  avatar?: AvatarRecord;
  /** Media URLs to send */
  media?: Array<{
    type: 'photo' | 'video' | 'animation' | 'document';
    url: string;
    caption?: string;
  }>;
  /** Inline keyboard to show */
  keyboard?: InlineKeyboardMarkup;
}

// =============================================================================
// TELEGRAM API TYPES (Subset for our use)
// =============================================================================

/**
 * Inline keyboard button
 */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/**
 * Inline keyboard markup
 */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Reply keyboard button
 */
export interface KeyboardButton {
  text: string;
  request_contact?: boolean;
}

/**
 * Reply keyboard markup
 */
export interface ReplyKeyboardMarkup {
  keyboard: KeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  selective?: boolean;
}

/**
 * Remove keyboard markup
 */
export interface ReplyKeyboardRemove {
  remove_keyboard: true;
  selective?: boolean;
}

/**
 * Union type for all reply markup types
 */
export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove;

// =============================================================================
// GSI INDEX PATTERNS
// =============================================================================

/**
 * GSI patterns for Telegram admin queries
 * gsi3pk: TELEGRAM_BOT#{botId} for looking up avatars by Telegram bot ID
 */
export interface TelegramBotGSI {
  gsi3pk: string; // TELEGRAM_BOT#{botId}
  gsi3sk: string; // AVATAR
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Session TTL: 24 hours for active sessions */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Onboarding session TTL: 15 minutes for incomplete onboarding */
export const ONBOARDING_TTL_MS = 15 * 60 * 1000;

/** Maximum bot name length */
export const MAX_BOT_NAME_LENGTH = 64;

/** Maximum description length */
export const MAX_DESCRIPTION_LENGTH = 512;

/** Maximum persona length */
export const MAX_PERSONA_LENGTH = 4096;

/** Bot token regex pattern */
export const BOT_TOKEN_REGEX = /\b(\d{8,10}:[A-Za-z0-9_-]{35})\b/;

/** t.me bot link regex pattern */
export const BOT_LINK_REGEX = /t\.me\/([A-Za-z0-9_]{5,32})/i;
