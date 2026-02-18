/**
 * Structured error codes for the Swarm framework.
 *
 * Codes follow the pattern: DOMAIN_CATEGORY
 * - PLATFORM_*   Platform adapter errors (Telegram, Discord, Twitter, Web)
 * - LLM_*        LLM service errors
 * - CONFIG_*     Configuration/validation errors
 * - STATE_*      State/persistence errors
 * - MEDIA_*      Media generation/processing errors
 * - AUTH_*       Authentication/authorization errors
 * - QUEUE_*      Queue/messaging errors
 * - NETWORK_*    Network/transport errors
 */
export enum SwarmErrorCode {
  // ── General ──────────────────────────────────────────────────────────
  /** Unclassified / catch-all error */
  UNKNOWN = 'UNKNOWN',

  // ── Platform ─────────────────────────────────────────────────────────
  /** Platform client not initialized before use */
  PLATFORM_NOT_INITIALIZED = 'PLATFORM_NOT_INITIALIZED',
  /** Rate-limited by upstream platform API */
  PLATFORM_RATE_LIMITED = 'PLATFORM_RATE_LIMITED',
  /** Platform API returned an unexpected error */
  PLATFORM_API_ERROR = 'PLATFORM_API_ERROR',
  /** Webhook configuration or validation failure */
  PLATFORM_WEBHOOK_ERROR = 'PLATFORM_WEBHOOK_ERROR',
  /** Media upload to platform failed */
  PLATFORM_MEDIA_UPLOAD_ERROR = 'PLATFORM_MEDIA_UPLOAD_ERROR',
  /** Unsupported media type for platform */
  PLATFORM_UNSUPPORTED_MEDIA = 'PLATFORM_UNSUPPORTED_MEDIA',

  // ── LLM ──────────────────────────────────────────────────────────────
  /** Missing API key for LLM provider */
  LLM_MISSING_API_KEY = 'LLM_MISSING_API_KEY',
  /** LLM circuit breaker is open */
  LLM_CIRCUIT_OPEN = 'LLM_CIRCUIT_OPEN',
  /** LLM API returned a non-OK response */
  LLM_API_ERROR = 'LLM_API_ERROR',
  /** LLM returned empty / unparseable response */
  LLM_EMPTY_RESPONSE = 'LLM_EMPTY_RESPONSE',
  /** LLM request timed out */
  LLM_TIMEOUT = 'LLM_TIMEOUT',

  // ── Config ───────────────────────────────────────────────────────────
  /** Config file not found on disk */
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  /** Config failed schema validation */
  CONFIG_VALIDATION_ERROR = 'CONFIG_VALIDATION_ERROR',
  /** Required secret not found in Secrets Manager */
  CONFIG_MISSING_SECRET = 'CONFIG_MISSING_SECRET',

  // ── State / Persistence ──────────────────────────────────────────────
  /** DynamoDB or state service operation failed */
  STATE_READ_ERROR = 'STATE_READ_ERROR',
  /** DynamoDB write / conditional-check failure */
  STATE_WRITE_ERROR = 'STATE_WRITE_ERROR',

  // ── Media ────────────────────────────────────────────────────────────
  /** Image/video generation request failed */
  MEDIA_GENERATION_ERROR = 'MEDIA_GENERATION_ERROR',
  /** Media fetch (from URL or S3) failed */
  MEDIA_FETCH_ERROR = 'MEDIA_FETCH_ERROR',
  /** Usage/credit limit reached for media generation */
  MEDIA_LIMIT_REACHED = 'MEDIA_LIMIT_REACHED',

  // ── Auth ─────────────────────────────────────────────────────────────
  /** Authentication token invalid or expired */
  AUTH_INVALID_TOKEN = 'AUTH_INVALID_TOKEN',
  /** Caller lacks required permissions */
  AUTH_FORBIDDEN = 'AUTH_FORBIDDEN',

  // ── Queue ────────────────────────────────────────────────────────────
  /** SQS send/receive failure */
  QUEUE_SEND_ERROR = 'QUEUE_SEND_ERROR',
  /** Failed to parse SQS message body */
  QUEUE_PARSE_ERROR = 'QUEUE_PARSE_ERROR',

  // ── Network ──────────────────────────────────────────────────────────
  /** HTTP fetch failed after retries */
  NETWORK_FETCH_ERROR = 'NETWORK_FETCH_ERROR',
  /** Request timed out */
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
}
