/**
 * Station Stack
 * Contains station agent runner, tweet poster, and platform heartbeat
 * Depends on CoreInfraStack and MessagingStack for queues
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
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Reference to the core infrastructure stack
   */
  coreInfraStack: CoreInfraStack;

  /**
   * Reference to the messaging stack
   */
  messagingStack: MessagingStack;
}

export class StationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StationStackProps) {
    super(scope, id, props);

    // Station stack is a placeholder for future station-specific infrastructure
    // (autonomous tweet poster, station agent runner, platform heartbeat)
    // Currently this functionality is embedded in SharedHandlers and AdminApiStack
    // This stack exists to demonstrate the architectural split
  }
}
