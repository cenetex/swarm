/**
 * CloudFormation Resource Count Tests
 *
 * Validates that top-level stacks stay under CloudFormation's 500-resource hard limit.
 * This test prevents regressions as new resources are added during feature development.
 *
 * For context, see:
 * - docs/infra/stack-audit-2026-04-17.md (historic resource counts)
 * - issue #1353 (original resource-count pressure)
 * - issue #1435 (phased migration to nested stack)
 */
import { describe, test, expect, mock } from 'bun:test';

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

class ResourceCountNodejsFunction extends lambda.Function {
  constructor(scope: Construct, id: string, props: Record<string, unknown>) {
    const {
      entry: _entry,
      bundling: _bundling,
      depsLockFilePath: _depsLockFilePath,
      projectRoot: _projectRoot,
      awsSdkConnectionReuse: _awsSdkConnectionReuse,
      ...functionProps
    } = props;

    super(scope, id, {
      ...functionProps,
      runtime: (props.runtime as lambda.Runtime | undefined) ?? lambda.Runtime.NODEJS_20_X,
      handler: (props.handler as string | undefined) ?? 'handler',
      code: lambda.Code.fromInline('exports.handler = async () => undefined;'),
    });
  }
}

mock.module('aws-cdk-lib/aws-lambda-nodejs', () => ({
  NodejsFunction: ResourceCountNodejsFunction,
  OutputFormat: { CJS: 'cjs' },
}));

const { Template } = await import('aws-cdk-lib/assertions');
const { AdminApiStack } = await import('../src/stacks/admin-api-stack.js');
const { SharedInfraStack } = await import('../src/stacks/shared-infra-stack.js');

/**
 * Dummy VPC context that CDK needs when Vpc.fromLookup is used.
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
const TEST_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:swarm/test/openrouter-api-key-abcdef';

describe('CloudFormation Resource Counts', () => {
  test('SwarmApi-staging resource count ≤ 500', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    // Create SharedInfraStack
    const sharedInfra = new SharedInfraStack(app, 'TestSharedInfraStaging', {
      environment: 'staging',
      enableCdn: false,
      env: TEST_ENV,
    });

    // Create AdminApiStack with admin emails configured (triggers full initialization)
    const adminApi = new AdminApiStack(app, 'TestAdminApiStaging', {
      environment: 'staging',
      sharedInfraStack: sharedInfra,
      handlersPath: '/tmp/handlers', // Dummy path; resources won't be accessed
      adminEmails: 'admin@example.com',
      openRouterApiKeyArn: TEST_SECRET_ARN,
      env: TEST_ENV,
    });

    const template = Template.fromStack(adminApi);
    const resourceCount = Object.keys(template.toJSON().Resources || {}).length;

    // Target: ≤ 450 once phased migration (#1435) completes.
    // Phase 1 (current): zero delta — SharedHandlersStack is an empty skeleton,
    // parent still instantiates SharedHandlers directly. Cap at 500 (CFN hard limit).
    expect(resourceCount).toBeLessThanOrEqual(500);
    console.log(`SwarmApi-staging resource count: ${resourceCount}/500`);
  }, 60_000);

  test('SwarmApi-prod resource count ≤ 500', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    // Create SharedInfraStack
    const sharedInfra = new SharedInfraStack(app, 'TestSharedInfraProd', {
      environment: 'prod',
      enableCdn: false,
      env: TEST_ENV,
    });

    // Create AdminApiStack with admin emails configured (triggers full initialization)
    const adminApi = new AdminApiStack(app, 'TestAdminApiProd', {
      environment: 'prod',
      sharedInfraStack: sharedInfra,
      handlersPath: '/tmp/handlers', // Dummy path; resources won't be accessed
      adminEmails: 'admin@example.com',
      openRouterApiKeyArn: TEST_SECRET_ARN,
      env: TEST_ENV,
    });

    const template = Template.fromStack(adminApi);
    const resourceCount = Object.keys(template.toJSON().Resources || {}).length;

    // Target: ≤ 450 once phased migration (#1435) completes.
    // Phase 1 (current): zero delta — SharedHandlersStack is an empty skeleton,
    // parent still instantiates SharedHandlers directly. Cap at 500 (CFN hard limit).
    expect(resourceCount).toBeLessThanOrEqual(500);
    console.log(`SwarmApi-prod resource count: ${resourceCount}/500`);
  }, 60_000);

  test('SharedInfraStack-staging resource count ≤ 200', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedInfraStackStaging', {
      environment: 'staging',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const resourceCount = Object.keys(template.toJSON().Resources || {}).length;

    // Shared infra is stable and should stay well under 200
    expect(resourceCount).toBeLessThanOrEqual(200);
    console.log(`SharedInfraStack-staging resource count: ${resourceCount}/200`);
  });

  test('SharedInfraStack-prod resource count ≤ 200', () => {
    const app = new cdk.App({ context: DUMMY_VPC_CONTEXT });

    const stack = new SharedInfraStack(app, 'TestSharedInfraStackProd', {
      environment: 'prod',
      enableCdn: true,
      env: TEST_ENV,
    });

    const template = Template.fromStack(stack);
    const resourceCount = Object.keys(template.toJSON().Resources || {}).length;

    // Shared infra is stable and should stay well under 200
    expect(resourceCount).toBeLessThanOrEqual(200);
    console.log(`SharedInfraStack-prod resource count: ${resourceCount}/200`);
  });
});
