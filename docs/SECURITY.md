# Security Policy

This document describes the security practices for the AWS Swarm project.

## Dependency Security

### Automated Audits

The project uses automated dependency security audits in the CI pipeline to detect known vulnerabilities in dependencies.

#### CI Pipeline

Every pull request and push to `main` runs:

```bash
pnpm audit --audit-level=high
```

This command:
- Checks all dependencies (including transitive) against the npm advisory database
- **Fails the build** if high or critical severity vulnerabilities are found
- Reports moderate and low severity issues without failing

#### Severity Levels

| Severity | Action | Description |
|----------|--------|-------------|
| **Critical** | ❌ Fails build | Immediate exploitation risk; requires immediate fix |
| **High** | ❌ Fails build | Serious security risk; blocks merge until resolved |
| **Moderate** | ⚠️ Warning only | Should be addressed but won't block merge |
| **Low** | ℹ️ Info only | Minimal risk; fix when convenient |

### Handling Audit Failures

When the security audit fails in CI, follow these steps:

#### 1. Review the Vulnerability

```bash
# Run audit locally to see details
pnpm audit

# Get detailed report with recommendations
pnpm audit --json
```

#### 2. Attempt Automatic Fix

```bash
# Try automatic fix (updates dependencies)
pnpm audit --fix

# Verify the fix doesn't break anything
pnpm install
pnpm build
pnpm test
```

#### 3. Manual Resolution

If automatic fix doesn't work or breaks functionality:

**Option A: Update the vulnerable package**
```bash
# Update specific package
pnpm update package-name

# Or update all dependencies
pnpm update --latest
```

**Option B: Find alternative package**
- Search for maintained alternatives
- Replace in package.json
- Update code to use new package

**Option C: Override vulnerable transitive dependency**
- Add override to root `package.json`:
```json
{
  "pnpm": {
    "overrides": {
      "vulnerable-package": "fixed-version"
    }
  }
}
```

#### 4. Document Exceptions (Last Resort)

If a vulnerability cannot be fixed immediately (e.g., waiting for upstream fix), a formal security exception must be filed. See [Security Exception Governance](#security-exception-governance) below for the full policy.

**Known Exceptions:**

| Package | CVE | Severity | Issue | Reason | Target Resolution |
|---------|-----|----------|-------|--------|-------------------|
| `bigint-buffer` | CVE-2025-3194 | High (CVSS 7.5) | [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | Package unmaintained; no patched version available (`patched_versions: <0.0.0`). Transitive dep via `@solana/spl-token > @solana/buffer-layout-utils > bigint-buffer`. The vulnerable `toBigIntLE()` function is not called directly by our code. Even the latest `@solana/spl-token@0.4.14` still depends on this package. Risk accepted: DoS-only impact (CWE-120), no data exfiltration, and the function is only reachable with attacker-controlled buffer sizes in the Solana token layout path. | Re-evaluate 2026-05-01 or when `@solana/spl-token` removes `bigint-buffer` dependency |

**Resolved CVEs (previously ignored):**

| Package | CVE | Resolution | Date |
|---------|-----|------------|------|
| `ajv` (via eslint) | CVE-2025-69873 | Fixed via pnpm override `ajv@^6: 6.14.0`. The vulnerable ajv 6.12.6 was a transitive dependency of eslint (dev-only). ReDoS only exploitable when `$data: true` option is used, which this project does not do, but the override eliminates the vulnerability entirely. | 2026-02-20 |
| `bn.js` (via @solana/web3.js) | CVE-2026-2739 | Fixed via pnpm override `bn.js: 5.2.3`. Infinite loop when calling `maskn(0)`. | 2026-02-20 |

---

## Security Exception Governance

Security exceptions are temporary risk acceptances for known vulnerabilities that cannot be immediately remediated. Every exception is tracked in a machine-readable registry, has an owner, carries an expiry date, and is subject to automated and manual review.

**No permanent waivers.** Every exception must expire and be re-evaluated.

### Where Exceptions Are Tracked

| Artifact | Location | Purpose |
|----------|----------|---------|
| Exception registry | [`.audit-exceptions.json`](../.audit-exceptions.json) | Machine-readable source of truth for all active, expired, and resolved exceptions |
| Registry schema | [`.audit-exceptions.schema.json`](../.audit-exceptions.schema.json) | JSON Schema defining required fields and validation rules |
| Validation script | [`scripts/validate-security-exceptions.mjs`](../scripts/validate-security-exceptions.mjs) | Validates registry entries, checks expiry, outputs CI annotations |
| Automated workflow | [`.github/workflows/security-exceptions.yml`](../.github/workflows/security-exceptions.yml) | Weekly Monday 09:00 UTC automated validation; creates issues for expired/expiring entries |
| Governance rules | [CLAUDE.md](../CLAUDE.md) | WIP caps, priority order, and lifecycle rules |

### Required Fields

Every exception entry in `.audit-exceptions.json` must include these fields (enforced by the schema and validation script):

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (pattern: `SE-NNN`) | Unique identifier for the exception |
| `advisory` | `string` | GHSA or CVE identifier |
| `package` | `string` | Affected npm package name |
| `severity` | `enum` | `low`, `moderate`, `high`, or `critical` |
| `owner` | `string` | Team or person responsible for reviewing and remediating this exception |
| `rationale` | `string` (min 10 chars) | Why this exception is acceptable (risk assessment) |
| `mitigation` | `string` (min 10 chars) | What compensating controls are in place |
| `expiry` | `date` (YYYY-MM-DD) | When this exception expires and must be re-evaluated |
| `reviewCadence` | `enum` | `weekly`, `monthly`, or `quarterly` |
| `status` | `enum` | `active`, `expired`, or `resolved` |

Optional but recommended fields: `cve`, `npmAdvisoryId`, `title`, `installedVersion`, `dependencyChain`, `affectedPackages`, `mitigations` (array), `dateAdded`, `lastReviewed`, `reviewBy`, `reason` (detailed), `resolvedDate`, `resolvedReason`.

### Review Cadence

| Frequency | Activity | Mechanism |
|-----------|----------|-----------|
| **Weekly (Monday 09:00 UTC)** | Automated validation of all registry entries. Expired or expiring-within-14-days entries trigger a `type:security` + `priority:high` GitHub issue. | [`.github/workflows/security-exceptions.yml`](../.github/workflows/security-exceptions.yml) |
| **Weekly (Monday triage)** | Leadership reviews any open security exception issues during triage. Exception count is a scorecard metric. | Monday triage cadence |
| **Per-exception cadence** | Each exception defines its own `reviewCadence` (weekly, monthly, or quarterly). The `lastReviewed` and `reviewBy` fields track compliance. | Registry entry fields |
| **On every PR** | `pnpm audit --audit-level=high` runs in CI. New high/critical findings that are not covered by an active exception block the merge. | CI pipeline (`ci.yml`) |

### Exception Lifecycle

```
1. REQUEST     2. REVIEW      3. APPROVE     4. MONITOR     5. EXPIRE/RESOLVE
   |              |              |              |              |
   Open issue     Reviewer       Add to         Weekly         Renew with new
   with details   validates      registry       workflow       justification
   + proposed     risk           with expiry    validates      OR resolve
   expiry                                       entries        (remove/fix)
```

#### 1. Request

Open a GitHub issue with label `type:security` containing:

- **Vulnerability details**: CVE/GHSA ID, affected package, severity, dependency chain
- **Risk assessment**: What is the actual exposure? Is the vulnerable code path reachable?
- **Mitigations**: What compensating controls reduce the risk?
- **Proposed expiry**: Maximum 90 days for high/critical, 180 days for moderate/low
- **Remediation plan**: What would resolve this permanently? (upstream fix, package replacement, etc.)

#### 2. Review

A security-aware reviewer (or leadership during triage) validates:

- The risk assessment is accurate and complete
- Mitigations are sufficient for the accepted risk level
- The proposed expiry is appropriate for the severity
- A remediation plan exists (even if it depends on an upstream fix)

#### 3. Approve and Register

The exception is added to `.audit-exceptions.json` following the schema. The PR adding the exception requires normal review. The `ignoredAdvisories` array is updated if the exception should suppress `pnpm audit` failures.

#### 4. Monitor

- The weekly automated workflow checks all entries
- Entries expiring within 14 days generate warnings
- The exception owner is responsible for periodic manual review per the defined `reviewCadence`
- After each review, update `lastReviewed` and `reviewBy` in the registry

#### 5. Expire or Resolve

When an exception expires:

- The automated workflow creates a `type:security` + `priority:high` GitHub issue
- The exception **must** be either:
  - **Renewed**: Update `expiry` with a new date and provide fresh justification (the old rationale is not sufficient -- explain what changed or why more time is needed)
  - **Resolved**: Set `status: "resolved"`, add `resolvedDate` and `resolvedReason`, remove the advisory from `ignoredAdvisories`
- Expired exceptions that are not addressed within 7 days are escalated (see below)

### Maximum Expiry Durations

| Severity | Maximum Expiry | Renewal Limit |
|----------|---------------|---------------|
| **Critical** | 30 days | 2 renewals, then escalate to leadership for override |
| **High** | 90 days | 3 renewals, then escalate |
| **Moderate** | 180 days | No hard limit, but must show progress each renewal |
| **Low** | 365 days | No hard limit |

### Escalation Procedures for Stale Exceptions

An exception becomes "stale" when it expires and is not acted upon within the defined window.

| Trigger | Timeline | Action |
|---------|----------|--------|
| Exception expires | Day 0 | Automated workflow creates `type:security` + `priority:high` issue |
| No action on expired exception | Day 7 | Owner is pinged on the issue. Exception is flagged in the next Monday triage review. |
| Still no action | Day 14 | Leadership escalation: the exception is added to the Monday triage agenda as a blocking item. No new feature work may start until addressed. |
| Still no action | Day 21 | The exception blocks the next production release (Release Gate G4 in [RELEASE-GATES.md](./RELEASE-GATES.md)). |
| Renewal limit exceeded | On renewal attempt | Escalate to leadership. Requires leadership sign-off with documented justification for continued acceptance. |

### Closure Criteria

An exception may be marked `resolved` when ANY of these conditions is met:

1. **Upstream fix available**: The vulnerable package has a patched version, and the project has upgraded to it.
2. **Dependency removed**: The affected package is no longer in the dependency tree.
3. **Alternative adopted**: The vulnerable dependency has been replaced with a secure alternative.
4. **Risk eliminated**: Architecture changes have made the vulnerable code path unreachable (must be verified, not assumed).

When closing an exception:

```json
{
  "status": "resolved",
  "resolvedDate": "2026-MM-DD",
  "resolvedReason": "Upgraded @solana/spl-token to v0.5.0 which removes bigint-buffer dependency"
}
```

Remove the advisory from the `ignoredAdvisories` array and verify `pnpm audit` passes cleanly.

### Local Validation

Run the validation script locally before submitting PRs that modify the registry:

```bash
# Validate all entries, warn on expiring-within-30-days
node scripts/validate-security-exceptions.mjs

# Use a shorter warning window (14 days, matches CI)
node scripts/validate-security-exceptions.mjs --warn-days 14

# CI mode (emits GitHub Actions annotations)
node scripts/validate-security-exceptions.mjs --warn-days 14 --ci
```

Exit code 0 means all entries are valid. Exit code 1 means expired entries or schema errors exist.

### Dependency Update Strategy

1. **Regular Updates**: Review and update dependencies monthly
2. **Security Updates**: Apply security patches immediately
3. **Version Pinning**: Use exact versions in `pnpm-lock.yaml` (committed to git)
4. **Testing**: Always test after dependency updates

### Automated Dependency Updates

Consider enabling automated dependency updates:

**Dependabot** (GitHub native):
```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
```

**Renovate** (more configurable):
```json
{
  "extends": ["config:base"],
  "schedule": ["before 3am on Monday"],
  "vulnerabilityAlerts": {
    "enabled": true
  }
}
```

## Reporting Security Vulnerabilities

**DO NOT** open public GitHub issues for security vulnerabilities.

Instead, please report security issues by contacting the project maintainers through GitHub's private vulnerability reporting feature or by email to the repository owner.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We aim to respond within 48 hours.

## Secrets Manager Lifecycle

Avatar secrets stored in AWS Secrets Manager under the `swarm/` prefix are subject to lifecycle management rules:

### Creation
- Per-avatar secrets follow the pattern: `swarm/<avatarId>/<secret-name>` (e.g., `swarm/agent-1-abc/telegram_bot_token`)
- Secrets are created by the admin API during avatar setup
- Shared platform secrets use: `swarm/global/<secret-name>` or `swarm/<environment>/<secret-name>`

### Monitoring
- Use `scripts/audit-secrets.sh <env>` to list all secrets with:
  - Last access date (helps identify stale secrets)
  - Extracted avatar ID (for matching against active avatars)
  - Orphan detection (secrets without matching active avatars)
- Run monthly to identify candidates for cleanup

### Cleanup
**Rule:** When an avatar is deleted or archived, all associated secrets must be removed within 30 days.

- Secrets without a matching active avatar in the state table are cleanup candidates
- Cleanup is **never automatic** — always requires explicit human review
- Track secrets pending deletion with `scripts/audit-secrets.sh` output and cross-reference GitHub issues
- When deleting secrets, document the avatar ID and reason in the commit message

### Cost Impact
- Each secret costs $0.40/month
- Orphaned secrets accumulate ~$40/mo in staging, $40+/mo in prod
- Regular cleanup is required for cost hygiene

---

## Security Best Practices

### Code Security

1. **No Secrets in Code**: Use AWS Secrets Manager, never commit secrets
2. **Input Validation**: Validate all external inputs (webhooks, API requests)
3. **Least Privilege**: Lambda roles have minimal necessary permissions
4. **Encryption**: All secrets encrypted with KMS, data at rest encrypted

### Infrastructure Security

1. **Zero Trust**: Cloudflare Access for admin authentication
2. **API Security**: Token-based webhook validation
3. **Network Isolation**: Lambda functions in VPC where needed
4. **Audit Logging**: All admin actions logged to CloudWatch

### Telegram Webhook Security

The Telegram webhook handler implements multiple security layers:

1. **Secret Token Verification**: Unique per-avatar webhook secrets
2. **IP Verification**: Checks against Telegram's official IP ranges
3. **No Information Disclosure**: Returns 200 for all errors
4. **Sanitized Logging**: Never logs message content or secrets

See `CLAUDE.md` for implementation details.

## Security Checklist for PRs

- [ ] No secrets or credentials in code
- [ ] All inputs validated and sanitized
- [ ] Dependencies audited (CI will check)
- [ ] No new high/critical vulnerabilities introduced
- [ ] Security-sensitive changes reviewed by maintainer
- [ ] Audit logging added for sensitive operations

## Security Tools

| Tool | Purpose | Status |
|------|---------|--------|
| `pnpm audit` | Dependency vulnerability scanning | ✅ Enabled in CI |
| CodeQL | Static code analysis | 🔄 Consider adding |
| Dependabot | Automated dependency updates | 🔄 Optional |
| npm-audit-resolver | Manage audit exceptions | 🔄 As needed |

## Security Contact

For security concerns or questions:
- GitHub Issues: Use `type:security` label (for non-sensitive issues only)
- Private Vulnerability Reporting: Use GitHub's security advisory feature
- Email: Contact repository owner through GitHub profile

## Privileged Access Review

Privileged identities (GitHub admins, deployment roles, admin wallets/emails, environment secrets) are reviewed quarterly via an automated workflow. The workflow produces evidence artifacts and creates follow-up issues for stale or unknown principals.

The review covers GitHub admins, deployment roles, admin wallets/emails, and environment secrets. Break-glass access requires post-incident documentation.

## Compliance

This project follows security best practices including:
- OWASP Top 10 web application security risks
- AWS Well-Architected Framework security pillar
- Principle of least privilege
- Defense in depth
- Quarterly privileged-access recertification

## License

This security policy is part of the AWS Swarm project and follows the same MIT license.

---

*Last updated: 2026-02-23*
