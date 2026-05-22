import { describe, it, expect } from 'bun:test';
import type { ECSClient } from '@aws-sdk/client-ecs';
import type { AvatarConfig, DiscordMessage } from '@swarm/core';
import { DiscordVoiceTaskLauncher } from './discord-voice-task-launcher.js';

function makeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DISCORD_VOICE_WORKER_ENABLED: 'true',
    DISCORD_VOICE_WORKER_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123:cluster/swarm',
    DISCORD_VOICE_WORKER_TASK_DEFINITION_ARN: 'arn:aws:ecs:us-east-1:123:task-definition/voice:1',
    DISCORD_VOICE_WORKER_SUBNET_IDS: 'subnet-a,subnet-b',
    DISCORD_VOICE_WORKER_SECURITY_GROUP_IDS: 'sg-voice',
    DISCORD_VOICE_WORKER_CONTAINER_NAME: 'DiscordVoiceWorker',
    STATE_TABLE: 'StateTable',
    ADMIN_TABLE: 'AdminTable',
    MEDIA_BUCKET: 'media-bucket',
    CDN_URL: 'https://cdn.example.com',
    SECRET_PREFIX: 'swarm-test',
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

function makeAvatarConfig(): AvatarConfig {
  return {
    id: 'avatar-1',
    name: 'Test Avatar',
    version: '1',
    persona: 'test',
    platforms: {
      discord: {
        enabled: true,
        mode: 'bot',
        voice: { enabled: true, autoJoinOnMention: true },
      },
    },
    llm: { provider: 'openrouter', model: 'test', temperature: 0.7, maxTokens: 1000 },
    media: { image: { provider: 'openrouter', model: 'test' } },
    scheduling: {},
    behavior: {
      responseDelayMs: [0, 0],
      typingIndicator: false,
      ignoreBots: true,
      cooldownMinutes: 0,
      maxContextMessages: 10,
    },
    tools: [],
    secrets: [],
  } as AvatarConfig;
}

function makeMessage(): DiscordMessage {
  return {
    id: 'msg-1',
    channel_id: 'text-1',
    guild_id: 'guild-1',
    author: {
      id: 'user-1',
      username: 'alice',
    },
    content: '<@bot-1> join',
    timestamp: new Date(0).toISOString(),
    tts: false,
    mention_everyone: false,
    mentions: [{ id: 'bot-1', username: 'Bot' }],
    attachments: [],
    embeds: [],
    type: 0,
  };
}

function makeRequest() {
  return {
    avatarId: 'avatar-1',
    avatarConfig: makeAvatarConfig(),
    botUserId: 'bot-1',
    message: makeMessage(),
    decision: {
      shouldLaunch: true as const,
      reason: 'ready' as const,
      voiceChannelId: 'voice-1',
      maxSessionSeconds: 90,
    },
  };
}

class CapturingEcsClient {
  commands: Array<{ input: Record<string, unknown> }> = [];

  async send(command: { input: Record<string, unknown> }) {
    this.commands.push(command);
    return { tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123:task/voice/abc' }] };
  }
}

describe('DiscordVoiceTaskLauncher', () => {
  it('does not launch when the worker is disabled', async () => {
    const ecs = new CapturingEcsClient();
    const launcher = new DiscordVoiceTaskLauncher(
      makeEnv({ DISCORD_VOICE_WORKER_ENABLED: 'false' }),
      ecs as unknown as ECSClient,
    );

    const result = await launcher.launch(makeRequest());

    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(ecs.commands).toHaveLength(0);
  });

  it('does not launch without complete ECS config', async () => {
    const ecs = new CapturingEcsClient();
    const launcher = new DiscordVoiceTaskLauncher(
      makeEnv({ DISCORD_VOICE_WORKER_TASK_DEFINITION_ARN: undefined }),
      ecs as unknown as ECSClient,
    );

    const result = await launcher.launch(makeRequest());

    expect(result.launched).toBe(false);
    expect(result.reason).toBe('missing_config');
    expect(ecs.commands).toHaveLength(0);
  });

  it('builds an ECS Fargate RunTask request with the session context', async () => {
    const ecs = new CapturingEcsClient();
    const launcher = new DiscordVoiceTaskLauncher(makeEnv(), ecs as unknown as ECSClient);

    const result = await launcher.launch(makeRequest());

    expect(result).toEqual({
      launched: true,
      reason: 'started',
      taskArn: 'arn:aws:ecs:us-east-1:123:task/voice/abc',
    });
    expect(ecs.commands).toHaveLength(1);

    const input = ecs.commands[0].input as {
      launchType: string;
      networkConfiguration?: {
        awsvpcConfiguration?: {
          subnets?: string[];
          securityGroups?: string[];
          assignPublicIp?: string;
        };
      };
      overrides?: {
        containerOverrides?: Array<{
          name?: string;
          environment?: Array<{ name: string; value: string }>;
        }>;
      };
    };

    expect(input.launchType).toBe('FARGATE');
    expect(input.networkConfiguration?.awsvpcConfiguration).toEqual({
      subnets: ['subnet-a', 'subnet-b'],
      securityGroups: ['sg-voice'],
      assignPublicIp: 'ENABLED',
    });

    const container = input.overrides?.containerOverrides?.[0];
    expect(container?.name).toBe('DiscordVoiceWorker');
    const env = Object.fromEntries(
      (container?.environment || []).map(({ name, value }) => [name, value]),
    );
    expect(env).toMatchObject({
      AVATAR_ID: 'avatar-1',
      DISCORD_BOT_USER_ID: 'bot-1',
      DISCORD_GUILD_ID: 'guild-1',
      DISCORD_TEXT_CHANNEL_ID: 'text-1',
      DISCORD_VOICE_CHANNEL_ID: 'voice-1',
      DISCORD_TRIGGER_MESSAGE_ID: 'msg-1',
      DISCORD_TRIGGER_USER_ID: 'user-1',
      DISCORD_VOICE_SESSION_SECONDS: '90',
      STATE_TABLE: 'StateTable',
      ADMIN_TABLE: 'AdminTable',
      MEDIA_BUCKET: 'media-bucket',
      CDN_URL: 'https://cdn.example.com',
      SECRET_PREFIX: 'swarm-test',
      ENVIRONMENT: 'test',
    });
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  it('deduplicates repeated launches for the same avatar and voice channel', async () => {
    const ecs = new CapturingEcsClient();
    const launcher = new DiscordVoiceTaskLauncher(makeEnv(), ecs as unknown as ECSClient);

    await launcher.launch(makeRequest());
    const duplicate = await launcher.launch(makeRequest());

    expect(duplicate).toEqual({ launched: false, reason: 'duplicate_recent_session' });
    expect(ecs.commands).toHaveLength(1);
  });
});
