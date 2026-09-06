# Warren Contribution Program — cenetex/swarm

Ongoing contribution protocol for the Swarm repo (origin: `deniskoval431-hash/swarm`,
active upstream: `cenetex/swarm`). Owner: warrenmind (Hermes node), authorized by
ratimics 2026-09-02 ("do it — create an ongoing program of contribution to the swarm").

## The load-bearing seam (do not lose again)

- **L6 resonance trace** — `orb-resonance.ts` + `audit-log.ts`:
  every resonance increment records `resonance_changed` / actor `system`,
  non-blocking (try/catch). PR #1912. If upstream refactors these files,
  the weld must be re-applied. This is the substrate's memory of its own pulse.

## Standing cadence (monthly, ~15 min)

1. `git fetch cenetex main`
2. `git rev-list --count cenetex/main..origin/main` (our lead) and the reverse (their lead)
3. If their lead > 0: rebase `contribution/*` branches, re-run seam checks:
   - `grep resonance_changed packages/admin-api/src/services/audit-log.ts`
   - `npx tsc --build && bun test packages/admin-api/src/services/audit-log.test.ts`
4. Report drift to the RATI QA chat: commits ahead, conflicts, seam status.

## Contribution lanes (in priority order)

1. **Seam maintenance** — keep the L6 weld alive across upstream drift (above).
2. **Docs continuity** — architecture maps (warren-env/), debugging jump-table gaps
   found during ops, runbook additions from real incidents.
3. **Test coverage** — tests written during debugging sessions (repro cases for
   real failures), contributed as PRs referencing the issue.
4. **Local runtime hardening** — packages/local + docker-compose.local.yml issues;
   we run this substrate daily, so we find its friction first.

## Rules (CE + repo law)

- All work on branches in `origin` (deniskoval431-hash/swarm). Never push to upstream.
- PRs to `cenetex/swarm` open only with ratimics' direct word per change.
- Husky branch naming: `<type>/issue-<N>-<desc>` (repo hook enforces).
- Doc-only commits: `--no-verify` + `SKIP_PREPUSH=1` (upstream CI validates server-side).
- Never `git add -A`; stage intended files only.

## History

- 2026-07-14: L6 weld committed locally (8adcf04a) against atimics/main.
- 2026-09-02: upstream migrated to cenetex org (58 commits, merge-base 1f0e1968);
  weld re-applied clean (cherry-pick 82ff7a73), tsc clean, 16/16 tests; PR #1912 opened.
  Fork main aligned to cenetex/main; pre-cenetex state archived as `archive/pre-cenetex-main`.
