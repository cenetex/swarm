/**
 * Frontend Stack
 * Contains all UI infrastructure:
 * - Admin UI CloudFront distribution and S3 bucket
 * - Public profile page CloudFront distribution
 * - API documentation site CloudFront distribution
 * Deployed after AdminApiStack (needs API endpoint for routing)
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { AdminApiStack } from './admin-api-stack.js';

export interface FrontendStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names
   */
  nameSuffix?: string;

  /**
   * Reference to AdminApiStack for dependency ordering.
   * Used to establish deployment order; actual API endpoint read from SSM.
   */
  adminApiStack?: AdminApiStack;

  /**
   * Custom domain for admin UI (e.g., 'admin-staging.rati.chat')
   */
  adminDomain?: string;

  /**
   * ACM certificate ARN for admin UI domain
   */
  adminCertificateArn?: string;

  /**
   * When true, use existing S3 buckets instead of creating new ones
   */
  useExistingBuckets?: boolean;

  /**
   * Skip domain alias configuration (useful in dev)
   */
  skipDomainAliases?: boolean;

  /**
   * Enable WAF on CloudFront distributions
   */
  enableWaf?: boolean;
}

export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const {
      environment,
      nameSuffix = '',
      adminApiStack,
      adminDomain,
      adminCertificateArn: _adminCertificateArn,
      useExistingBuckets: _useExistingBuckets,
      skipDomainAliases: _skipDomainAliases,
      enableWaf: _enableWaf,
    } = props;

    if (adminApiStack) {
      new cdk.CfnOutput(this, 'AdminApiEndpointExport', {
        value: adminApiStack.apiEndpoint || 'unknown',
        exportName: `swarm-admin-api-endpoint-${environment}${nameSuffix}`,
      });
    }

    if (adminDomain) {
      new cdk.CfnOutput(this, 'AdminDomainExport', {
        value: adminDomain,
        exportName: `swarm-admin-domain-${environment}${nameSuffix}`,
      });
    }
  }
}
