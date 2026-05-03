# Staging Swarm Shutdown — Runbook (2026-04-25)

One-shot operational doc to fully retire the `Swarm*-staging` CloudFormation stacks in account `022118847419`.
Estimated runtime end-to-end: 30–45 minutes. Estimated savings: ~$85–95/mo.

> **Stop conditions** are flagged with `🛑`. Don't push past one without resolving.

---

## 0 · Setup

```bash
# Sanity-check identity. Should be the staging SSO operator (account 022118847419).
aws sts get-caller-identity

# Pin region for the whole session.
export AWS_REGION=us-east-1
export AWS_PAGER=""

# Snapshot the current cost baseline so the savings claim can be verified later.
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -v-1d +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY --metrics UnblendedCost \
  --query "ResultsByTime[*].[TimePeriod.Start,Total.UnblendedCost.Amount]" \
  --output text | tee /tmp/staging-cost-baseline.txt
```

---

## 1 · Pre-flight (do not skip)

### 1.1 — Confirm zero cross-stack imports

```bash
for E in $(aws cloudformation list-exports \
  --query "Exports[?contains(Name,'staging') && (contains(Name,'swarm') || contains(Name,'Swarm'))].Name" \
  --output text); do
  IMP=$(aws cloudformation list-imports --export-name "$E" 2>&1 | grep -v ValidationError || true)
  [ -n "$IMP" ] && echo "🛑 $E imported by: $IMP"
done
```

🛑 **Stop** if any import is found. Resolve before proceeding.

Verified clean as of 2026-04-25 — every `swarm-*-staging` export is unused.

### 1.2 — Verify `SwarmAdmin-staging` removal policy in CDK

```bash
cd ~/develop/aws-swarm
git pull
grep -rE "SwarmAdmin|removalPolicy|RemovalPolicy" packages/infra/lib/swarm-stack.ts | head -30
```

🛑 **Stop** if `SwarmAdmin-staging` is `RemovalPolicy.DESTROY`. Either:
- Change to `RETAIN` in a quick PR + deploy first, or
- Skip step 5 of this runbook (leave `SwarmStack-staging` standing for now).

### 1.3 — Back up the data tables anyway

Cheap insurance regardless of the removal policy.

```bash
TS=$(date -u +%Y%m%dT%H%M)
for T in SwarmAdmin-staging SwarmAdmin-staging-archive swarm-state-staging swarm-activity-staging; do
  aws dynamodb create-backup \
    --table-name "$T" \
    --backup-name "pre-staging-shutdown-${TS}" \
    --query "BackupDetails.[BackupArn,BackupStatus]" --output text
done
```

Save the printed BackupArns somewhere durable (1Password / sticky note). Recovery via `restore-table-from-backup`.

### 1.4 — Empty the S3 buckets (CDK won't delete a non-empty bucket)

```bash
for B in swarm-admin-ui-staging-split-022118847419 \
         swarm-cdn-logs-staging-022118847419 \
         swarm-docs-site-staging-split-022118847419 \
         swarm-media-staging-022118847419; do
  echo "Emptying $B"
  aws s3 rm "s3://$B" --recursive --quiet || echo "  (already empty or error)"
done
```

Note: `swarm-media-staging-…` had **507 objects**. Confirm you don't need any of that media first. If unsure: `aws s3 sync s3://swarm-media-staging-022118847419 ./swarm-media-staging-backup/`.

🛑 If any bucket has versioning on, `s3 rm` won't delete versions — use `aws s3api delete-objects` with version IDs, or set lifecycle to expire all versions immediately and wait.

### 1.5 — Capture the active stack list (so you can diff after)

```bash
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?contains(StackName,'Swarm') || contains(StackName,'swarm')].StackName" \
  --output text | tee /tmp/staging-swarm-stacks-before.txt
```

Expected:
```
SwarmApi-staging
SwarmDocsSite-staging
SwarmShared-staging
SwarmStack-staging
SwarmUi-staging
```

---

## 2 · Tear-down sequence

Run from `~/develop/aws-swarm`. Each step uses `aws cloudformation delete-stack` directly because the legacy CDK code may not synth cleanly anymore — going via the CFN API is simpler and equally safe given there are no cross-stack deps.

### 2.1 — SwarmDocsSite-staging (smallest, safest first)

```bash
aws cloudformation delete-stack --stack-name SwarmDocsSite-staging
aws cloudformation wait stack-delete-complete --stack-name SwarmDocsSite-staging \
  && echo "✓ SwarmDocsSite-staging gone"
```

Resources: 9. Stateful: 1 S3 bucket (already emptied in 1.4).

### 2.2 — SwarmUi-staging

```bash
aws cloudformation delete-stack --stack-name SwarmUi-staging
aws cloudformation wait stack-delete-complete --stack-name SwarmUi-staging \
  && echo "✓ SwarmUi-staging gone"
```

Resources: 10. Stateful: 1 S3 bucket (already emptied).

### 2.3 — SwarmApi-staging

```bash
aws cloudformation delete-stack --stack-name SwarmApi-staging
aws cloudformation wait stack-delete-complete --stack-name SwarmApi-staging \
  && echo "✓ SwarmApi-staging gone"
```

Resources: 100. Stateless. Expect this one to take longest (~8–12 min) due to API Gateway + many Lambdas + IAM cleanup.

🛑 If `wait` times out: check `aws cloudformation describe-stack-events --stack-name SwarmApi-staging --query "StackEvents[?ResourceStatus=='DELETE_FAILED']"`. Common cause: a Lambda has an ENI in a VPC that's still attached. Force-delete the ENI: `aws ec2 describe-network-interfaces --filters Name=description,Values="*Lambda*"` then `delete-network-interface`.

### 2.4 — SwarmShared-staging

```bash
aws cloudformation delete-stack --stack-name SwarmShared-staging
aws cloudformation wait stack-delete-complete --stack-name SwarmShared-staging \
  && echo "✓ SwarmShared-staging gone"
```

Resources: 5 (SSM param, SNS topic, SNS sub, Lambda layer, CDK metadata).

### 2.5 — SwarmStack-staging (the big one with the DDB table)

🛑 **Re-confirm pre-flight 1.2 before continuing.** If `SwarmAdmin-staging` is `RemovalPolicy.DESTROY`, skip this step entirely and leave the stack alone.

```bash
# Final size check before destroying.
aws dynamodb describe-table --table-name SwarmAdmin-staging \
  --query "Table.[ItemCount,TableSizeBytes]" --output text

aws cloudformation delete-stack --stack-name SwarmStack-staging
aws cloudformation wait stack-delete-complete --stack-name SwarmStack-staging \
  && echo "✓ SwarmStack-staging gone"
```

If `RemovalPolicy.RETAIN` is set on the DDB table, CFN will silently leave it behind (it becomes orphan, see step 3.1). All other ~100 resources go.

---

## 3 · Post-shutdown orphan cleanup

These are NOT in any stack and won't auto-delete.

### 3.1 — DynamoDB tables

```bash
# Verify nothing's reading from these (last 7d table activity).
for T in SwarmAdmin-staging SwarmAdmin-staging-archive swarm-state-staging swarm-activity-staging; do
  aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB \
    --metric-name ConsumedReadCapacityUnits \
    --dimensions Name=TableName,Value="$T" \
    --start-time $(date -u -v-7d +%Y-%m-%dT%H:%M:%S) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
    --period 604800 --statistics Sum \
    --query "[Datapoints[0].Sum, '$T']" --output text
done
```

If all are `None`/0, delete:

```bash
for T in SwarmAdmin-staging SwarmAdmin-staging-archive swarm-state-staging swarm-activity-staging; do
  aws dynamodb delete-table --table-name "$T" \
    --query "TableDescription.TableStatus" --output text
done
```

(Backups from step 1.3 keep the data recoverable for 35 days by default.)

### 3.2 — S3 buckets

After step 2 destroyed the stacks, the buckets may already be gone. If `RetainOnDelete` was set:

```bash
for B in swarm-admin-ui-staging-split-022118847419 \
         swarm-cdn-logs-staging-022118847419 \
         swarm-docs-site-staging-split-022118847419 \
         swarm-media-staging-022118847419; do
  if aws s3api head-bucket --bucket "$B" 2>/dev/null; then
    aws s3 rm "s3://$B" --recursive --quiet
    aws s3api delete-bucket --bucket "$B" && echo "✓ deleted $B"
  fi
done
```

### 3.3 — Secrets Manager (~78 staging swarm secrets)

Use the **7-day recovery window** (default) so any mistake is reversible.

```bash
# List candidates first.
aws secretsmanager list-secrets \
  --query "SecretList[?starts_with(Name,'swarm/') || starts_with(Name,'swarm-split/')].[Name,LastAccessedDate]" \
  --output text | tee /tmp/staging-secrets-to-delete.txt

# Eyeball the list. Then delete with recovery window.
for S in $(awk '{print $1}' /tmp/staging-secrets-to-delete.txt); do
  aws secretsmanager delete-secret --secret-id "$S" \
    --recovery-window-in-days 7 \
    --query "Name" --output text
done
```

🛑 **Do NOT touch** anything starting with `cenetex/`, `litigation/`, or `kyro/` — those are unrelated. The query above already scopes to `swarm/`-prefixed only.

If you mess up: `aws secretsmanager restore-secret --secret-id <name>` within 7 days.

### 3.4 — CloudWatch log groups

```bash
# Show what's left.
aws logs describe-log-groups \
  --query "logGroups[?contains(logGroupName,'Swarm') || contains(logGroupName,'swarm')].[logGroupName,storedBytes]" \
  --output text | sort -k2 -nr | head -30

# Delete the swarm-* and Swarm*-staging log groups.
aws logs describe-log-groups \
  --query "logGroups[?starts_with(logGroupName,'/aws/lambda/swarm-') || starts_with(logGroupName,'/aws/lambda/Swarm') || starts_with(logGroupName,'/aws/apigateway/Swarm')].logGroupName" \
  --output text | tr '\t' '\n' | while read LG; do
    [ -n "$LG" ] && aws logs delete-log-group --log-group-name "$LG" && echo "✓ $LG"
  done
```

🛑 The `/aws/lambda/swarm-*` prefix could collide with anything else named `swarm-*` — re-read the list first to make sure nothing surprising is in scope. Run the `describe` query, eyeball, **then** the delete query.

### 3.5 — Lambda layer versions

```bash
# Old versions of swarm-deps-staging accumulate one per deploy; only the newest is used.
aws lambda list-layer-versions --layer-name swarm-deps-staging \
  --query "LayerVersions[*].[Version]" --output text \
  | tr '\t' '\n' | while read V; do
    aws lambda delete-layer-version --layer-name swarm-deps-staging --version-number "$V" \
      && echo "✓ swarm-deps-staging:$V deleted"
  done
```

(After SwarmShared-staging is destroyed, the layer itself may already be gone — this just cleans residual versions.)

### 3.6 — WAF rules

```bash
aws wafv2 list-web-acls --scope REGIONAL \
  --query "WebACLs[?contains(Name,'Swarm') || contains(Name,'swarm')].[Name,Id]" \
  --output text
```

If anything's listed, manually inspect & remove via the console — WAF rule removal is fiddly to script and the savings are small (~$8-10/mo).

---

## 4 · Verification

### 4.1 — Confirm stacks are gone

```bash
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?contains(StackName,'Swarm') || contains(StackName,'swarm')].StackName" \
  --output text | tee /tmp/staging-swarm-stacks-after.txt
```

Expected: empty output, or only stacks that were intentionally retained.

### 4.2 — Confirm no Swarm Lambdas remain

```bash
aws lambda list-functions \
  --query "Functions[?contains(FunctionName,'Swarm') || starts_with(FunctionName,'swarm-')].FunctionName" \
  --output text
```

Expected: empty.

### 4.3 — Cost re-check (T+24h)

```bash
# Run this 24h after shutdown.
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -v-1d +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity DAILY --metrics UnblendedCost \
  --query "ResultsByTime[*].[TimePeriod.Start,Total.UnblendedCost.Amount]" \
  --output text
```

Expected daily spend: was ~$13/day (April average), should drop to ~$10/day. Full month bill should land around **$310/mo** instead of $403/mo. Tax accrues separately and may smear the picture for a few days.

---

## 5 · Things to leave strictly alone (in this account)

These stacks live in `022118847419` but are **not** part of the swarm shutdown:

| Stack | Purpose | Why keep |
|---|---|---|
| `CDKToolkit` | CDK bootstrap | Needed for any future CDK ops |
| `GitHubAgentStack` | cenetex/agent system | This is your live agent infrastructure! |
| `RatibotStack-prod` | Solana trading bot prod | ⚠️ Yes, prod ratibot is in the staging account |
| `RatibotStack-dev` | Ratibot dev | Active dev environment |
| `CoinRatiChatStack` | coin.rati.chat | Token site |
| `FireHorseStack` | solanafirehorse | Solana tooling |
| `github-actions-oidc-coin-rati-chat` | OIDC for coin-rati-chat CI | |
| `github-oidc-solanafirehorse` | OIDC for solanafirehorse CI | |

`AmazonWorkMail` for the `rati` org also lives in this account. Keep it.

---

## 6 · Rollback (if you need to undo)

The destructive steps and their reversibility:

| Action | Reversible? | How |
|---|---|---|
| `delete-stack` | Yes, while stack still exists | None — once `DELETE_COMPLETE`, must re-deploy from CDK |
| DDB `delete-table` | Yes for 35d | `restore-table-from-backup` using ARN from step 1.3 |
| S3 `delete-bucket` | Yes if recreated within 24h | Bucket name stays globally reserved briefly; just re-deploy |
| Secrets `delete-secret` (with `--recovery-window-in-days 7`) | Yes within 7d | `restore-secret --secret-id <name>` |
| Log group `delete-log-group` | No | Logs are gone |
| Lambda layer version delete | No | Re-publish on next deploy |

Most likely failure mode: `SwarmApi-staging` delete hangs on stuck Lambda ENIs. Resolution scripted in 2.3. If you abort mid-tear-down, CFN will park the stack in `DELETE_FAILED` — re-run `delete-stack`, possibly with `--retain-resources <id>` for the offender.

---

## 7 · After everything is done

- Update `~/develop/CLAUDE.md` to remove `aws-swarm-staging` references if any (none currently).
- Update memory: note that staging swarm-* infrastructure is decommissioned as of 2026-04-25.
- Close out cost-related issues #1587 and #1589 follow-up if applicable.
- Consider whether the agent `cenetex/aws-swarm` repo should default `cdk synth/deploy` only to prod env going forward (so `pnpm cdk deploy` in dev doesn't try to recreate staging).

---

**Author**: investigation 2026-04-25
**Estimated savings**: ~$85-95/mo recurring
**Resources removed**: ~5 stacks, ~225 CFN resources, ~78 secrets, ~30 log groups, hundreds of Lambda layer versions
