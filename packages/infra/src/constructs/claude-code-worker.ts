/**
 * Claude Code Worker Construct
 *
 * ECS Fargate service that processes Claude Code tasks.
 * Uses FIFO SQS queue for ordered processing per avatar.
 */
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ClaudeCodeWorkerProps {
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
   * State table for job tracking
   */
  stateTable: dynamodb.ITable;

  /**
   * Response queue for callbacks (FIFO)
   */
  responseQueue: sqs.IQueue;

  /**
   * Secret ARN containing ANTHROPIC_API_KEY (for direct Anthropic API)
   */
  anthropicApiKeyArn?: string;

  /**
   * Secret ARN containing OPENROUTER_API_KEY (for OpenRouter)
   */
  openRouterApiKeyArn?: string;

  /**
   * Use OpenRouter instead of direct Anthropic API
   */
  useOpenRouter?: boolean;

  /**
   * Path to worker code (for Docker build)
   */
  workerCodePath?: string;

  /**
   * Minimum number of worker tasks
   */
  minCapacity?: number;

  /**
   * Maximum number of worker tasks
   */
  maxCapacity?: number;

  /**
   * Path to compiled handlers code (for callback Lambda)
   */
  handlersCodePath?: string;

  /**
   * Lambda layer with dependencies
   */
  dependencyLayer?: lambda.ILayerVersion;
  /**
   * Secrets Manager prefix (e.g., "swarm" or "swarm-abcdef")
   */
  secretPrefix?: string;
}

export class ClaudeCodeWorker extends Construct {
  public readonly queue: sqs.Queue;
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: ClaudeCodeWorkerProps) {
    super(scope, id);

    const {
      environment,
      cluster,
      stateTable,
      responseQueue,
      anthropicApiKeyArn,
      openRouterApiKeyArn,
      useOpenRouter = false,
      workerCodePath,
      minCapacity = 0,
      maxCapacity = 5,
    } = props;
    const suffix = props.nameSuffix ?? '';
    const secretPrefix = props.secretPrefix ?? 'swarm';
    const isProd = environment === 'prod' || environment === 'production';
    const logRetention = isProd
      ? logs.RetentionDays.TWO_WEEKS
      : logs.RetentionDays.THREE_DAYS;

    // FIFO queue for ordered processing per avatar
    this.queue = new sqs.Queue(this, 'ClaudeCodeQueue', {
      queueName: `swarm-claude-code-${environment}${suffix}.fifo`,
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.minutes(10),
      retentionPeriod: cdk.Duration.days(1),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'ClaudeCodeDLQ', {
          queueName: `swarm-claude-code-dlq-${environment}${suffix}.fifo`,
          fifo: true,
          retentionPeriod: cdk.Duration.days(7),
        }),
        maxReceiveCount: 3,
      },
    });

    // Task definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 4096,
      cpu: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Log group
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/swarm-claude-code-worker-${environment}${suffix}`,
      retention: logRetention,
      removalPolicy:
        environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Container environment variables
    const containerEnv: Record<string, string> = {
      NODE_ENV: 'production',
      CLAUDE_CODE_QUEUE_URL: this.queue.queueUrl,
      STATE_TABLE: stateTable.tableName,
      RESPONSE_QUEUE_URL: responseQueue.queueUrl,
    };

    // Configure for OpenRouter if enabled
    if (useOpenRouter) {
      containerEnv.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
      containerEnv.ANTHROPIC_API_KEY = ''; // Must be empty string for OpenRouter
    }

    // Container
    const container = this.taskDefinition.addContainer('ClaudeCodeWorker', {
      image: workerCodePath
        ? ecs.ContainerImage.fromAsset(workerCodePath)
        : ecs.ContainerImage.fromAsset(
            path.resolve(__dirname, '../../../claude-code-worker')
          ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'claude-code',
        logGroup,
      }),
      environment: containerEnv,
      healthCheck: {
        command: ['CMD-SHELL', 'pgrep -f "node.*index.js" || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    // Add API key secrets based on configuration
    if (useOpenRouter && openRouterApiKeyArn) {
      // OpenRouter mode: inject OPENROUTER_API_KEY
      const secret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'OpenRouterApiKey',
        openRouterApiKeyArn
      );
      container.addSecret(
        'OPENROUTER_API_KEY',
        ecs.Secret.fromSecretsManager(secret)
      );
    } else if (anthropicApiKeyArn) {
      // Direct Anthropic mode: inject ANTHROPIC_API_KEY
      const secret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'AnthropicApiKey',
        anthropicApiKeyArn
      );
      container.addSecret(
        'ANTHROPIC_API_KEY',
        ecs.Secret.fromSecretsManager(secret)
      );
    }

    // Grant permissions
    this.queue.grantConsumeMessages(this.taskDefinition.taskRole);
    responseQueue.grantSendMessages(this.taskDefinition.taskRole);
    stateTable.grantReadWriteData(this.taskDefinition.taskRole);

    // Service
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: minCapacity, // respect scale-to-zero when minCapacity=0
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      assignPublicIp: true, // Required for pulling images without NAT
      circuitBreaker: {
        rollback: true,
      },
    });

    // Auto-scaling based on queue depth
    if (maxCapacity > 0) { // enable scaling even for 0→1 transitions
      const scaling = this.service.autoScaleTaskCount({
        minCapacity: Math.max(minCapacity, 0),
        maxCapacity,
      });

      // Scale based on messages visible in queue (scales to minCapacity when empty)
      scaling.scaleOnMetric('QueueDepthScaling', {
        metric: this.queue.metricApproximateNumberOfMessagesVisible(),
        scalingSteps: [
          { upper: 0, change: -maxCapacity }, // Scale to min when queue is empty
          { lower: 1, change: +1 }, // Scale up when messages arrive
          { lower: 5, change: +2 }, // Scale faster with more messages
          { lower: 10, change: +3 },
        ],
        adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
        cooldown: cdk.Duration.minutes(3),
      });
    }

    // Callback Lambda handler (processes results and sends to users)
    if (props.handlersCodePath) {
      const callbackLogGroup = new logs.LogGroup(this, 'CallbackLogGroup', {
        logGroupName: `/aws/lambda/swarm-claude-code-callback-${environment}${suffix}`,
        retention: logRetention,
        removalPolicy:
          environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });

      const callbackLambda = new lambda.Function(this, 'CallbackHandler', {
        functionName: `swarm-claude-code-callback-${environment}${suffix}`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'claude-code-callback.handler',
        code: lambda.Code.fromAsset(props.handlersCodePath),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          NODE_OPTIONS: '--enable-source-maps',
          STATE_TABLE: stateTable.tableName,
        },
        logGroup: callbackLogGroup,
        layers: props.dependencyLayer ? [props.dependencyLayer] : [],
      });

      // Grant permissions to callback Lambda
      stateTable.grantReadData(callbackLambda);

      // Grant access to all avatar secrets (for platform adapters)
      callbackLambda.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${secretPrefix}/*`],
        })
      );

      // Trigger from response queue
      callbackLambda.addEventSource(
        new lambdaEventSources.SqsEventSource(responseQueue, {
          batchSize: 10,
          reportBatchItemFailures: true,
        })
      );
    }

    // Outputs
    new cdk.CfnOutput(this, 'QueueUrl', {
      value: this.queue.queueUrl,
      description: 'Claude Code queue URL',
      exportName: `swarm-claude-code-queue-${environment}${suffix}`,
    });

    new cdk.CfnOutput(this, 'QueueArn', {
      value: this.queue.queueArn,
      description: 'Claude Code queue ARN',
      exportName: `swarm-claude-code-queue-arn-${environment}${suffix}`,
    });
  }
}
