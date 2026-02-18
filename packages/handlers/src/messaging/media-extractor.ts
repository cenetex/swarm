/**
 * Media Extractor Module
 *
 * Resolves Telegram file IDs to downloadable URLs and builds multimodal
 * LLM message content so the model can see images via vision and hear
 * transcribed voice/audio.
 *
 * Design decisions:
 * - Images: resolved to URLs and passed as `image_url` content parts.
 *   Modern LLMs on OpenRouter support vision natively.
 * - Voice/Audio: transcribed via OpenAI Whisper (when key is available)
 *   and the transcript is prepended to the text content.  Falls back to
 *   a descriptive placeholder when no transcription API key is configured.
 * - Documents/Videos/Animations: described with metadata placeholder text.
 *   Full extraction for these types can be added later.
 */
import {
  logger,
  type SwarmEnvelope,
  type MediaAttachment,
} from '@swarm/core';

// ============================================================================
// Telegram File Resolution
// ============================================================================

/**
 * Resolve a Telegram file_id to a downloadable HTTPS URL via the Bot API.
 *
 * @param botToken  Telegram bot token (e.g. from secrets)
 * @param fileId    Telegram file_id from the Update object
 * @returns         Absolute URL to the file on Telegram's CDN
 */
export async function resolveTelegramFileUrl(
  botToken: string,
  fileId: string,
): Promise<string> {
  const url = `https://api.telegram.org/bot${botToken}/getFile`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  const result = (await response.json()) as {
    ok: boolean;
    result?: { file_path: string };
    description?: string;
  };

  if (!result.ok || !result.result?.file_path) {
    throw new Error(result.description || 'Failed to get Telegram file');
  }

  return `https://api.telegram.org/file/bot${botToken}/${result.result.file_path}`;
}

// ============================================================================
// Media Description Helpers
// ============================================================================

function describeAttachment(att: MediaAttachment): string {
  switch (att.type) {
    case 'photo':
      return '[The user sent a photo]';
    case 'audio':
      return '[The user sent a voice/audio message]';
    case 'video':
      return att.mimeType
        ? `[The user sent a video (${att.mimeType})]`
        : '[The user sent a video]';
    case 'animation':
      return '[The user sent a GIF/animation]';
    case 'document':
      return att.mimeType
        ? `[The user sent a document (${att.mimeType})]`
        : '[The user sent a document]';
    default:
      return '[The user sent media]';
  }
}

// ============================================================================
// Public API
// ============================================================================

export interface MediaExtractionConfig {
  /** Telegram bot token - required to resolve file_id to URL */
  telegramBotToken?: string;
  /** OpenAI API key - required for Whisper transcription */
  openaiApiKey?: string;
}

export interface MediaExtractionResult {
  /**
   * If the user message should include image_url content parts for the LLM
   * (vision), they are listed here.
   */
  imageUrls: string[];
  /**
   * Text to prepend/append to the user message describing non-image media.
   * Includes transcriptions for audio when available.
   */
  mediaDescriptions: string[];
  /**
   * Combined text annotation for all media (empty string if none).
   * Ready to append after the user's text.
   */
  annotation: string;
}

/**
 * Extract media context from a SwarmEnvelope.
 *
 * For photos: resolves file URLs so they can be passed to vision-capable LLMs.
 * For audio/voice: attempts transcription, falls back to placeholder.
 * For other types: produces descriptive placeholder text.
 */
export async function extractMediaContext(
  envelope: SwarmEnvelope,
  config: MediaExtractionConfig,
): Promise<MediaExtractionResult> {
  const result: MediaExtractionResult = {
    imageUrls: [],
    mediaDescriptions: [],
    annotation: '',
  };

  const media = envelope.content.media;
  if (!media || media.length === 0) {
    return result;
  }

  const isTelegram = envelope.platform === 'telegram';

  for (const att of media) {
    // ----- PHOTOS / IMAGES -----
    if (att.type === 'photo') {
      const url = await resolveAttachmentUrl(att, isTelegram, config);
      if (url) {
        result.imageUrls.push(url);
        logger.info('Resolved image for LLM vision', {
          event: 'media_image_resolved',
          subsystem: 'media-extractor',
          hasUrl: true,
        });
      } else {
        result.mediaDescriptions.push(describeAttachment(att));
      }
      continue;
    }

    // ----- AUDIO / VOICE -----
    if (att.type === 'audio') {
      // If the envelope already has text from prior transcription (e.g.
      // maybeTranscribeAudio ran successfully), skip re-transcription.
      const alreadyTranscribed =
        envelope.content.text && envelope.content.text.length > 0;

      if (!alreadyTranscribed) {
        const transcript = await tryTranscribeAudio(att, isTelegram, config);
        if (transcript) {
          result.mediaDescriptions.push(
            `[Voice message transcript]: ${transcript}`,
          );
          logger.info('Transcribed audio for LLM context', {
            event: 'media_audio_transcribed',
            subsystem: 'media-extractor',
            transcriptLength: transcript.length,
          });
          continue;
        }
      }

      // Fallback: provide descriptive placeholder
      result.mediaDescriptions.push(describeAttachment(att));
      continue;
    }

    // ----- DOCUMENT (image-like) -----
    if (
      att.type === 'document' &&
      att.mimeType &&
      att.mimeType.startsWith('image/')
    ) {
      const url = await resolveAttachmentUrl(att, isTelegram, config);
      if (url) {
        result.imageUrls.push(url);
        continue;
      }
    }

    // ----- Everything else -----
    result.mediaDescriptions.push(describeAttachment(att));
  }

  // Build combined annotation
  if (result.mediaDescriptions.length > 0) {
    result.annotation = result.mediaDescriptions.join('\n');
  }

  return result;
}

/**
 * Build multimodal LLM user message content from extracted media.
 *
 * When images are present, returns an array of content parts (text + image_url)
 * suitable for vision-capable models.  Otherwise returns a plain string.
 */
export function buildUserMessageContent(
  textContent: string,
  extraction: MediaExtractionResult,
): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  const combinedText = extraction.annotation
    ? `${textContent}\n\n${extraction.annotation}`
    : textContent;

  if (extraction.imageUrls.length === 0) {
    return combinedText;
  }

  // Multimodal content: text + image URLs
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [{ type: 'text', text: combinedText }];

  for (const url of extraction.imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }

  return parts;
}

// ============================================================================
// Internal Helpers
// ============================================================================

async function resolveAttachmentUrl(
  att: MediaAttachment,
  isTelegram: boolean,
  config: MediaExtractionConfig,
): Promise<string | null> {
  // Already have a URL
  if (att.url) return att.url;

  // Resolve from Telegram file_id
  if (isTelegram && att.fileId && config.telegramBotToken) {
    try {
      return await resolveTelegramFileUrl(config.telegramBotToken, att.fileId);
    } catch (err) {
      logger.warn('Failed to resolve Telegram file URL', {
        event: 'media_resolve_failed',
        subsystem: 'media-extractor',
        error: err instanceof Error ? err.message : String(err),
        type: att.type,
      });
      return null;
    }
  }

  return null;
}

async function tryTranscribeAudio(
  att: MediaAttachment,
  isTelegram: boolean,
  config: MediaExtractionConfig,
): Promise<string | null> {
  if (!config.openaiApiKey) return null;

  // Resolve the audio file URL
  const audioUrl = await resolveAttachmentUrl(att, isTelegram, config);
  if (!audioUrl) return null;

  try {
    // Download the audio file
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      logger.warn('Failed to download audio for transcription', {
        event: 'media_audio_download_failed',
        subsystem: 'media-extractor',
        status: audioResponse.status,
      });
      return null;
    }

    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    // Determine the filename extension from mime type or URL
    const ext = att.mimeType?.includes('ogg')
      ? 'ogg'
      : att.mimeType?.includes('mp3')
        ? 'mp3'
        : att.mimeType?.includes('wav')
          ? 'wav'
          : audioUrl.includes('.oga')
            ? 'oga'
            : 'ogg';

    // Send to OpenAI Whisper API
    const form = new FormData();
    form.append(
      'file',
      new Blob([audioBuffer], { type: att.mimeType || 'audio/ogg' }),
      `audio.${ext}`,
    );
    form.append('model', 'whisper-1');

    const transcribeResponse = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: form,
      },
    );

    if (!transcribeResponse.ok) {
      const errorText = await transcribeResponse.text();
      logger.warn('OpenAI Whisper transcription failed', {
        event: 'media_transcription_failed',
        subsystem: 'media-extractor',
        status: transcribeResponse.status,
        errorPreview: errorText.slice(0, 200),
      });
      return null;
    }

    const data = (await transcribeResponse.json()) as { text: string };
    return data.text || null;
  } catch (err) {
    logger.warn('Audio transcription error', {
      event: 'media_transcription_error',
      subsystem: 'media-extractor',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
