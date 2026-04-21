/**
 * SharedHandlersStack (Nested) — Phase 1 skeleton only
 *
 * Foundation for phased migration of SharedHandlers resources (SQS queues,
 * Lambda functions, log groups, alarms) out of AdminApiStack to reduce the
 * top-level CloudFormation resource count from 511 to ≤450 (well under the
 * 500-resource hard limit that blocks prod deploys).
 *
 * Why this isn't wired up yet:
 *   PR #1427 attempted a single-shot nested-stack migration and failed with
 *   `AlreadyExists` because CloudFormation tried to CREATE the new named
 *   queues and DELETE the old ones in a single changeset. #1434 reverted it.
 *   This file is Phase 1 of the replacement plan: publish the class so
 *   downstream slices can reference it, but do NOT instantiate anything
 *   inside it yet — otherwise we'd duplicate every resource in the stack.
 *
 * Phased rollout (see docs/infra/PHASED-MIGRATION-RUNBOOK.md):
 *   - Phase 1 (this PR): stack class exists, parent keeps using
 *     `new SharedHandlers(this, ...)` directly. Zero resource delta.
 *   - Phase 2: add `RemovalPolicy.RETAIN` to the first batch of named
 *     resources in the parent stack and deploy so the retention takes effect.
 *   - Phase 3: remove those resources from the parent template and adopt
 *     them into this nested stack via `cdk import`. Because they were
 *     retained in Phase 2, no create/delete collision occurs.
 *   - Repeat Phases 2+3 for remaining batches (~25 resources per slice).
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as sns from 'aws-cdk-lib/aws-sns';

export interface SharedHandlersStackProps extends cdk.NestedStackProps {
  environment: string;
  nameSuffix?: string;
  dependencyLayer?: lambda.ILayerVersion;
  stateTable: dynamodb.ITable;
  activityTable: dynamodb.ITable;
  mediaBucket: s3.IBucket;
  adminTable?: dynamodb.ITable;
  cdnUrl?: string;
  replicateApiKeyArn?: string;
  secretPrefix?: string;
  twitterApiTier?: 'free' | 'basic';
  twitterMonthlyBudget?: number;
  twitterDailyReservePct?: number;
  internalTestKey?: string;
  alarmTopic?: sns.ITopic;
  raticrossInboundKey?: string;
  heliusApiKey?: string;
  heliusApiKeyArn?: string;
}

/**
 * Phase 1 skeleton. Intentionally empty — no constructs are instantiated
 * here until Phase 3 of the migration runbook. Parent AdminApiStack
 * continues to instantiate SharedHandlers directly.
 */
export class SharedHandlersStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: SharedHandlersStackProps) {
    super(scope, id, {
      ...props,
      description: `Shared Handlers (Nested) Stack for ${props.environment} — Phase 1 skeleton`,
    });
    // Props accepted to stabilize the public shape, but no child constructs
    // are created yet. See docs/infra/PHASED-MIGRATION-RUNBOOK.md.
  }
}
