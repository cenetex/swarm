/**
 * Messaging Stack
 * Contains message routing and processing infrastructure:
 * - SQS queues and DLQs for async message handling
 * - Lambda processors for messages, responses, media, tweets
 * - Telegram webhook handlers
 * - Twitter mention poller
 * Deployed after CoreInfraStack, can be deployed independently of Admin API
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SharedHandlers } from '../constructs/shared-handlers.js';
import type { CoreInfraStack } from './core-infra-stack.js';

export interface MessagingStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names (e.g., "-split")
   */
  nameSuffix?: string;

  /**
   * Reference to CoreInfraStack for DynamoDB, S3, SNS access
   */
  coreInfraStack: CoreInfraStack;

  /**
   * Path to compiled handlers
   */
  handlersPath: string;

  /**
   * Prefix for secrets in Secrets Manager (e.g., 'swarm/prod')
   */
  secretPrefix?: string;

  /**
   * ARN of Lambda layer with dependencies
   */
  dependencyLayer?: lambda.ILayerVersion;

  /**
   * Optional suffix specifically for messaging resources
   */
  messagingNameSuffix?: string;

  /**
   * Enable Discord gateway
   */
  enableDiscordGateway?: boolean;
}

export class MessagingStack extends cdk.Stack {
  public readonly sharedHandlers: SharedHandlers;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);

    const {
      environment,
      nameSuffix = '',
      coreInfraStack,
      handlersPath,
      secretPrefix,
      dependencyLayer,
      messagingNameSuffix = '',
      enableDiscordGateway,
    } = props;

    this.sharedHandlers = new SharedHandlers(this, 'Handlers', {
      environment,
      nameSuffix: messagingNameSuffix,
      coreInfraStack,
      handlersPath,
      secretPrefix,
      dependencyLayer,
      enableDiscordGateway: enableDiscordGateway ?? false,
    });

    new cdk.CfnOutput(this, 'MessageQueueUrlExport', {
      value: this.sharedHandlers.messageQueue.queueUrl,
      exportName: `swarm-message-queue-url-${environment}${nameSuffix}`,
    });

    new cdk.CfnOutput(this, 'ResponseQueueUrlExport', {
      value: this.sharedHandlers.responseQueue.queueUrl,
      exportName: `swarm-response-queue-url-${environment}${nameSuffix}`,
    });
  }
}
