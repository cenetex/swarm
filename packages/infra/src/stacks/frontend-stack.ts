/**
 * Frontend Stack
 * Contains CloudFront distribution for Admin UI
 * This stack changes when UI assets are updated
 */
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AdminUi } from '../constructs/admin-ui.js';
import type { AdminApiStack } from './admin-api-stack.js';

export interface FrontendStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;
  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Reference to the Admin API stack (optional - if API is deployed).
   * Used only to establish a CDK dependency ordering; the actual API endpoint
   * is read from SSM to avoid CloudFormation cross-stack export issues.
   */
  adminApiStack?: AdminApiStack;

  /**
   * Custom domain for Admin UI (e.g., 'admin-staging.rati.chat')
   */
  adminDomain?: string;

  /**
   * ACM certificate ARN for Admin UI custom domain (must be in us-east-1)
   */
  adminCertificateArn?: string;

  /**
   * Whether to import an existing S3 bucket instead of creating a new one
   */
  useExistingBuckets?: boolean;

  /**
   * Whether to skip adding domain aliases to the CloudFront distribution
   */
  skipDomainAliases?: boolean;

  /**
   * Enable WAF on the CloudFront distribution.
   * Set to false for staging to reduce idle cost.
   * @default true
   */
  enableWaf?: boolean;
}

export class FrontendStack extends cdk.Stack {
  public readonly adminUi: AdminUi;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { environment, adminApiStack, adminDomain, adminCertificateArn, nameSuffix, useExistingBuckets, skipDomainAliases, enableWaf } = props;

    // Get API Gateway hostname from SSM parameter written by AdminApiStack.
    // Using SSM dynamic references instead of direct cross-stack property access
    // avoids CloudFormation export-in-use errors when the API stack is updated.
    let apiGatewayHost: string | undefined;
    if (adminApiStack?.apiEndpointParamName) {
      // Read the API endpoint URL from SSM at deploy time
      const apiEndpointUrl = ssm.StringParameter.valueForStringParameter(
        this,
        adminApiStack.apiEndpointParamName
      );
      // Parse API endpoint: https://xxx.execute-api.region.amazonaws.com
      // Use Fn.select to parse at deploy time since the value is a token
      apiGatewayHost = cdk.Fn.select(2, cdk.Fn.split('/', apiEndpointUrl));
    }

    // Create Admin UI with CloudFront
    this.adminUi = new AdminUi(this, 'AdminUi', {
      environment,
      domainName: adminDomain,
      certificateArn: adminCertificateArn,
      apiDomain: apiGatewayHost,
      nameSuffix,
      enableWaf,
      useExistingBucket: useExistingBuckets,
      skipDomainAliases,
    });

    // Outputs
    new cdk.CfnOutput(this, 'AdminUiUrl', {
      value: adminDomain
        ? `https://${adminDomain}`
        : `https://${this.adminUi.distribution.distributionDomainName}`,
      description: 'Admin UI URL',
    });
  }
}
