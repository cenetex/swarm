/**
 * Station Stack
 * Contains long-running agent services:
 * - Discord gateway ECS Fargate task
 * - Claude Code worker ECS Fargate task
 * - Station agent runner for one-off Lambda invocations
 * - Autonomous tweet poster
 * Deployed after CoreInfraStack and MessagingStack (depends on SQS queues)
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { CoreInfraStack } from './core-infra-stack.js';
import type { MessagingStack } from './messaging-stack.js';

export interface StationStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names
   */
  nameSuffix?: string;

  /**
   * Reference to CoreInfraStack for ECS cluster and other infrastructure
   */
  coreInfraStack: CoreInfraStack;

  /**
   * Reference to MessagingStack for queue endpoints
   */
  messagingStack: MessagingStack;
}

export class StationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StationStackProps) {
    super(scope, id, props);

    const { environment, nameSuffix = '', coreInfraStack, messagingStack } = props;

    new cdk.CfnOutput(this, 'EcsClusterNameExport', {
      value: coreInfraStack.discordClusterName,
      exportName: `swarm-ecs-cluster-name-${environment}${nameSuffix}`,
    });

    new cdk.CfnOutput(this, 'EcsClusterArnExport', {
      value: coreInfraStack.discordClusterArn,
      exportName: `swarm-ecs-cluster-arn-${environment}${nameSuffix}`,
    });
  }
}
