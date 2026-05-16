/**
 * Tool Executor Module
 * Handles conversion of tool results to response actions,
 * and audio transcription for the message processor.
 */
import {
  logger,
  type ResponseAction,
  type SwarmEnvelope,
  type AvatarConfig,
} from '@swarm/core';
import {
  createToolClient,
  type ToolContext,
} from '@swarm/mcp-server';

/**
 * Convert tool results to response actions
 */
export function toolResultsToActions(
  toolResults: Array<{ name: string; result: { success: boolean; data?: unknown; media?: { type: string; url: string }; pendingJob?: { jobId: string; type: string; prompt?: string } } }>
): ResponseAction[] {
  const actions: ResponseAction[] = [];

  for (const { name, result } of toolResults) {
    if (!result.success) continue;

    switch (name) {
      case 'send_message': {
        const data = result.data as { text?: string } | undefined;
        if (data?.text) {
          actions.push({ type: 'send_message', text: data.text });
        }
        break;
      }

      case 'generate_image': {
        if (result.media) {
          actions.push({
            type: 'send_media',
            mediaType: 'image',
            url: result.media.url,
          });
        } else if (result.pendingJob) {
          actions.push({
            type: 'send_message',
            text: `🎨 Generating image: "${result.pendingJob.prompt}"... I'll send it when it's ready!`,
          });
        }
        break;
      }

      case 'generate_video': {
        if (result.media) {
          actions.push({
            type: 'send_media',
            mediaType: 'video',
            url: result.media.url,
          });
        } else if (result.pendingJob) {
          actions.push({
            type: 'send_message',
            text: `🎬 Generating video: "${result.pendingJob.prompt}"... I'll send it when it's ready!`,
          });
        }
        break;
      }

      case 'send_voice_message': {
        const data = result.data as { url?: string } | undefined;
        if (data?.url) {
          actions.push({
            type: 'send_voice',
            url: data.url,
          });
        }
        break;
      }

      case 'react': {
        const data = result.data as { emoji?: string; messageId?: string } | undefined;
        if (data?.emoji) {
          actions.push({ type: 'react', emoji: data.emoji, messageId: data.messageId || '' });
        }
        break;
      }

      case 'wait': {
        const data = result.data as { durationMs?: number } | undefined;
        if (data?.durationMs) {
          actions.push({ type: 'wait', durationMs: data.durationMs });
        }
        break;
      }

      case 'ignore': {
        const data = result.data as { reason?: string } | undefined;
        actions.push({ type: 'ignore', reason: data?.reason || 'No response needed' });
        break;
      }

      case 'send_gallery_image': {
        // Explicit handling: only emit send_media when media.url is present.
        // Failed results (stale/invalid IDs) are already skipped by the
        // !result.success guard above, but being explicit here prevents
        // accidental broken-image actions if the default path changes.
        if (result.media?.url) {
          actions.push({
            type: 'send_media',
            mediaType: 'image',
            url: result.media.url,
          });
        }
        break;
      }

      case 'generate_sticker':
      case 'create_sticker':
      case 'send_sticker': {
        const data = result.data as { fileId?: string; stickerId?: string; emoji?: string } | undefined;
        if (data?.fileId) {
          actions.push({
            type: 'send_sticker',
            emoji: data.emoji || '🐴',
            stickerId: data.fileId,
          });
        } else if (result.media?.url) {
          actions.push({
            type: 'send_media',
            mediaType: 'image',
            url: result.media.url,
          });
        }
        break;
      }

      // Handle any tool that returns media (gallery, stickers, etc.)
      default: {
        if (result.media?.url && result.media?.type) {
          // Map media types to valid SendMediaAction types
          const typeMap: Record<string, 'image' | 'video' | 'animation'> = {
            image: 'image',
            video: 'video',
            animation: 'animation',
            sticker: 'image', // stickers are treated as images
            gif: 'animation',
          };
          const mediaType = typeMap[result.media.type];
          if (mediaType) {
            actions.push({
              type: 'send_media',
              mediaType,
              url: result.media.url,
            });
          }
        }
        break;
      }
    }
  }

  return actions;
}

export async function maybeTranscribeAudio(
  envelope: SwarmEnvelope,
  toolClient: ReturnType<typeof createToolClient>,
  toolContext: ToolContext,
  avatarConfig: AvatarConfig
): Promise<void> {
  const audioAttachment = envelope.content.media?.find(m => m.type === 'audio');
  if (!audioAttachment?.fileId) return;

  const shouldTranscribe = avatarConfig.voice?.enabled || avatarConfig.tools.includes('transcribe_audio');
  if (!shouldTranscribe) return;

  try {
    const result = await toolClient.execute('transcribe_audio', {
      platformFileId: audioAttachment.fileId,
    }, toolContext);

    if (result.success) {
      const data = result.data as { text?: string } | undefined;
      if (data?.text) {
        const prefix = envelope.content.text ? `${envelope.content.text}\n\n` : '';
        envelope.content.text = `${prefix}${data.text}`;
      }
    }
  } catch (error) {
    logger.warn('Voice transcription failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
