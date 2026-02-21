/**
 * Profile Page Stack
 * Contains S3 bucket and CloudFront distribution for public avatar profile pages
 * Serves *.rati.chat subdomains where each subdomain is an avatar ID
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ProfilePage } from '../constructs/profile-page.js';

export interface ProfilePageStackProps extends cdk.StackProps {
  /**
   * Environment name (dev, staging, prod)
   */
  environment: string;

  /**
   * Optional suffix for resource names/exports (e.g., "-a1b2c3")
   */
  nameSuffix?: string;

  /**
   * Custom domain for profile pages (e.g., 'profiles.rati.chat' or 'rati.chat')
   * The wildcard *.rati.chat will also be added if includeWildcardAliases is enabled
   */
  profileDomain?: string;

  /**
   * ACM certificate ARN for the profile page custom domain (must be in us-east-1)
   * Should cover both the domain and wildcard (e.g., *.rati.chat and rati.chat)
   */
  profileCertificateArn?: string;

  /**
   * Whether to include wildcard aliases (e.g., '*.rati.chat') on the CloudFront distribution.
   * Default: enabled only for `prod`.
   */
  includeWildcardAliases?: boolean;

  /**
   * Enable WAF on the CloudFront distribution.
   * Set to false for staging to reduce idle cost.
   * @default true
   */
  enableWaf?: boolean;

  /**
   * API URL for the profile page to fetch data from
   */
  apiUrl?: string;
}

export class ProfilePageStack extends cdk.Stack {
  public readonly profilePage: ProfilePage;

  constructor(scope: Construct, id: string, props: ProfilePageStackProps) {
    super(scope, id, props);

    const {
      environment,
      profileDomain,
      profileCertificateArn,
      nameSuffix,
      includeWildcardAliases,
      enableWaf,
      apiUrl,
    } = props;

    // Create Profile Page with CloudFront
    this.profilePage = new ProfilePage(this, 'ProfilePage', {
      environment,
      domainName: profileDomain,
      certificateArn: profileCertificateArn,
      nameSuffix,
      includeWildcardAliases,
      enableWaf,
      apiUrl,
    });

    // Outputs
    new cdk.CfnOutput(this, 'ProfilePageUrl', {
      value: profileDomain
        ? `https://${profileDomain}`
        : `https://${this.profilePage.distribution.distributionDomainName}`,
      description: 'Profile Page URL',
    });

    // DNS Configuration instructions
    if (profileDomain) {
      new cdk.CfnOutput(this, 'DnsInstructions', {
        value: `Add a CNAME record pointing ${profileDomain} and *.rati.chat to ${this.profilePage.distribution.distributionDomainName}`,
        description: 'DNS configuration instructions',
      });
    }
  }
}
