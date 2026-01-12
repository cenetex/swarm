/**
 * Voice Services for runtime handlers
 */
import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({});
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';
const VOICE_TTS_MODEL = process.env.VOICE_TTS_MODEL;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const FETCH_TIMEOUT_MS = 10_000;

type AudioFormat = 'ogg' | 'mp3' | 'wav';

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | { uri?: string };
  error?: string;
}

function detectAudioFormat(contentType?: string | null, url?: string | null): AudioFormat {
  const type = (contentType || '').toLowerCase();
  if (type.includes('ogg') || type.includes('opus')) return 'ogg';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';

  const lowerUrl = (url || '').toLowerCase();
  if (lowerUrl.endsWith('.mp3')) return 'mp3';
  if (lowerUrl.endsWith('.wav')) return 'wav';
  if (lowerUrl.endsWith('.ogg') || lowerUrl.endsWith('.oga') || lowerUrl.endsWith('.opus')) return 'ogg';
  return 'ogg';
}

function formatToContentType(format: AudioFormat): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    default:
      return 'audio/ogg';
  }
}

function extractOutputUrl(output: ReplicatePrediction['output']): string | undefined {
  if (Array.isArray(output)) return output[0];
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'uri' in output) return output.uri;
  return undefined;
}

function parseS3Key(url: string): { bucket: string; key: string } | null {
  const match = url.match(/https:\/\/([^.]+)\.s3[^/]*\.amazonaws\.com\/(.+)/);
  if (!match) return null;
  return { bucket: match[1], key: decodeURIComponent(match[2]) };
}

function isUrl(value?: string): boolean {
  return !!value && /^https?:\/\//i.test(value);
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function makeUrlAccessible(url: string, cdnUrl?: string): Promise<string> {
  if (!url.includes('.s3.amazonaws.com') && !url.includes('.s3.us-')) {
    return url;
  }

  if (cdnUrl) {
    const parsed = parseS3Key(url);
    if (parsed) {
      return `${cdnUrl}/${parsed.key}`;
    }
    return url;
  }

  const parsed = parseS3Key(url);
  if (!parsed) return url;

  const command = new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

async function runReplicatePrediction(
  apiKey: string,
  model: string,
  input: Record<string, unknown>
): Promise<string> {
  const createResponse = await fetch(REPLICATE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Prefer': 'wait',
    },
    body: JSON.stringify({ version: model, input }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Replicate prediction failed: ${createResponse.status} - ${errorText}`);
  }

  let prediction = await createResponse.json() as ReplicatePrediction;
  let attempts = 0;
  const maxAttempts = 120;
  const pollIntervalMs = 1000;

  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    attempts++;

    const pollResponse = await fetch(`${REPLICATE_ENDPOINT}/${prediction.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      throw new Error(`Replicate poll failed: ${pollResponse.status} - ${errorText}`);
    }

    prediction = await pollResponse.json() as ReplicatePrediction;
  }

  if (prediction.status !== 'succeeded') {
    const reason = prediction.error || `status=${prediction.status}`;
    throw new Error(`Replicate prediction failed: ${reason}`);
  }

  const outputUrl = extractOutputUrl(prediction.output);
  if (!outputUrl) {
    throw new Error('Replicate prediction returned no output');
  }

  return outputUrl;
}

async function uploadAudioAsset(params: {
  agentId: string;
  buffer: Buffer;
  format: AudioFormat;
  mediaBucket: string;
  cdnUrl?: string;
}): Promise<{ assetId: string; url: string }> {
  const assetId = randomUUID();
  const s3Key = `agents/${params.agentId}/audio/${assetId}.${params.format}`;

  await s3Client.send(new PutObjectCommand({
    Bucket: params.mediaBucket,
    Key: s3Key,
    Body: params.buffer,
    ContentType: formatToContentType(params.format),
    CacheControl: 'max-age=31536000',
  }));

  const url = params.cdnUrl
    ? `${params.cdnUrl}/${s3Key}`
    : `https://${params.mediaBucket}.s3.amazonaws.com/${s3Key}`;

  return { assetId, url };
}

async function getTelegramFileUrl(botToken: string, fileId: string): Promise<string> {
  const url = `https://api.telegram.org/bot${botToken}/getFile`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  const result = await response.json() as {
    ok: boolean;
    result?: { file_path: string };
    description?: string;
  };

  if (!result.ok || !result.result?.file_path) {
    throw new Error(result.description || 'Failed to get Telegram file');
  }

  return `https://api.telegram.org/file/bot${botToken}/${result.result.file_path}`;
}

export function createVoiceServices(config: {
  agentId: string;
  secrets: Record<string, string>;
  voiceConfig?: { ttsProvider?: 'voice-clone'; format?: AudioFormat; speed?: number; referenceUrl?: string };
  mediaBucket?: string;
  cdnUrl?: string;
}) {
  const openAiKey = config.secrets.OPENAI_API_KEY || config.secrets.openai_api_key;
  const replicateKey = config.secrets.REPLICATE_API_TOKEN || config.secrets.REPLICATE_API_KEY || config.secrets.replicate_api_key;
  const telegramToken = config.secrets.TELEGRAM_BOT_TOKEN || config.secrets.telegram_bot_token;

  return {
    transcribeAudio: async (params: {
      assetId?: string;
      url?: string;
      platformFileId?: string;
      language?: string;
      model?: string;
      diarize?: boolean;
    }) => {
      if (!openAiKey) {
        throw new Error('OPENAI_API_KEY not configured');
      }

      let audioUrl = params.url;
      if (!audioUrl && params.platformFileId) {
        if (!telegramToken) {
          throw new Error('TELEGRAM_BOT_TOKEN not configured');
        }
        audioUrl = await getTelegramFileUrl(telegramToken, params.platformFileId);
      }

      if (!audioUrl) {
        throw new Error('No audio source provided');
      }

      const response = await fetchWithTimeout(audioUrl);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to download audio: ${response.status} - ${errorText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type');
      const format = detectAudioFormat(contentType, audioUrl);

      const form = new FormData();
      form.append('file', new Blob([buffer], { type: contentType || formatToContentType(format) }), `audio.${format}`);
      form.append('model', params.model || 'whisper-1');
      if (params.language) {
        form.append('language', params.language);
      }

      const transcribeResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openAiKey}`,
        },
        body: form,
      });

      if (!transcribeResponse.ok) {
        const errorText = await transcribeResponse.text();
        throw new Error(`OpenAI transcription failed: ${transcribeResponse.status} - ${errorText}`);
      }

      const data = await transcribeResponse.json() as { text: string; language?: string };
      return { text: data.text, language: data.language };
    },

    createVoiceSeed: async () => {
      throw new Error('Voice seed generation not supported in runtime handlers');
    },

    cloneVoiceFromSeed: async () => {
      throw new Error('Voice cloning not supported in runtime handlers');
    },

    createVoiceProfile: async () => {
      throw new Error('Voice profile creation not supported in runtime handlers');
    },

    setActiveVoiceProfile: async () => {
      throw new Error('Voice profile updates not supported in runtime handlers');
    },

    createMyVoice: async () => {
      throw new Error('Voice creation not supported in runtime handlers - use admin API');
    },

    hasVoice: async () => {
      // Return voice config info from the current config
      const hasVoiceProfile = !!(config.voiceConfig?.referenceUrl);
      return {
        hasVoice: hasVoiceProfile,
        voiceId: undefined,
        voiceStyle: config.voiceConfig?.ttsProvider,
        referenceUrl: config.voiceConfig?.referenceUrl,
      };
    },

    generateVoiceMessage: async (params: {
      agentId: string;
      platform: string;
      text: string;
      voiceId?: string;
      format?: AudioFormat;
      speed?: number;
      pitch?: number;
      emotion?: string;
      maxDurationMs?: number;
    }) => {
      if (!config.mediaBucket) {
        throw new Error('MEDIA_BUCKET not configured');
      }

      const format = params.format || config.voiceConfig?.format || 'ogg';
      const referenceUrl = config.voiceConfig?.referenceUrl;
      const voiceId = params.voiceId;

      if (config.voiceConfig?.ttsProvider === 'voice-clone' && VOICE_TTS_MODEL && replicateKey && (referenceUrl || isUrl(voiceId))) {
        const seedUrl = referenceUrl || (isUrl(voiceId) ? voiceId : undefined);
        if (!seedUrl) {
          throw new Error('Voice reference URL not configured');
        }

        const outputUrl = await runReplicatePrediction(replicateKey, VOICE_TTS_MODEL, {
          text: params.text,
          speaker_wav: await makeUrlAccessible(seedUrl, config.cdnUrl),
        });

        const audioResponse = await fetchWithTimeout(outputUrl);
        if (!audioResponse.ok) {
          const errorText = await audioResponse.text();
          throw new Error(`Failed to download TTS audio: ${audioResponse.status} - ${errorText}`);
        }

        const buffer = Buffer.from(await audioResponse.arrayBuffer());
        const contentType = audioResponse.headers.get('content-type');
        const detectedFormat = detectAudioFormat(contentType, outputUrl);

        const asset = await uploadAudioAsset({
          agentId: config.agentId,
          buffer,
          format: detectedFormat,
          mediaBucket: config.mediaBucket,
          cdnUrl: config.cdnUrl,
        });

        return { assetId: asset.assetId, url: asset.url, durationMs: undefined, format: detectedFormat };
      }

      if (!openAiKey) {
        throw new Error('OPENAI_API_KEY not configured');
      }

      const voice = voiceId && !isUrl(voiceId) ? voiceId : OPENAI_TTS_VOICE;
      const responseFormat = format === 'ogg' ? 'opus' : format;

      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openAiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_TTS_MODEL,
          voice,
          input: params.text,
          response_format: responseFormat,
          ...(params.speed ? { speed: params.speed } : {}),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI TTS failed: ${response.status} - ${errorText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      const asset = await uploadAudioAsset({
        agentId: config.agentId,
        buffer,
        format,
        mediaBucket: config.mediaBucket,
        cdnUrl: config.cdnUrl,
      });

      return { assetId: asset.assetId, url: asset.url, durationMs: undefined, format };
    },

    sendVoiceMessage: async (params: {
      agentId: string;
      platform: string;
      conversationId: string;
      assetId?: string;
      url?: string;
      caption?: string;
      replyToMessageId?: string;
    }) => {
      if (params.platform !== 'telegram') {
        throw new Error(`Voice messaging not supported for platform: ${params.platform}`);
      }

      if (!telegramToken) {
        throw new Error('TELEGRAM_BOT_TOKEN not configured');
      }

      const voiceUrl = params.url;
      if (!voiceUrl) {
        throw new Error('Voice URL required for sendVoiceMessage');
      }

      const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendVoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: params.conversationId,
          voice: voiceUrl,
          caption: params.caption,
          reply_to_message_id: params.replyToMessageId ? Number(params.replyToMessageId) : undefined,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Telegram sendVoice failed: ${response.status} - ${errorText}`);
      }

      return { success: true };
    },
  };
}
