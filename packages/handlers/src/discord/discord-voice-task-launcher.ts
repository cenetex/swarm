import {
  ECSClient,
  RunTaskCommand,
  type RunTaskCommandInput,
} from '@aws-sdk/client-ecs';
import { logger, type AvatarConfig, type DiscordMessage } from '@swarm/core';
import type { DiscordVoiceLaunchDecision } from './discord-voice-control.js';

export interface DiscordVoiceTaskRequest {
  avatarId: string;
  avatarConfig: AvatarConfig;
  botUserId?: string;
  message: DiscordMessage;
  decision: Extract<DiscordVoiceLaunchDecision, { shouldLaunch: true }>;
}

export interface DiscordVoiceTaskLaunchResult {
  launched: boolean;
  reason:
    | 'started'
    | 'disabled'
    | 'missing_config'
    | 'duplicate_recent_session'
    | 'ecs_error';
  taskArn?: string;
  detail?: string;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_SESSION_DEDUP_MS = 30_000;

export class DiscordVoiceTaskLauncher {
  private readonly recentLaunches = new Map<string, number>();

  constructor(
    private readonly env: EnvLike = process.env,
    private readonly ecsClient: ECSClient = new ECSClient({}),
  ) {}

  async launch(request: DiscordVoiceTaskRequest): Promise<DiscordVoiceTaskLaunchResult> {
    if (this.env.DISCORD_VOICE_WORKER_ENABLED !== 'true') {
      return { launched: false, reason: 'disabled' };
    }

    const config = this.getConfig();
    if (!config) {
      return {
        launched: false,
        reason: 'missing_config',
        detail: 'Discord voice worker ECS config is incomplete',
      };
    }

    const dedupKey = [
      request.avatarId,
      request.message.guild_id,
      request.decision.voiceChannelId,
    ].join(':');
    const now = Date.now();
    const lastLaunch = this.recentLaunches.get(dedupKey);
    if (lastLaunch && now - lastLaunch < DEFAULT_SESSION_DEDUP_MS) {
      return { launched: false, reason: 'duplicate_recent_session' };
    }

    const input = this.buildRunTaskInput(config, request);

    try {
      const result = await this.ecsClient.send(new RunTaskCommand(input));
      const failure = result.failures?.[0];
      if (failure) {
        return {
          launched: false,
          reason: 'ecs_error',
          detail: `${failure.arn || 'task'}: ${failure.reason || 'unknown failure'}`,
        };
      }

      const taskArn = result.tasks?.[0]?.taskArn;
      this.recentLaunches.set(dedupKey, now);
      return { launched: true, reason: 'started', taskArn };
    } catch (err) {
      logger.error('Failed to launch Discord voice worker task', err, {
        event: 'discord_voice_worker_launch_failed',
        subsystem: 'discord-voice',
        avatarId: request.avatarId,
        guildId: request.message.guild_id,
        voiceChannelId: request.decision.voiceChannelId,
      });
      return {
        launched: false,
        reason: 'ecs_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getConfig(): {
    clusterArn: string;
    taskDefinitionArn: string;
    subnetIds: string[];
    securityGroupIds: string[];
    containerName: string;
  } | null {
    const clusterArn = this.env.DISCORD_VOICE_WORKER_CLUSTER_ARN;
    const taskDefinitionArn = this.env.DISCORD_VOICE_WORKER_TASK_DEFINITION_ARN;
    const subnetIds = splitCsv(this.env.DISCORD_VOICE_WORKER_SUBNET_IDS);
    if (!clusterArn || !taskDefinitionArn || subnetIds.length === 0) {
      return null;
    }

    return {
      clusterArn,
      taskDefinitionArn,
      subnetIds,
      securityGroupIds: splitCsv(this.env.DISCORD_VOICE_WORKER_SECURITY_GROUP_IDS),
      containerName: this.env.DISCORD_VOICE_WORKER_CONTAINER_NAME || 'DiscordVoiceWorker',
    };
  }

  private buildRunTaskInput(
    config: NonNullable<ReturnType<DiscordVoiceTaskLauncher['getConfig']>>,
    request: DiscordVoiceTaskRequest,
  ): RunTaskCommandInput {
    const env = [
      ['AVATAR_ID', request.avatarId],
      ['DISCORD_BOT_USER_ID', request.botUserId],
      ['DISCORD_GUILD_ID', request.message.guild_id],
      ['DISCORD_TEXT_CHANNEL_ID', request.message.channel_id],
      ['DISCORD_VOICE_CHANNEL_ID', request.decision.voiceChannelId],
      ['DISCORD_TRIGGER_MESSAGE_ID', request.message.id],
      ['DISCORD_TRIGGER_USER_ID', request.message.author.id],
      ['DISCORD_VOICE_SESSION_SECONDS', String(request.decision.maxSessionSeconds ?? 600)],
      ['STATE_TABLE', this.env.STATE_TABLE],
      ['ADMIN_TABLE', this.env.ADMIN_TABLE],
      ['MEDIA_BUCKET', this.env.MEDIA_BUCKET],
      ['CDN_URL', this.env.CDN_URL],
      ['SECRET_PREFIX', this.env.SECRET_PREFIX || 'swarm'],
      ['ENVIRONMENT', this.env.ENVIRONMENT],
    ]
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
      .map(([name, value]) => ({ name, value }));

    return {
      cluster: config.clusterArn,
      taskDefinition: config.taskDefinitionArn,
      launchType: 'FARGATE',
      startedBy: `voice-${request.avatarId}`.slice(0, 128),
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.subnetIds,
          securityGroups: config.securityGroupIds.length ? config.securityGroupIds : undefined,
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: config.containerName,
            environment: env,
          },
        ],
      },
    };
  }
}

function splitCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
