/**
 * Context Builder Module
 *
 * Builds the system prompt, injects dream/memory context, transcribes audio
 * attachments, and prepares the final user message with multimodal content.
 */
import {
  logger,
  buildDynamicSystemPrompt,
  type ToolCategory,
  type ProcessorAvatarConfig,
} from '@swarm/core';
import type { AdminChatMessage } from '../../types.js';
import * as voice from '../../services/voice.js';
import * as memory from '../../services/memory.js';
import { formatDreamForPrompt, getDreamForResponse } from '../../services/dreams.js';
import { sanitizeMessages } from '../chat-tool-helpers.js';
import { getAccountSummary } from '../../services/accounts.js';
import type { AvatarContext, ProcessChatOptions } from './types.js';

const DREAMS_ENABLED = process.env.DREAMS_ENABLED === 'true';

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

const MAX_CONTEXT_MESSAGES = parseIntEnv('MAX_CONTEXT_MESSAGES', 20);

/**
 * Build system prompt dynamically based on enabled tool categories
 */
export function buildSystemPrompt(avatar?: AvatarContext): string {
  if (avatar) {
    const categories: ToolCategory[] = avatar.enabledCategories || [
      'secrets', 'profile', 'media', 'gallery', 'wallets', 'diagnostics',
    ];

    const avatarConfig: ProcessorAvatarConfig = {
      avatarId: avatar.id,
      name: avatar.name,
      description: avatar.description,
      persona: avatar.persona,
      enabledCategories: categories,
    };

    return buildDynamicSystemPrompt(avatarConfig, 'admin-ui');
  }

  return `You are a Swarm avatar assistant. Please select an avatar to chat with.`;
}

/**
 * Sanitize and truncate messages for the LLM context window.
 *
 * Returns the sanitized messages array (no SDK wrapping needed — we call
 * the Chat Completions API directly).
 */
export function buildModelInput(_systemPrompt: string, messages: AdminChatMessage[]): AdminChatMessage[] {
  const sanitizedMessages = sanitizeMessages(messages);
  const truncatedMessages = sanitizedMessages.slice(-MAX_CONTEXT_MESSAGES);
  if (sanitizedMessages.length > truncatedMessages.length) {
    logger.info('Truncated conversation history for LLM', {
      event: 'history_truncated',
      originalCount: sanitizedMessages.length,
      truncatedCount: truncatedMessages.length,
      maxContextMessages: MAX_CONTEXT_MESSAGES,
    });
  }
  // Re-sanitize after truncation: slicing may orphan tool results whose
  // matching assistant tool_calls were trimmed from the start of the window.
  return sanitizeMessages(truncatedMessages);
}

/**
 * Inject dream context into the system prompt (prepended).
 */
export async function injectDreamContext(
  systemPrompt: string,
  avatarId: string,
  persona: string
): Promise<string> {
  if (!DREAMS_ENABLED) return systemPrompt;

  try {
    const { dream, isGenerating } = await getDreamForResponse(avatarId, persona);
    const dreamSection = formatDreamForPrompt(dream);
    if (dreamSection) {
      systemPrompt = dreamSection + systemPrompt;
    }
    logger.info('Dream context evaluated', {
      event: 'dream_context_evaluated',
      avatarId,
      hasDream: Boolean(dream),
      isGenerating,
    });
  } catch (err) {
    logger.warn('Failed to inject dream context', {
      event: 'dream_context_error',
      avatarId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  return systemPrompt;
}

/**
 * Inject memory context into the system prompt (appended).
 */
export async function injectMemoryContext(
  systemPrompt: string,
  avatarId: string,
  userMessage: string | null
): Promise<string> {
  try {
    const query = typeof userMessage === 'string' ? userMessage.trim() : '';
    const memoryContext = query.length > 0
      ? await memory.getMemoryContextForQuery(avatarId, query)
      : await memory.getMemoryContext(avatarId);
    if (memoryContext) {
      systemPrompt += `\n\n${memoryContext}`;
      logger.info('Memory context injected', {
        event: 'memory_context_injected',
        avatarId,
        contextLength: memoryContext.length,
        queryAware: query.length > 0,
        queryLength: query.length,
      });
    }
  } catch (err) {
    logger.warn('Failed to get memory context', {
      event: 'memory_context_error',
      avatarId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  return systemPrompt;
}

/**
 * Transcribe audio attachments and return the combined transcription text.
 */
export async function transcribeAudioAttachments(
  avatarId: string,
  attachments: Array<{ type: 'image' | 'file' | 'audio'; data: string; name?: string }>
): Promise<string> {
  const audioAttachments = attachments.filter(a => a.type === 'audio');
  if (audioAttachments.length === 0) return '';

  logger.info('Auto-transcribing audio attachments', {
    event: 'audio_transcription_start',
    avatarId,
    audioCount: audioAttachments.length,
  });

  let transcribedText = '';
  for (const audio of audioAttachments) {
    try {
      const transcription = await voice.transcribeAudio({
        avatarId,
        url: audio.data,
      });
      if (transcription.text) {
        transcribedText += `\n\n[Voice message transcription]: "${transcription.text}"`;
        logger.info('Audio transcription successful', {
          event: 'audio_transcription_success',
          avatarId,
          textLength: transcription.text.length,
        });
      }
    } catch (err) {
      logger.warn('Audio transcription failed', {
        event: 'audio_transcription_error',
        avatarId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      transcribedText += '\n\n[Voice message received but transcription failed]';
    }
  }

  return transcribedText;
}

/**
 * Build the final user message content, incorporating transcriptions and image attachments.
 */
export function buildUserMessageContent(
  userMessage: string,
  transcribedText: string,
  attachments?: Array<{ type: 'image' | 'file' | 'audio'; data: string; name?: string }>
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const messageWithTranscription = transcribedText
    ? userMessage + transcribedText
    : userMessage;

  if (attachments && attachments.length > 0) {
    const imageAttachments = attachments.filter(a => a.type === 'image');
    if (imageAttachments.length > 0) {
      return [
        { type: 'text', text: messageWithTranscription },
        ...imageAttachments.map(a => ({
          type: 'image_url' as const,
          image_url: { url: a.data },
        })),
      ];
    }
  }

  return messageWithTranscription;
}

/**
 * Inject current user identity context (linked wallets, Orb status) into the
 * system prompt so the avatar knows who it is talking to.
 */
export async function injectUserIdentityContext(
  systemPrompt: string,
  accountId: string
): Promise<string> {
  try {
    const account = await getAccountSummary(accountId);
    if (!account) return systemPrompt;

    const wallets = account.identities
      .filter(i => i.type === 'wallet')
      .map(i => i.providerId);

    if (wallets.length === 0) return systemPrompt;

    const shortAddr = (addr: string) =>
      addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;

    const lines = [
      '\n\n## Current User',
      `- Account: ${account.displayName || account.email || shortAddr(wallets[0])}`,
      `- Linked wallets: ${wallets.map(w => shortAddr(w)).join(', ')}`,
    ];

    systemPrompt += lines.join('\n');

    logger.info('User identity context injected', {
      event: 'user_identity_injected',
      accountId,
      walletCount: wallets.length,
    });
  } catch (err) {
    logger.warn('Failed to inject user identity context', {
      event: 'user_identity_error',
      accountId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  return systemPrompt;
}

/**
 * Build the enriched system prompt with optional dream + memory context.
 */
export async function buildEnrichedSystemPrompt(
  avatar: AvatarContext | undefined,
  userMessage: string | null,
  options?: ProcessChatOptions
): Promise<string> {
  let systemPrompt = options?.customSystemPrompt || buildSystemPrompt(avatar);

  // Inject dream context
  if (!options?.customSystemPrompt && avatar?.id && avatar?.persona) {
    systemPrompt = await injectDreamContext(systemPrompt, avatar.id, avatar.persona);
  }

  // Inject memory context
  if (avatar?.id && avatar?.enabledCategories?.includes('memory')) {
    systemPrompt = await injectMemoryContext(systemPrompt, avatar.id, userMessage);
  }

  // Inject user identity context (linked wallets)
  if (options?.userAccountId) {
    systemPrompt = await injectUserIdentityContext(systemPrompt, options.userAccountId);
  }

  // Inject active task context (admin UI workspace state)
  if (options?.activeTask) {
    const t = options.activeTask;
    systemPrompt += `\n\n## Active Task\nThe user is currently focused on a "${t.toolName}" task (status: ${t.status}, surface: ${t.surface}). Tailor your response to this context.`;
  }

  return systemPrompt;
}
