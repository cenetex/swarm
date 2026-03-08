/**
 * PII Redaction Utility
 *
 * Central redaction for structured log output. Removes or masks personal data
 * (email addresses, wallet addresses, bearer tokens, API keys, IP addresses)
 * from arbitrary data objects before they reach CloudWatch or DynamoDB logs.
 *
 * Design decisions:
 * - Operates on serialized JSON strings for simplicity and coverage.
 * - Returns a new object; never mutates the input.
 * - Patterns are intentionally broad to catch edge cases; false positives in
 *   log data are acceptable (safer to over-redact than under-redact).
 *
 * @module redact-pii
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Email: anything that looks like user@domain.tld */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Solana wallet address (base58, 32-44 chars of [1-9A-HJ-NP-Za-km-z]).
 * Bounded by word boundaries to avoid matching random substrings.
 */
const SOLANA_WALLET_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

/**
 * Ethereum-style hex address (0x followed by 40 hex chars).
 */
const ETH_ADDRESS_PATTERN = /\b0x[0-9a-fA-F]{40}\b/g;

/** Bearer / Bot tokens in header values */
const BEARER_TOKEN_PATTERN = /\b(Bearer|Bot)\s+[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * Generic API key patterns: sk_live_xxx, pk_test_xxx, api_key_xxx, secret_xxx.
 * Uses lookbehind to avoid consuming the preceding character.
 */
const API_KEY_PATTERN = /(?:sk|pk|api[_-]?key|secret)[_-]\w{16,}/gi;

/**
 * IPv4 addresses. Bounded to avoid matching version numbers like 1.2.3.
 */
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * Phone numbers: not used for free-text redaction (too many false positives on
 * numeric log data like timestamps, IDs, ports). Phone values are caught via
 * the SENSITIVE_KEYS check on field names instead.
 */

// ---------------------------------------------------------------------------
// Redaction placeholders
// ---------------------------------------------------------------------------

const REDACTED_EMAIL = '[REDACTED_EMAIL]';
const REDACTED_WALLET = '[REDACTED_WALLET]';
const REDACTED_TOKEN = '[REDACTED_TOKEN]';
const REDACTED_KEY = '[REDACTED_KEY]';
const REDACTED_IP = '[REDACTED_IP]';

// ---------------------------------------------------------------------------
// Sensitive field names (case-insensitive key matching)
// ---------------------------------------------------------------------------

/**
 * Keys whose *values* should be fully replaced regardless of content.
 * Matched case-insensitively against the last segment of a dotted path.
 */
const SENSITIVE_KEYS = new Set([
  'email',
  'phone',
  'phonenumber',
  'phone_number',
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'password',
  'secret',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'ssn',
  'wallet_address',
  'walletaddress',
  'privatekey',
  'private_key',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact PII from a string value.
 *
 * Applies pattern-based replacement for emails, wallets, tokens, keys, and IPs.
 * Phone patterns are intentionally excluded from free-text redaction because
 * they produce too many false positives on numeric log data (timestamps, IDs).
 */
export function redactString(value: string): string {
  return redactStringWithOptions(value);
}

interface RedactStringOptions {
  allowSolanaAddresses?: boolean;
}

function redactStringWithOptions(value: string, options: RedactStringOptions = {}): string {
  let result = value;
  result = result.replace(EMAIL_PATTERN, REDACTED_EMAIL);
  result = result.replace(ETH_ADDRESS_PATTERN, REDACTED_WALLET);
  result = result.replace(BEARER_TOKEN_PATTERN, REDACTED_TOKEN);
  result = result.replace(API_KEY_PATTERN, REDACTED_KEY);
  if (!options.allowSolanaAddresses) {
    // Solana wallets: only replace if it doesn't look like a typical ID/hash
    // (we check length >= 32 which the pattern already enforces)
    result = result.replace(SOLANA_WALLET_PATTERN, (match) => {
      // Preserve short alphanumeric tokens that are likely IDs, not wallets
      if (match.length < 32) return match;
      return REDACTED_WALLET;
    });
  }
  result = result.replace(IPV4_PATTERN, (match) => {
    // Preserve common non-routable / obvious non-PII addresses
    if (match === '0.0.0.0' || match === '127.0.0.1' || match.startsWith('169.254.')) {
      return match;
    }
    return REDACTED_IP;
  });
  return result;
}

/**
 * Deep-redact an arbitrary data object.
 *
 * - Replaces values of sensitive keys entirely.
 * - Applies pattern-based redaction to all string values.
 * - Recurses into nested objects and arrays.
 * - Returns a new object (input is never mutated).
 */
export function redactData(data: unknown): unknown {
  return redactDataWithKey(undefined, data);
}

function shouldPreserveSolanaAddressForKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'mint' || normalized === 'tokenmint' || normalized === 'mintaddress';
}

function redactDataWithKey(key: string | undefined, data: unknown): unknown {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    return redactStringWithOptions(data, {
      allowSolanaAddresses: key ? shouldPreserveSolanaAddressForKey(key) : false,
    });
  }

  if (Array.isArray(data)) {
    return data.map(item => redactDataWithKey(key, item));
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = typeof value === 'string' ? '[REDACTED]' : '[REDACTED]';
      } else {
        result[key] = redactDataWithKey(key, value);
      }
    }
    return result;
  }

  return data;
}

/**
 * Redact PII from a structured log data record.
 *
 * This is the primary entry point for the logger integration. It accepts the
 * optional `data` bag passed to logger methods and returns a redacted copy.
 */
export function redactLogData(
  data: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!data) return data;
  return redactData(data) as Record<string, unknown>;
}

/**
 * Truncate message content to a maximum length.
 * Used to limit PII exposure in message buffers and observability records.
 */
export function truncateContent(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '...';
}
