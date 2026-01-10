/**
 * Agent Construct
 * CDK construct for a single swarm agent with all its resources
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import type { AgentConfig } from '@swarm/core';

export interface AgentConstructProps {
  /**
   * Agent configuration
   */
  config: AgentConfig;

  /**
   * Shared state table (multi-tenant)
   */
  stateTable: dynamodb.ITable;

  /**
   * Shared activity table
   */
  activityTable: dynamodb.ITable;

  /**
   * Shared media bucket
   */
  mediaBucket: s3.IBucket;

  /**
   * Lambda layer with dependencies
   */
  dependencyLayer: lambda.ILayerVersion;

  /**
   * Path to compiled handlers code
   */
  handlersCodePath: string;

  /**
   * ARN of secrets (or will create)
   */
  secretsArn?: string;

  /**
   * Environment (dev, staging, prod)
   */
  environment?: string;
}

export class AgentConstruct extends Construct {
  public readonly messageQueue: sqs.Queue;
  public readonly responseQueue: sqs.Queue;
  public readonly mediaQueue: sqs.Queue;
  public readonly api: apigateway.RestApi;
  public readonly secrets: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: AgentConstructProps) {
    super(scope, id);

    const { config, stateTable, activityTable, mediaBucket, dependencyLayer, handlersCodePath, environment = 'dev' } = props;

    // Create or import secrets
    if (props.secretsArn) {
      this.secrets = secretsmanager.Secret.fromSecretCompleteArn(this, 'Secrets', props.secretsArn);
    } else {
      this.secrets = new secretsmanager.Secret(this, 'Secrets', {
        secretName: `swarm/${config.id}/secrets`,
        description: `Secrets for agent ${config.name}`,
      });
    }

    // Create SQS queues with DLQ
    const dlq = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `${config.id}-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.messageQueue = new sqs.Queue(this, 'MessageQueue', {
      queueName: `${config.id}-messages.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    this.responseQueue = new sqs.Queue(this, 'ResponseQueue', {
      queueName: `${config.id}-responses.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    this.mediaQueue = new sqs.Queue(this, 'MediaQueue', {
      queueName: `${config.id}-media`,
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Common Lambda environment
    const commonEnv: Record<string, string> = {
      NODE_OPTIONS: '--enable-source-maps',
      AGENT_ID: config.id,
      AGENT_NAME: config.name,
      STATE_TABLE: stateTable.tableName,
      ACTIVITY_TABLE: activityTable.tableName,
      MEDIA_BUCKET: mediaBucket.bucketName,
      SECRETS_ARN: this.secrets.secretArn,
      MESSAGE_QUEUE_URL: this.messageQueue.queueUrl,
      RESPONSE_QUEUE_URL: this.responseQueue.queueUrl,
      MEDIA_QUEUE_URL: this.mediaQueue.queueUrl,
      ENVIRONMENT: environment,
    };

    // Lambda role
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant permissions
    stateTable.grantReadWriteData(lambdaRole);
    activityTable.grantReadWriteData(lambdaRole);
    mediaBucket.grantReadWrite(lambdaRole);
    this.secrets.grantRead(lambdaRole);
    this.messageQueue.grantSendMessages(lambdaRole);
    this.messageQueue.grantConsumeMessages(lambdaRole);
    this.responseQueue.grantSendMessages(lambdaRole);
    this.responseQueue.grantConsumeMessages(lambdaRole);
    this.mediaQueue.grantSendMessages(lambdaRole);
    this.mediaQueue.grantConsumeMessages(lambdaRole);

    // Grant Bedrock access
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: ['*'],
    }));

    // Create API Gateway
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${config.id}-api`,
      description: `API for agent ${config.name}`,
      deployOptions: {
        stageName: environment,
      },
      defaultCorsPreflightOptions: config.platforms.web?.corsOrigins ? {
        allowOrigins: config.platforms.web.corsOrigins,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Wallet-Address', 'X-Wallet-Signature'],
      } : undefined,
    });

    // Telegram webhook handler
    if (config.platforms.telegram?.enabled) {
      const telegramHandler = new lambda.Function(this, 'TelegramWebhook', {
        functionName: `${config.id}-telegram-webhook`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'telegram-webhook.handler',
        code: lambda.Code.fromAsset(handlersCodePath),
        layers: [dependencyLayer],
        role: lambdaRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        environment: {
          ...commonEnv,
          TELEGRAM_BOT_USERNAME: config.platforms.telegram.botUsername || '',
        },
      });

      const telegramResource = this.api.root.addResource('webhook').addResource('telegram').addResource(config.id);
      telegramResource.addMethod('POST', new apigateway.LambdaIntegration(telegramHandler));
    }

    // Web chat handler
    if (config.platforms.web?.enabled) {
      const webHandler = new lambda.Function(this, 'WebChat', {
        functionName: `${config.id}-web-chat`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'web-chat.handler',
        code: lambda.Code.fromAsset(handlersCodePath),
        layers: [dependencyLayer],
        role: lambdaRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        environment: commonEnv,
      });

      const chatResource = this.api.root.addResource('chat');
      chatResource.addMethod('POST', new apigateway.LambdaIntegration(webHandler));
    }

    // Message processor (SQS triggered)
    const messageProcessor = new lambda.Function(this, 'MessageProcessor', {
      functionName: `${config.id}-message-processor`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'message-processor.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: commonEnv,
    });

    messageProcessor.addEventSource(new lambdaEventSources.SqsEventSource(this.messageQueue, {
      batchSize: 1,
    }));

    // Response sender (SQS triggered)
    const responseSender = new lambda.Function(this, 'ResponseSender', {
      functionName: `${config.id}-response-sender`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'response-sender.handler',
      code: lambda.Code.fromAsset(handlersCodePath),
      layers: [dependencyLayer],
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: commonEnv,
    });

    responseSender.addEventSource(new lambdaEventSources.SqsEventSource(this.responseQueue, {
      batchSize: 1,
    }));

    // Scheduled tweet poster
    const scheduledTweet = config.scheduling.tweets?.[0];
    if (config.platforms.twitter?.enabled && scheduledTweet) {
      const tweetPoster = new lambda.Function(this, 'TweetPoster', {
        functionName: `${config.id}-tweet-poster`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'tweet-poster.handler',
        code: lambda.Code.fromAsset(handlersCodePath),
        layers: [dependencyLayer],
        role: lambdaRole,
        timeout: cdk.Duration.minutes(2),
        memorySize: 512,
        environment: {
          ...commonEnv,
          TWEET_TEMPLATE: scheduledTweet.template || 'general',
        },
      });

      // Schedule rule - parse cron string or use default
      const cronParts = scheduledTweet.cron?.split(' ') || [];
      new events.Rule(this, 'TweetSchedule', {
        schedule: cronParts.length >= 5
          ? events.Schedule.cron({
              minute: cronParts[0] || '0',
              hour: cronParts[1] || '12',
              day: cronParts[2] || '*',
              month: cronParts[3] || '*',
              weekDay: cronParts[4] || '*',
            })
          : events.Schedule.cron({
              hour: '12,18',
              minute: '0',
            }),
        targets: [new targets.LambdaFunction(tweetPoster)],
      });
    }

    // Twitter mention poller - polls for mentions every 5 minutes
    const twitterMentions = config.platforms.twitter?.features?.includes('mention_replies');
    if (config.platforms.twitter?.enabled && twitterMentions) {
      const mentionPoller = new lambda.Function(this, 'TwitterMentionPoller', {
        functionName: `${config.id}-twitter-mention-poller`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'twitter-mention-poller.handler',
        code: lambda.Code.fromAsset(handlersCodePath),
        layers: [dependencyLayer],
        role: lambdaRole,
        timeout: cdk.Duration.seconds(60),
        memorySize: 512,
        environment: commonEnv,
      });

      // Poll every 5 minutes
      new events.Rule(this, 'MentionPollSchedule', {
        schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
        targets: [new targets.LambdaFunction(mentionPoller)],
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: `API URL for agent ${config.name}`,
    });

    if (config.platforms.telegram?.enabled) {
      new cdk.CfnOutput(this, 'TelegramWebhookUrl', {
        value: `${this.api.url}webhook/telegram/${config.id}`,
        description: 'Telegram webhook URL',
      });
    }
  }
}
