/**
 * Utilities barrel export
 */
export { logger, Logger, isValidLogLevel, parseLogLevel, type LogLevel, type LogContext } from './logger.js';
export { 
  loadAvatarConfigFromFile,
  loadAvatarConfigFromEnv,
  mergeAvatarConfigs
} from './config.js';
export {
  extractThinking,
  formatThinkingForMemory,
  hasThinkingTags,
  type ThinkingExtractionResult,
} from './thinking-tags.js';

export {
  UpdateExpressionBuilder,
  type DynamoDbUpdateExpression,
} from './dynamodb-expression.js';

export {
  fetchWithRetry,
  type FetchRetryOptions,
} from './fetch-retry.js';

export {
  CORRELATION_ID_ATTR,
  generateCorrelationId,
  extractCorrelationIdFromApiEvent,
  extractCorrelationIdFromSqsRecord,
} from './correlation.js';

export {
  isProductionEnvironment,
  getHeaderValue,
  hasValidInternalTestKey,
  type InternalTestKeyOptions,
} from './internal-test-key.js';

export {
  buildMediaUrl,
  canonicalizeMediaUrl,
  canonicalizeMediaUrls,
} from './media-url.js';

// Metrics (CloudWatch Embedded Metric Format)
export {
  MetricsLogger,
  createMetricsLogger,
  createRuntimeMetricsLogger,
  getEnvironmentDimension,
  emitMetric,
  type MetricUnit,
  type MetricDatum,
  type MetricsLoggerOptions,
} from './metrics.js';

// Centralized environment variable validation
export {
  BaseEnvSchema,
  TelegramWebhookEnvSchema,
  MessageProcessorEnvSchema,
  ResponseSenderEnvSchema,
  TweetPosterEnvSchema,
  AdminApiEnvSchema,
  EnvValidationError,
  validateEnv,
  tryValidateEnv,
  requireEnv,
  optionalEnv,
  envPrimitives,
  type BaseEnv,
  type TelegramWebhookEnv,
  type MessageProcessorEnv,
  type ResponseSenderEnv,
  type TweetPosterEnv,
  type AdminApiEnv,
} from './env.js';

// Telegram HTML formatting
export {
  escapeHtml,
  markdownToTelegramHtml,
  stripMarkdown,
} from './telegram-html.js';

// PII redaction
export {
  redactString,
  redactData,
  redactLogData,
  truncateContent,
} from './redact-pii.js';
