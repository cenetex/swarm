/**
 * Docs Site Stack
 * Contains S3 bucket and CloudFront distribution for the VitePress documentation site
 * Serves docs.rati.chat (prod) or staging-docs.rati.chat (staging)
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DocsSite } from '../constructs/docs-site.js';

export interface DocsSiteStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Custom domain for the docs site (e.g., 'docs.rati.chat')
   */
  docsDomain?: string;

  /**
   * ACM certificate ARN for the docs site custom domain (must be in us-east-1)
   */
  docsCertificateArn?: string;

  /**
   * Whether to import an existing bucket instead of creating a new one.
   */
  useExistingBuckets?: boolean;

  /**
   * Whether to skip adding domain aliases to the CloudFront distribution.
   */
  skipDomainAliases?: boolean;

  /**
   * Enable WAF on the CloudFront distribution.
   * @default true
   */
  enableWaf?: boolean;
}

export class DocsSiteStack extends cdk.Stack {
  public readonly docsSite: DocsSite;

  constructor(scope: Construct, id: string, props: DocsSiteStackProps) {
    super(scope, id, props);

    const {
      environment,
      docsDomain,
      docsCertificateArn,
      nameSuffix,
      useExistingBuckets,
      skipDomainAliases,
      enableWaf,
    } = props;

    // Create Docs Site with CloudFront
    this.docsSite = new DocsSite(this, 'DocsSite', {
      environment,
      domainName: docsDomain,
      certificateArn: docsCertificateArn,
      nameSuffix,
      useExistingBucket: useExistingBuckets,
      skipDomainAliases,
      enableWaf,
    });

    // Outputs
    new cdk.CfnOutput(this, 'DocsSiteUrl', {
      value: docsDomain
        ? `https://${docsDomain}`
        : `https://${this.docsSite.distribution.distributionDomainName}`,
      description: 'Docs Site URL',
    });

    // DNS Configuration instructions
    if (docsDomain) {
      new cdk.CfnOutput(this, 'DnsInstructions', {
        value: `Add a CNAME record pointing ${docsDomain} to ${this.docsSite.distribution.distributionDomainName}`,
        description: 'DNS configuration instructions',
      });
    }
  }
}
