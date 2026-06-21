# Pre-PR implementation review — issue-43-organization

## Scope

Plan: `thoughts/plans/issue-43-plan-organization.html`

Branch: `issue-43-organization`

Comparison: uncommitted working-tree diff on the feature branch, including the untracked plan and validation artifacts.

## Changed files

- `src/schemas.ts`
- `src/storage/database.ts`
- `src/server/app.ts`
- `src/cli.ts`
- `src/__tests__/contracts.test.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/plans/issue-43-plan-organization.html`
- `thoughts/validation/pre-pr-reviews/2026-06-21-issue-43-organization.md`

## Verification before review

- `bun run test` — PASS
- `bun run test:e2e` — PASS
- `bun run test:fixtures` — PASS

## Review cycle 1

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT-5.5 quality-reviewer | `P1_P2_FOUND` | Found hidden default-column orphaning and quick-open 200-item cap. |
| GLM-5.2 quality-reviewer-glm | `P1_P2_FOUND` | Found lifecycle API source-sync parity gap and missing client consumption for new organization events. |

## Triage

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Hidden `backlog` could orphan new planning documents | GPT-5.5 | P2 | IN_PLAN | Fixed | Added visible fallback column selection for registration/mode-change/backfill and rejected configurations with no visible columns. Regression: `hidden backlog does not orphan new planning documents`. |
| Cmd-O only searched bounded 200-item navigator | GPT-5.5 | P2 | IN_PLAN | Fixed | Added paged quick-open source loading via `/api/plans?includeArchived=true&includeDeferred=true&limit=200`, separate from navigator errors. Regression: client text assertions and e2e quick-open behavior. |
| Lifecycle API `active` transition missed immediate filesystem sync | GLM-5.2 | P2 | REGRESSION_FROM_THIS_DIFF | Fixed | `PUT /api/plans/:planId/lifecycle` now calls `sourceSync.syncNow(..., 'manual')` after `sourceSync.register`. Regression: `lifecycle API active transition immediately syncs filesystem sources`. |
| New organization events were emitted but ignored by browser client | GLM-5.2 | P2 | IN_PLAN | Fixed | Client now schedules metadata reload for `plan.lifecycle.changed`, `plan.column.changed`, `plan.pin.changed`, and `plan.project.changed`. Regression: `review client consumes organization events and paginates quick-open source data`. |
| `plan.columns.changed` schema event is declared but not emitted | GLM-5.2 | P3 | IN_PLAN | Deferred | Non-blocking; no live SPA consumer currently depends on column-config events. |

## Verification after fixes

- `bun run build && node --test dist/__tests__/contracts.test.js` — PASS
- `bun run test` — PASS
- `bun run test:e2e` — PASS
- `bun run test:fixtures` — PASS

## Review cycle 2

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT-5.5 quality-reviewer | `CLEAN_FOR_PR` | No P1/P2 production-blocking issues found after fixes. |
| GLM-5.2 quality-reviewer-glm | `CLEAN_FOR_PR` | All four prior blockers verified fixed; no new P1/P2 issues found. |

## Remaining non-blocking observations

- `plan.columns.changed` is declared but not emitted for board-column configuration changes. Current column settings persist correctly; stale concurrent Kanban tabs require manual reload. Logged as follow-up.
- Review-shell Status uses a free-text column-key input. Invalid labels fail safely with the existing organizer alert. Logged as follow-up UX polish.
- API/CLI pin/project commands can apply to collaboration documents, while board-column moves remain planning-only. This is a minor consistency follow-up, not a data-loss or security risk.

## Final gate result

PASS — GPT verdict `CLEAN_FOR_PR`; GLM verdict `CLEAN_FOR_PR`.
