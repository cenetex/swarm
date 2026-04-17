# SwarmApi Stack Resource Audit — 2026-04-17

Produced against `packages/infra/cdk.out/SwarmApi-staging.template.json` synthesized from `main` at commit 737f5365.
Production (`SwarmApi-prod`) hit **511 resources** during the v0.27.0 deploy and tripped CloudFormation's 500-resource hard limit. Staging is currently at **496 / 500** — effectively out of headroom.

## Top-level resource counts

| Count | Type |
|------:|------|
| 118 | `AWS::Lambda::Permission` |
| 109 | `AWS::ApiGatewayV2::Route` |
|  50 | `AWS::IAM::Policy` |
|  47 | `AWS::CloudWatch::Alarm` |
|  39 | `AWS::Lambda::Function` |
|  27 | `AWS::IAM::Role` |
|  25 | `Custom::LogRetention` |
|  20 | `AWS::ApiGatewayV2::Integration` |
|  14 | `AWS::SQS::Queue` |
|  12 | `Custom::LogGroupCreate` |
|  12 | `Custom::LogGroupRetention` |
|   8 | `AWS::Lambda::EventSourceMapping` |
|   7 | `AWS::Events::Rule` |
|   2 | `AWS::SQS::QueuePolicy` |
|   1 | `AWS::ApiGatewayV2::Api` / `Stage` / `AWS::Lambda::Url` / `AWS::SSM::Parameter` / `AWS::CloudWatch::Dashboard` / `AWS::CDK::Metadata` |

**Total: 496**

## Construct ownership

| Count | Path | Note |
|------:|------|------|
| 377 | `SwarmApi-staging/AdminApi` | HttpApi + 23 handlers + alarms + IAM |
| 111 | `SwarmApi-staging/SharedHandlers` | 13 lambdas + IAM + alarms + custom log groups |
|   5 | Shared custom-resource providers (`LogRetentionaae0aa3c…`, `AWS679f53fac…`) | Singleton lambdas injected by CDK for Custom:: resources |
|   3 | `ApiEndpointParam`, `OpsDashboard`, `CDKMetadata` | Outputs / metadata |

**AdminApi alone is 76 % of the stack.** Its internal `AdminApi/AdminApi` sub-construct contributes 240 resources — 109 routes × (Route + Lambda Permission) + 20 integrations + API + Stage.

### Route distribution

109 routes by method:

| Count | Method |
|------:|--------|
| 42 | `POST` |
| 39 | `GET` |
| 21 | `OPTIONS` (CORS preflight) |
|  3 | `DELETE` |
|  2 | `PUT` |
|  2 | `PATCH` |

## Quick-win candidates

### 1. Migrate `Custom::LogRetention` → explicit `AWS::Logs::LogGroup` *(safe, high value)*

All 39 lambdas use the deprecated `logRetention` prop. CDK emits `aws-cdk-lib.aws_lambda.FunctionOptions#logRetention is deprecated. use logGroup instead` on every synth. Every such use injects a `Custom::LogRetention` resource plus shares a singleton custom-resource lambda.

- **Current:** 25 `Custom::LogRetention` + 1 shared provider lambda / role / policy (inside `LogRetentionaae0aa3c…` construct — counted as 3 shared resources).
- **Target:** one explicit `AWS::Logs::LogGroup` per lambda with `logGroupName: /aws/lambda/${functionName}`, `retention: <existing>`, `removalPolicy: RETAIN`, then pass it via `logGroup:` on the function. The singleton provider and its IAM vanish.
- **Resource delta:** −25 (LogRetention) − 3 (provider triple) + up to +25 (new LogGroups) = **net −3 at worst, −28 at best** depending on whether `LogGroup` resources are counted (they are, but most lambdas today write to an implicit log group that is NOT in the template).
- **Risk:** must preserve the existing log-group name exactly and set `RETAIN` to avoid destroying production logs; CDK will otherwise collide with the implicit log group created on first invocation.

### 2. Collapse `Custom::LogGroupCreate` + `Custom::LogGroupRetention` pairs *(needs investigation)*

12 pairs of `Custom::LogGroupCreate` / `Custom::LogGroupRetention` suggest a second custom-resource pattern (likely from SharedHandlers — log groups for 12 of the 13 shared lambdas). Same migration approach as (1). Potential savings: **up to −24 resources**.

### 3. Trim OPTIONS preflight routes *(needs product validation)*

21 `OPTIONS` routes are explicit CORS preflight entries. `AWS::ApiGatewayV2::Api` natively supports a single `CorsConfiguration` that handles OPTIONS for every route. If AdminApi already configures CORS at the API level, the explicit OPTIONS routes are duplicate and can be removed.

- **Potential saving:** 21 routes × 3 resources each (Route + Permission + sometimes a separate Integration) ≈ **−42 to −63 resources**.
- **Risk:** behavior divergence on pre-flight origin/header rules — must confirm AdminApi CORS config matches the per-route OPTIONS contract.

### 4. Alarm audit *(low value, keep for later)*

47 alarms, all with `AlarmActions` wired up. No orphan alarms to remove. Breakdown:

| Count | Metric |
|------:|--------|
| 11 | `Errors` |
| 10 | `ApproximateNumberOfMessagesVisible` (queue depth) |
|  8 | `Throttles` |
|  8 | `Duration` |
|  7 | `ApproximateAgeOfOldestMessage` |
|  1 | `InvocationClientErrors`, `EntitlementFallback`, other |

All appear load-bearing for ops. **No quick cuts here.**

## Structural cuts (tracked separately)

- **#1353** — move `SharedHandlers` into a nested stack: frees 111 resources from the top-level budget.
- **#1354** — move `AdminApi` into its own top-level stack: frees 377 resources; largest lever by far.

## Proposed sequencing

1. **This audit doc** (#1355) — land in `docs/infra/`.
2. **Quick wins** (#1355 follow-up PR) — logRetention migration first, then `Custom::LogGroup*` pair, then OPTIONS-route consolidation gated on CORS-config review. Target: 496 → ≤460 in staging (≤475 in prod).
3. **SharedHandlers nested stack** (#1353) — structural, unblocks prod for v0.27.x.
4. **AdminApi top-level stack** (#1354) — durable fix, decouples route-growth pressure from SharedHandlers.

## Reproduction

```bash
cd packages/infra
npx cdk synth --app "npx tsx bin/swarm.ts" \
  -c environment=staging \
  -c useExistingResources=true \
  -c skipDomainAliases=true \
  -c stackHash= \
  SwarmApi-staging

node -e '
const t = require("./cdk.out/SwarmApi-staging.template.json");
const by = {};
for (const r of Object.values(t.Resources)) by[r.Type] = (by[r.Type]||0)+1;
for (const [k,v] of Object.entries(by).sort((a,b)=>b[1]-a[1])) console.log(v, k);
console.log("TOTAL:", Object.keys(t.Resources).length);
'
```

Prod synth currently requires a valid 6-hex `stackHash` (the value `prod00` in `cdk.context.json` fails `normalizeStackHash`'s regex in `packages/infra/bin/swarm.ts:135`). CI passes `-c stackHash=<hex>` explicitly. Staging is representative for audit purposes because SharedHandlers / AdminApi topology is identical across envs.
