/**
 * CDK Infrastructure Snapshot Tests
 *
 * These tests synthesize the CDK stacks and snapshot the resulting
 * CloudFormation templates. Any unintentional infrastructure drift
 * will cause the snapshot to differ, failing CI.
 *
 * To update snapshots after intentional changes:
 *   bun test --update-snapshots
 */
import { describe, test, expect } from 'bun:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SharedInfraStack } from '../src/stacks/shared-infra-stack.js';
import { AdminUiStack } from '../src/stacks/admin-ui-stack.js';
import { ProfilePageStack } from '../src/stacks/profile-page-stack.js';

/**
 * Dummy VPC context that CDK needs when Vpc.fromLookup is used.
 * The key format is: vpc-provider:account=<account>:filter.isDefault=true:region=<region>:returnAsymmetricSubnets=true
 * We provide a synthetic result so synth doesn't hit the AWS API.
 */
const DUMMY_VPC_CONTEXT: Record<string, unknown> = {
  'vpc-provider:account=123456789012:filter.isDefault=true:region=us-east-1:returnAsymmetricSubnets=true': {
    vpcId: 'vpc-12345678',
    vpcCidrBlock: '172.31.0.0/16',
    ownerAccountId: '123456789012',
    availabilityZones: ['us-east-1a', 'us-east-1b'],
    subnetGroups: [
      {
        name: 'Public',
        type: 'Public',
        subnets: [
          {
            subnetId: 'subnet-11111111',
            cidr: '172.31.0.0/20',
            availabilityZone: 'us-east-1a',
            routeTableId: 'rtb-11111111',
          },
          {
            subnetId: 'subnet-22222222',
            cidr: '172.31.16.0/20',
            availabilityZone: 'us-east-1b',
            routeTableId: 'rtb-22222222',
          },
        ],
      },
    ],
  },
};

const TEST_ENV = {
  account: '123456789012',
  region: 'us-east-1',
};

/**
 * Sanitize a CloudFormation template to remove values that change between
 * synths (asset hashes, timestamps, random tokens) so snapshots stay stable.
 */
function sanitizeTemplate(template: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(template);

  // Replace asset hashes (64 hex chars) with a placeholder
  const sanitized = json
    .replace(/[a-f0-9]{64}\.zip/g, 'ASSET_HASH.zip')
    .replace(/"S3Key":"[a-f0-9]{64}/g, '"S3Key":"ASSET_HASH')
    .replace(/"[a-f0-9]{64}"/g, '"ASSET_HASH"')
    // Replace timestamps / random tokens generated at synth time
    .replace(/test-\d+-[a-z0-9]+/g, 'test-TIMESTAMP-RANDOM')
    .replace(/replicate-\d+-[a-z0-9]+/g, 'replicate-TIMESTAMP-RANDOM')
    // Replace CodeSha256 (base64 hashes)
    .replace(/"CodeSha256":"[A-Za-z0-9+/=]+"/g, '"CodeSha256":"CODE_HASH"');

  return JSON.parse(sanitized);
}

describe('CDK Infrastructure Snapshots', () => {
  test('SharedInfraStack snapshot (dev)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedInfra', {
      environment: 'dev',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });

  test('SharedInfraStack snapshot (prod)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedInfraProd', {
      environment: 'prod',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });

  test('SharedInfraStack snapshot (useExistingResources)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedInfraExisting', {
      environment: 'staging',
      enableCdn: true,
      galleryDomain: 'gallery.rati.chat',
      useExistingResources: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });

  test('SharedInfraStack snapshot (useExistingResources + mediaCdnUrl fallback)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedInfraExistingCdnFallback', {
      environment: 'staging',
      enableCdn: true,
      mediaCdnUrl: 'https://dodxbiygmi95j.cloudfront.net',
      useExistingResources: true,
      env: TEST_ENV,
    });

    // cdnUrl should be set from mediaCdnUrl
    expect(stack.cdnUrl).toBe('https://dodxbiygmi95j.cloudfront.net');

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });

  test('SharedInfraStack throws when useExistingResources + enableCdn but no CDN URL', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    expect(() => {
      new SharedInfraStack(app, 'TestSharedInfraExistingNoCdn', {
        environment: 'staging',
        enableCdn: true,
        // no galleryDomain, no mediaCdnUrl
        useExistingResources: true,
        env: TEST_ENV,
      });
    }).toThrow(/CDN URL could be resolved/);
  });

  test('AdminUiStack snapshot (dev, no custom domain)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    // AdminUiStack requires a minimal AdminApiStack reference for the API endpoint
    // but can work without one
    const stack = new AdminUiStack(app, 'TestAdminUi', {
      environment: 'dev',
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });

  test('AdminUiStack snapshot (staging, with domain)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new AdminUiStack(app, 'TestAdminUiStaging', {
      environment: 'staging',
      adminDomain: 'staging-swarm.rati.chat',
      adminCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });

  test('AdminUiStack snapshot (skipDomainAliases + useExistingBuckets)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new AdminUiStack(app, 'TestAdminUiExisting', {
      environment: 'staging',
      adminDomain: 'staging-swarm.rati.chat',
      adminCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
      useExistingBuckets: true,
      skipDomainAliases: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });

  test('ProfilePageStack snapshot (dev, no custom domain)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new ProfilePageStack(app, 'TestProfilePage', {
      environment: 'dev',
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });

  test('ProfilePageStack snapshot (prod, with custom domain)', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new ProfilePageStack(app, 'TestProfilePageProd', {
      environment: 'prod',
      profileDomain: 'profiles.rati.chat',
      profileCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
      includeWildcardAliases: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const sanitized = sanitizeTemplate(template.toJSON());
    expect(sanitized).toMatchSnapshot();
  });
});

describe('CDK Infrastructure - Resource Assertions', () => {
  test('SharedInfraStack creates expected DynamoDB tables', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedResources', {
      environment: 'dev',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    // State table with GSI
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'swarm-state-dev',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });

    // Activity table
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'swarm-activity-dev',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'timestamp', KeyType: 'RANGE' },
      ],
    });
  });

  test('SharedInfraStack creates S3 bucket and CloudFront distribution', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedCdn', {
      environment: 'dev',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    // Media bucket
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });

    // CloudFront distribution
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  test('SharedInfraStack creates SNS alarm topic', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedAlarms', {
      environment: 'dev',
      enableCdn: true,
      alarmNotificationEmail: 'test@example.com',
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'swarm-alarms-dev',
    });

    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'test@example.com',
    });
  });

  test('SharedInfraStack creates ECS cluster', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedEcs', {
      environment: 'dev',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'swarm-discord-dev',
    });
  });

  test('SharedInfraStack prod tables have deletion protection', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedProdProtection', {
      environment: 'prod',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    // Both tables should have deletion protection enabled in prod
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'swarm-state-prod',
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'swarm-activity-prod',
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  test('SharedInfraStack with useExistingResources does NOT create shared resources', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedNoCreate', {
      environment: 'prod',
      enableCdn: true,
      mediaCdnUrl: 'https://d1234.cloudfront.net',
      useExistingResources: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    // When useExistingResources=true, no DynamoDB tables should be created
    template.resourceCountIs('AWS::DynamoDB::Table', 0);

    // No S3 buckets (media bucket and CDN log bucket are both imported/skipped)
    template.resourceCountIs('AWS::S3::Bucket', 0);

    // No ECS cluster (imported by name)
    template.resourceCountIs('AWS::ECS::Cluster', 0);

    // No CloudFront distribution (CDN URL is resolved from existing)
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);

    // No WAF WebACL
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);

    // Should still create SNS topic (alarm topic is always fresh)
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'swarm-alarms-prod',
    });

    // Should still create Lambda layer
    template.resourceCountIs('AWS::Lambda::LayerVersion', 1);

    // cdnUrl should be set from mediaCdnUrl
    expect(stack.cdnUrl).toBe('https://d1234.cloudfront.net');
  });

  test('AdminUiStack creates CloudFront with WAF', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new AdminUiStack(app, 'TestAdminUiWaf', {
      environment: 'dev',
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    // CloudFront distribution
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);

    // WAF WebACL
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });

  test('SharedInfraStack creates budget guardrails when monthlyBudgetUsd is set', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedBudget', {
      environment: 'prod',
      enableCdn: true,
      monthlyBudgetUsd: 500,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    // Monthly budget
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetName: 'swarm-monthly-prod',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: {
          Amount: 500,
          Unit: 'USD',
        },
      },
    });

    // Cost anomaly monitor
    template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
      MonitorName: 'swarm-anomaly-prod',
      MonitorType: 'DIMENSIONAL',
      MonitorDimension: 'SERVICE',
    });

    // Cost anomaly subscription
    template.hasResourceProperties('AWS::CE::AnomalySubscription', {
      SubscriptionName: 'swarm-anomaly-alerts-prod',
      Frequency: 'DAILY',
    });
  });

  test('SharedInfraStack omits budget guardrails when monthlyBudgetUsd is not set', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedNoBudget', {
      environment: 'dev',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    // No budget resources
    template.resourceCountIs('AWS::Budgets::Budget', 0);
    template.resourceCountIs('AWS::CE::AnomalyMonitor', 0);
    template.resourceCountIs('AWS::CE::AnomalySubscription', 0);
  });

  test('ProfilePageStack creates SPA routing CloudFront function', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new ProfilePageStack(app, 'TestProfilePageSpa', {
      environment: 'dev',
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);

    // CloudFront function for SPA routing
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: {
        Comment: 'Rewrite non-file routes to /index.html for SPA routing',
      },
    });
  });
});
