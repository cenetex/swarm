import WebSocket from 'ws';
import { Readable } from 'node:stream';
import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterImplementerMethods,
  DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import {
  createSecretsService,
  createStateService,
  logger,
  type AvatarConfig,
} from '@swarm/core';
import { createVoiceServices } from '../services/voice.js';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { INTENT_GUILD_VOICE_STATES } from './discord-voice-control.js';

const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENT_GUILDS = 1 << 0;
const DEFAULT_INTENTS = INTENT_GUILDS | INTENT_GUILD_VOICE_STATES;

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

async function run(): Promise<void> {
  const avatarId = requiredEnv('AVATAR_ID');
  const guildId = requiredEnv('DISCORD_GUILD_ID');
  const voiceChannelId = requiredEnv('DISCORD_VOICE_CHANNEL_ID');
  const sessionSeconds = Number.parseInt(process.env.DISCORD_VOICE_SESSION_SECONDS || '600', 10);
  const sessionTimeoutMs = Math.max(30, Number.isFinite(sessionSeconds) ? sessionSeconds : 600) * 1000;

  logger.setContext({
    subsystem: 'discord-voice',
    service: 'discord-voice-session-worker',
    avatarId,
    guildId,
    voiceChannelId,
  });

  const avatarConfig = await getAvatarConfig(avatarId);
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

  const voice = await import('@discordjs/voice');
  const gateway = new MinimalDiscordGateway(botToken);
  gateway.start();
  await gateway.waitReady();

  const connection = voice.joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator: gateway.adapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 20_000);
    const audioUrl = await buildGreetingAudioUrl(avatarId, avatarConfig, secrets);
    if (audioUrl) {
      const player = voice.createAudioPlayer();
      const stream = await fetchAudioStream(audioUrl);
      const resource = voice.createAudioResource(stream, {
        inputType: voice.StreamType.Arbitrary,
      });
      connection.subscribe(player);
      player.play(resource);
      await voice.entersState(player, voice.AudioPlayerStatus.Idle, Math.min(sessionTimeoutMs, 120_000));
    } else {
      await new Promise(resolve => setTimeout(resolve, Math.min(sessionTimeoutMs, 30_000)));
    }
  } finally {
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
