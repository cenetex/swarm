/* eslint-disable no-console -- Intentional: cold-start diagnostics must use console directly (logger may not be initialized yet) */
/**
 * Runtime Configuration Validation
 *
 * Validates critical environment variables at Lambda cold-start time rather than
 * letting missing config surface as cryptic request-time errors. Each variable
 * is tagged with a severity and the subsystem it affects so operators get
 * actionable diagnostics.
 *
 * Usage:
 *   import { validateRuntimeConfig } from '../services/runtime-config.js';
 *   const report = validateRuntimeConfig();
 *   if (!report.ok) { /* log / abort / surface in health endpoint * / }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigSeverity = 'critical' | 'warning';

export interface ConfigRule {
  /** Environment variable name */
  name: string;
  /** Human-readable subsystem this variable feeds (shown in error output) */
  subsystem: string;
  /** When 'critical', a missing value means the handler cannot function correctly */
  severity: ConfigSeverity;
  /**
   * Optional predicate run against the resolved value. Return an error string
   * if the value is invalid, or `undefined` / empty string if OK.
   */
  validate?: (value: string) => string | undefined;
}

export interface ConfigViolation {
  name: string;
  subsystem: string;
  severity: ConfigSeverity;
  message: string;
}

export interface ConfigReport {
  /** True when zero critical violations exist */
  ok: boolean;
  violations: ConfigViolation[];
  /** ISO-8601 timestamp of when the validation ran */
  validatedAt: string;
}

// ---------------------------------------------------------------------------
// Rule set — the canonical list of config surfaces to validate
// ---------------------------------------------------------------------------

/**
 * Returns true when the environment appears to be a test runner
 * (bun:test, vitest, jest, etc.) or an explicitly local dev mode.
 *
 * When called with an explicit env map, it inspects that map.
 * When called without arguments, it inspects `process.env`.
 */
export function isTestOrLocalEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  const nodeEnv = (env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'test' || nodeEnv === 'development') return true;
  // bun:test sets this
  if (env.BUN_ENV === 'test') return true;
  // Common CI indicators
  if (env.CI === 'true') return true;
  return false;
}

function isValidUrl(value: string): string | undefined {
  try {
    new URL(value);
    return undefined;
  } catch {
    return `"${value}" is not a valid URL`;
  }
}

function isNonEmpty(value: string): string | undefined {
  if (value.trim().length === 0) return 'value is empty or whitespace-only';
  return undefined;
}

/**
 * The core rule set for deployed Lambda handlers. In test/local environments
 * these are still evaluated but critical violations are downgraded to warnings.
 */
export const RUNTIME_CONFIG_RULES: ConfigRule[] = [
  // --- DynamoDB ---
  {
    name: 'ADMIN_TABLE',
    subsystem: 'DynamoDB (admin data)',
    severity: 'critical',
    validate: isNonEmpty,
  },

  // --- Media / CDN ---
  {
    name: 'CDN_URL',
    subsystem: 'Media CDN (image/video delivery)',
    severity: 'warning',
    validate: (v) => {
      if (!v) return undefined; // empty is OK for warning-level
      return isValidUrl(v);
    },
  },
  {
    name: 'MEDIA_BUCKET',
    subsystem: 'S3 media storage',
    severity: 'warning',
    validate: isNonEmpty,
  },

  // --- Queues ---
  {
    name: 'RESPONSE_QUEUE_URL',
    subsystem: 'SQS response queue (async media callbacks)',
    severity: 'warning',
    validate: (v) => {
      if (!v) return undefined;
      return isValidUrl(v);
    },
  },

  // --- LLM ---
  {
    name: 'LLM_API_KEY_SECRET_ARN',
    subsystem: 'LLM API key (Secrets Manager)',
    severity: 'critical',
    validate: (v) => {
      if (!v.startsWith('arn:aws:secretsmanager:')) {
        return `expected a Secrets Manager ARN, got "${v.substring(0, 40)}…"`;
      }
      return undefined;
    },
  },

  // --- Telegram ---
  {
    name: 'TELEGRAM_WEBHOOK_DOMAIN',
    subsystem: 'Telegram webhook delivery',
    severity: 'warning',
    validate: (v) => {
      if (!v) return undefined;
      // Should be a bare hostname, not a full URL
      if (v.startsWith('http://') || v.startsWith('https://')) {
        return `expected a bare hostname, got URL "${v}"`;
      }
      return undefined;
    },
  },
];

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Evaluate all config rules against the current `process.env` and return a
 * structured report.
 *
 * In test / local-dev environments, critical severities are downgraded to
 * warnings so the validation never blocks local tooling.
 *
 * @param rules  Override the default rule set (useful for testing).
 * @param env    Override the environment map (defaults to `process.env`).
 */
export function validateRuntimeConfig(
  rules: ConfigRule[] = RUNTIME_CONFIG_RULES,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ConfigReport {
  const isLocal = isTestOrLocalEnv(env);
  const violations: ConfigViolation[] = [];

  for (const rule of rules) {
    const value = env[rule.name];

    // Missing entirely
    if (value === undefined || value === '') {
      if (rule.severity === 'critical') {
        violations.push({
          name: rule.name,
          subsystem: rule.subsystem,
          severity: isLocal ? 'warning' : 'critical',
          message: `Environment variable ${rule.name} is not set. Subsystem affected: ${rule.subsystem}.`,
        });
      }
      // For warning-level rules, missing is acceptable (optional config)
      continue;
    }

    // Present — run custom validator if any
    if (rule.validate) {
      const error = rule.validate(value);
      if (error) {
        violations.push({
          name: rule.name,
          subsystem: rule.subsystem,
          severity: isLocal ? 'warning' : rule.severity,
          message: `${rule.name}: ${error}. Subsystem affected: ${rule.subsystem}.`,
        });
      }
    }
  }

  return {
    ok: violations.every((v) => v.severity !== 'critical'),
    violations,
    validatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cold-start hook — call from handler entry points
// ---------------------------------------------------------------------------

let _coldStartValidated = false;
let _cachedReport: ConfigReport | null = null;

/**
 * Run config validation once per Lambda container lifetime.
 * Logs violations and throws on critical failures in deployed environments.
 *
 * Safe to call from every handler invocation — only the first call does work.
 */
export function ensureRuntimeConfig(): ConfigReport {
  if (_coldStartValidated && _cachedReport) {
    // Even on warm invocations, throw if the cached report has critical
    // violations in deployed environments — config is still broken.
    if (!_cachedReport.ok && !isTestOrLocalEnv()) {
      const criticals = _cachedReport.violations.filter((v) => v.severity === 'critical');
      if (criticals.length > 0) {
        throw new Error(
          '[runtime-config] CRITICAL configuration errors — handler cannot operate correctly:\n' +
            criticals.map((v) => `  - ${v.message}`).join('\n'),
        );
      }
    }
    return _cachedReport;
  }

  const report = validateRuntimeConfig();
  _cachedReport = report;
  _coldStartValidated = true;

  if (report.violations.length > 0) {
    const grouped = {
      critical: report.violations.filter((v) => v.severity === 'critical'),
      warning: report.violations.filter((v) => v.severity === 'warning'),
    };

    if (grouped.warning.length > 0) {
      console.warn(
        '[runtime-config] Configuration warnings:\n' +
          grouped.warning.map((v) => `  - ${v.message}`).join('\n'),
      );
    }

    if (grouped.critical.length > 0) {
      const msg =
        '[runtime-config] CRITICAL configuration errors — handler cannot operate correctly:\n' +
        grouped.critical.map((v) => `  - ${v.message}`).join('\n');
      console.error(msg);
      // In deployed environments, throw so the Lambda invocation fails fast
      // rather than producing subtle downstream errors.
      if (!isTestOrLocalEnv()) {
        throw new Error(msg);
      }
    }
  }

  return report;
}

/**
 * Reset the cold-start cache. Only useful in tests.
 */
export function _resetConfigCache(): void {
  _coldStartValidated = false;
  _cachedReport = null;
}
