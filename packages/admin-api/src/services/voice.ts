/**
 * Voice Service
 * Handles transcription, voice profile creation, and TTS generation.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import type { AudioAsset, VoiceProfile } from '../types.js';
import { _getSecretValueInternal } from './secrets.js';
import { syncAgentConfig } from './config-sync.js';
import { getAgent } from './agents.js';
import * as credits from './credits.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3Client = new S3Client({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;
const CDN_URL = process.env.CDN_URL;
const REPLICATE_ENDPOINT = 'https://api.replicate.com/v1/predictions';

// Replicate models for voice generation
// STABLE_AUDIO_MODEL: Used for generating seed audio from text prompts
// Default: suno-ai/bark - text-to-audio model for speech/audio generation
const STABLE_AUDIO_MODEL = process.env.STABLE_AUDIO_MODEL || process.env.VOICE_SEED_MODEL || 'suno-ai/bark';

// VOICE_TTS_MODEL: Used for voice cloning and TTS with a reference audio
// Default: lucataco/xtts-v2 - popular voice cloning model (4.7M runs)
const VOICE_TTS_MODEL = process.env.VOICE_TTS_MODEL || 'lucataco/xtts-v2';

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

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function makeUrlAccessible(url: string): Promise<string> {
  if (!url.includes('.s3.amazonaws.com') && !url.includes('.s3.us-')) {
    return url;
  }

  if (CDN_URL) {
    const parsed = parseS3Key(url);
    if (parsed) {
      return `${CDN_URL}/${parsed.key}`;
    }
    return url;
  }

  const parsed = parseS3Key(url);
  if (!parsed) return url;

  const command = new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

async function getSecret(agentId: string, type: 'openai_api_key' | 'replicate_api_key'): Promise<string | null> {
  const key = await _getSecretValueInternal(agentId, type, 'default');
  if (key) return key;
  return _getSecretValueInternal('GLOBAL', type, 'default');
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
  source: AudioAsset['source'];
  format: AudioFormat;
  durationMs?: number;
}): Promise<AudioAsset> {
  const now = Date.now();
  const assetId = uuid();
  const extension = params.format;
  const s3Key = `agents/${params.agentId}/audio/${assetId}.${extension}`;

  await s3Client.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: s3Key,
    Body: params.buffer,
    ContentType: formatToContentType(params.format),
    CacheControl: 'max-age=31536000',
  }));

  const url = CDN_URL
    ? `${CDN_URL}/${s3Key}`
    : `https://${MEDIA_BUCKET}.s3.amazonaws.com/${s3Key}`;

  const asset: AudioAsset = {
    pk: `AUDIO#${assetId}`,
    sk: 'ASSET',
    assetId,
    agentId: params.agentId,
    source: params.source,
    format: params.format,
    durationMs: params.durationMs,
    url,
    createdAt: now,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: asset,
  }));

  return asset;
}

async function getAudioAsset(assetId: string): Promise<AudioAsset | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AUDIO#${assetId}`, sk: 'ASSET' },
  }));
  return (result.Item as AudioAsset) || null;
}

async function getVoiceProfile(voiceId: string): Promise<VoiceProfile | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `VOICE#${voiceId}`, sk: 'PROFILE' },
  }));
  return (result.Item as VoiceProfile) || null;
}

async function saveVoiceProfile(profile: VoiceProfile): Promise<void> {
  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: profile,
  }));
}

export async function transcribeAudio(params: {
  agentId: string;
  assetId?: string;
  url?: string;
  language?: string;
  model?: string;
  diarize?: boolean;
}): Promise<{ text: string; language?: string; confidence?: number }> {
  const apiKey = await getSecret(params.agentId, 'openai_api_key');
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  let audioUrl = params.url;
  if (!audioUrl && params.assetId) {
    const asset = await getAudioAsset(params.assetId);
    if (!asset) throw new Error(`Audio asset not found: ${params.assetId}`);
    audioUrl = asset.url;
  }

  if (!audioUrl) {
    throw new Error('No audio source provided');
  }

  const accessibleUrl = await makeUrlAccessible(audioUrl);
  const response = await fetchWithTimeout(accessibleUrl);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to download audio: ${response.status} - ${errorText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type');
  const format = detectAudioFormat(contentType, accessibleUrl);
  const filename = `audio.${format}`;

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType || formatToContentType(format) }), filename);
  form.append('model', params.model || 'whisper-1');
  if (params.language) {
    form.append('language', params.language);
  }

  const transcribeResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!transcribeResponse.ok) {
    const errorText = await transcribeResponse.text();
    throw new Error(`OpenAI transcription failed: ${transcribeResponse.status} - ${errorText}`);
  }

  const data = await transcribeResponse.json() as { text: string; language?: string };
  return { text: data.text, language: data.language };
}

export async function createVoiceSeed(params: {
  agentId: string;
  prompt: string;
  durationMs: number;
  styleTags?: string[];
  negativeTags?: string[];
}): Promise<{ assetId: string; url: string; durationMs?: number }> {
  const apiKey = await getSecret(params.agentId, 'replicate_api_key');
  if (!apiKey) {
    throw new Error('Replicate API key not configured');
  }

  const durationSeconds = Math.max(1, Math.round(params.durationMs / 1000));
  const style = params.styleTags?.length ? ` ${params.styleTags.join(', ')}` : '';
  const prompt = `${params.prompt}${style}`.trim();
  const negative = params.negativeTags?.join(', ');

  const outputUrl = await runReplicatePrediction(apiKey, STABLE_AUDIO_MODEL, {
    prompt,
    duration: durationSeconds,
    ...(negative ? { negative_prompt: negative } : {}),
  });

  const audioResponse = await fetchWithTimeout(outputUrl);
  if (!audioResponse.ok) {
    const errorText = await audioResponse.text();
    throw new Error(`Failed to download seed audio: ${audioResponse.status} - ${errorText}`);
  }

  const buffer = Buffer.from(await audioResponse.arrayBuffer());
  const contentType = audioResponse.headers.get('content-type');
  const format = detectAudioFormat(contentType, outputUrl);

  const asset = await uploadAudioAsset({
    agentId: params.agentId,
    buffer,
    source: 'stable-audio',
    format,
    durationMs: params.durationMs,
  });

  return { assetId: asset.assetId, url: asset.url, durationMs: asset.durationMs };
}

export async function cloneVoiceFromSeed(params: {
  agentId: string;
  seedAssetId: string;
  name?: string;
}): Promise<{ voiceId: string; status: 'creating' | 'ready' | 'failed'; previewAssetId?: string }> {
  const now = Date.now();
  const voiceId = uuid();

  const profile: VoiceProfile = {
    pk: `VOICE#${voiceId}`,
    sk: 'PROFILE',
    voiceId,
    agentId: params.agentId,
    status: 'ready',
    provider: 'voice-clone',
    seedAssetId: params.seedAssetId,
    createdAt: now,
    updatedAt: now,
  };

  await saveVoiceProfile(profile);

  return { voiceId, status: 'ready' };
}

export async function createVoiceProfile(params: {
  agentId: string;
  seedPrompt?: string;
  seedAssetId?: string;
  voiceName?: string;
}): Promise<{ voiceId: string; status: 'creating' | 'ready' | 'failed' }> {
  let seedAssetId = params.seedAssetId;
  if (!seedAssetId) {
    if (!params.seedPrompt) {
      throw new Error('seedPrompt or seedAssetId is required');
    }
    const seed = await createVoiceSeed({
      agentId: params.agentId,
      prompt: params.seedPrompt,
      durationMs: 8000,
    });
    seedAssetId = seed.assetId;
  }

  const clone = await cloneVoiceFromSeed({
    agentId: params.agentId,
    seedAssetId,
    name: params.voiceName,
  });

  return { voiceId: clone.voiceId, status: clone.status };
}

/**
 * Check if an agent has a voice configured
 */
export async function hasVoice(agentId: string): Promise<{
  hasVoice: boolean;
  voiceId?: string;
  voiceStyle?: string;
  referenceUrl?: string;
}> {
  const agent = await getAgent(agentId);
  if (!agent) {
    return { hasVoice: false };
  }

  const voiceConfig = agent.voiceConfig;
  if (!voiceConfig?.enabled) {
    return { hasVoice: false };
  }

  const hasVoiceProfile = !!(voiceConfig.defaultVoiceId || voiceConfig.referenceUrl);
  
  return {
    hasVoice: hasVoiceProfile,
    voiceId: voiceConfig.defaultVoiceId,
    voiceStyle: voiceConfig.ttsProvider,
    referenceUrl: voiceConfig.referenceUrl,
  };
}

/**
 * Create a voice for the agent based on a description.
 * 
 * Consolidated Pipeline:
 * 1. Generate a voice seed audio using Stable Audio based on description
 * 2. Clone that audio into a voice profile
 * 3. Set as the agent's active voice for TTS
 * 4. Generate a voice introduction message
 */
export async function createMyVoice(params: {
  agentId: string;
  description: string;
  updatedBy?: string;
}): Promise<{ voiceId: string; message: string; previewUrl?: string; introAssetId?: string; introUrl?: string }> {
  const agent = await getAgent(params.agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${params.agentId}`);
  }

  // Check if already has a voice
  const existing = await hasVoice(params.agentId);
  if (existing.hasVoice) {
    return {
      voiceId: existing.voiceId || 'existing',
      message: 'You already have a voice configured! Use generate_voice_message to speak.',
      previewUrl: existing.referenceUrl,
    };
  }

  // Check energy cost (voice generation costs 1 energy)
  const energyCheck = await credits.canUseEnergy(params.agentId, credits.ENERGY_COSTS.voice);
  if (!energyCheck.allowed) {
    throw new Error(`Not enough energy to create voice. ${energyCheck.reason}`);
  }

  // Build a voice prompt based on the description
  const agentName = agent.name || 'Agent';
  const agentDescription = params.description || agent.description || agent.persona || '';
  
  // Create a prompt for Stable Audio to generate a voice
  const voicePrompt = buildVoicePrompt(agentName, agentDescription);
  
  // Step 1: Generate seed audio using Stable Audio
  let seedAssetId: string;
  let seedUrl: string;
  
  try {
    const seed = await createVoiceSeed({
      agentId: params.agentId,
      prompt: voicePrompt,
      durationMs: 8000, // 8 seconds of audio for voice cloning
      styleTags: ['voice', 'speaking', 'clear'],
      negativeTags: ['music', 'noise', 'static', 'instrumental'],
    });
    seedAssetId = seed.assetId;
    seedUrl = seed.url;
  } catch (err) {
    // If Stable Audio fails, we can still use a fallback
    throw new Error(`Failed to generate voice seed: ${err instanceof Error ? err.message : 'Unknown error'}. Make sure STABLE_AUDIO_MODEL is configured.`);
  }

  // Step 2: Clone the voice from the seed audio
  const clone = await cloneVoiceFromSeed({
    agentId: params.agentId,
    seedAssetId,
    name: `${agentName}'s Voice`,
  });

  // Step 3: Set as active voice profile
  await setActiveVoiceProfile(params.agentId, clone.voiceId, params.updatedBy || 'system');

  // Consume energy after successful creation
  await credits.consumeEnergy(params.agentId, credits.ENERGY_COSTS.voice);

  // Step 4: Generate a voice introduction message
  let introAssetId: string | undefined;
  let introUrl: string | undefined;
  const introText = `Hello! This is ${agentName}. I just got my voice set up and I'm excited to speak with you!`;
  
  try {
    const introMessage = await generateVoiceMessage({
      agentId: params.agentId,
      text: introText,
      format: 'ogg',
    });
    introAssetId = introMessage.assetId;
    introUrl = introMessage.url;
  } catch (err) {
    // Non-fatal - voice was created successfully, intro message failed
    console.warn(`Failed to generate intro message: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  return {
    voiceId: clone.voiceId,
    message: `Voice created successfully! I can now speak using generate_voice_message. My voice was crafted from: "${voicePrompt.substring(0, 100)}..."`,
    previewUrl: seedUrl,
    introAssetId,
    introUrl,
  };
}

/**
 * Build a voice prompt for Stable Audio based on agent characteristics
 */
function buildVoicePrompt(name: string, description: string): string {
  // Extract personality traits from description
  const descLower = description.toLowerCase();
  
  // Detect gender/voice type hints
  let voiceType = 'speaking voice';
  if (descLower.includes('female') || descLower.includes('woman') || descLower.includes('girl') || descLower.includes('she ')) {
    voiceType = 'female speaking voice';
  } else if (descLower.includes('male') || descLower.includes('man') || descLower.includes('boy') || descLower.includes('he ')) {
    voiceType = 'male speaking voice';
  }
  
  // Detect tone hints from the description
  let tone = 'clear and natural';
  if (descLower.includes('playful') || descLower.includes('fun') || descLower.includes('silly')) {
    tone = 'playful and energetic';
  } else if (descLower.includes('serious') || descLower.includes('professional')) {
    tone = 'professional and articulate';
  } else if (descLower.includes('calm') || descLower.includes('gentle') || descLower.includes('soft')) {
    tone = 'calm and soothing';
  } else if (descLower.includes('mysterious') || descLower.includes('enigmatic')) {
    tone = 'mysterious and intriguing';
  } else if (descLower.includes('wise') || descLower.includes('elder')) {
    tone = 'wise and measured';
  } else if (descLower.includes('young') || descLower.includes('youthful')) {
    tone = 'youthful and vibrant';
  }
  
  // Build the prompt
  const prompt = `A ${voiceType}, ${tone}, speaking naturally with personality. The voice of ${name}. Clear vocal tones, expressive speech patterns, conversational delivery.`;
  
  return prompt;
}

export async function setActiveVoiceProfile(
  agentId: string,
  voiceId: string,
  updatedBy: string = 'system'
): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const profile = await getVoiceProfile(voiceId);
  let referenceUrl: string | undefined;
  if (profile?.cloneAssetId || profile?.seedAssetId) {
    const assetId = profile.cloneAssetId || profile.seedAssetId;
    if (assetId) {
      const asset = await getAudioAsset(assetId);
      referenceUrl = asset?.url;
    }
  }

  const updated = {
    ...agent,
    voiceConfig: {
      enabled: true,
      defaultVoiceId: voiceId,
      ttsProvider: agent.voiceConfig?.ttsProvider || 'voice-clone',
      speed: agent.voiceConfig?.speed,
      pitch: agent.voiceConfig?.pitch,
      format: agent.voiceConfig?.format || 'ogg',
      referenceUrl: referenceUrl || agent.voiceConfig?.referenceUrl,
    },
    updatedAt: Date.now(),
    updatedBy,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: updated,
  }));

  await syncAgentConfig(updated);
}

export async function generateVoiceMessage(params: {
  agentId: string;
  text: string;
  voiceId?: string;
  format?: AudioFormat;
  speed?: number;
  pitch?: number;
  emotion?: string;
  maxDurationMs?: number;
}): Promise<{ assetId: string; url: string; durationMs?: number; format?: AudioFormat }> {
  const agent = await getAgent(params.agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${params.agentId}`);
  }

  // Check energy cost (voice message costs 1 energy)
  const energyCheck = await credits.canUseEnergy(params.agentId, credits.ENERGY_COSTS.voice);
  if (!energyCheck.allowed) {
    throw new Error(`Not enough energy to generate voice message. ${energyCheck.reason}`);
  }

  const voiceConfig = agent.voiceConfig;
  const format = params.format || voiceConfig?.format || 'ogg';
  const voiceId = params.voiceId || voiceConfig?.defaultVoiceId;
  const referenceUrl = voiceConfig?.referenceUrl;

  if (voiceConfig?.ttsProvider === 'voice-clone' && VOICE_TTS_MODEL && (voiceId || referenceUrl)) {
    const apiKey = await getSecret(params.agentId, 'replicate_api_key');
    if (!apiKey) {
      throw new Error('Replicate API key not configured');
    }

    let seedUrl = referenceUrl;
    if (!seedUrl && voiceId) {
      const profile = await getVoiceProfile(voiceId);
      const assetId = profile?.cloneAssetId || profile?.seedAssetId;
      if (assetId) {
        const asset = await getAudioAsset(assetId);
        seedUrl = asset?.url;
      }
    }

    if (!seedUrl && voiceId?.startsWith('http')) {
      seedUrl = voiceId;
    }

    if (!seedUrl) {
      throw new Error('Voice reference audio not found');
    }

    const outputUrl = await runReplicatePrediction(apiKey, VOICE_TTS_MODEL, {
      text: params.text,
      speaker_wav: await makeUrlAccessible(seedUrl),
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
      agentId: params.agentId,
      buffer,
      source: 'tts',
      format: detectedFormat,
    });

    // Consume energy after successful generation
    await credits.consumeEnergy(params.agentId, credits.ENERGY_COSTS.voice);

    return { assetId: asset.assetId, url: asset.url, format: detectedFormat };
  }

  const apiKey = await getSecret(params.agentId, 'openai_api_key');
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const voice = voiceId && !voiceId.startsWith('http') ? voiceId : OPENAI_TTS_VOICE;
  const responseFormat = format === 'ogg' ? 'opus' : format;

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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
    agentId: params.agentId,
    buffer,
    source: 'tts',
    format,
  });

  // Consume energy after successful generation
  await credits.consumeEnergy(params.agentId, credits.ENERGY_COSTS.voice);

  return { assetId: asset.assetId, url: asset.url, format };
}

export async function sendVoiceMessage(params: {
  agentId: string;
  platform: string;
  conversationId: string;
  assetId?: string;
  url?: string;
  caption?: string;
  replyToMessageId?: string;
}): Promise<{ success: boolean }> {
  if (params.platform !== 'telegram') {
    throw new Error(`Voice messaging not supported for platform: ${params.platform}`);
  }

  let voiceUrl = params.url;
  if (!voiceUrl && params.assetId) {
    const asset = await getAudioAsset(params.assetId);
    if (!asset) throw new Error(`Audio asset not found: ${params.assetId}`);
    voiceUrl = await makeUrlAccessible(asset.url);
  }

  if (!voiceUrl) {
    throw new Error('No voice URL provided');
  }

  const botToken = await _getSecretValueInternal(params.agentId, 'telegram_bot_token', 'default');
  if (!botToken) {
    throw new Error('Telegram bot token not configured');
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
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
}
