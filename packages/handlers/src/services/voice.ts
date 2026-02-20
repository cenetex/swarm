/**
 * Voice Services for runtime handlers
 */
import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildMediaUrl, canonicalizeMediaUrl } from '@swarm/core';

// Default S3 client - lazy initialized
let defaultS3Client: S3Client | null = null;
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';
const MEDIA_CONVERT_FUNCTION = process.env.MEDIA_CONVERT_FUNCTION;

function getDefaultS3Client(): S3Client {
  if (!defaultS3Client) {
    defaultS3Client = new S3Client({});
  }
  return defaultS3Client;
}

// Type for injected fetch function
type FetchFn = typeof fetch;

// Type for injected S3 client
interface S3ClientLike {
  send: (command: unknown) => Promise<unknown>;
}

// VOICE_TTS_MODEL: Used for voice cloning and TTS with a reference audio
// Default: lucataco/xtts-v2 - popular voice cloning model (4.7M runs)
const VOICE_TTS_MODEL = process.env.VOICE_TTS_MODEL || 'lucataco/xtts-v2';

// Official models (like stability-ai) use a different endpoint than community models
const OFFICIAL_MODEL_PREFIXES = ['stability-ai', 'meta', 'openai', 'mistralai', 'resemble-ai'];
const FETCH_TIMEOUT_MS = 10_000;

type AudioFormat = 'ogg' | 'mp3' | 'wav';

type MediaConvertResponse = { success: boolean; url?: string; format?: string; error?: string };

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
  const keyWithQuery = decodeURIComponent(match[2]);
  const key = keyWithQuery.split('?')[0] || keyWithQuery;
  return { bucket: match[1], key };
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

  // If CDN is configured, canonicalize S3 URL to CDN URL
  if (cdnUrl) {
    return canonicalizeMediaUrl(url, cdnUrl);
  }

  const parsed = parseS3Key(url);
  if (!parsed) return url;

  const command = new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key });
  return getSignedUrl(getDefaultS3Client(), command, { expiresIn: 3600 });
}

async function convertAudioToOgg(params: { avatarId: string; sourceUrl: string }): Promise<string | null> {
  if (!MEDIA_CONVERT_FUNCTION) return null;

  const client = new LambdaClient({});
  const payload = JSON.stringify({
    avatarId: params.avatarId,
    sourceUrl: params.sourceUrl,
    mediaType: 'audio',
    targetFormat: 'ogg',
  });

  const result = await client.send(new InvokeCommand({
    FunctionName: MEDIA_CONVERT_FUNCTION,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(payload),
  }));

  if (!result.Payload) return null;
  const raw = new TextDecoder().decode(result.Payload);

  let parsed: MediaConvertResponse;
  try {
    parsed = JSON.parse(raw) as MediaConvertResponse;
  } catch {
    return null;
  }

  if (!parsed.success || !parsed.url) return null;
  return parsed.url;
}

// Cache for model versions (community models need version hash)
const modelVersionCache = new Map<string, string>();

async function getModelVersion(apiKey: string, model: string): Promise<string> {
  if (modelVersionCache.has(model)) {
    return modelVersionCache.get(model)!;
  }
  
  const response = await fetch(`https://api.replicate.com/v1/models/${model}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get model version for ${model}: ${response.status}`);
  }
  
  const data = await response.json() as { latest_version?: { id: string } };
  const version = data.latest_version?.id;
  if (!version) {
    throw new Error(`No version found for model ${model}`);
  }
  
  modelVersionCache.set(model, version);
  return version;
}

function isOfficialModel(model: string): boolean {
  return OFFICIAL_MODEL_PREFIXES.some(prefix => model.startsWith(prefix));
}

async function runReplicatePrediction(
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
  options: { pollIntervalMs?: number; maxAttempts?: number } = {}
): Promise<string> {
  // Official models use /v1/models/{owner}/{model}/predictions
  // Community models use /v1/predictions with a version hash
  const isOfficial = isOfficialModel(model);
  
  let endpoint: string;
  let body: Record<string, unknown>;
  
  if (isOfficial) {
    endpoint = `https://api.replicate.com/v1/models/${model}/predictions`;
    body = { input };
  } else {
    const version = await getModelVersion(apiKey, model);
    endpoint = REPLICATE_ENDPOINT;
    body = { version, input };
  }
  
  const createResponse = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Prefer': 'wait',
    },
    body: JSON.stringify(body),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Replicate prediction failed: ${createResponse.status} - ${errorText}`);
  }

  let prediction = await createResponse.json() as ReplicatePrediction;
  let attempts = 0;
  const maxAttempts = options.maxAttempts ?? 120;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && attempts < maxAttempts) {
    if (pollIntervalMs > 0) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
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
  avatarId: string;
  buffer: Buffer;
  format: AudioFormat;
  mediaBucket: string;
  cdnUrl?: string;
}): Promise<{ assetId: string; url: string }> {
  const assetId = randomUUID();
  const s3Key = `avatars/${params.avatarId}/audio/${assetId}.${params.format}`;

  await getDefaultS3Client().send(new PutObjectCommand({
    Bucket: params.mediaBucket,
    Key: s3Key,
    Body: params.buffer,
    ContentType: formatToContentType(params.format),
    CacheControl: 'max-age=31536000',
  }));

  const url = buildMediaUrl(s3Key, params.mediaBucket, params.cdnUrl);

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
  avatarId: string;
  secrets: Record<string, string>;
  voiceConfig?: { ttsProvider?: 'voice-clone'; format?: AudioFormat; speed?: number; referenceUrl?: string };
  mediaBucket?: string;
  cdnUrl?: string;
  replicatePollIntervalMs?: number;
  // Optional dependency injection for testing
  _deps?: {
    fetch?: FetchFn;
    s3Client?: S3ClientLike;
  };
}) {
  const openAiKey = config.secrets.OPENAI_API_KEY || config.secrets.openai_api_key;
  const replicateKey = config.secrets.REPLICATE_API_TOKEN || config.secrets.REPLICATE_API_KEY || config.secrets.replicate_api_key;
  const telegramToken = config.secrets.TELEGRAM_BOT_TOKEN || config.secrets.telegram_bot_token;

  // Note: _deps available for future DI/testing support but currently unused
  // since helper functions use getDefaultS3Client() directly

  return {
    transcribeAudio: async (params: {
      assetId?: string;
      url?: string;
      platformFileId?: string;
      language?: string;
      model?: string;
      diarize?: boolean;
    }) => {
      // Transcription is optional in runtime handlers. If no provider is configured,
      // return an empty transcript so callers can proceed without hard-failing.
      if (!openAiKey) {
        return { text: '', language: params.language };
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
      avatarId: string;
      text: string;
      voiceId?: string;
      format?: AudioFormat;
      speed?: number;
    }): Promise<{ assetId: string; url: string; durationMs?: number; format: AudioFormat }> => {
      if (!config.mediaBucket) {
        throw new Error('MEDIA_BUCKET not configured');
      }

      const referenceUrl = config.voiceConfig?.referenceUrl;
      const voiceId = params.voiceId;

      if (!replicateKey) {
        throw new Error('Replicate API key not configured');
      }

      if (config.voiceConfig?.ttsProvider !== 'voice-clone' || !VOICE_TTS_MODEL) {
        throw new Error('Voice cloning not enabled');
      }

      const seedUrl = referenceUrl || (isUrl(voiceId) ? voiceId : undefined);
      if (!seedUrl) {
        throw new Error('Voice reference URL not configured');
      }

      const accessibleSeedUrl = await makeUrlAccessible(seedUrl, config.cdnUrl);
      const outputUrl = await runReplicatePrediction(
        replicateKey,
        VOICE_TTS_MODEL,
        {
          text: params.text,
          speaker: accessibleSeedUrl, // XTTS-v2 uses 'speaker' not 'speaker_wav'
          language: 'en',
        },
        { pollIntervalMs: config.replicatePollIntervalMs }
      );

      const audioResponse = await fetchWithTimeout(outputUrl);
      if (!audioResponse.ok) {
        const errorText = await audioResponse.text();
        throw new Error(`Failed to download TTS audio: ${audioResponse.status} - ${errorText}`);
      }

      const buffer = Buffer.from(await audioResponse.arrayBuffer());
      const contentType = audioResponse.headers.get('content-type');
      const detectedFormat = detectAudioFormat(contentType, outputUrl);

      const asset = await uploadAudioAsset({
        avatarId: config.avatarId,
        buffer,
        format: detectedFormat,
        mediaBucket: config.mediaBucket,
        cdnUrl: config.cdnUrl,
      });

      return { assetId: asset.assetId, url: asset.url, durationMs: undefined, format: detectedFormat };
    },

    sendVoiceMessage: async (params: {
      avatarId: string;
      platform: string;
      text: string;
      conversationId?: string;
      voiceId?: string;
      format?: AudioFormat;
      speed?: number;
      replyToMessageId?: string;
    }): Promise<{ success: boolean; assetId?: string; url?: string; sent?: boolean }> => {
      if (!config.mediaBucket) {
        throw new Error('MEDIA_BUCKET not configured');
      }

      // Generate the voice message first
      const referenceUrl = config.voiceConfig?.referenceUrl;
      const voiceId = params.voiceId;

      if (!replicateKey) {
        throw new Error('Replicate API key not configured');
      }

      if (config.voiceConfig?.ttsProvider !== 'voice-clone' || !VOICE_TTS_MODEL) {
        throw new Error('Voice cloning not enabled');
      }

      const seedUrl = referenceUrl || (isUrl(voiceId) ? voiceId : undefined);
      if (!seedUrl) {
        throw new Error('Voice reference URL not configured');
      }

      const accessibleSeedUrl = await makeUrlAccessible(seedUrl, config.cdnUrl);
      const outputUrl = await runReplicatePrediction(
        replicateKey,
        VOICE_TTS_MODEL,
        {
          text: params.text,
          speaker: accessibleSeedUrl, // XTTS-v2 uses 'speaker' not 'speaker_wav'
          language: 'en',
        },
        { pollIntervalMs: config.replicatePollIntervalMs }
      );

      const audioResponse = await fetchWithTimeout(outputUrl);
      if (!audioResponse.ok) {
        const errorText = await audioResponse.text();
        throw new Error(`Failed to download TTS audio: ${audioResponse.status} - ${errorText}`);
      }

      const buffer = Buffer.from(await audioResponse.arrayBuffer());
      const contentType = audioResponse.headers.get('content-type');
      const detectedFormat = detectAudioFormat(contentType, outputUrl);

      const asset = await uploadAudioAsset({
        avatarId: config.avatarId,
        buffer,
        format: detectedFormat,
        mediaBucket: config.mediaBucket,
        cdnUrl: config.cdnUrl,
      });

      const assetId = asset.assetId;
      const url = asset.url;

      const accessibleUrl = await makeUrlAccessible(url, config.cdnUrl);

      // For Telegram, send directly to the chat
      if (params.platform === 'telegram') {
        if (!params.conversationId) {
          throw new Error('conversationId is required for Telegram voice messages');
        }

        if (!telegramToken) {
          throw new Error('TELEGRAM_BOT_TOKEN not configured');
        }

        // Telegram wants OGG/Opus for "voice" notes and often fails to fetch signed/redirecting URLs
        // ("failed to get HTTP URL content").
        // We (1) transcode to OGG/Opus via MediaConvertHandler when available, (2) download ourselves,
        // (3) upload bytes via multipart/form-data.
        let telegramSourceUrl = accessibleUrl;
        if (detectedFormat !== 'ogg') {
          try {
            const converted = await convertAudioToOgg({ avatarId: params.avatarId, sourceUrl: accessibleUrl });
            if (converted) telegramSourceUrl = converted;
          } catch (err) {
            console.warn('[Voice] Media convert failed, falling back to original audio:', err);
          }
        }

        const audioResponse = await fetchWithTimeout(telegramSourceUrl);
        if (!audioResponse.ok) {
          const errorText = await audioResponse.text();
          throw new Error(`Failed to download voice audio for Telegram upload: ${audioResponse.status} - ${errorText}`);
        }

        const buffer = Buffer.from(await audioResponse.arrayBuffer());
        const contentType = audioResponse.headers.get('content-type');
        const uploadType = contentType || 'audio/ogg';
        const fileName = 'voice.ogg';

        const form = new FormData();
        form.append('chat_id', params.conversationId.toString());
        form.append('voice', new Blob([buffer], { type: uploadType }), fileName);
        if (params.replyToMessageId) {
          form.append('reply_to_message_id', Number(params.replyToMessageId).toString());
        }

        const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendVoice`, {
          method: 'POST',
          body: form,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Telegram sendVoice failed: ${response.status} - ${errorText}`);
        }

        return { success: true, assetId, url, sent: true };
      }

      // For web and other platforms, return the audio URL for playback
      return { success: true, assetId, url, sent: false };
    },
  };
}
