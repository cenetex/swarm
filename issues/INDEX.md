# Issue Index

GitHub Issues is the source of truth for all issue lifecycle state.

## Canonical tracker

- Repository issues: https://github.com/cenetex/aws-swarm/issues

CLI:

```bash
gh issue list --repo cenetex/aws-swarm --state open --limit 200
```

## Local artifacts

- `issues/open/*.yml` and `issues/features/*.json` are planning mirrors only.
- Each local item should include `githubIssue` to map to GitHub.
- Reconciliation snapshot: `issues/GITHUB-LOCAL-RECONCILIATION-2026-02-16.md`

## Local read-only mirror

Generate/update local mirror report from GitHub:

```bash
node scripts/sync-issues-mirror.mjs
```

Output:

- `issues/GITHUB-OPEN-ISSUES.md`
