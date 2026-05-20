/**
 * Chat Tools — barrel export
 *
 * Re-exports all per-domain modules so that chat.ts can import from a single location.
 */
export type {
  AvatarContext,
  ProcessChatOptions,
  ProcessChatResult,
} from './types.js';

export {
  buildSystemPrompt,
  buildModelInput,
  buildEnrichedSystemPrompt,
  injectUserIdentityContext,
  transcribeAudioAttachments,
  buildUserMessageContent,
} from './context-builder.js';

export {
  getToolArgs,
  executeFallbackToolLoop,
  executeSdkToolStream,
} from './tool-execution.js';

export {
  handlePauseToolCalls,
} from './pause-tools.js';

export {
  cleanResponse,
  surfaceModelConfig,
  shouldUseEmptyResponseFallback,
  extractPendingJobs,
  extractTaskActions,
  detectAvatarUpdates,
  extractMedia,
} from './post-processing.js';

export {
  resumeChatAfterToolResult,
} from './resume-chat.js';

export {
  runLlmCallLoop,
  type LlmCallResult,
} from './llm-orchestrator.js';

export {
  handleHealthCheck,
  handleGetHistory,
  handleDeleteHistory,
  handleAppendMessage,
} from './handler-routes.js';
