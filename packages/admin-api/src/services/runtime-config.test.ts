/**
 * Tests for runtime configuration validation.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  validateRuntimeConfig,
  ensureRuntimeConfig,
  _resetConfigCache,
  RUNTIME_CONFIG_RULES,
  type ConfigRule,
} from './runtime-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid environment for all critical rules. */
function validEnv(): Record<string, string> {
  return {
    ADMIN_TABLE: 'SwarmAdmin-staging',
    LLM_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:swarm/admin/llm-api-key-AbCdEf',
    CDN_URL: 'https://gallery.rati.chat',
    MEDIA_BUCKET: 'swarm-media-staging',
    RESPONSE_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/swarm-response-queue-staging',
    TELEGRAM_WEBHOOK_DOMAIN: 'api.example.com',
    // Mark as deployed so critical = critical (not downgraded)
    NODE_ENV: 'production',
  };
}

// ---------------------------------------------------------------------------
// validateRuntimeConfig
// ---------------------------------------------------------------------------

describe('validateRuntimeConfig', () => {
  test('returns ok:true when all critical config is present and valid', () => {
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, validEnv());
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.validatedAt).toBeTruthy();
  });

  test('reports critical violation when ADMIN_TABLE is missing', () => {
    const env = validEnv();
    delete env.ADMIN_TABLE;
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, env);
    expect(report.ok).toBe(false);
    const v = report.violations.find((x) => x.name === 'ADMIN_TABLE');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('critical');
    expect(v!.message).toContain('ADMIN_TABLE');
    expect(v!.message).toContain('DynamoDB');
  });

  test('reports critical violation when LLM_API_KEY_SECRET_ARN is missing', () => {
    const env = validEnv();
    delete env.LLM_API_KEY_SECRET_ARN;
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, env);
    expect(report.ok).toBe(false);
    const v = report.violations.find((x) => x.name === 'LLM_API_KEY_SECRET_ARN');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('critical');
  });

  test('reports validation error when LLM_API_KEY_SECRET_ARN is not a valid ARN', () => {
    const env = validEnv();
    env.LLM_API_KEY_SECRET_ARN = 'not-an-arn';
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, env);
    expect(report.ok).toBe(false);
    const v = report.violations.find((x) => x.name === 'LLM_API_KEY_SECRET_ARN');
    expect(v).toBeDefined();
    expect(v!.message).toContain('Secrets Manager ARN');
  });

  test('warns when CDN_URL is invalid URL format', () => {
    const env = validEnv();
    env.CDN_URL = 'not a url';
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, env);
    // CDN_URL is warning-level, so ok should still be true
    expect(report.ok).toBe(true);
    const v = report.violations.find((x) => x.name === 'CDN_URL');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('warning');
    expect(v!.message).toContain('not a valid URL');
  });

  test('warns when TELEGRAM_WEBHOOK_DOMAIN contains a URL instead of hostname', () => {
    const env = validEnv();
    env.TELEGRAM_WEBHOOK_DOMAIN = 'https://api.example.com';
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, env);
    expect(report.ok).toBe(true);
    const v = report.violations.find((x) => x.name === 'TELEGRAM_WEBHOOK_DOMAIN');
    expect(v).toBeDefined();
    expect(v!.message).toContain('bare hostname');
  });

  test('does not report warning-level vars when they are missing', () => {
    // Only provide critical vars
    const env: Record<string, string> = {
      ADMIN_TABLE: 'SwarmAdmin-staging',
      LLM_API_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:key-AbCdEf',
      NODE_ENV: 'production',
    };
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, env);
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  test('downgrades critical to warning in test environment', () => {
    const env: Record<string, string> = {
      NODE_ENV: 'test',
      // Missing ADMIN_TABLE and LLM_API_KEY_SECRET_ARN
    };
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, env);
    // Should be ok because critical is downgraded to warning in test
    expect(report.ok).toBe(true);
    const criticals = report.violations.filter((v) => v.severity === 'critical');
    expect(criticals).toHaveLength(0);
    // But warnings should still be present
    const warnings = report.violations.filter((v) => v.severity === 'warning');
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('supports custom rules', () => {
    const customRules: ConfigRule[] = [
      {
        name: 'MY_CUSTOM_VAR',
        subsystem: 'custom subsystem',
        severity: 'critical',
      },
    ];
    const report = validateRuntimeConfig(customRules, { NODE_ENV: 'production' });
    expect(report.ok).toBe(false);
    expect(report.violations[0].name).toBe('MY_CUSTOM_VAR');
  });

  test('empty string is treated as missing', () => {
    const env = validEnv();
    env.ADMIN_TABLE = '';
    const report = validateRuntimeConfig(RUNTIME_CONFIG_RULES, env);
    expect(report.ok).toBe(false);
    expect(report.violations.find((x) => x.name === 'ADMIN_TABLE')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ensureRuntimeConfig (cold-start caching)
// ---------------------------------------------------------------------------

describe('ensureRuntimeConfig', () => {
  beforeEach(() => {
    _resetConfigCache();
  });

  test('returns cached report on second call', () => {
    const r1 = ensureRuntimeConfig();
    const r2 = ensureRuntimeConfig();
    expect(r1).toBe(r2); // same reference
  });

  test('_resetConfigCache clears the cache', () => {
    const r1 = ensureRuntimeConfig();
    _resetConfigCache();
    const r2 = ensureRuntimeConfig();
    expect(r1).not.toBe(r2);
  });
});
