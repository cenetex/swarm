/**
 * Media Stack
 * Contains media processing (voice, image, sticker generation)
 * Depends on CoreInfraStack for tables, bucket, and SNS topic
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { CoreInfraStack } from './core-infra-stack.js';

export interface MediaStackProps extends cdk.StackProps {
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
}

export class MediaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MediaStackProps) {
    super(scope, id, props);

    // Media stack is a placeholder for future media processing infrastructure
    // (voice transcription, image generation, sticker processing)
    // Currently this functionality is embedded in SharedHandlers and AdminApiStack
    // This stack exists to demonstrate the architectural split
  }
}
