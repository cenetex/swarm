# SWARM-004: Developer Tooling Improvements

**Priority:** P0 — Do Now
**Package:** Root
**Risk:** Low — config-only changes, no runtime impact

## Worker Assignment

- **Assigned Worker:** `worker-004`
- **Branch:** `feat/swarm-004`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-004`
- **Core Mission:** Enforce consistent formatting and quality gates across the repository with low-risk root tooling changes.

## Problem

1. **No `.prettierrc`** — Prettier is installed but has no config. Every developer uses defaults, which is fragile.
2. **No `.editorconfig`** — No enforcement of indentation style, line endings, or trailing newlines across editors.
3. **`lint-staged` only runs ESLint** — Formatting issues can slip through.
4. **No test coverage thresholds** — CI runs coverage but doesn't enforce minimums.

## Solution

1. Add `.prettierrc` with project settings (2-space indent, single quotes, trailing commas)
2. Add `.editorconfig` for cross-editor consistency
3. Update `lint-staged` in `package.json` to run Prettier alongside ESLint
4. Add coverage thresholds to `vitest.config.ts`

## Acceptance Criteria

- [ ] `.prettierrc` exists with consistent project formatting rules
- [ ] `.editorconfig` exists with 2-space indent, LF line endings, UTF-8
- [ ] `lint-staged` runs both `eslint --fix` and `prettier --write`
- [ ] `vitest.config.ts` has coverage thresholds (start at 40% lines/functions)
- [ ] CI still passes with the new thresholds
