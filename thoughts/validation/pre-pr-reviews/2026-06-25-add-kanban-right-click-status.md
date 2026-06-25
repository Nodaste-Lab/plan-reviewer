# Pre-PR Implementation Review — add-kanban-right-click-status

Date: 2026-06-25
Branch: `add-kanban-right-click-status`
Plan: `thoughts/plans/kanban-card-context-menu.html`
Base/comparison: `origin/main`

## Review packet

### Status

```text
## add-kanban-right-click-status
 M src/__tests__/contracts.test.ts
 M src/server/app.ts
 M src/test-fixtures/e2e-run.ts
?? thoughts/plans/kanban-card-context-menu.html
```

### Base diff

`git diff --stat origin/main...HEAD` and `git diff --name-only origin/main...HEAD` were empty. The implementation is currently in uncommitted working-tree changes.

### Working-tree changes

```text
src/__tests__/contracts.test.ts |  17 +++-
src/server/app.ts               |   9 +-
src/test-fixtures/e2e-run.ts    | 220 ++++++++++++++++++++++++++++++++++++++++
3 files changed, 241 insertions(+), 5 deletions(-)
```

Changed files in review scope:

- `src/server/app.ts`
- `src/__tests__/contracts.test.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/plans/kanban-card-context-menu.html` (untracked plan artifact)
- `thoughts/validation/pre-pr-reviews/2026-06-25-add-kanban-right-click-status.md` (this validation artifact)

No staged changes were present at review start.

## Scope summary

Implement the execution-ready Kanban card context menu plan:

- right-click / keyboard menu on Kanban planning cards,
- visible-column status moves using the existing column endpoint,
- defer with required note,
- archive with Undo toast using existing archive/unarchive endpoints,
- rollback and stale-state recovery,
- hidden-column exclusion,
- disabled-Kanban fail-closed behavior,
- preserve drag/drop and detail links.

Non-goals:

- no redesign of Kanban columns, configuration, hidden-column policy, or project filtering,
- no new lifecycle state, board-column API, persistence model, or migration,
- no context menu outside Kanban,
- no collaboration document behavior changes,
- no replacement of existing drag/drop movement.

## Verification before pre-PR gate

- `git diff --check` — passed.
- `bun run build && node --test dist/__tests__/contracts.test.js` — passed, 128 tests.
- `node dist/test-fixtures/e2e-run.js` — passed.
- `bun run test` — passed, 129 tests.
- `bun run test:e2e` — passed in 54s.

## Review cycle 1

### GPT verdict

`VERDICT: FINDINGS_TO_RESOLVE`

GPT found one in-plan P3: stale-state recovery set `#organizer-error` immediately before `window.location.reload()`, so the AC11 explanation could be lost after reload.

### GLM verdict

`VERDICT: CLEAN_FOR_PR`

GLM found no blocking in-scope P1/P2/P3 issues. Non-blocking notes were: custom context menu suppresses native link context menu by plan decision; contract assertions pin inline JS source text; right-click outside a card does not close the open menu; pre-existing server-side lifecycle permissiveness in `setPlanBoardColumn` is recovered by the client.

### Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Stale recovery explanation can be lost across reload | GPT | P3 | IN_PLAN | Fixed | AC11 requires refresh plus a report that the plan changed elsewhere; prior code called `setOrganizerError(...)` then immediately `window.location.reload()` in stale 404/409 and stale-200 paths. |
| Native link context menu suppressed on Kanban card links | GLM | P3 | QUESTION | Rejected as non-blocking plan decision | Locked decision uses a custom card `contextmenu`; detail links still exist and can be opened normally. |
| Contract assertions pin inline JS text | GLM | P3 | IN_PLAN | Accepted as non-blocking existing test idiom | Runtime behavior is covered by e2e; no reviewer requested a blocking fix. |
| Right-click outside any card does not close an open menu | GLM | P3 | IN_PLAN | Rejected as non-blocking | AC7 requires Escape or outside click; outside left-click is handled. |
| `setPlanBoardColumn` does not reject deferred/archived plans server-side | GLM | P3 | IN_PLAN | Fixed | Server-side lifecycle guard now rejects deferred/archived plan column moves with `invalid_state` 409 before mutating `board_column_key`. |

### Fixes applied

- Added a one-shot `sessionStorage` backed Kanban organizer reload message helper in `src/server/app.ts`.
- Replaced stale reload paths with `reloadWithOrganizerMessage('The plan changed elsewhere; the board refreshed from server truth.')` so the message survives the page refresh.
- Added e2e assertions in `src/test-fixtures/e2e-run.ts` for 409 stale move, hidden-destination stale 200, and archived-card stale 200 paths that `#organizer-error` is visible after reload.
- Added a storage-level lifecycle guard in `src/storage/database.ts` so deferred and archived plans cannot be moved to board columns through `PUT /api/plans/:planId/column`.
- Added contract coverage in `src/__tests__/contracts.test.ts` proving deferred and archived column moves return `invalid_state` 409 and leave the assigned column unchanged.
- Verified the lifecycle guard with `bun run build && node --test dist/__tests__/contracts.test.js` (129 passed) and `node dist/test-fixtures/e2e-run.js` (passed in 54s).

### Verification after fixes

- `bun run build && node --test dist/__tests__/contracts.test.js` — passed, 128 tests.
- `node dist/test-fixtures/e2e-run.js` — passed in 54s.

## Review cycle 2

### GPT verdict

`VERDICT: CLEAN_FOR_PR`

GPT verified the stale-reload message finding is resolved by the one-shot `sessionStorage` message helper and post-reload e2e assertions. No new PR-blocking P1/P2/P3 issues were found.

### GLM verdict

`VERDICT: CLEAN_FOR_PR`

GLM traced all stale reload paths through the helper, confirmed e2e coverage is genuine, and found no new P1/P2/P3 production failures. GLM noted the branch is behind current `origin/main`; this is a non-blocking merge-readiness recommendation to rebase/merge and rerun final gates before merge.

### Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Stale recovery explanation can be lost across reload | GPT cycle 1 | P3 | IN_PLAN | Fixed and verified clean in cycle 2 | `reloadWithOrganizerMessage` stores a one-shot message before reload; `restoreOrganizerReloadMessage` displays and clears it after reload; e2e asserts stale reload messages are visible. |
| Branch is behind current `origin/main` | GLM cycle 2 | Observation, not P1/P2/P3 | QUESTION | Non-blocking for pre-PR gate; handle before/while opening PR | GLM observed current `origin/main` has disjoint changes. Tracking destination: PR preparation step should rebase/merge current main and rerun final gates if needed. |

## Review cycle 3

### GPT verdict

`VERDICT: CLEAN_FOR_PR`

GPT verified the lifecycle guard rejects non-active board-column moves before mutation/event emission, confirmed contract coverage for deferred and archived states, and found no blocking P1/P2/P3 issues.

### GLM verdict

`VERDICT: CLEAN_FOR_PR`

GLM independently verified the guard placement, caller impact, stale-state client recovery, and test coverage. No P1/P2/P3 production-failure issues were found.

### Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| `setPlanBoardColumn` does not reject deferred/archived plans server-side | GLM cycle 1 / user follow-up | P3 | IN_PLAN | Fixed and verified clean in cycle 3 | `setPlanBoardColumn` now throws `invalid_state` 409 for non-active plans before column mutation; contract coverage asserts deferred and archived plans keep `boardColumnKey: backlog`; browser fixture still passes stale-state recovery. |

## Remaining out-of-scope follow-ups

None.

## Final gate result

`OPEN_PR_READY`

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`
- Final verification after the lifecycle-guard fix: `bun run test` passed with 130 tests.
- Targeted verification after the stale-message fix: `bun run build && node --test dist/__tests__/contracts.test.js` passed with 128 tests; `node dist/test-fixtures/e2e-run.js` passed in 54s.
- Targeted verification after the lifecycle-guard fix: `bun run build && node --test dist/__tests__/contracts.test.js` passed with 129 tests; `node dist/test-fixtures/e2e-run.js` passed in 54s.
- Post-rebase verification after reconciling with `origin/main`: `bun run test` passed with 130 tests; `bun run test:e2e` passed in 54s.

Next step: `OPEN_PR_READY` — continue with final PR preparation, including reconciling with current `origin/main` if needed, commit, push, PR creation, and post-PR monitoring.
