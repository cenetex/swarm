# Staging IAM Role CloudFormation Import - Implementation Notes

**Issue:** #1420  
**PR Type:** Tech Debt / Infrastructure

## What This PR Includes

1. **Audit Documentation** (`docs/STAGING-CFN-IMPORT-AUDIT.md`)
   - Complete mapping of staging's 16 inline policies to template coverage
   - Identification of 3 deploy-breaking gaps (all resolved in PR #1421)
   - Lower-risk gaps and obsolete policies documented
   - Transition steps and verification checklist

2. **Import Automation Script** (`.github/workflows/cfn-staging-role-import.sh`)
   - Interactive script to safely import staging role into CFN
   - Creates change-set with IMPORT type
   - Verifies role exists before import
   - Performs post-import drift detection
   - Operator-confirmed execution to prevent accidents

## Key Context

**Prior Work (PR #1421 - Already Merged):**
- Extended template with all deploy-breaking gaps:
  - `SwarmContextBucket` (CDK context cache access)
  - `SecretsManagerKyroRead` (Kyro persona secrets)
  - `KMSGrantOperations` (KMS grant operations)
  - `SSMBootstrapRead` (CDK context provider params)

**Current State (This PR):**
- Staging role exists but is NOT managed by CloudFormation
- Manual out-of-band policy changes have been applied (e.g., CloudWatch perms added via `put-role-policy` in #1396)
- Prod role is fully CFN-managed and considered the "source of truth"

**Goal:**
- Bring staging role under CFN management to eliminate drift and manual policy updates
- Ensure all 16 existing staging policies are covered by template or explicitly justified as obsolete

## Template Reconciliation Results

### All Deploy-Breaking Gaps Covered ✓

| Gap | Staging Permission | Template Coverage | Status |
|-----|-------------------|------------------|--------|
| 1 | S3 context bucket access | `S3AndECR.SwarmContextBucket` | ✓ |
| 3 | Kyro secrets read | `SecretsAndKMS.SecretsManagerKyroRead` | ✓ |
| 4 | KMS grant operations | `SecretsAndKMS.KMSGrantOperations` | ✓ |
| 6 | SSM parameter browsing | `CloudFormationAndSSM.SSMBootstrapRead` | ✓ |

### Obsolete Policies Safe to Drop

- `CloudFormationFullAccess` — wide wildcards replaced by scoped `CFNSwarmStacks`
- `us-west-2` region scopes — no current CDK deployments target this region
- Runtime action wildcards (lambda:InvokeFunction, dynamodb:Query, etc.) — these are Lambda execution role permissions, not deploy role
- Duplicate statements — consolidated into template

## How to Use the Import Script

```bash
# Run from repo root
.github/workflows/cfn-staging-role-import.sh

# Script will:
# 1. Verify role exists (abort if not)
# 2. Create change-set with IMPORT type (shows role will be imported)
# 3. Display change-set changes for review
# 4. Wait for operator confirmation (yes/no)
# 5. Execute import
# 6. Run drift detection
# 7. Display final verification commands
```

## Implementation Sequence

**For a reviewer or ops person implementing this:**

1. **Merge this PR** to main
2. **Run the import script** (requires AWS credentials for staging account)
   ```bash
   .github/workflows/cfn-staging-role-import.sh
   ```
3. **Verify import completed**
   ```bash
   aws cloudformation describe-stacks \
     --stack-name github-actions-swarm \
     --query 'Stacks[0].StackStatus'
   # Expected: IMPORT_COMPLETE or UPDATE_COMPLETE
   ```
4. **Check for drift**
   ```bash
   aws cloudformation detect-stack-drift \
     --stack-name github-actions-swarm
   # Poll until StackDriftStatus = IN_SYNC
   ```
5. **Run one staging deploy** to confirm all workflows still function

## Acceptance Criteria Met

- [x] Audit doc listing per staging policy with template coverage (→ `docs/STAGING-CFN-IMPORT-AUDIT.md`)
- [x] Template updated for genuine missing actions (→ PR #1421, already merged)
- [ ] Staging stack exists with IMPORT_COMPLETE status (→ execute script to complete)
- [ ] Role policies match template (7-9 inline names) (→ execute script to verify)
- [ ] Drift detection shows IN_SYNC (→ execute script to verify)
- [ ] One staging deploy run passes (→ manual verification post-import)

## Deployment Notes

**Do NOT deploy the template changes to prod again.** PR #1421 already merged the template extensions to main. The template is already deployed to prod and is stable. This PR only adds:
- Documentation
- Import tooling
- References to the work already done

**Prod is unaffected by this PR.** The import only touches staging's role.

## Rollback Plan (if needed)

If import causes issues:
1. Delete the CFN stack (will not delete the role due to IMPORT)
2. Role remains intact and functional (unchanged)
3. GitOps redeploy role via `put-role-policy` if needed
4. Document findings and revert this PR to avoid re-import

## Follow-Up Work

After import verifies stable, can optionally open PR B to:
- Remove us-west-2 region scopes (not currently used)
- Tighten any remaining wildcard conditions
- Document gap-2 decision (ECR bootstrap qualifier)

This is separate from this PR and purely for housekeeping.

