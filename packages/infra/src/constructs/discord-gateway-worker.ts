/**
 * Discord Gateway Worker Construct
 *
 * ECS Fargate service that maintains WebSocket connections to the Discord Gateway.
 * Multi-tenant: discovers all Discord-enabled avatars from the state table,
 * connects their bots, and routes incoming messages into the shared message queue.
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DiscordGatewayWorkerProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * ECS cluster to deploy to
   */
  cluster: ecs.ICluster;

  /**
   * State table — read to discover avatars and their Discord config
   */
  stateTable: dynamodb.ITable;

  /**
   * Activity table — write Discord message activity records
   */
  activityTable: dynamodb.ITable;

  /**
   * Admin/shared-room table — read/write shared room ledger records.
   */
  adminTable?: dynamodb.ITable;

  /**
   * Media bucket used by voice workers to store generated greeting audio.
   */
  mediaBucket?: s3.IBucket;

  /**
   * CDN URL for generated media assets.
   */
  cdnUrl?: string;

  /**
   * Shared FIFO message queue — inbound Discord messages are enqueued here
   */
  messageQueue: sqs.IQueue;

  /**
   * Secrets Manager prefix (e.g., "swarm" or "swarm-abcdef")
   */
  secretPrefix?: string;

  /**
   * Desired number of running tasks.
   * Set to 0 for staging to avoid idle ECS cost when there is no activity.
   * @default 1
   */
  desiredCount?: number;
}

export class DiscordGatewayWorker extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly voiceTaskDefinition: ecs.FargateTaskDefinition;
  public readonly voiceSubnets: ec2.SelectedSubnets;
  public readonly voiceWorkerSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DiscordGatewayWorkerProps) {
    super(scope, id);

    const {
      environment,
      cluster,
      stateTable,
      activityTable,
      adminTable,
      mediaBucket,
      messageQueue,
    } = props;
    const suffix = props.nameSuffix ?? '';
    const secretPrefix = props.secretPrefix ?? 'swarm';
    const isProd = environment === 'prod' || environment === 'production';
    const logRetention = isProd
      ? logs.RetentionDays.ONE_MONTH
      : logs.RetentionDays.ONE_WEEK;

    const image = ecs.ContainerImage.fromAsset(
      path.resolve(__dirname, '../../../..'),
      {
        file: 'packages/handlers/Dockerfile.discord-gateway',
        platform: ecr_assets.Platform.LINUX_ARM64,
        // Cache layers in GitHub Actions cache to avoid full rebuild/push on every deploy.
        // Requires buildx driver: docker-container (set in deploy-cdk-reusable.yml).
        cacheFrom: [{ type: 'gha', params: { scope: 'discord-gateway-arm64' } }],
        cacheTo: { type: 'gha', params: { scope: 'discord-gateway-arm64', mode: 'max' } },
      }
    );

    const voiceSubnets = cluster.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PUBLIC,
    });

    const voiceWorkerSecurityGroup = new ec2.SecurityGroup(this, 'DiscordVoiceWorkerSecurityGroup', {
      vpc: cluster.vpc,
      allowAllOutbound: true,
      description: 'Outbound-only security group for ephemeral Discord voice workers',
    });
    this.voiceSubnets = voiceSubnets;
    this.voiceWorkerSecurityGroup = voiceWorkerSecurityGroup;

    // Task definition — lightweight: WebSocket connections are I/O-bound, not CPU.
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Log group — let CloudFormation generate the name to avoid collisions
    // with orphaned log groups from previous failed deployments
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Short-lived per-call workers. The gateway launches these with RunTask
    // after it sees an opted-in avatar mentioned by a user who is in voice.
    this.voiceTaskDefinition = new ecs.FargateTaskDefinition(this, 'VoiceTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const voiceLogGroup = new logs.LogGroup(this, 'VoiceLogGroup', {
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.voiceTaskDefinition.addContainer('DiscordVoiceWorker', {
      image,
      command: ['node', 'dist/discord/discord-voice-session-worker.js'],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'discord-voice',
        logGroup: voiceLogGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        STATE_TABLE: stateTable.tableName,
        ...(adminTable ? { ADMIN_TABLE: adminTable.tableName } : {}),
        ...(mediaBucket ? { MEDIA_BUCKET: mediaBucket.bucketName } : {}),
        CDN_URL: props.cdnUrl || '',
        SECRET_PREFIX: secretPrefix,
        ENVIRONMENT: environment,
      },
    });

    // Container
    this.taskDefinition.addContainer('DiscordGateway', {
      image,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'discord-gw',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        STATE_TABLE: stateTable.tableName,
        ACTIVITY_TABLE: activityTable.tableName,
        ...(adminTable
          ? {
              ADMIN_TABLE: adminTable.tableName,
              SHARED_ROOM_TABLE: adminTable.tableName,
            }
          : {}),
        ...(mediaBucket ? { MEDIA_BUCKET: mediaBucket.bucketName } : {}),
        CDN_URL: props.cdnUrl || '',
        MESSAGE_QUEUE_URL: messageQueue.queueUrl,
        SECRET_PREFIX: secretPrefix,
        ENVIRONMENT: environment,
        DISCORD_VOICE_WORKER_ENABLED: 'true',
        DISCORD_VOICE_WORKER_CLUSTER_ARN: cluster.clusterArn,
        DISCORD_VOICE_WORKER_TASK_DEFINITION_ARN: this.voiceTaskDefinition.family,
        DISCORD_VOICE_WORKER_SUBNET_IDS: voiceSubnets.subnetIds.join(','),
        DISCORD_VOICE_WORKER_SECURITY_GROUP_IDS: voiceWorkerSecurityGroup.securityGroupId,
        DISCORD_VOICE_WORKER_CONTAINER_NAME: 'DiscordVoiceWorker',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'pgrep -f "node.*discord-gateway" || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    // IAM — read/write state (idempotency + channel history), write activity, send messages, read secrets
    stateTable.grantReadWriteData(this.taskDefinition.taskRole);
    activityTable.grantReadWriteData(this.taskDefinition.taskRole);
    adminTable?.grantReadWriteData(this.taskDefinition.taskRole);
    mediaBucket?.grantReadWrite(this.taskDefinition.taskRole);
    messageQueue.grantSendMessages(this.taskDefinition.taskRole);

    stateTable.grantReadData(this.voiceTaskDefinition.taskRole);
    adminTable?.grantReadWriteData(this.voiceTaskDefinition.taskRole);
    mediaBucket?.grantReadWrite(this.voiceTaskDefinition.taskRole);

    this.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${secretPrefix}/*`,
        ],
      })
    );

    this.voiceTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${secretPrefix}/*`,
        ],
      })
    );

    const voicePassRoleResources = [this.voiceTaskDefinition.taskRole.roleArn];
    if (this.voiceTaskDefinition.executionRole) {
      voicePassRoleResources.push(this.voiceTaskDefinition.executionRole.roleArn);
    }
    const voiceTaskDefinitionFamilyArn = cdk.Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'task-definition',
      resourceName: `${this.voiceTaskDefinition.family}:*`,
    });

    this.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [voiceTaskDefinitionFamilyArn],
      })
    );
    this.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: voicePassRoleResources,
      })
    );

    // Service — always-on, single task (one worker handles all bots).
    // desiredCount defaults to 1 but can be set to 0 for staging to avoid idle cost.
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: props.desiredCount ?? 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      assignPublicIp: true, // Required for pulling images and reaching Discord API
      circuitBreaker: {
        rollback: true,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'ServiceArn', {
      value: this.service.serviceArn,
      description: 'Discord Gateway worker service ARN',
      exportName: `swarm-discord-gateway-service-arn-${environment}${suffix}`,
    });
  }
}
