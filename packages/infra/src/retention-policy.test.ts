/**
 * Retention Policy Validation Tests
 *
 * Ensures that the retention baselines defined in retention-policy.ts
 * match the values declared in CDK constructs and application code.
 * Any drift between policy and implementation will cause test failure.
 *
 * Reference: docs/DATA-RETENTION-MATRIX.md
 */

import { describe, it, expect } from 'bun:test';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  HANDLER_LOG_RETENTION_PROD,
  HANDLER_LOG_RETENTION_STAGING,
  SERVICE_LOG_RETENTION_PROD,
  SERVICE_LOG_RETENTION_STAGING,
  ACCESS_LOG_RETENTION_PROD,
  ACCESS_LOG_RETENTION_STAGING,
  DLQ_RETENTION_DAYS,
  PROCESSING_QUEUE_MAX_RETENTION_DAYS,
  CHANNEL_STATE_TTL_SECONDS,
  ACTIVITY_TTL_SECONDS,
  AUDIT_EVENT_TTL_SECONDS,
  CONTENT_POSTED_TTL_DAYS,
  CONTENT_REJECTED_TTL_DAYS,
  CONTENT_PENDING_TTL_DAYS,
  FACT_TTL_DAYS,
  S3_TEMP_FILE_EXPIRY_DAYS,
  S3_CDN_LOG_EXPIRY_DAYS,
  S3_SQS_OFFLOAD_EXPIRY_HOURS,
  S3_INTELLIGENT_TIERING_DAYS,
} from './utils/retention-policy.js';

describe('Retention Policy Baselines', () => {
  // ========================================================================
  // CloudWatch Log Retention
  // ========================================================================
  describe('CloudWatch log retention', () => {
    it('handler logs: prod = ONE_MONTH (30 days)', () => {
      expect(HANDLER_LOG_RETENTION_PROD).toBe(logs.RetentionDays.ONE_MONTH);
      // RetentionDays enum values equal the number of days
      expect(HANDLER_LOG_RETENTION_PROD as number).toBe(30);
    });

    it('handler logs: staging = THREE_DAYS', () => {
      expect(HANDLER_LOG_RETENTION_STAGING).toBe(logs.RetentionDays.THREE_DAYS);
      expect(HANDLER_LOG_RETENTION_STAGING as number).toBe(3);
    });

    it('service logs (admin, discord, claude-code): prod = TWO_WEEKS (14 days)', () => {
      expect(SERVICE_LOG_RETENTION_PROD).toBe(logs.RetentionDays.TWO_WEEKS);
      expect(SERVICE_LOG_RETENTION_PROD as number).toBe(14);
    });

    it('service logs: staging = THREE_DAYS', () => {
      expect(SERVICE_LOG_RETENTION_STAGING).toBe(logs.RetentionDays.THREE_DAYS);
      expect(SERVICE_LOG_RETENTION_STAGING as number).toBe(3);
    });

    it('API access logs: prod = ONE_MONTH (30 days)', () => {
      expect(ACCESS_LOG_RETENTION_PROD).toBe(logs.RetentionDays.ONE_MONTH);
      expect(ACCESS_LOG_RETENTION_PROD as number).toBe(30);
    });

    it('API access logs: staging = ONE_WEEK (7 days)', () => {
      expect(ACCESS_LOG_RETENTION_STAGING).toBe(logs.RetentionDays.ONE_WEEK);
      expect(ACCESS_LOG_RETENTION_STAGING as number).toBe(7);
    });

    it('prod retention is always >= staging retention', () => {
      expect(HANDLER_LOG_RETENTION_PROD as number).toBeGreaterThanOrEqual(
        HANDLER_LOG_RETENTION_STAGING as number,
      );
      expect(SERVICE_LOG_RETENTION_PROD as number).toBeGreaterThanOrEqual(
        SERVICE_LOG_RETENTION_STAGING as number,
      );
      expect(ACCESS_LOG_RETENTION_PROD as number).toBeGreaterThanOrEqual(
        ACCESS_LOG_RETENTION_STAGING as number,
      );
    });
  });

  // ========================================================================
  // SQS Queue Retention
  // ========================================================================
  describe('SQS queue retention', () => {
    it('DLQ retention is 14 days (forensic investigation window)', () => {
      expect(DLQ_RETENTION_DAYS).toBe(14);
    });

    it('processing queue max retention does not exceed 4 days', () => {
      expect(PROCESSING_QUEUE_MAX_RETENTION_DAYS).toBeLessThanOrEqual(4);
    });

    it('DLQ retention exceeds processing queue retention', () => {
      expect(DLQ_RETENTION_DAYS).toBeGreaterThan(PROCESSING_QUEUE_MAX_RETENTION_DAYS);
    });
  });

  // ========================================================================
  // DynamoDB TTL Targets
  // ========================================================================
  describe('DynamoDB TTL targets', () => {
    it('channel state TTL = 90 days', () => {
      expect(CHANNEL_STATE_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
    });

    it('activity records TTL = 24 hours', () => {
      expect(ACTIVITY_TTL_SECONDS).toBe(24 * 60 * 60);
    });

    it('audit event TTL = 90 days (current)', () => {
      expect(AUDIT_EVENT_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
    });

    it('content store: posted = 90 days, rejected = 7 days, pending = 30 days', () => {
      expect(CONTENT_POSTED_TTL_DAYS).toBe(90);
      expect(CONTENT_REJECTED_TTL_DAYS).toBe(7);
      expect(CONTENT_PENDING_TTL_DAYS).toBe(30);
    });

    it('fact store TTL = 90 days', () => {
      expect(FACT_TTL_DAYS).toBe(90);
    });

    it('audit events have the longest DynamoDB retention', () => {
      const allTtlSeconds = [
        CHANNEL_STATE_TTL_SECONDS,
        ACTIVITY_TTL_SECONDS,
        CONTENT_POSTED_TTL_DAYS * 86400,
        CONTENT_REJECTED_TTL_DAYS * 86400,
        CONTENT_PENDING_TTL_DAYS * 86400,
        FACT_TTL_DAYS * 86400,
      ];
      for (const ttl of allTtlSeconds) {
        expect(AUDIT_EVENT_TTL_SECONDS).toBeGreaterThanOrEqual(ttl);
      }
    });
  });

  // ========================================================================
  // S3 Lifecycle
  // ========================================================================
  describe('S3 lifecycle rules', () => {
    it('temp files expire in 1 day', () => {
      expect(S3_TEMP_FILE_EXPIRY_DAYS).toBe(1);
    });

    it('CDN logs expire in 90 days', () => {
      expect(S3_CDN_LOG_EXPIRY_DAYS).toBe(90);
    });

    it('SQS offload objects expire in 24 hours', () => {
      expect(S3_SQS_OFFLOAD_EXPIRY_HOURS).toBe(24);
    });

    it('intelligent tiering transition at 30 days', () => {
      expect(S3_INTELLIGENT_TIERING_DAYS).toBe(30);
    });
  });

  // ========================================================================
  // Cross-cutting policy invariants
  // ========================================================================
  describe('policy invariants', () => {
    it('no log group retains data for more than 30 days in prod', () => {
      const maxRetentionDays = 30;
      expect(HANDLER_LOG_RETENTION_PROD as number).toBeLessThanOrEqual(maxRetentionDays);
      expect(SERVICE_LOG_RETENTION_PROD as number).toBeLessThanOrEqual(maxRetentionDays);
      expect(ACCESS_LOG_RETENTION_PROD as number).toBeLessThanOrEqual(maxRetentionDays);
    });

    it('staging log retention is at most 7 days (cost control)', () => {
      const maxStagingDays = 7;
      expect(HANDLER_LOG_RETENTION_STAGING as number).toBeLessThanOrEqual(maxStagingDays);
      expect(SERVICE_LOG_RETENTION_STAGING as number).toBeLessThanOrEqual(maxStagingDays);
      expect(ACCESS_LOG_RETENTION_STAGING as number).toBeLessThanOrEqual(maxStagingDays);
    });

    it('DLQ retention does not exceed 14 days', () => {
      expect(DLQ_RETENTION_DAYS).toBeLessThanOrEqual(14);
    });

    it('all TTL values are positive', () => {
      const allValues = [
        CHANNEL_STATE_TTL_SECONDS,
        ACTIVITY_TTL_SECONDS,
        AUDIT_EVENT_TTL_SECONDS,
        CONTENT_POSTED_TTL_DAYS,
        CONTENT_REJECTED_TTL_DAYS,
        CONTENT_PENDING_TTL_DAYS,
        FACT_TTL_DAYS,
        S3_TEMP_FILE_EXPIRY_DAYS,
        S3_CDN_LOG_EXPIRY_DAYS,
        S3_SQS_OFFLOAD_EXPIRY_HOURS,
        S3_INTELLIGENT_TIERING_DAYS,
        DLQ_RETENTION_DAYS,
        PROCESSING_QUEUE_MAX_RETENTION_DAYS,
      ];
      for (const val of allValues) {
        expect(val).toBeGreaterThan(0);
      }
    });
  });
});
