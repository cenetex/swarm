/**
 * Handler Environment Variable Validation
 *
 * Provides validated accessors for required environment variables.
 * Fail-fast behaviour prevents silent fallbacks to hardcoded production
 * values (see https://github.com/cenetex/aws-swarm/issues/233).
 */

const DYNAMODB_TABLE_NAME_ALLOWED_CHARS_REGEX = /^[A-Za-z0-9_.-]+$/;
const DYNAMODB_TABLE_NAME_MIN_LENGTH = 3;
const DYNAMODB_TABLE_NAME_MAX_LENGTH = 255;

/** Cached validated ADMIN_TABLE value. */
let _adminTable: string | undefined;

/**
 * Return the ADMIN_TABLE env value, throwing on first access if it is not set.
 * This avoids the previous `|| 'SwarmAdmin-prod'` fallback that could silently
 * route non-production workloads to the production table.
 */
export function getAdminTable(): string {
  if (!_adminTable) {
    const val = process.env.ADMIN_TABLE?.trim();
    if (!val) {
      throw new Error(
        'ADMIN_TABLE environment variable is required but not set. ' +
        'Refusing to fall back to a hardcoded table name.',
      );
    }
    if (val.length < DYNAMODB_TABLE_NAME_MIN_LENGTH || val.length > DYNAMODB_TABLE_NAME_MAX_LENGTH) {
      throw new Error(
        `ADMIN_TABLE environment variable is invalid. ` +
        `Expected ${DYNAMODB_TABLE_NAME_MIN_LENGTH}-${DYNAMODB_TABLE_NAME_MAX_LENGTH} characters, got ${val.length}.`,
      );
    }
    if (!DYNAMODB_TABLE_NAME_ALLOWED_CHARS_REGEX.test(val)) {
      throw new Error(
        'ADMIN_TABLE environment variable is invalid. ' +
        'Expected only characters matching [A-Za-z0-9_.-].',
      );
    }
    _adminTable = val;
  }
  return _adminTable;
}

/** @internal Reset cached table name -- test-only. */
export function _resetAdminTableCache(): void {
  _adminTable = undefined;
}
