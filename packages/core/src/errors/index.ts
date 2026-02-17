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
  toSwarmError,
  type ErrorContext,
} from './errors.js';
