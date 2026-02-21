/**
 * Processors barrel export
 */

// === MessageProcessor (Unified Pipeline) ===
export {
  MessageProcessor,
  createMessageProcessor,
  type LLMTool,
  type LLMResponse as ProcessorLLMResponse,
  type ToolExecutionResult,
  type MessageProcessorDependencies,
} from './message-processor.js';

// === Processor Types ===
export type {
  ToolCategory,
  ToolsetId,
  ProcessorConfig,
  ProcessorAvatarConfig,
  ProcessorMessage,
  ProcessorMessageContent,
  ProcessorToolCall,
  ProcessorMediaItem,
  ProcessorPendingJob,
  ProcessorResult,
  ProcessorOptions,
  CategoryDetectionInput,
  AvatarService,
  HistoryService,
  MemoryService,
  DreamsService,
  VoiceService,
} from './types.js';

// === Tool Builder ===
export {
  CATEGORY_TOOLSETS,
  BASE_TOOLSETS,
  DEFAULT_CATEGORIES,
  detectEnabledCategories,
  resolveAllowedToolsets,
  createToolContext,
  filterByPlatform,
  filterByToolsets,
  filterByVisibility,
  filterTools,
  summarizeCapabilities,
  type ToolContext as ProcessorToolContext,
  type FilterableToolDefinition,
} from './tool-builder.js';

// === Prompt Builder ===
export {
  buildDynamicSystemPrompt,
  buildChatSystemPrompt,
  getPlatformPromptSection,
  toolsToCategories,
  type RuntimeContext,
} from './prompt-builder.js';

// === Legacy Processors ===
export {
  MessageEvaluator,
  createMessageEvaluator,
  type EvaluationResult
} from './message-evaluator.js';

export {
  OutboundSender,
  createOutboundSender,
  type ActionError,
} from './outbound-sender.js';
