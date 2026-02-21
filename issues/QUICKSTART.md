# Quick Reference: GitHub-First Issues Workflow

Use this when triaging or executing work. GitHub Issues is the source of truth.

## 1) Find what to work on

- Open GitHub issues sorted by priority labels:

```bash
gh issue list --repo cenetex/aws-swarm --state open --limit 200
```

- Prefer labels like `priority:high`, `type:*`, and package labels.

## 2) Start work

- Assign issue in GitHub.
- Add `status:in-progress` label (optional if your workflow expects it).
- Branch/PR should reference the issue (e.g., `Closes #123`).

## 3) Keep local mirrors in sync (optional)

- Local `issues/open` and `issues/features` are planning mirrors only.
- Refresh a read-only mirror report:

```bash
node scripts/sync-issues-mirror.mjs
```

This generates `issues/GITHUB-OPEN-ISSUES.md`.

## 4) Close-out

- Merge PR with issue-closing keywords.
- Verify issue state/labels in GitHub.

## Rules

- Do not use local files to drive issue lifecycle.
- If local and GitHub differ, GitHub is correct.
