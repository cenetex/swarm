# Nested Stack Topology

## Overview

As of v0.27.0, the production `SwarmApi-prod` stack uses **nested stacks** to stay under CloudFormation's 500-resource hard limit.

### Resource Count Problem

The monolithic `SwarmApi-prod` stack reached **511 resources** before the split:
- 118 AWS::Lambda::Permission resources
- 109 AWS::ApiGatewayV2::Route resources
- 53 AWS::IAM::Policy resources
- 49 AWS::CloudWatch::Alarm resources
- 40 AWS::Lambda::Function resources
- 30 AWS::IAM::Role resources

CloudFormation deployment failed with:
```
Template error: instance of Cfn" value must have member which name is one of "AWSTemplateFormatVersion", "Description", "Metadata", ... at /#: TooManyResourcesInStack
```

### Solution: Nested Stacks

**SharedHandlersStack** (nested) contains:
- All shared multi-tenant Lambda functions (MessageProcessor, ResponseSender, MediaProcessor, TweetSender, etc.)
- Shared queues (message, response, media, post)
- Dead-letter queues (dlq, scheduler dlq)
- Event source mappings for SQS→Lambda
- Related IAM policies, roles, log groups, and alarms

This reduces the top-level **SwarmApi-prod** resource count to ~350, maintaining a safety buffer below 500.

## Stack Hierarchy

```
SwarmApi-prod (top-level)
└── SharedHandlersNestedStack (nested)
    └── SharedHandlers (construct)
        ├── SQS Queues (message, response, media, post, dlq, scheduler dlq)
        ├── Lambda Functions (MessageProcessor, ResponseSender, MediaProcessor, etc.)
        ├── Event Source Mappings
        ├── IAM Roles & Policies
        ├── CloudWatch Log Groups
        └── CloudWatch Alarms (~22 alarms)
```

## Logical IDs and Replacement

### Preserving Logical IDs

The nested stack **does not change the logical IDs** of resources within SharedHandlers. When `cdk diff` is run against an existing environment:
- Nested stack creation does NOT trigger resource replacement for retained resources (DynamoDB tables, S3 buckets)
- SQS queues and Lambda functions retain their original names and identities
- No downtime or data loss during deployment

### Why Logical IDs Matter

CloudFormation matches resources by logical ID + stack. When moving a resource from top-level to nested:
- Old logical ID: `SharedHandlers3A4F1B2C` (in SwarmApi-prod)
- New logical ID: `SharedHandlers3A4F1B2C` (in SwarmApi-prod → SharedHandlersNestedStack)

Since the construct ID (`'SharedHandlers'`) and property chains are identical, CDK generates the same logical ID, preventing replacement.

## Deployment Flow

### Staging (useExistingResources=true)

1. SharedInfraStack deploys first (DynamoDB, S3, layer, etc.)
2. AdminApiStack + SharedHandlersNestedStack deploy in parallel
3. Nested stack resources reuse existing table/bucket names without recreation
4. No import-export dependency — resources reference by name/ARN directly

### Production

Same flow as staging. Nested stack respects existing resource retention attributes.

## Backward Compatibility

AdminApiStack provides a deprecated getter:

```typescript
get sharedHandlers() {
  return this.sharedHandlersStack?.sharedHandlers;
}
```

Existing code accessing `adminApiStack.sharedHandlers` continues to work. New code should use `adminApiStack.sharedHandlersStack?.sharedHandlers` directly.

## Monitoring & Alarms

All CloudWatch alarms from SharedHandlers are still present in the nested stack. Alarms remain wired to the SNS topic for notifications. OpsDashboard queries both top-level and nested stack resources:

- Shared handler functions: messageProcessor, responseSender, mediaProcessor, tweetSender, telegramWebhook
- Shared queues: messageQueue, responseQueue, mediaQueue, postQueue
- Shared DLQs: dlq, schedulerDlq

## Future Expansion

If top-level `SwarmApi-prod` again approaches 450 resources, AdminApiConstruct (API Gateway routes, admin Lambda handlers) can be moved to a second nested stack following the same pattern.

## References

- Issue: #1353 (unblock prod deploy)
- Related: #1352 (release preflight fix)
- CloudFormation nested stack limit: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html
