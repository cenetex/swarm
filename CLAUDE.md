# Claude Code Development Guide

Multi-tenant social media avatar platform on AWS serverless. Chat-first — all user actions happen inside the chat experience (no settings pages, no modals). See `docs/design-philosophy.md`.

**Packages:** `core/` (types, adapters, services), `handlers/` (Lambda webhooks), `admin-api/` (conversational admin backend), `admin-ui/` (React chat frontend), `infra/` (CDK), `mcp-server/`, `layer/`, `profile-page/`, `claude-code-worker/`, `plan-tests/` (run with `RUN_PLAN_TESTS=1`).

---

## Agent Execution Checklist

Every piece of work MUST be tied to a GitHub issue. No exceptions.

### Starting an issue

1. **Verify the issue is ready** — has acceptance criteria, scope boundaries, and `package:*` label.
2. **Check WIP caps** — max 8 `status:in-progress` project-wide, max 3 open PRs per contributor, max 5 parallel worktrees.
3. **Create branch** — `<type>/issue-<number>-<short-description>` (e.g., `fix/issue-42-dynamo-query`). The pre-push hook enforces this pattern.
4. **For parallel work, use worktrees:**
   ```bash
   git worktree add ../aws-swarm-042 -b fix/issue-42-dynamo-query main
   (cd ../aws-swarm-042 && pnpm install)
   scripts/worktree-start.sh 42   # REQUIRED — pushes branch, labels issue in-progress
   ```
5. **Implement within stated scope.** Do not expand beyond what the issue describes.
6. **Commit** with conventional format: `type(scope): description` referencing the issue (`Closes #42`).

### Finishing an issue

7. **Push and create PR** — one issue, one PR. Title matches commit convention.
8. **For worktrees:** `scripts/worktree-finalize.sh --issues 42` (commits, rebases, pushes, creates PR).
9. **Squash merge** to main. Clean up branch after merge.

### When blocked

- **Ambiguous scope** — comment on issue, add `status:blocked`. Do not guess.
- **Blocked by another issue** — comment `Blocked by #XX`, add `status:blocked`.
- **Discovered adjacent work** — open a new issue. Do not silently expand the PR.
- **Contradictory instructions** — comment on issue, wait for resolution.

---

## Development Commands

```bash
bun test                              # all tests (bun, not vitest)
bun test packages/core/               # single package
bun test path/to/file.test.ts         # single file
pnpm build                            # all packages
pnpm lint                             # all packages
pnpm typecheck                        # all packages
```

| Hook | Runs | Skip with |
|------|------|-----------|
| **pre-commit** | lockfile check, `pnpm lint` | `SKIP_PRECOMMIT=1` |
| **pre-push** | branch name validation, `pnpm lint`, `pnpm build`, admin-ui build, smoke test, `bun test` | `SKIP_PREPUSH=1` |

All deploys go through GitHub Actions (push to main → staging auto-deploy; tags → production with approval). Never run `cdk deploy` locally.

---

## Commit Convention

Format: `type(scope): description` — see [Conventional Commits](https://www.conventionalcommits.org/).

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

**Scopes:** `core`, `handlers`, `admin-api`, `admin-ui`, `infra`, `mcp-server`, `profile-page`, `plan`, `ci`, `docs`

Always reference the governing issue: `Closes #42` or `Related to #42`.

---

## Branching & PRs

- `main` is protected. All changes via PR + CI pass + squash merge.
- Branch pattern: `<type>/issue-<number>-<short-description>` — **enforced by pre-push hook**.
- One issue = one PR. If too large, ask leadership to split the issue.
- Copilot agent: `scripts/gh-assign-copilot.sh <issue-number>` or `scripts/gh-create-issue.sh --copilot`.

---

## Governance

### Priority order (higher = do first)

| Priority | Category |
|----------|----------|
| **P0** | Incidents — production outages, confirmed security vulns |
| **P1** | Reliability — DLQ growth, error rate breaches |
| **P2** | Security hardening |
| **P3** | Feature delivery (current milestone) |
| **P4** | Tech debt / quality |

Do not start P3/P4 work while P0/P1 issues are open.

### WIP caps

| Limit | Cap |
|-------|-----|
| `status:in-progress` issues | **8** project-wide |
| Open PRs per contributor | **3** |
| Parallel agent worktrees | **5** |
| Simultaneous `priority:high` | **5** |

### Key rules

- **No untracked work.** Every branch/commit/PR references a GitHub issue.
- **Issue is the spec.** Do not expand scope beyond what the issue describes.
- **Branches without an issue number must not be pushed to origin.**

Full governance details: [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md), [docs/ISSUE-GOVERNANCE.md](docs/ISSUE-GOVERNANCE.md), [docs/STRATEGY-OPERATIONS.md](docs/STRATEGY-OPERATIONS.md), [docs/SECURITY.md](docs/SECURITY.md).

---

## Versioning & Releases

SemVer via GitHub Releases (no `version` in package.json). Release with `./scripts/release.sh [patch|minor|major]`. Tags trigger production deploy.
