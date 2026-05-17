/**
 * Telegram Inline Keyboard Builder Utilities
 * Builds inline keyboards for the Telegram admin bot
 */
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';
import type {
  CallbackAction,
  ParsedCallbackData,
} from '../types/telegram-admin.js';

// =============================================================================
// CALLBACK DATA ENCODING/DECODING
// =============================================================================

/**
 * Encode callback data for inline keyboard buttons
 * Format: action[:key=value,key2=value2]
 */
export function encodeCallbackData(action: CallbackAction, data?: Record<string, string>): string {
  if (!data || Object.keys(data).length === 0) {
    return action;
  }

  const params = Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');

  return `${action}:${params}`;
}

/**
 * Decode callback data from inline keyboard button press
 */
export function decodeCallbackData(callbackData: string): ParsedCallbackData {
  const colonIndex = callbackData.indexOf(':');

  if (colonIndex === -1) {
    return { action: callbackData as CallbackAction };
  }

  const action = callbackData.substring(0, colonIndex) as CallbackAction;
  const paramsStr = callbackData.substring(colonIndex + 1);

  const data: Record<string, string> = {};
  for (const param of paramsStr.split(',')) {
    const eqIndex = param.indexOf('=');
    if (eqIndex > 0) {
      const key = param.substring(0, eqIndex);
      const value = param.substring(eqIndex + 1);
      data[key] = value;
    }
  }

  return { action, data };
}

// =============================================================================
// BUTTON BUILDERS
// =============================================================================

/**
 * Create an inline keyboard button
 */
export function button(text: string, action: CallbackAction, data?: Record<string, string>): InlineKeyboardButton {
  return {
    text,
    callback_data: encodeCallbackData(action, data),
  };
}

/**
 * Create a URL button
 */
export function urlButton(text: string, url: string): InlineKeyboardButton {
  return { text, url };
}

function stripAt(username: string): string {
  return username.trim().replace(/^@+/, '');
}

/**
 * Build a Telegram managed-bot creation link for @BotFather.
 * Format: https://t.me/newbot/<manager_bot_username>/<suggested_username>?name=<display_name>
 */
export function managedBotCreationUrl(
  managerBotUsername: string,
  suggestedBotUsername: string,
  suggestedBotName: string
): string {
  const manager = encodeURIComponent(stripAt(managerBotUsername));
  const username = encodeURIComponent(suggestedBotUsername);
  const name = encodeURIComponent(suggestedBotName);
  return `https://t.me/newbot/${manager}/${username}?name=${name}`;
}

// =============================================================================
// KEYBOARD BUILDERS
// =============================================================================

/**
 * Build an inline keyboard from rows of buttons
 */
export function keyboard(...rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

/**
 * Build main menu keyboard for new users (no bot yet)
 */
export function mainMenuNewUser(): InlineKeyboardMarkup {
  return onboardingStartKeyboard();
}

/**
 * Build the onboarding start keyboard. When a manager bot username is known,
 * offer Telegram's managed-bot flow first; manual token paste remains the
 * fallback path.
 */
export function onboardingStartKeyboard(
  managerBotUsername?: string,
  suggestedBotUsername = 'swarmbot',
  suggestedBotName = 'Swarm Bot'
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];

  if (managerBotUsername) {
    rows.push([
      urlButton(
        'Create Managed Bot',
        managedBotCreationUrl(managerBotUsername, suggestedBotUsername, suggestedBotName)
      ),
    ]);
  }

  rows.push([button('Paste BotFather Token', 'manual_token')]);
  rows.push([urlButton('Learn More', 'https://swarm.rati.chat/docs')]);

  return keyboard(
    ...rows
  );
}

/**
 * Build main menu keyboard for existing users (has bot)
 */
export function mainMenu(botUsername?: string): InlineKeyboardMarkup {
  return keyboard(
    [button('Profile', 'profile_menu'), button('Integrations', 'integrations_menu')],
    [button('Generate Media', 'media_menu'), button('Status', 'status')],
    [button('Help', 'help')],
    ...(botUsername ? [[urlButton(`Open @${botUsername}`, `https://t.me/${botUsername}`)]] : [])
  );
}

/**
 * Build profile menu keyboard
 */
export function profileMenu(): InlineKeyboardMarkup {
  return keyboard(
    [button('Edit Name', 'edit_name'), button('Edit Description', 'edit_description')],
    [button('Edit Persona', 'edit_persona')],
    [button('Upload Profile Image', 'upload_image'), button('Generate Image', 'generate_image')],
    [button('Back to Main Menu', 'main_menu')]
  );
}

/**
 * Build integrations menu keyboard
 */
export function integrationsMenu(): InlineKeyboardMarkup {
  return keyboard(
    [button('Connect Twitter', 'connect_twitter'), button('Connect Discord', 'connect_discord')],
    [button('Telegram Settings', 'telegram_settings')],
    [button('Back to Main Menu', 'main_menu')]
  );
}

/**
 * Build media generation menu keyboard
 */
export function mediaMenu(): InlineKeyboardMarkup {
  return keyboard(
    [button('Generate Image', 'generate_media')],
    [button('View Gallery', 'view_gallery')],
    [button('Back to Main Menu', 'main_menu')]
  );
}

/**
 * Build confirmation keyboard
 */
export function confirmationKeyboard(yesText = 'Yes', noText = 'No'): InlineKeyboardMarkup {
  return keyboard(
    [button(yesText, 'confirm_yes'), button(noText, 'confirm_no')]
  );
}

/**
 * Build cancel keyboard (for multi-step flows)
 */
export function cancelKeyboard(): InlineKeyboardMarkup {
  return keyboard(
    [button('Cancel', 'cancel')]
  );
}

/**
 * Build skip/cancel keyboard (for optional steps)
 */
export function skipCancelKeyboard(skipText = 'Skip'): InlineKeyboardMarkup {
  return keyboard(
    [button(skipText, 'confirm_yes'), button('Cancel', 'cancel')]
  );
}

/**
 * Build back button keyboard
 */
export function backButton(action: CallbackAction, text = 'Back'): InlineKeyboardMarkup {
  return keyboard(
    [button(text, action)]
  );
}

// =============================================================================
// MESSAGE TEMPLATES
// =============================================================================

/**
 * Welcome message for new users
 */
export const WELCOME_NEW_USER = `Welcome to Ratibot! I'll help you create your own AI-powered bot.

Tap "Create Managed Bot" to create a Telegram bot without copying a token. If Telegram does not offer managed-bot access for your account yet, use the manual token option.`;

/**
 * Manual token fallback instructions
 */
export const MANUAL_TOKEN_INSTRUCTIONS = `Manual token setup:

1. Open @BotFather
2. Send /newbot
3. Choose a name and username for your bot
4. Forward the message containing your bot token to me

Tip: The message from BotFather will contain a token that looks like: 123456789:ABCdef...`;

/**
 * Welcome message for returning users
 */
export function welcomeReturningUser(botUsername: string, botName: string): string {
  return `Welcome back! Your bot @${botUsername} (${botName}) is active.

What would you like to do?`;
}

/**
 * Token received - asking for name
 */
export function tokenReceivedMessage(botUsername: string): string {
  return `Found your bot: @${botUsername}

Now, what would you like to name your bot? This will be displayed in the admin panel.

Example: "My Assistant" or "Coffee Shop Bot"`;
}

/**
 * Managed bot received - asking for name
 */
export function managedBotReceivedMessage(botUsername: string): string {
  return `Connected your managed bot: @${botUsername}

Now, what would you like to name your bot? This will be displayed in the admin panel.

Example: "My Assistant" or "Coffee Shop Bot"`;
}

/**
 * Managed bot token was unavailable
 */
export function managedBotUnavailableMessage(botUsername?: string): string {
  const botLabel = botUsername ? ` for @${botUsername}` : '';
  return `Telegram did not return managed-bot access${botLabel}. Please use manual token setup for now.`;
}

/**
 * Name received - asking for description
 */
export function nameReceivedMessage(name: string): string {
  return `Great! Your bot will be called "${name}".

Now give your bot a short description (optional).

Example: "A helpful assistant for coffee lovers"

Or send "skip" to continue without a description.`;
}

/**
 * Description received - asking for persona
 */
export function descriptionReceivedMessage(_name: string): string {
  return `Perfect! Now describe your bot's personality. How should it talk? What's its style?

Example: "A friendly barista who loves coffee, speaks casually, uses coffee puns, and always recommends the perfect drink."

Or send "skip" to use a default personality.`;
}

/**
 * Bot creation success message
 */
export function creationSuccessMessage(botUsername: string): string {
  return `Your bot is ready!

@${botUsername} is now live and will respond to messages.

What you can do:
- Start chatting: t.me/${botUsername}
- Add to a group to let others interact
- DM me anytime to update your bot's settings

Have fun!`;
}

/**
 * Invalid token error message
 */
export const INVALID_TOKEN = `That doesn't look like a valid bot token. Please forward the complete message from @BotFather.

The token should look like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789`;

/**
 * Token already used error message
 */
export const TOKEN_ALREADY_USED = `This bot is already registered with another account.

If you own this bot, please create a new bot with @BotFather and forward that token to me.`;

/**
 * Already has a bot error message
 */
export function alreadyHasBotMessage(botUsername: string): string {
  return `You've already created a bot (@${botUsername}).

Each Telegram account can create one bot. Use the menu to manage your existing bot.`;
}

/**
 * Status overview message
 */
export function statusMessage(
  botUsername: string,
  name: string,
  isActive: boolean,
  integrations: { twitter?: boolean; discord?: boolean }
): string {
  const statusEmoji = isActive ? '🟢' : '🔴';
  const twitterStatus = integrations.twitter ? '✅ Connected' : '❌ Not connected';
  const discordStatus = integrations.discord ? '✅ Connected' : '❌ Not connected';

  return `📊 Bot Status for @${botUsername}

${statusEmoji} Status: ${isActive ? 'Active' : 'Inactive'}
📝 Name: ${name}

Integrations:
- Twitter: ${twitterStatus}
- Discord: ${discordStatus}`;
}

/**
 * Help message
 */
export const HELP_MESSAGE = `Here's what I can help you with:

/start - Show main menu
/status - Check your bot's status
/profile - Edit bot profile (name, description, persona)
/image - Upload or generate profile image
/connect - Configure integrations (Twitter, Discord)
/generate - Create images or stickers
/cancel - Cancel current operation
/help - Show this help message

You can also just describe what you want in plain text and I'll help you out!`;

/**
 * Operation cancelled message
 */
export const OPERATION_CANCELLED = 'Operation cancelled. What would you like to do?';

/**
 * Generic error message
 */
export const ERROR_GENERIC = `Something went wrong. Please try again or type /help for assistance.`;

/**
 * Forward from non-BotFather message
 */
export const NOT_FROM_BOTFATHER = `I can only accept forwards from @BotFather.

Please forward the message that contains your bot token directly from @BotFather.`;
