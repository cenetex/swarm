/**
 * Post-Processing Module
 *
 * Handles response cleanup after LLM + tool execution:
 * - Thinking tag extraction
 * - Media URL redaction
 * - Stale text filtering
 * - Media extraction from tool results
 * - Pending job detection
 * - Avatar update detection (profile image, name)
 * - Model config surfacing
 */
import { logger, extractThinking } from '@swarm/core';
import { extractTaskAction, type TaskAction } from '@swarm/mcp-server';
import type { ToolResult } from '../../types.js';
import { extractMediaFromToolResults, type MediaItem, type SdkToolCall } from '../chat-tool-helpers.js';
import { redactMediaUrlsFromText } from '../../utils/redact-media-urls.js';
import * as avatars from '../../services/avatars.js';

/**
 * Clean up the LLM response text:
 * 1. Extract and strip <thinking> tags
 * 2. Remove stale "connect your X/Twitter" text
 * 3. Redact raw media URLs
 *
 * Returns the cleaned response and any extracted thinking blocks.
 */
export function cleanResponse(response: string): { response: string; extractedThinking?: string[] } {
  let cleaned = response;
  let extractedThinking: string[] | undefined;

  // Extract <thinking> tags
  if (typeof cleaned === 'string') {
    const { cleanContent, thinkingBlocks } = extractThinking(cleaned);
    cleaned = cleanContent;
    const cleanedThinking = thinkingBlocks
      .map((t: string) => redactMediaUrlsFromText(t).trim())
      .filter((t: string) => t.length > 0);
    extractedThinking = cleanedThinking.length > 0 ? cleanedThinking : undefined;
  }

  // Filter stale "Please connect your X/Twitter account:" text
  if (typeof cleaned === 'string') {
    cleaned = cleaned.replace(/please\s+connect\s+your\s+(x\/?twitter|twitter\/?x)\s+account\s*:/gi, '').trim();
  }

  // Redact raw CloudFront media URLs
  if (typeof cleaned === 'string') {
    cleaned = redactMediaUrlsFromText(cleaned);
  }

  return { response: cleaned, extractedThinking };
}

/**
 * Surface model config from tool results if the LLM response is empty or unhelpful.
 */
export function surfaceModelConfig(
  response: string,
  toolCalls: SdkToolCall[],
  toolResults: ToolResult[]
): string {
  if (toolCalls.length === 0 || toolResults.length === 0) return response;

  const toolCallNameById = new Map(toolCalls.map(tc => [String(tc.id), String(tc.name)]));
  const modelConfigResult = toolResults.find(r => toolCallNameById.get(String(r.tool_call_id)) === 'get_my_model_config');

  if (!modelConfigResult?.content || typeof modelConfigResult.content !== 'string') return response;

  try {
    const parsed = JSON.parse(modelConfigResult.content) as { success?: boolean; data?: unknown };
    if (parsed?.success === true && parsed.data && typeof parsed.data === 'object') {
      const data = parsed.data as Record<string, unknown>;
      const model = typeof data.model === 'string' ? data.model : undefined;
      const temperature = typeof data.temperature === 'number' ? data.temperature : undefined;
      const maxTokens = typeof data.maxTokens === 'number' ? data.maxTokens : undefined;
      const provider = typeof data.provider === 'string' ? data.provider : undefined;

      const summaryParts = [
        model ? `Model: ${model}` : null,
        provider ? `Provider: ${provider}` : null,
        typeof temperature === 'number' ? `Temperature: ${temperature}` : null,
        typeof maxTokens === 'number' ? `Max tokens: ${maxTokens}` : null,
      ].filter((p): p is string => !!p);

      if (summaryParts.length > 0) {
        const summary = summaryParts.join('\n');
        const responseIsEmptyOrApology = !response || response.includes("I apologize, but I couldn't generate a response");
        if (responseIsEmptyOrApology) {
          return summary;
        }
        const hasModelHint = /\bmodel\b|temperature|max\s*tokens/i.test(response);
        if (!hasModelHint) {
          return `${response}\n\n${summary}`;
        }
      }
    }
  } catch {
    // Ignore JSON parsing failures
  }

  return response;
}

/**
 * Extract pending async jobs from tool results (image/video/sticker generation).
 */
export function extractPendingJobs(
  toolCalls: SdkToolCall[],
  toolResults: ToolResult[]
): Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }> {
  const pendingJobs: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }> = [];
  const toolCallNames = new Map(toolCalls.map(tc => [String(tc.id), String(tc.name)]));

  for (const result of toolResults) {
    if (!result.content || typeof result.content !== 'string') continue;

    try {
      const parsed = JSON.parse(result.content);
      const toolName = toolCallNames.get(String(result.tool_call_id));

      if (parsed._pendingJob) {
        pendingJobs.push({
          jobId: parsed._pendingJob.jobId,
          type: parsed._pendingJob.type || 'image',
          prompt: parsed._pendingJob.prompt,
          purpose: parsed._pendingJob.purpose,
        });
      } else if (parsed.jobId && (parsed.status === 'pending' || parsed.status === 'processing')) {
        pendingJobs.push({
          jobId: parsed.jobId,
          type: toolName === 'generate_video'
            ? 'video'
            : toolName === 'generate_sticker'
              ? 'sticker'
              : 'image',
          prompt: parsed.prompt,
        });
      }
    } catch {
      // Not JSON, skip
    }
  }

  return pendingJobs;
}

/**
 * Detect avatar updates (profile image URL, name) from tool results.
 */
export async function detectAvatarUpdates(
  toolCalls: SdkToolCall[],
  toolResults: ToolResult[],
  avatarId: string | undefined
): Promise<{ profileImageUrl?: string; name?: string }> {
  const updates: { profileImageUrl?: string; name?: string } = {};
  const toolCallNames = new Map(toolCalls.map(tc => [String(tc.id), String(tc.name)]));

  for (const result of toolResults) {
    const toolName = toolCallNames.get(String(result.tool_call_id));
    if (!result.content || typeof result.content !== 'string') continue;

    try {
      const parsed = JSON.parse(result.content);

      // Profile image updates
      if (toolName === 'set_profile_image' || toolName === 'save_uploaded_profile_image') {
        if (parsed.success && (parsed.data?.url || parsed.url || parsed.resultUrl)) {
          updates.profileImageUrl = parsed.data?.url || parsed.url || parsed.resultUrl;
          logger.info('Profile image updated', { profileImageUrl: updates.profileImageUrl });
        }
      }

      // Name updates from update_my_profile
      if (toolName === 'update_my_profile') {
        if (parsed.success && parsed.data?.updated?.includes('name')) {
          if (avatarId) {
            const updatedAgent = await avatars.getAvatar(avatarId);
            if (updatedAgent?.name) {
              updates.name = updatedAgent.name;
              logger.info('Avatar name updated', { name: updates.name });
            }
          }
        }
      }
    } catch {
      // Not JSON, skip
    }
  }

  return updates;
}

/**
 * Extract task actions from tool results.
 * Returns an array of { toolCallId, taskAction } pairs for each tool result
 * that contains a structured taskAction field.
 */
export function extractTaskActions(
  toolCalls: SdkToolCall[],
  toolResults: ToolResult[],
): Array<{ toolCallId: string; toolName: string; taskAction: TaskAction }> {
  const actions: Array<{ toolCallId: string; toolName: string; taskAction: TaskAction }> = [];
  const toolCallNames = new Map(toolCalls.map(tc => [String(tc.id), String(tc.name)]));

  for (const result of toolResults) {
    if (!result.content || typeof result.content !== 'string') continue;
    const toolCallId = String(result.tool_call_id);
    const toolName = toolCallNames.get(toolCallId) || 'unknown';

    const taskAction = extractTaskAction(result.content);
    if (taskAction) {
      actions.push({ toolCallId, toolName, taskAction });
      logger.info('Extracted task action from tool result', { toolCallId, toolName, taskType: taskAction.task.type });
    }
  }

  return actions;
}

/**
 * Extract media items from tool results (delegates to chat-tool-helpers).
 */
export function extractMedia(toolResults: ToolResult[]): MediaItem[] {
  const media = extractMediaFromToolResults(toolResults);
  logger.info('Extracted media items from tool results', { count: media.length });
  return media;
}
