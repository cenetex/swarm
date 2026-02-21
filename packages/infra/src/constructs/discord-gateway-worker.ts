/**
 * Discord Gateway Worker Construct
 *
 * ECS Fargate service that maintains WebSocket connections to the Discord Gateway.
 * Multi-tenant: discovers all Discord-enabled avatars from the state table,
 * connects their bots, and routes incoming messages into the shared message queue.
 */
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
   * Shared FIFO message queue — inbound Discord messages are enqueued here
   */
  messageQueue: sqs.IQueue;

  /**
   * Secrets Manager prefix (e.g., "swarm" or "swarm-abcdef")
   */
  secretPrefix?: string;
}

export class DiscordGatewayWorker extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: DiscordGatewayWorkerProps) {
    super(scope, id);

    const {
      environment,
      cluster,
      stateTable,
      activityTable,
      messageQueue,
    } = props;
    const suffix = props.nameSuffix ?? '';
    const secretPrefix = props.secretPrefix ?? 'swarm';
    const isProd = environment === 'prod' || environment === 'production';
    const logRetention = isProd
      ? logs.RetentionDays.TWO_WEEKS
      : logs.RetentionDays.THREE_DAYS;

    // Task definition — lightweight: WebSocket connections are I/O-bound, not CPU
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Log group — let CloudFormation generate the name to avoid collisions
    // with orphaned log groups from previous failed deployments
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Container
    this.taskDefinition.addContainer('DiscordGateway', {
      image: ecs.ContainerImage.fromAsset(
        path.resolve(__dirname, '../../../..'),
        { file: 'packages/handlers/Dockerfile.discord-gateway' }
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'discord-gw',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        STATE_TABLE: stateTable.tableName,
        ACTIVITY_TABLE: activityTable.tableName,
        MESSAGE_QUEUE_URL: messageQueue.queueUrl,
        SECRET_PREFIX: secretPrefix,
        ENVIRONMENT: environment,
      },
      healthCheck: {
        command: ['CMD-SHELL', 'pgrep -f "node.*discord-gateway" || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    // IAM — read avatars, write activity, send messages, read secrets
    stateTable.grantReadData(this.taskDefinition.taskRole);
    activityTable.grantReadWriteData(this.taskDefinition.taskRole);
    messageQueue.grantSendMessages(this.taskDefinition.taskRole);

    this.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${secretPrefix}/*`,
        ],
      })
    );

    // Service — always-on, single task (one worker handles all bots)
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 1,
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
