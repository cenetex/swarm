/**
 * Errors barrel export
 */
export { SwarmErrorCode } from './codes.js';

export {
  SwarmError,
  PlatformError,
  LLMError,
  ConfigError,
  StateError,
  MediaError,
  AuthError,
  QueueError,
  NetworkError,
  isSwarmError,
  isSwarmErrorWithCode,
  isAuthError,
  toSwarmError,
  swarmErrorToHttpStatus,
  swarmErrorToHttpResponse,
  type ErrorContext,
} from './errors.js';

export {
  classifyError,
  type ErrorClassification,
  type ErrorReason,
} from './classify.js';
