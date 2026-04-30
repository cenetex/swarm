import type { AvatarConfig, LLMConfig } from '../types/index.js';
import type { SwarmEnvelope } from '../types/envelope.js';

export type LLMTier = 'fast' | 'standard' | 'heavy';

export interface TierSelectionResult {
  modelId: string;
  tier: LLMTier;
  reason: string;
  estimatedCostCentsPer1kTokens: number;
}

interface TierModelConfig {
  fast: string;
  standard: string;
  heavy: string;
}

const DEFAULT_MODELS: TierModelConfig = {
  fast: 'claude-3-5-haiku-20241022',
  standard: 'claude-3-5-sonnet-20241022',
  heavy: 'claude-opus-4-1-20250805',
};

const COST_PER_1K_TOKENS_CENTS: Record<string, number> = {
  'claude-3-5-haiku-20241022': 8,
  'claude-3-5-sonnet-20241022': 30,
  'claude-opus-4-1-20250805': 300,
};

function assessMessageLength(lastMessage: string): { score: number; reason: string } {
  const len = lastMessage.trim().length;
  if (len < 50) return { score: 2, reason: 'very_short_message' };
  if (len < 100) return { score: 1.5, reason: 'short_message' };
  if (len > 500) return { score: -2, reason: 'long_complex_message' };
  return { score: 0, reason: 'normal_length' };
}

function assessComplexity(lastMessage: string): { score: number; reason: string } {
  const lowerMsg = lastMessage.toLowerCase();

  const questionWords = [
    'who', 'what', 'why', 'how', 'explain', 'analyze', 'research',
    'summarize', 'compare', 'elaborate', 'describe', 'discuss',
    'implement', 'design', 'plan', 'evaluate', 'assess'
  ];
  const hasComplex = questionWords.some(word => new RegExp(`\\b${word}\\b`).test(lowerMsg));
  if (hasComplex) return { score: -2.5, reason: 'complex_request' };

  const casual = ['lol', 'haha', 'yeah', 'nope', 'ok', 'sure', 'cool', 'nice', 'thanks', 'awesome', 'nice one'];
  const hasCasual = casual.some(word => new RegExp(`\\b${word}\\b`).test(lowerMsg));
  if (hasCasual) return { score: 1.5, reason: 'casual_tone' };

  return { score: 0, reason: 'neutral_tone' };
}

function assessContent(lastMessage: string): { score: number; reason: string } {
  if (/@\w+/.test(lastMessage)) return { score: -1.5, reason: 'mentions_users' };
  if (/https?:\/\//.test(lastMessage)) return { score: -1.5, reason: 'contains_url' };
  if (/\[\w*(?:file|image|attachment|media|upload|photo)\w*\]|\[.+\]/i.test(lastMessage)) return { score: -1.5, reason: 'has_attachment' };

  return { score: 0, reason: 'no_complex_content' };
}

function assessConversationDepth(messages: Array<{ role: string; content: unknown }>): { score: number; reason: string } {
  let userMessageCount = 0;
  for (const msg of messages) {
    if (msg.role === 'user') userMessageCount++;
  }

  if (userMessageCount <= 2) return { score: 0.5, reason: 'short_conversation' };
  if (userMessageCount >= 10) return { score: -1, reason: 'long_conversation' };
  return { score: 0, reason: 'normal_conversation_length' };
}

function assessToolRequirements(enabledTools: Array<{ type: string; function?: { name: string } }>): { score: number; reason: string } {
  const toolNames = enabledTools.map(t => t.function?.name || '').filter(Boolean);
  const heavyTools = ['generate_image', 'generate_video', 'research', 'web_search'];
  const hasHeavyTools = heavyTools.some(tool => toolNames.some(name => name.includes(tool.replace(/_/g, ''))));

  if (hasHeavyTools) return { score: -2, reason: 'heavy_tools_available' };
  return { score: 0, reason: 'standard_tools' };
}

function shouldRouteToHeavy(lastMessage: string, config: Partial<LLMConfig>): boolean {
  if (!config.heavyForIntents) return false;

  const lowerMsg = lastMessage.toLowerCase();
  return config.heavyForIntents.some(intent =>
    intent.toLowerCase().split(/[\s_-]/).every(word => lowerMsg.includes(word))
  );
}

export function selectModel(
  avatar: AvatarConfig,
  envelope: SwarmEnvelope,
  recentMessages: Array<{ role: string; content: unknown }>,
  enabledTools: Array<{ type: string; function?: { name: string } }> = [],
): TierSelectionResult {
  const llmConfig = avatar.llm;
  const tierOverride = (llmConfig as unknown as Record<string, unknown>)?.tier as string | undefined;
  const fastModel = (llmConfig as unknown as Record<string, unknown>)?.fastModel as string | undefined;
  const heavyModel = (llmConfig as unknown as Record<string, unknown>)?.heavyModel as string | undefined;
  const heavyForIntents = (llmConfig as unknown as Record<string, unknown>)?.heavyForIntents as string[] | undefined;

  const models: TierModelConfig = {
    fast: fastModel || DEFAULT_MODELS.fast,
    standard: llmConfig.model || DEFAULT_MODELS.standard,
    heavy: heavyModel || DEFAULT_MODELS.heavy,
  };

  if (tierOverride && tierOverride !== 'auto') {
    const model = models[tierOverride as LLMTier];
    const cost = COST_PER_1K_TOKENS_CENTS[model] || 30;
    return {
      modelId: model,
      tier: tierOverride as LLMTier,
      reason: `explicit_override_${tierOverride}`,
      estimatedCostCentsPer1kTokens: cost,
    };
  }

  const lastUserMessage = recentMessages
    .reverse()
    .find(m => m.role === 'user')?.content as string | undefined || '';

  if (shouldRouteToHeavy(lastUserMessage, llmConfig as unknown as Record<string, unknown>)) {
    const cost = COST_PER_1K_TOKENS_CENTS[models.heavy] || 300;
    return {
      modelId: models.heavy,
      tier: 'heavy',
      reason: 'intent_match_research',
      estimatedCostCentsPer1kTokens: cost,
    };
  }

  const lowerMsg = lastUserMessage.toLowerCase();

  // Check for heavy-tier keywords first (high signal)
  const heavyKeywords = ['analyze', 'explain', 'research', 'summarize', 'compare', 'elaborate', 'describe', 'discuss'];
  const hasHeavyKeywords = heavyKeywords.some(word => new RegExp(`\\b${word}\\b`).test(lowerMsg));

  if (hasHeavyKeywords) {
    const cost = COST_PER_1K_TOKENS_CENTS[models.heavy] || 300;
    return {
      modelId: models.heavy,
      tier: 'heavy',
      reason: 'heavy_keywords_detected',
      estimatedCostCentsPer1kTokens: cost,
    };
  }

  // Check for tools that require heavy tier
  const toolNames = enabledTools.map(t => t.function?.name || '').filter(Boolean);
  const heavyTools = ['generateImage', 'generate_image', 'research', 'websearch', 'web_search', 'generateVideo', 'generate_video'];
  const hasHeavyTools = toolNames.some(tool => heavyTools.some(ht => tool.toLowerCase().includes(ht.toLowerCase())));

  if (hasHeavyTools) {
    const cost = COST_PER_1K_TOKENS_CENTS[models.heavy] || 300;
    return {
      modelId: models.heavy,
      tier: 'heavy',
      reason: 'has_heavy_tools',
      estimatedCostCentsPer1kTokens: cost,
    };
  }

  // Check for content complexity signal
  const hasUrl = /https?:\/\//.test(lastUserMessage);
  const hasUserMention = /@\w+/.test(lastUserMessage);
  const hasAttachment = /\[\w*(?:file|image|attachment|media|upload|photo)\w*\]|\[.+\]/i.test(lastUserMessage);

  // Check for fast-tier signals
  const fastKeywords = ['lol', 'haha', 'yeah', 'yep', 'nope', 'ok', 'sure', 'cool', 'nice', 'thanks'];
  const hasFastKeywords = fastKeywords.some(word => new RegExp(`\\b${word}\\b`).test(lowerMsg));

  // If there's a URL, mention, or attachment in the message, never route to fast
  if (hasUrl || hasUserMention || hasAttachment) {
    const cost = COST_PER_1K_TOKENS_CENTS[models.standard] || 30;
    return {
      modelId: models.standard,
      tier: 'standard',
      reason: 'has_complex_content_signal',
      estimatedCostCentsPer1kTokens: cost,
    };
  }

  let score = 0;

  // Length assessment - only very short messages get fast boost
  const len = lastUserMessage.trim().length;
  if (len < 15) score += 2.5;
  else if (len < 40) score += 1;
  else if (len > 500) score -= 2;

  // Complexity assessment - fast keywords boost score
  if (hasFastKeywords) score += 1.5;

  // Conversation depth
  let userMessageCount = 0;
  for (const msg of recentMessages) {
    if (msg.role === 'user') userMessageCount++;
  }
  if (userMessageCount <= 2) score += 0.5;
  if (userMessageCount >= 7) score -= 2;


  if (score >= 3) {
    const cost = COST_PER_1K_TOKENS_CENTS[models.fast] || 8;
    return {
      modelId: models.fast,
      tier: 'fast',
      reason: `heuristic_fast_score_${Math.round(score * 10) / 10}`,
      estimatedCostCentsPer1kTokens: cost,
    };
  }

  if (score <= -1.5) {
    const cost = COST_PER_1K_TOKENS_CENTS[models.heavy] || 300;
    return {
      modelId: models.heavy,
      tier: 'heavy',
      reason: `heuristic_heavy_score_${Math.round(score * 10) / 10}`,
      estimatedCostCentsPer1kTokens: cost,
    };
  }

  const cost = COST_PER_1K_TOKENS_CENTS[models.standard] || 30;
  return {
    modelId: models.standard,
    tier: 'standard',
    reason: `heuristic_default_score_${Math.round(score * 10) / 10}`,
    estimatedCostCentsPer1kTokens: cost,
  };
}
