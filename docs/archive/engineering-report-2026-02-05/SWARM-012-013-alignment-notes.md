# SWARM-012/013 Alignment Notes - 2026-02-06

## Purpose

Record and close the contract alignment gate between SWARM-012 (state machine) and SWARM-013 (orchestrator API) before and during SWARM-014 launch.

## Source Drafts Reviewed

- SWARM-012 draft from `feat/swarm-012` (`run 20260206T060843Z`), promoted to `main`.
- SWARM-013 draft from `feat/swarm-013` (`run 20260206T164723Z`), reconciled and promoted to `main`.
- Cross-check pass after Wave 6 dispatch rerun (`run 20260206T182912Z`).

## Resolution Summary

| Area | Prior Mismatch | Resolution Applied | Status |
|------|----------------|--------------------|--------|
| State enum | SWARM-013 used `not_started|in_progress|blocked|completed` while SWARM-012 defined explicit onboarding states | SWARM-013 now uses SWARM-012 canonical state enum (`not_started`, `auth_pending`, `profile_pending`, `integration_pending`, `readiness_pending`, `ready_to_activate`, `blocked`, `completed`, `cancelled`) | Resolved |
| Terminal semantics | `cancelled` terminal state missing from SWARM-013 response enum | SWARM-013 response state enum now includes `cancelled`; terminal behavior references SWARM-012 contract | Resolved |
| Restart target | SWARM-013 restart path reset to `not_started`; SWARM-012 restart transitions target `auth_pending` | SWARM-013 restart behavior now resets to `auth_pending` per SWARM-012 | Resolved |
| Error code style | SWARM-012/018 used canonical `snake_case`; SWARM-013 examples used `SCREAMING_SNAKE` | SWARM-013 examples now use canonical `snake_case` (`invalid_transition`, `step_not_skippable`, `idempotency_key_conflict`, `step_dependency_timeout`, `transition_write_conflict`) | Resolved |
| Blocked resume metadata | SWARM-012 allowed resume-to-previous-state behavior; SWARM-013 did not model it in response shape | SWARM-013 response envelope now includes `onboarding.resumeTargetState` | Resolved |

## Follow-Up Notes

- `idempotency_in_flight` is used in SWARM-013 idempotency conflict behavior and should be explicitly added to the SWARM-018 code table during implementation-phase contract hardening.
- Alignment status here is docs-level and still requires implementation + integration tests before ticket closure.

## Gate Decision for SWARM-014

Gate status: **OPEN / UNBLOCKED**.

SWARM-014 was launched and completed docs-phase review in Wave 6 rerun `20260206T182912Z` after the alignment items above were reconciled.
