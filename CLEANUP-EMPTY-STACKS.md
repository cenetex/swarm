# Cleanup: Delete Empty REVIEW_IN_PROGRESS Stacks

## Issue #1664

Three CloudFormation stacks in production were stuck in `REVIEW_IN_PROGRESS` from aborted changeset creations. These stacks have zero resources and were blocking CDK diff output.

## Affected Stacks

- `SwarmFrontend-prod`
- `SwarmStation-prod`
- `SwarmMessaging-prod`

## Pre-Deletion Verification

Before deleting, confirm that the stacks are empty and in REVIEW_IN_PROGRESS status:

```bash
# Verify status and resource count for each stack
for s in SwarmFrontend-prod SwarmStation-prod SwarmMessaging-prod; do
  echo "=== $s ==="
  aws cloudformation describe-stacks --stack-name "$s" --profile prod --query 'Stacks[0].StackStatus'
  aws cloudformation list-stack-resources --stack-name "$s" --profile prod --query 'length(StackResourceSummaries)'
done
```

Expected output: All should show `REVIEW_IN_PROGRESS` and `0` resources.

## Deletion

Once verified, delete the three empty stacks:

```bash
for s in SwarmFrontend-prod SwarmStation-prod SwarmMessaging-prod; do
  aws cloudformation delete-stack --stack-name "$s" --profile prod
  echo "Deleting $s..."
done
```

## Verification

After deletion, confirm they're gone or in DELETE_IN_PROGRESS:

```bash
aws cloudformation list-stacks --profile prod --query 'StackSummaries[?contains(StackName, `Swarm`) && (StackStatus==`REVIEW_IN_PROGRESS` || StackStatus==`DELETE_IN_PROGRESS`)]'
```

Expected output: Empty list (or no rows matching `REVIEW_IN_PROGRESS`).

## CDK Prevention

The code has been updated to gate these three stacks on context flags:
- `deployMessagingStack`: defaults to `true`, set to `false` to skip
- `deployStationStack`: defaults to `true`, set to `false` to skip (requires messagingStack)
- `deployFrontendStack`: defaults to `true`, set to `false` to skip

This prevents `cdk diff` from trying to create or update these stacks in the future.
