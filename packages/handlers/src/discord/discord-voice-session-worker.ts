import WebSocket from 'ws';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterImplementerMethods,
  DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import {
  createSecretsService,
  createPresenceService,
  createStateService,
  logger,
  type AvatarConfig,
  type SwarmEnvelope,
} from '@swarm/core';
import { createVoiceServices } from '../services/voice.js';
import { callLLM, stripAvatarNamePrefix, type LLMMessage } from '../messaging/llm-client.js';
import { buildSystemPrompt } from '../messaging/context-builder.js';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { INTENT_GUILD_VOICE_STATES } from './discord-voice-control.js';

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENT_GUILDS = 1 << 0;
const DEFAULT_INTENTS = INTENT_GUILDS | INTENT_GUILD_VOICE_STATES;
const require = createRequire(import.meta.url);

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string;
}

interface GatewayHello {
  heartbeat_interval: number;
}

interface GatewayReady {
  user: { id: string; username: string };
}

class MinimalDiscordGateway {
  private ws: WebSocket | null = null;
  private sequence: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private adapterMethods: DiscordGatewayAdapterLibraryMethods | null = null;
  private readyResolve?: () => void;
  private readyReject?: (err: Error) => void;
  private botUserId?: string;

  constructor(private readonly botToken: string) {}

  readonly adapterCreator: DiscordGatewayAdapterCreator = (
    methods: DiscordGatewayAdapterLibraryMethods,
  ): DiscordGatewayAdapterImplementerMethods => {
    this.adapterMethods = methods;
    return {
      sendPayload: (payload: unknown) => {
        this.send(payload as GatewayPayload);
        return true;
      },
      destroy: () => {
        if (this.adapterMethods === methods) {
          this.adapterMethods = null;
        }
      },
    };
  };

  start(): void {
    this.ws = new WebSocket(DEFAULT_GATEWAY_URL);

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(data.toString()) as GatewayPayload;
        if (typeof payload.s === 'number') {
          this.sequence = payload.s;
        }
        this.handlePayload(payload);
      } catch (err) {
        this.readyReject?.(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.ws.on('error', (err) => {
      this.readyReject?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  waitReady(timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Discord voice worker gateway READY timeout'));
      }, timeoutMs);
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.adapterMethods?.destroy();
    this.adapterMethods = null;
    this.ws?.removeAllListeners();
    this.ws?.close(1000, 'voice session complete');
    this.ws = null;
  }

  getBotUserId(): string | undefined {
    return this.botUserId;
  }

  private handlePayload(payload: GatewayPayload): void {
    if (payload.op === 10) {
      const hello = payload.d as GatewayHello;
      this.heartbeatTimer = setInterval(
        () => this.send({ op: 1, d: this.sequence }),
        hello.heartbeat_interval,
      );
      this.send({ op: 1, d: this.sequence });
      this.identify();
      return;
    }

    if (payload.op !== 0 || !payload.t) return;

    if (payload.t === 'READY') {
      const ready = payload.d as GatewayReady;
      this.botUserId = ready.user.id;
      this.readyResolve?.();
      return;
    }

    if (payload.t === 'VOICE_SERVER_UPDATE') {
      this.adapterMethods?.onVoiceServerUpdate(
        payload.d as Parameters<DiscordGatewayAdapterLibraryMethods['onVoiceServerUpdate']>[0],
      );
      return;
    }

    if (payload.t === 'VOICE_STATE_UPDATE') {
      const update = payload.d as { user_id?: string };
      if (!this.botUserId || update.user_id === this.botUserId) {
        this.adapterMethods?.onVoiceStateUpdate(
          payload.d as Parameters<DiscordGatewayAdapterLibraryMethods['onVoiceStateUpdate']>[0],
        );
      }
    }
  }

  private identify(): void {
    this.send({
      op: 2,
      d: {
        token: this.botToken,
        intents: DEFAULT_INTENTS,
        properties: {
          os: process.platform,
          browser: 'swarm-voice',
          device: 'swarm-voice',
        },
      },
    });
  }

  private send(payload: GatewayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}

async function getAvatarConfig(avatarId: string): Promise<AvatarConfig> {
  const table = process.env.STATE_TABLE;
  if (!table) throw new Error('STATE_TABLE is required');
  const stateService = createStateService(table);
  const result = await stateService.getAvatarConfigWithStatus(avatarId);
  if (!result || result.status !== 'active') {
    throw new Error(`Avatar is not active or not found: ${avatarId}`);
  }
  return result.config;
}

async function buildGreetingAudioUrl(
  avatarId: string,
  avatarConfig: AvatarConfig,
  secrets: Record<string, string>,
): Promise<string | undefined> {
  if (process.env.DISCORD_VOICE_GREETING_AUDIO_URL) {
    return process.env.DISCORD_VOICE_GREETING_AUDIO_URL;
  }

  if (!process.env.MEDIA_BUCKET) {
    logger.warn('Discord voice worker has no MEDIA_BUCKET; joining without spoken greeting', {
      event: 'discord_voice_no_media_bucket',
      subsystem: 'discord-voice',
      avatarId,
    });
    return undefined;
  }

  const voiceServices = createVoiceServices({
    avatarId,
    secrets,
    voiceConfig: avatarConfig.voice,
    mediaBucket: process.env.MEDIA_BUCKET,
    cdnUrl: process.env.CDN_URL,
  });

  const text = process.env.DISCORD_VOICE_GREETING_TEXT
    || `${avatarConfig.name} is here in voice.`;
  const generated = await voiceServices.generateVoiceMessage({
    avatarId,
    text,
    format: 'ogg',
  });
  return generated.url;
}

async function fetchAudioStream(url: string): Promise<Readable> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Failed to fetch voice audio: ${response.status} ${text.slice(0, 200)}`);
  }
  return Readable.from(Buffer.from(await response.arrayBuffer()));
}

export function sanitizeDiscordVoiceTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function sanitizeDiscordVoiceReply(text: string, avatarName: string): string {
  return stripAvatarNamePrefix(text.replace(/\s+/g, ' ').trim(), avatarName).slice(0, 700);
}

export function shouldHandleVoiceSpeaker(userId: string, botUserId?: string): boolean {
  return Boolean(userId) && userId !== botUserId;
}

export function isDiscordVoiceBargeInEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function shouldStartVoiceTurn(params: {
  userId: string;
  botUserId?: string;
  stopped: boolean;
  isPlaying: boolean;
  bargeInEnabled: boolean;
  isActiveSpeaker: boolean;
}): boolean {
  if (params.stopped || params.isActiveSpeaker) return false;
  if (!shouldHandleVoiceSpeaker(params.userId, params.botUserId)) return false;
  return !params.isPlaying || params.bargeInEnabled;
}

async function collectDiscordOggTurn(params: {
  opusStream: Readable;
  maxBytes: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const prism = require('prism-media') as {
    opus: {
      OggLogicalBitstream: new (options: unknown) => NodeJS.WritableStream;
      OpusHead: new (options: unknown) => unknown;
    };
  };
  const oggBitstream = new prism.opus.OggLogicalBitstream({
    opusHead: new prism.opus.OpusHead({
      channelCount: 2,
      sampleRate: 48_000,
    }),
    pageSizeControl: {
      maxPackets: 10,
    },
  }) as unknown as NodeJS.WritableStream;
  const oggStream = params.opusStream.pipe(oggBitstream) as unknown as NodeJS.ReadableStream;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish();
    }, params.timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      oggStream.removeAllListeners();
      params.opusStream.removeAllListeners();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    oggStream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > params.maxBytes) {
        finish();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    oggStream.on('end', finish);
    oggStream.on('close', finish);
    oggStream.on('error', fail);
    params.opusStream.on('error', fail);
  });
}

async function transcribeDiscordVoiceTurn(params: {
  audio: Buffer;
  secrets: Record<string, string>;
  language?: string;
}): Promise<string> {
  const openAiKey = params.secrets.OPENAI_API_KEY || params.secrets.openai_api_key;
  if (!openAiKey || params.audio.length === 0) return '';

  const form = new FormData();
  form.append('file', new Blob([params.audio], { type: 'audio/ogg' }), 'discord-voice.ogg');
  form.append('model', process.env.DISCORD_VOICE_TRANSCRIBE_MODEL || 'whisper-1');
  if (params.language) form.append('language', params.language);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiKey}`,
    },
    body: form,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI transcription failed: ${response.status} ${text.slice(0, 200)}`);
  }

  const data = await response.json() as { text?: string };
  return sanitizeDiscordVoiceTranscript(data.text || '');
}

function buildDiscordVoiceEnvelope(params: {
  avatarId: string;
  guildId: string;
  voiceChannelId: string;
  speakerUserId: string;
  transcript: string;
}): SwarmEnvelope {
  const now = Date.now();
  return {
    avatarId: params.avatarId,
    platform: 'discord',
    traceId: `discord-voice-${randomUUID()}`,
    messageId: `discord-voice-${now}-${params.speakerUserId}`,
    conversationId: params.voiceChannelId,
    timestamp: now,
    sender: {
      id: params.speakerUserId,
      username: params.speakerUserId,
      displayName: params.speakerUserId,
      isBot: false,
      platform: 'discord',
      platformUserId: params.speakerUserId,
    },
    content: { text: params.transcript },
    mentions: [],
    raw: {
      guildId: params.guildId,
      voiceChannelId: params.voiceChannelId,
      source: 'discord_voice',
    },
    metadata: {
      receivedAt: now,
      priority: 'high',
      idempotencyKey: `discord-voice-${params.voiceChannelId}-${params.speakerUserId}-${now}`,
      isMention: true,
      shouldRespond: true,
      responseReason: 'discord_voice_turn',
    },
  };
}

async function generateDiscordVoiceReply(params: {
  avatarId: string;
  guildId: string;
  voiceChannelId: string;
  speakerUserId: string;
  transcript: string;
  avatarConfig: AvatarConfig;
  secrets: Record<string, string>;
  stateService: ReturnType<typeof createStateService>;
}): Promise<string | undefined> {
  const presenceService = createPresenceService(process.env.STATE_TABLE || '');
  const envelope = buildDiscordVoiceEnvelope(params);
  const systemPrompt = await buildSystemPrompt(
    envelope,
    params.avatarConfig,
    params.avatarId,
    params.secrets,
    presenceService,
    params.stateService,
    { fastResponseMode: true },
  );
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `${systemPrompt}\n\nYou are speaking live in a Discord voice channel. Reply conversationally in one or two short spoken sentences. Do not describe actions or mention transcription.`,
    },
    {
      role: 'user',
      content: `[Discord voice from ${params.speakerUserId}]: ${params.transcript}`,
    },
  ];

  const llmResponse = await callLLM(messages, [], params.avatarConfig.llm, params.secrets);
  const reply = sanitizeDiscordVoiceReply(llmResponse.content || '', params.avatarConfig.name);
  return reply || undefined;
}

async function playDiscordVoiceUrl(params: {
  voice: typeof import('@discordjs/voice');
  connection: import('@discordjs/voice').VoiceConnection;
  audioUrl: string;
  timeoutMs: number;
  onPlayer?: (player: import('@discordjs/voice').AudioPlayer) => void;
}): Promise<{ playbackMs: number }> {
  const startedAt = Date.now();
  const player = params.voice.createAudioPlayer();
  params.onPlayer?.(player);
  const stream = await fetchAudioStream(params.audioUrl);
  const resource = params.voice.createAudioResource(stream, {
    inputType: params.voice.StreamType.Arbitrary,
  });
  params.connection.subscribe(player);
  player.play(resource);
  await params.voice.entersState(
    player,
    params.voice.AudioPlayerStatus.Idle,
    params.timeoutMs,
  );
  return { playbackMs: Date.now() - startedAt };
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function observeVoiceConnection(params: {
  connection: import('@discordjs/voice').VoiceConnection;
  voice: typeof import('@discordjs/voice');
  avatarId: string;
  guildId: string;
  voiceChannelId: string;
  attempt: number;
}): () => void {
  const onStateChange = (
    oldState: import('@discordjs/voice').VoiceConnectionState,
    newState: import('@discordjs/voice').VoiceConnectionState,
  ) => {
    logger.info('Discord voice connection state changed', {
      event: 'discord_voice_connection_state_changed',
      subsystem: 'discord-voice',
      avatarId: params.avatarId,
      guildId: params.guildId,
      voiceChannelId: params.voiceChannelId,
      attempt: params.attempt,
      oldStatus: oldState.status,
      newStatus: newState.status,
    });
  };
  const onError = (err: Error) => {
    logger.warn('Discord voice connection emitted error', {
      event: 'discord_voice_connection_error',
      subsystem: 'discord-voice',
      avatarId: params.avatarId,
      guildId: params.guildId,
      voiceChannelId: params.voiceChannelId,
      attempt: params.attempt,
      errorName: err.name,
      errorMessage: err.message,
    });
  };

  params.connection.on('stateChange', onStateChange);
  params.connection.on('error', onError);
  return () => {
    params.connection.off('stateChange', onStateChange);
    params.connection.off('error', onError);
  };
}

async function joinDiscordVoiceWithRetry(params: {
  voice: typeof import('@discordjs/voice');
  gateway: MinimalDiscordGateway;
  avatarId: string;
  guildId: string;
  voiceChannelId: string;
  timeoutMs: number;
  attempts: number;
}): Promise<{
  connection: import('@discordjs/voice').VoiceConnection;
  stopObserving: () => void;
}> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    const connection = params.voice.joinVoiceChannel({
      channelId: params.voiceChannelId,
      guildId: params.guildId,
      adapterCreator: params.gateway.adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    const stopObserving = observeVoiceConnection({
      connection,
      voice: params.voice,
      avatarId: params.avatarId,
      guildId: params.guildId,
      voiceChannelId: params.voiceChannelId,
      attempt,
    });

    try {
      await params.voice.entersState(
        connection,
        params.voice.VoiceConnectionStatus.Ready,
        params.timeoutMs,
      );
      logger.info('Discord voice connection ready', {
        event: 'discord_voice_connection_ready',
        subsystem: 'discord-voice',
        avatarId: params.avatarId,
        guildId: params.guildId,
        voiceChannelId: params.voiceChannelId,
        attempt,
      });
      return { connection, stopObserving };
    } catch (err) {
      lastError = err;
      logger.warn('Discord voice connection did not become ready', {
        event: 'discord_voice_connection_ready_timeout',
        subsystem: 'discord-voice',
        avatarId: params.avatarId,
        guildId: params.guildId,
        voiceChannelId: params.voiceChannelId,
        attempt,
        attempts: params.attempts,
        timeoutMs: params.timeoutMs,
        status: connection.state.status,
        errorName: err instanceof Error ? err.name : undefined,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      stopObserving();
      connection.destroy();
      if (attempt < params.attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(lastError ? String(lastError) : 'Discord voice connection failed');
}

async function run(): Promise<void> {
  const avatarId = requiredEnv('AVATAR_ID');
  const guildId = requiredEnv('DISCORD_GUILD_ID');
  const voiceChannelId = requiredEnv('DISCORD_VOICE_CHANNEL_ID');
  const sessionSeconds = Number.parseInt(process.env.DISCORD_VOICE_SESSION_SECONDS || '600', 10);
  const sessionTimeoutMs = Math.max(30, Number.isFinite(sessionSeconds) ? sessionSeconds : 600) * 1000;
  const idleSeconds = Number.parseInt(process.env.DISCORD_VOICE_IDLE_SECONDS || '90', 10);
  const idleTimeoutMs = Math.max(30, Number.isFinite(idleSeconds) ? idleSeconds : 90) * 1000;
  const turnSilenceMs = Math.max(400, Number.parseInt(process.env.DISCORD_VOICE_TURN_SILENCE_MS || '1200', 10));
  const maxTurnMs = Math.max(2_000, Number.parseInt(process.env.DISCORD_VOICE_MAX_TURN_MS || '12000', 10));
  const maxTurnBytes = Math.max(32_000, Number.parseInt(process.env.DISCORD_VOICE_MAX_TURN_BYTES || '2000000', 10));
  const bargeInEnabled = isDiscordVoiceBargeInEnabled(process.env.DISCORD_VOICE_BARGE_IN_ENABLED);
  const readyTimeoutMs = parsePositiveIntEnv('DISCORD_VOICE_READY_TIMEOUT_MS', 60_000);
  const readyAttempts = parsePositiveIntEnv('DISCORD_VOICE_READY_ATTEMPTS', 2);

  logger.setContext({
    subsystem: 'discord-voice',
    service: 'discord-voice-session-worker',
    avatarId,
    guildId,
    voiceChannelId,
  });

  const avatarConfig = await getAvatarConfig(avatarId);
  const stateService = createStateService(requiredEnv('STATE_TABLE'));
  const secretsService = createSecretsService();
  const secrets = await loadAvatarSecrets(
    secretsService,
    avatarId,
    process.env.SECRET_PREFIX || 'swarm',
  );
  const botToken = secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token;
  if (!botToken) {
    throw new Error(`Discord bot token not configured for avatar ${avatarId}`);
  }
  const voiceServices = createVoiceServices({
    avatarId,
    secrets,
    voiceConfig: avatarConfig.voice,
    mediaBucket: process.env.MEDIA_BUCKET,
    cdnUrl: process.env.CDN_URL,
  });

  const voice = await import('@discordjs/voice');
  const gateway = new MinimalDiscordGateway(botToken);
  gateway.start();
  await gateway.waitReady();

  const { connection, stopObserving } = await joinDiscordVoiceWithRetry({
    voice,
    gateway,
    avatarId,
    guildId,
    voiceChannelId,
    timeoutMs: readyTimeoutMs,
    attempts: readyAttempts,
  });

  try {
    const audioUrl = await buildGreetingAudioUrl(avatarId, avatarConfig, secrets);
    if (audioUrl) {
      await playDiscordVoiceUrl({
        voice,
        connection,
        audioUrl,
        timeoutMs: Math.min(sessionTimeoutMs, 120_000),
      });
    }

    let lastActivityAt = Date.now();
    let stopped = false;
    let isPlaying = false;
    let interruptedPlaybackCount = 0;
    let currentPlayer: import('@discordjs/voice').AudioPlayer | undefined;
    const activeSpeakers = new Set<string>();
    const stop = () => { stopped = true; };
    const sessionTimer = setTimeout(stop, sessionTimeoutMs);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivityAt > idleTimeoutMs) stop();
    }, Math.min(10_000, idleTimeoutMs));

    connection.receiver.speaking.on('start', (userId) => {
      if (!shouldStartVoiceTurn({
        userId,
        botUserId: gateway.getBotUserId(),
        stopped,
        isPlaying,
        bargeInEnabled,
        isActiveSpeaker: activeSpeakers.has(userId),
      })) {
        return;
      }
      if (isPlaying && bargeInEnabled && currentPlayer) {
        interruptedPlaybackCount += 1;
        logger.info('Discord voice playback interrupted by speaker', {
          event: 'discord_voice_playback_interrupted',
          subsystem: 'discord-voice',
          avatarId,
          speakerUserId: userId,
          interruptedPlaybackCount,
        });
        currentPlayer.stop(true);
      }
      activeSpeakers.add(userId);
      const opusStream = connection.receiver.subscribe(userId, {
        end: {
          behavior: voice.EndBehaviorType.AfterSilence,
          duration: turnSilenceMs,
        },
      });

      void (async () => {
        const turnStartedAt = Date.now();
        let captureMs = 0;
        let transcriptionMs = 0;
        let llmMs = 0;
        let voiceGenerationMs = 0;
        let playbackMs = 0;
        let wasInterrupted = false;
        try {
          const captureStartedAt = Date.now();
          const audio = await collectDiscordOggTurn({
            opusStream: opusStream as unknown as Readable,
            maxBytes: maxTurnBytes,
            timeoutMs: maxTurnMs,
          });
          captureMs = Date.now() - captureStartedAt;

          const transcriptionStartedAt = Date.now();
          const transcript = await transcribeDiscordVoiceTurn({ audio, secrets });
          transcriptionMs = Date.now() - transcriptionStartedAt;
          if (!transcript) return;
          lastActivityAt = Date.now();
          logger.info('Discord voice turn transcribed', {
            event: 'discord_voice_turn_transcribed',
            subsystem: 'discord-voice',
            avatarId,
            speakerUserId: userId,
            transcriptLength: transcript.length,
            audioBytes: audio.length,
            captureMs,
            transcriptionMs,
          });

          const llmStartedAt = Date.now();
          const reply = await generateDiscordVoiceReply({
            avatarId,
            guildId,
            voiceChannelId,
            speakerUserId: userId,
            transcript,
            avatarConfig,
            secrets,
            stateService,
          });
          llmMs = Date.now() - llmStartedAt;
          if (!reply) return;

          isPlaying = true;
          try {
            const voiceGenerationStartedAt = Date.now();
            const generated = await voiceServices.generateVoiceMessage({
              avatarId,
              text: reply,
              format: 'ogg',
            });
            voiceGenerationMs = Date.now() - voiceGenerationStartedAt;
            const playbackStartedWithInterrupts = interruptedPlaybackCount;
            const playback = await playDiscordVoiceUrl({
              voice,
              connection,
              audioUrl: generated.url,
              timeoutMs: Math.min(sessionTimeoutMs, 120_000),
              onPlayer: (player) => {
                currentPlayer = player;
              },
            });
            playbackMs = playback.playbackMs;
            wasInterrupted = interruptedPlaybackCount > playbackStartedWithInterrupts;
            lastActivityAt = Date.now();
          } finally {
            isPlaying = false;
            currentPlayer = undefined;
          }
          logger.info('Discord voice turn completed', {
            event: 'discord_voice_turn_completed',
            subsystem: 'discord-voice',
            avatarId,
            speakerUserId: userId,
            transcriptLength: transcript.length,
            replyLength: reply.length,
            audioBytes: audio.length,
            captureMs,
            transcriptionMs,
            llmMs,
            voiceGenerationMs,
            playbackMs,
            totalTurnMs: Date.now() - turnStartedAt,
            bargeInEnabled,
            interrupted: wasInterrupted,
          });
        } catch (err) {
          logger.warn('Discord voice turn failed', {
            event: 'discord_voice_turn_failed',
            subsystem: 'discord-voice',
            avatarId,
            speakerUserId: userId,
            error: err instanceof Error ? err.message : String(err),
            captureMs,
            transcriptionMs,
            llmMs,
            voiceGenerationMs,
            playbackMs,
            totalTurnMs: Date.now() - turnStartedAt,
          });
        } finally {
          activeSpeakers.delete(userId);
        }
      })();
    });

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!stopped) return;
        clearInterval(interval);
        clearTimeout(sessionTimer);
        clearInterval(idleTimer);
        resolve();
      }, 500);
    });
  } finally {
    stopObserving();
    connection.destroy();
    gateway.stop();
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const isDirectExecution = process.argv[1]?.endsWith('discord-voice-session-worker.js');
if (isDirectExecution) {
  run().catch((err) => {
    logger.error('Discord voice session worker failed', err, {
      event: 'discord_voice_worker_failed',
      subsystem: 'discord-voice',
    });
    process.exit(1);
  });
}

export { run, MinimalDiscordGateway };
