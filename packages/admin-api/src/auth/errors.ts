/**
 * Re-export the unified AuthError and isAuthError from @swarm/core.
 *
 * The core AuthError now supports both the structured options form and the
 * legacy positional form: `new AuthError('msg', 403, details)`.
 */
export { AuthError, isAuthError } from '@swarm/core';
