/**
 * Telegram Service
 * Handles Telegram API interactions for webhook registration
 */

const API_DOMAIN = process.env.API_DOMAIN || 'api-staging.rati.chat';

/**
 * Register a webhook with Telegram
 */
export async function registerTelegramWebhook(
  botToken: string,
  agentId: string
): Promise<{ success: boolean; message: string; webhookUrl?: string }> {
  const webhookUrl = `https://${API_DOMAIN}/webhook/telegram/${agentId}`;
  
  const url = `https://api.telegram.org/bot${botToken}/setWebhook`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true,
    }),
  });

  const result = await response.json() as { ok: boolean; description?: string };

  if (!result.ok) {
    console.error('Failed to register webhook:', result);
    return {
      success: false,
      message: result.description || 'Failed to register webhook',
    };
  }

  console.log(`Registered Telegram webhook for agent ${agentId}: ${webhookUrl}`);
  
  return {
    success: true,
    message: 'Webhook registered successfully',
    webhookUrl,
  };
}

/**
 * Get webhook info from Telegram
 */
export async function getTelegramWebhookInfo(
  botToken: string
): Promise<{ url?: string; pending_update_count?: number }> {
  const url = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;
  
  const response = await fetch(url);
  const result = await response.json() as { 
    ok: boolean; 
    result?: { url?: string; pending_update_count?: number } 
  };

  return result.result || {};
}

/**
 * Delete webhook (for cleanup)
 */
export async function deleteTelegramWebhook(
  botToken: string
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/deleteWebhook`;
  
  const response = await fetch(url, { method: 'POST' });
  const result = await response.json() as { ok: boolean };

  return result.ok;
}

/**
 * Validate a bot token by calling getMe
 */
export async function validateTelegramToken(
  botToken: string
): Promise<{ 
  valid: boolean; 
  error?: string;
  botInfo?: { username?: string; firstName?: string };
}> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getMe`;
    const response = await fetch(url);
    const result = await response.json() as { 
      ok: boolean; 
      description?: string;
      result?: { username?: string; first_name?: string } 
    };

    if (!result.ok || !result.result) {
      return { valid: false, error: result.description || 'Invalid token' };
    }

    return {
      valid: true,
      botInfo: {
        username: result.result.username,
        firstName: result.result.first_name,
      }
    };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}
