# Release Gates

Every production release must pass all six gates in order. A failure at any gate blocks the release until resolved.

---

## G1 — Code Quality

All linting and type-checking must pass with zero errors.

```bash
pnpm lint
pnpm typecheck
```

Both commands must exit 0. Do not suppress warnings to pass -- fix them or document exceptions.

---

## G2 — Test Suite

The full test suite must pass with no skipped critical tests.

```bash
bun test
```

- All tests must exit 0.
- Tests marked `.skip` or `.todo` are acceptable only if they are non-critical and tracked in a GitHub issue.
- Plan tests (`RUN_PLAN_TESTS=1 bun test packages/plan-tests/`) are optional but recommended before major releases.

---

## G3 — Build Integrity

All packages must build successfully, including the admin UI smoke check.

```bash
pnpm build
```

The pre-push hook runs this automatically, but verify manually before tagging a release. The admin-ui build is included in the top-level `pnpm build`.

---

## G4 — Security Audit

No high or critical vulnerabilities may ship to production unless covered by an active, non-expired security exception.

```bash
pnpm audit --audit-level=high
node scripts/validate-security-exceptions.mjs --warn-days 14
```

Both commands must exit 0. Requirements:

- `pnpm audit` passes, or all flagged advisories are covered by entries in `.audit-exceptions.json` with `status: "active"`.
- No expired exceptions exist in the registry.
- No exceptions are within 14 days of expiry without a renewal plan.

See [SECURITY.md](./SECURITY.md) for the full exception governance policy.

---

## G5 — Git State

The release must be cut from a clean, up-to-date `main` branch.

- Working tree is clean (`git status` shows no changes).
- Branch is `main`.
- All PR merges are squashed.
- No uncommitted or untracked files.

```bash
git status
git log --oneline -5  # verify recent squash merges look correct
```

---

## G6 — Operational Readiness

Production observability and incident response infrastructure must be current.

- CloudWatch dashboards are configured for the target environment.
- DLQ alarms are active for all avatar queues (depth and age).
- The [operational runbook](./RUNBOOK.md) is current and reflects the deployed architecture.
- Escalation contacts in the runbook are valid.

---

## Release Checklist

Copy this checklist into the release PR or GitHub Release notes:

```
- [ ] G1: `pnpm lint` passes
- [ ] G1: `pnpm typecheck` passes
- [ ] G2: `bun test` passes, no skipped critical tests
- [ ] G3: `pnpm build` succeeds
- [ ] G4: `pnpm audit --audit-level=high` passes
- [ ] G4: `node scripts/validate-security-exceptions.mjs --warn-days 14` passes
- [ ] G5: On `main`, clean working tree, all PRs squash-merged
- [ ] G6: CloudWatch dashboards configured
- [ ] G6: DLQ alarms active
- [ ] G6: Runbook current
```

---

## Running a Release

**Dry run** (validates gates without tagging):

```bash
./scripts/release.sh --dry-run
```

**Release** (tags and triggers production deploy via GitHub Actions):

```bash
./scripts/release.sh [patch|minor|major]
```

See [CLAUDE.md](../CLAUDE.md) for versioning policy. Tags trigger the production deploy workflow.
