/**
 * Error Recovery Guidance
 *
 * Maps common activation-blocking and runtime errors to actionable
 * recovery guidance displayed inline in the chat. Each error pattern
 * includes a user-friendly title, explanation, and concrete next steps.
 */

export interface ErrorRecovery {
  /** Short title for the error category */
  title: string;
  /** Human-readable explanation */
  explanation: string;
  /** Concrete next-step actions the user can take */
  actions: string[];
  /** Severity affects visual styling */
  severity: 'warning' | 'error' | 'info';
}

/**
 * Detect known error patterns and return recovery guidance.
 * Returns null if the error is not a recognized pattern.
 */
export function getErrorRecovery(errorMessage: string): ErrorRecovery | null {
  const lower = errorMessage.toLowerCase();

  // --- Credits / billing exhausted (402) ---
  if (
    lower.includes('credit') && (lower.includes('exhaust') || lower.includes('balance')) ||
    lower.includes('402') ||
    lower.includes('insufficient funds') ||
    lower.includes('payment required')
  ) {
    return {
      title: 'AI Credits Exhausted',
      explanation: 'The AI provider has run out of credits. Messages cannot be processed until credits are replenished.',
      actions: [
        'Contact your administrator to add credits to the OpenRouter account.',
        'Check your Plan & Usage panel for current usage details.',
        'If you are the admin, visit openrouter.ai to add credits.',
      ],
      severity: 'error',
    };
  }

  // --- Rate limited (429) ---
  if (
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('too many requests')
  ) {
    return {
      title: 'Rate Limited',
      explanation: 'Too many requests have been sent in a short period. The system will recover automatically.',
      actions: [
        'Wait 30-60 seconds before sending another message.',
        'If this persists, check your Plan & Usage to see daily limits.',
        'Orb holders get higher rate limits -- consider acquiring an Orb.',
      ],
      severity: 'warning',
    };
  }

  // --- Service temporarily unavailable (503 / circuit breaker) ---
  if (
    lower.includes('temporarily unavailable') ||
    lower.includes('circuit breaker') ||
    lower.includes('503') ||
    lower.includes('service unavailable')
  ) {
    return {
      title: 'Temporarily Unavailable',
      explanation: 'The AI service is temporarily experiencing issues. It usually recovers within a few minutes.',
      actions: [
        'Wait 1-2 minutes and try again.',
        'If the problem persists for more than 5 minutes, the upstream AI provider may be down.',
      ],
      severity: 'warning',
    };
  }

  // --- Timeout (504) ---
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('504')
  ) {
    return {
      title: 'Request Timed Out',
      explanation: 'The request took too long to process. This can happen with complex requests or during high traffic.',
      actions: [
        'Try sending a shorter or simpler message.',
        'Wait a moment and try again -- the system may be under heavy load.',
      ],
      severity: 'warning',
    };
  }

  // --- Missing API key / secret ---
  if (
    lower.includes('api key') && (lower.includes('missing') || lower.includes('invalid') || lower.includes('not set')) ||
    lower.includes('secret') && (lower.includes('missing') || lower.includes('not found') || lower.includes('not set')) ||
    lower.includes('no openrouter') ||
    lower.includes('authentication failed') && lower.includes('openrouter')
  ) {
    return {
      title: 'API Key Not Configured',
      explanation: 'A required API key or secret is missing. The avatar needs this to communicate with external services.',
      actions: [
        'For OpenRouter, ask an administrator to check the server-side provider key.',
        'For platform integrations, ask the avatar to open the relevant setup panel.',
        'Common user-provided keys: Telegram bot token, Discord bot token, or Replicate for voice/audio.',
      ],
      severity: 'error',
    };
  }

  // --- Webhook / Telegram setup issues ---
  if (
    lower.includes('webhook') && (lower.includes('not set') || lower.includes('failed') || lower.includes('error')) ||
    lower.includes('telegram') && (lower.includes('bot token') || lower.includes('invalid token'))
  ) {
    return {
      title: 'Platform Integration Issue',
      explanation: 'The platform integration is not fully configured. The webhook or bot token may be missing or invalid.',
      actions: [
        'Ask the avatar: "Set up Telegram" to start the guided configuration.',
        'Make sure you have a valid bot token from @BotFather on Telegram.',
        'The avatar will walk you through each step.',
      ],
      severity: 'error',
    };
  }

  // --- Network errors ---
  if (
    lower.includes('network') && lower.includes('error') ||
    lower.includes('failed to fetch') ||
    lower.includes('err_internet') ||
    lower.includes('connection refused')
  ) {
    return {
      title: 'Network Error',
      explanation: 'Unable to reach the server. Please check your internet connection.',
      actions: [
        'Check your internet connection.',
        'If you are behind a VPN or proxy, try disabling it temporarily.',
        'Refresh the page and try again.',
      ],
      severity: 'error',
    };
  }

  // --- Entitlement / plan limit exceeded ---
  if (
    lower.includes('daily') && lower.includes('limit') ||
    lower.includes('entitlement') && lower.includes('exceed') ||
    lower.includes('quota') && lower.includes('exceed') ||
    lower.includes('plan limit')
  ) {
    return {
      title: 'Daily Limit Reached',
      explanation: 'You have reached your daily usage limit for this plan tier.',
      actions: [
        'Check Plan & Usage in the header to see your current usage.',
        'Limits reset daily at midnight UTC.',
        'Consider upgrading your plan for higher limits.',
        'Orb holders receive boosted limits automatically.',
      ],
      severity: 'warning',
    };
  }

  return null;
}
