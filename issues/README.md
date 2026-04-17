# Issues

GitHub Issues is the **only** source of truth for issue lifecycle (open/close/status/labels/assignees/PR linkage).

- Tracker: https://github.com/cenetex/aws-swarm/issues
- CLI: `gh issue list --repo cenetex/aws-swarm --state open --limit 200`

## Workflow

1. Create or update the issue in GitHub first.
2. Reference it in branches/commits/PRs (`Closes #123`).
3. For triage context and WIP caps, see [../CLAUDE.md](../CLAUDE.md) and [../docs/OPERATING-MODEL.md](../docs/OPERATING-MODEL.md).
4. For planning candidates not yet promoted to issues, use the `AWS Swarm Roadmap` Project (cenetex/projects/4) — see `OPERATING-MODEL.md`.

## Why local mirrors were retired

This directory previously held hand-maintained JSON/YAML mirror files (`features/`, `bugs/`, `staging/`, `tech-debt/`, `docs/`, `closed/`). None carried a `githubIssue` pointer and they drifted from GitHub. They were retired on 2026-04-17 (see PR for #1380). `issues/archive/` preserves the 2026-03-08 snapshot for history.

Do not repopulate by hand. Any future local mirror must be a read-only snapshot generated from GitHub (e.g., `node scripts/sync-issues-mirror.mjs` → `issues/GITHUB-OPEN-ISSUES.md`).

## Ephemeral harvest directories

`issues/staging/` and `issues/prod/` are created on demand by `scripts/download-issues.sh`, which pulls avatar-reported issues (via `report_issue`) and user feedback (via `report_user_feedback`) out of CloudWatch Logs. These directories are gitignored and should never be committed — they're ephemeral local state, not source of truth. If you need to examine a harvested issue, run the script locally and read the output from your working copy.
