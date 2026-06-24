# Pre-PR implementation review — status-change-in-plan

Date: 2026-06-24
Branch: `status-change-in-plan`
Plan: `thoughts/plans/current-plan-status-controls.html`
Base/target: `main`

## Scope

Implement the execution-ready plan viewer controls plan:

- Move Project / State / Status navigator filters from the top action bar into the left navigator as a vertical stack.
- Add a top current-plan status selector for planning plans, backed by `PUT /api/plans/:id/column`.
- Do not add top state or project selectors.
- Omit planning-only status controls for collaboration documents.
- Truthfully display a hidden current board-column status while keeping update choices limited to visible board columns.

Out of scope: queue semantics, source sync, rendered-plan sanitizer, auth, Kanban redesign, project assignment workflow, lifecycle selector workflow, and new dependencies/frameworks.

## Changed files

- `src/server/app.ts`
- `src/__tests__/contracts.test.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/plans/current-plan-status-controls.html`
- `thoughts/plans/AGENTS.md`

## Verification

Passed before pre-PR gate:

- `bun run build && node --test dist/__tests__/contracts.test.js`
- `bun run test:e2e`
- `bun run test`

Independent GLM pre-PR reviewer also reran:

- `bun run build`
- `node --test dist/__tests__/contracts.test.js`
- `bun run test`
- `bun run test:e2e`

## Scoped implementation review cycle

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT scoped reviewer | `PASS_SCOPED` | No findings. |
| GLM scoped reviewer | `PASS_SCOPED` | No P1/P2 or scoped defects. |

## Pre-PR review cycle

| Reviewer | Verdict | P1/P2 findings |
| --- | --- | --- |
| GPT-5.5 | `CLEAN_FOR_PR` | None |
| GLM-5.2 | `CLEAN_FOR_PR` | None |

## Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| No findings | GPT-5.5 | — | — | No action | Reviewer returned `CLEAN_FOR_PR`. |
| Hidden-current failure rollback lacks dedicated E2E path | GLM-5.2 | P3 | IN_PLAN | Non-blocking residual risk; no fix in pre-PR P1/P2 loop | Rollback-to-visible is covered by E2E; rollback-to-hidden is covered by server/contract behavior and Chromium supports programmatic selection of disabled option value. |
| Hidden option lingers after hidden-to-visible status success until reload | GLM-5.2 | P3 | IN_PLAN | Non-blocking residual UI staleness; no fix in pre-PR P1/P2 loop | Successful update changes `data-current-value` and navigator metadata; stale disabled option is not selected and does not affect persistence. |
| Status selector appears for archived/deferred planning plans | GLM-5.2 | QUESTION/P3 | IN_PLAN | Non-blocking; plan does not exclude archived/deferred and existing API allows planning board-column mutation regardless of lifecycle | Existing behavior permits board-column updates for planning plans; state remains button-driven per plan. |

## Fixes applied after review

None. No in-scope P1/P2 findings were reported.

## Remaining non-blocking notes

The GLM P3 notes above are documented as residual risks for PR review context. They are not blocking because both pre-PR reviewers returned no unresolved in-scope P1/P2 findings.

## Final gate result

Pre-PR implementation review passed.

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`
- Artifact path: `thoughts/validation/pre-pr-reviews/2026-06-24-status-change-in-plan.md`
