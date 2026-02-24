/**
 * Retention Policy Baselines
 *
 * Canonical source of truth for data retention targets across the platform.
 * These constants are referenced by CDK constructs and validated by automated
 * tests to ensure infrastructure stays aligned with the approved policy.
 *
 * See docs/DATA-RETENTION-MATRIX.md for the full policy document.
 */
import * as logs from 'aws-cdk-lib/aws-logs';

// ============================================================================
// CloudWatch Log Retention
// ============================================================================

/** Handler Lambdas (message-processor, telegram-webhook, response-sender, etc.) */
export const HANDLER_LOG_RETENTION_PROD = logs.RetentionDays.ONE_MONTH;    // 30 days
export const HANDLER_LOG_RETENTION_STAGING = logs.RetentionDays.THREE_DAYS; // 3 days

/** Admin API, Discord Gateway, Claude Code Worker Lambdas/ECS tasks */
export const SERVICE_LOG_RETENTION_PROD = logs.RetentionDays.TWO_WEEKS;    // 14 days
export const SERVICE_LOG_RETENTION_STAGING = logs.RetentionDays.THREE_DAYS; // 3 days

/** API Gateway access logs */
export const ACCESS_LOG_RETENTION_PROD = logs.RetentionDays.ONE_MONTH;     // 30 days
export const ACCESS_LOG_RETENTION_STAGING = logs.RetentionDays.ONE_WEEK;   // 7 days

// ============================================================================
// SQS Queue Retention
// ============================================================================

/** Dead letter queues - forensic investigation window */
export const DLQ_RETENTION_DAYS = 14;

/** Processing queues - transient messages */
export const PROCESSING_QUEUE_MAX_RETENTION_DAYS = 4;

// ============================================================================
// DynamoDB TTL Targets (in seconds)
// ============================================================================

/** Channel state TTL */
export const CHANNEL_STATE_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

/** Activity records TTL */
export const ACTIVITY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/** Audit event TTL (compliance-critical) */
export const AUDIT_EVENT_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days (current)
export const AUDIT_EVENT_TTL_TARGET_SECONDS = 365 * 24 * 60 * 60; // 1 year (target)

/** Content store TTLs */
export const CONTENT_POSTED_TTL_DAYS = 90;
export const CONTENT_REJECTED_TTL_DAYS = 7;
export const CONTENT_PENDING_TTL_DAYS = 30;

/** Fact store TTL */
export const FACT_TTL_DAYS = 90;

// ============================================================================
// S3 Lifecycle
// ============================================================================

/** Temp file expiry in media bucket */
export const S3_TEMP_FILE_EXPIRY_DAYS = 1;

/** CDN log bucket expiry */
export const S3_CDN_LOG_EXPIRY_DAYS = 90;

/** SQS offload object expiry (set via Expires header) */
export const S3_SQS_OFFLOAD_EXPIRY_HOURS = 24;

/** Intelligent tiering transition threshold */
export const S3_INTELLIGENT_TIERING_DAYS = 30;
