# Issues

GitHub Issues is the **only source of truth** for issue lifecycle (open/close/status/labels/assignees/milestones).

## Policy

- Create/update/close issues directly in GitHub.
- Do **not** treat `issues/open/` or `issues/features/` files as authoritative.
- Local files are planning artifacts and mirrors only.

## Local files in this folder

- `issues/open/*.yml` and `issues/features/*.json` are optional local planning references.
- These files should include `githubIssue` so every local item maps to a real GitHub issue.
- If local and GitHub differ, GitHub wins.
- The stale `issues/open/*.yml` mirror set was archived on 2026-03-08 to
  `issues/archive/open-stale-2026-03-08/`.
- `issues/open/` is now intentionally empty of issue mirror YAML files until a
  fresh mirror is generated from GitHub.

## Recommended workflow

1. Create or update the issue on GitHub first.
2. Reference it in code/PRs (e.g., `Closes #123`).
3. Optionally update local mirror fields (`githubIssue`) for planning docs.
4. Refresh local mirror reports with:

```bash
node scripts/sync-issues-mirror.mjs
```

This writes a read-only snapshot report to `issues/GITHUB-OPEN-ISSUES.md`.

## Status of automation

- `.github/workflows/issue-sync.yml` is deprecated.
- Local-file-driven create/update/close automation is intentionally disabled.

## Why this change

- Eliminates duplicate write paths.
- Prevents drift between local files and GitHub.
- Keeps assignment, milestone, and PR linkage where work is actually managed.
