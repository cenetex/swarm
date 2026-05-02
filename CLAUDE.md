# Claude Code Development Guide

Multi-tenant social media avatar platform on AWS serverless. Chat-first — all user actions happen inside the chat experience (no settings pages, no modals). See `docs/design-philosophy.md`.

**Packages:** `core/` (types, adapters, services), `handlers/` (Lambda webhooks), `admin-api/` (conversational admin backend), `admin-ui/` (React chat frontend), `infra/` (CDK), `mcp-server/`, `layer/`, `profile-page/`, `claude-code-worker/`, `plan-tests/` (run with `RUN_PLAN_TESTS=1`).

## Quick Start

```bash
git clone https://github.com/cenetex/aws-swarm.git
cd aws-swarm
pnpm install          # IMPORTANT: Use pnpm, not npm
pnpm build
bun test
```

**For TypeScript builds:** Run `pnpm install` first. TypeScript compiler (`tsc`) is installed as a dev dependency and requires pnpm.

---

## Agent Execution Checklist

Every piece of work MUST be tied to a GitHub issue. No exceptions.

### Starting an issue

1. **Verify the issue is ready** — has acceptance criteria, scope boundaries, and `package:*` label.
2. **Check WIP caps** — max 10 open GitHub issues total with a target of 8 product slots and 2 bug-fix slots; max 8 `status:in-progress` project-wide; max 3 open PRs per contributor; max 5 parallel worktrees.
3. **Create branch** — `<type>/issue-<number>-<short-description>` (e.g., `fix/issue-42-dynamo-query`). The pre-commit hook validates issue readiness, and pre-push enforces the branch pattern.
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

**This project uses pnpm, not npm.** Install dependencies with `pnpm install`, not `npm install`.

```bash
pnpm install                          # install dependencies (required for tsc and other tools)
pnpm build                            # all packages
pnpm lint                             # all packages
pnpm typecheck                        # all packages
pnpm test                             # all tests via isolated runner (handles mock pollution)
bun test packages/core/               # single package (direct, no isolation)
bun test path/to/file.test.ts         # single file (direct, no isolation)
pnpm test:smoke                       # opt-in smoke tests (currently has known failures, see #1311)
```

**Test runner notes**: Tests run via `./scripts/test-isolated.sh` which puts mock-using files in
their own bun processes. This is required because bun's `mock.module()` is process-global and
cannot be undone — without isolation, one file's mocks pollute every subsequent file. New test
files that call `mock.module(` or `vi.mock(` are picked up automatically by the script.

| Hook | Runs | Skip with |
|------|------|-----------|
| **pre-commit** | branch guard, issue hygiene check, lockfile check, `pnpm lint` | `SKIP_PRECOMMIT=1` |
| **pre-push** | branch name validation, `pnpm lint`, `pnpm build`, admin-ui build, smoke test, `bun test` | `SKIP_PREPUSH=1` |

All deploys go through GitHub Actions. Tag pushes (`vX.Y.Z`) deploy to production; `main` pushes do not auto-deploy (staging was decommissioned 2026-05-01, see #1642). Never run `cdk deploy` locally.

## AWS Profiles

| Profile | Account | Use |
|---------|---------|-----|
| `default` / `staging` | `022118847419` | Secondary account (formerly staging — kept for ratibot prod, FireHorse, GitHub agent, future preview env) |
| `prod` | `332730082708` | Production account (swarm) |

Use `--profile prod` for production AWS CLI commands (ECS logs, CloudFormation, etc.). The SSO profile is still named `staging` for historical reasons even though no Swarm staging stacks exist there anymore.

---

## Commit Convention

Format: `type(scope): description` — see [Conventional Commits](https://www.conventionalcommits.org/).

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

**Scopes:** `core`, `handlers`, `admin-api`, `admin-ui`, `infra`, `mcp-server`, `profile-page`, `plan`, `ci`, `docs`

Always reference the governing issue: `Closes #42` or `Related to #42`.

---

## Branching & PRs

- `main` is protected. All changes via PR + CI pass + squash merge.
- Branch pattern: `<type>/issue-<number>-<short-description>` — validated before commit and enforced again by pre-push.
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
| Open GitHub issues total | **10** |
| Product backlog slots | **8** |
| Bug-fix backlog slots | **2** |
| `status:in-progress` issues | **8** project-wide |
| Open PRs per contributor | **3** |
| Parallel agent worktrees | **5** |
| Simultaneous `priority:high` | **5** |

When the open backlog hits the cap, close/archive another issue before opening or reopening a new one. Do not leave speculative or parking-lot issues open.

### Key rules

- **No untracked work.** Every branch/commit/PR references a GitHub issue.
- **Issue is the spec.** Do not expand scope beyond what the issue describes.
- **Branches without an issue number must not be pushed to origin.**

Full governance details: [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md), [docs/ISSUE-GOVERNANCE.md](docs/ISSUE-GOVERNANCE.md), [docs/SECURITY.md](docs/SECURITY.md).

---

## Patterns & Observability

- [docs/patterns/autonomous-agent-runner.md](docs/patterns/autonomous-agent-runner.md) — scheduled Lambda that wakes an avatar for one tool-loop tick. Reference implementation: `packages/handlers/src/station/station-agent-runner.ts`.
- [docs/observability.md](docs/observability.md) — structured-logger conventions (`createAvatarLogger` vs `createSystemLogger`, event codes, the `no-console` ratchet).

---

## Versioning & Releases

SemVer via GitHub Releases (no `version` in package.json). Release with `./scripts/release.sh [patch|minor|major]`. Tags trigger production deploy.
