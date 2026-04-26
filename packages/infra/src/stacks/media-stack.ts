/**
 * Media Stack
 * Contains media delivery infrastructure:
 * - CloudFront distribution for avatar media CDN
 * - Image and video processing Lambda functions (placeholder for future implementation)
 * - Replicate API integration
 * Deployed after CoreInfraStack
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
   * Optional suffix for resource names
   */
  nameSuffix?: string;

  /**
   * Reference to CoreInfraStack for S3 bucket and CDN distribution
   */
  coreInfraStack: CoreInfraStack;
}

export class MediaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MediaStackProps) {
    super(scope, id, props);

    const { environment, nameSuffix = '', coreInfraStack } = props;

    new cdk.CfnOutput(this, 'MediaBucketNameExport', {
      value: coreInfraStack.mediaBucketName,
      exportName: `swarm-media-bucket-name-${environment}${nameSuffix}`,
    });

    new cdk.CfnOutput(this, 'CdnUrlExport', {
      value: coreInfraStack.cdnUrl || 'default',
      exportName: `swarm-cdn-url-${environment}${nameSuffix}`,
    });

    if (coreInfraStack.cdnDistributionId) {
      new cdk.CfnOutput(this, 'CdnDistributionIdExport', {
        value: coreInfraStack.cdnDistributionId,
        exportName: `swarm-cdn-distribution-id-${environment}${nameSuffix}`,
      });
    }
  }
}
