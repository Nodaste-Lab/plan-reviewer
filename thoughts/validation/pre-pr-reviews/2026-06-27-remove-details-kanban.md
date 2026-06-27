# Pre-PR Implementation Review — remove-details-kanban

Date: 2026-06-27
Branch: `remove-details-kanban`
Base/range: `origin/main...HEAD` plus uncommitted working-tree changes
Plan/scope: stacked/mixed-scope PR including (1) committed Kanban card-open/menu-dismissal changes already on `remove-details-kanban`, and (2) the uncommitted scroll-bump/fractional iframe sizing fix from `thoughts/plans/plan-surface-first-wheel-scroll-block.html`.

## Review packet

### Git state

```text
## remove-details-kanban...origin/remove-details-kanban
 M src/__tests__/contracts.test.ts
 M src/server/app.ts
 M src/test-fixtures/e2e-run.ts
?? scripts/record-current-viewer-wheel.sh
?? thoughts/plans/plan-surface-first-wheel-scroll-block.html
?? thoughts/validation/scroll-block/
```

### Committed diff from `origin/main...HEAD`

```text
 src/__tests__/contracts.test.ts                    |   8 +-
 src/server/app.ts                                  |   6 +-
 src/test-fixtures/e2e-run.ts                       |  17 +++-
 .../validation/pre-pr-reviews/2026-06-27-main.md   | 107 +++++++++++++++++++++
 4 files changed, 132 insertions(+), 6 deletions(-)
```

### Working-tree diff

```text
 src/__tests__/contracts.test.ts |  1 +
 src/server/app.ts               |  8 ++--
 src/test-fixtures/e2e-run.ts    | 93 +++++++++++++++++++++++++++++++++++++----
 3 files changed, 90 insertions(+), 12 deletions(-)
```

### Untracked files in scope

```text
scripts/record-current-viewer-wheel.sh
thoughts/plans/plan-surface-first-wheel-scroll-block.html
thoughts/validation/scroll-block/repro-iframe-fractional-wheel-summary.json
```

## Implementation summary

- Captured physical trackpad wheel diagnostics against an existing Brave CDP session.
- Evidence showed wheel events entered the rendered-plan iframe while `#plan-touch-layer` was inactive.
- The iframe had fractional internal scroll (`0.5px` observed), causing 20–24 wheel events in each new direction to be consumed before parent scroll chained.
- Fixed `syncFrameHeight()` to size from both integer `scrollHeight` and fractional rendered rect heights, rounded up with `Math.ceil()`.
- Added contract and e2e guards for fractional iframe sizing, first-wheel plan behavior, direction reversal, and left-nav control behavior.

## Verification before review

- PASS: `bun run build && node --test dist/__tests__/contracts.test.js` — 143/143 tests passed.
- PASS: `bun run build && node dist/test-fixtures/e2e-run.js` — e2e scenarios passed.

## Review cycle 1

### GPT reviewer

Verdict: `FINDINGS_TO_RESOLVE`

Finding: P3 / IN_PLAN — `thoughts/plans/plan-surface-first-wheel-scroll-block.html` claimed installed-service/native post-fix smoke as mandatory, but current verification only included source contract/e2e plus repro evidence. Reviewer required either running installed-service smoke or revising the plan/validation note to make that requirement explicitly deferred/out of scope with rationale and tracking.

### GLM reviewer

Verdict: `FINDINGS_TO_RESOLVE`

Findings:

1. P3 / PLAN_PREREQUISITE — `origin/main...HEAD` includes unrelated committed Kanban card-open changes and validation docs (`6349b64`, `c71b3d7`, `thoughts/validation/pre-pr-reviews/2026-06-27-main.md`). A scroll-bump PR from this branch would include unrelated UI behavior unless this is intentionally a stacked/mixed-scope PR or the scroll changes move to a clean branch.
2. P3 / IN_PLAN — same installed-service/overlay-plan mismatch as GPT; plan still claimed installed-service smoke and overlay removal requirements not reflected in implementation/verification.

### Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---:|---:|---:|---|---|
| Plan claimed installed-service/native post-fix smoke as mandatory without post-fix installed evidence | GPT, GLM | P3 | IN_PLAN | Fixed by revising the plan to mark installed-service smoke as release/deploy follow-up and tracking it through `scripts/record-current-viewer-wheel.sh` plus this artifact | Source verification is green; native repro evidence exists; no Homebrew deploy/restart was performed in this source pre-PR gate |
| Plan still referenced overlay removal after evidence showed touch layer was inactive | GLM | P3 | IN_PLAN | Fixed by revising plan root cause, BDD, phases, verification, and delivery order to target fractional iframe sizing instead of overlay removal | Native evidence: wheel events came from iframe; `touchLayerDisplay:none`, `pointerEvents:none` |
| Branch includes unrelated committed Kanban changes in `origin/main...HEAD` | GLM | P3 | PLAN_PREREQUISITE | Unresolved blocker pending branch/scope decision | `git diff --name-only origin/main...HEAD` includes committed Kanban changes and `thoughts/validation/pre-pr-reviews/2026-06-27-main.md` from prior work |

## Fixes applied

- Updated `thoughts/plans/plan-surface-first-wheel-scroll-block.html` to remove stale overlay-removal claims.
- Updated the plan to classify installed-service smoke as release/deploy validation rather than a source pre-PR blocker.
- Added tracking destination for installed-service smoke: `scripts/record-current-viewer-wheel.sh` and this validation artifact.

## Verification after fixes

No code changes were made for the plan-doc fix. The latest code verification remains:

- PASS: `bun run build && node --test dist/__tests__/contracts.test.js` — 143/143 tests passed.
- PASS: `bun run build && node dist/test-fixtures/e2e-run.js` — e2e scenarios passed.

## Remaining blockers

- Branch/scope blocker resolved by user decision: treat this as a stacked/mixed-scope PR that includes the committed Kanban changes plus the scroll fix. Rerun GPT and GLM over the full scope.

## Review cycle 2

Scope decision: stacked/mixed-scope PR including committed Kanban card-open/menu-dismissal changes and uncommitted scroll-bump/fractional iframe sizing changes.

### GPT reviewer

Verdict: `FINDINGS_TO_RESOLVE`

Finding: P3 / IN_PLAN — stale AC-3 in `thoughts/plans/plan-surface-first-wheel-scroll-block.html` still said `document.elementFromPoint()` must not hit `#plan-touch-layer` during vertical-scroll handoff windows, but the implementation intentionally keeps the short post-programmatic handoff layer. The actual accepted contract is that first vertical wheel is not swallowed and iframe internal scroll remains zero.

### GLM reviewer

Verdict: `CLEAN_FOR_PR`

GLM found no P1/P2/P3 findings in the accepted stacked Kanban + scroll scope.

### Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---:|---:|---:|---|---|
| Stale AC-3 claimed touch layer must not be hit during handoff windows | GPT | P3 | IN_PLAN | Fixed by rewriting AC-3 to assert no swallowed first vertical wheel / no nonzero iframe internal scroll while allowing the existing short handoff layer | `src/server/app.ts` intentionally enables the handoff layer briefly; root-cause fix targets fractional iframe sizing |

## Cycle 2 fixes applied

- Updated `thoughts/plans/plan-surface-first-wheel-scroll-block.html` AC-3 to match the implemented scroll contract.

## Review cycle 3

Scope: accepted stacked/mixed-scope PR, after AC-3 doc fix.

### GPT reviewer

Verdict: `FINDINGS_TO_RESOLVE`

Finding: P3 / IN_PLAN — sibling stale locked decision in `thoughts/plans/plan-surface-first-wheel-scroll-block.html` still said desktop vertical wheel must not target `#plan-touch-layer`, conflicting with the accepted short handoff layer behavior.

### GLM reviewer

Verdict: `FINDINGS_TO_RESOLVE`

Finding: same P3 / IN_PLAN stale locked decision.

### Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---:|---:|---:|---|---|
| Stale locked decision said desktop vertical wheel must not target `#plan-touch-layer` | GPT, GLM | P3 | IN_PLAN | Fixed by rewriting the locked decision to prohibit vertical wheel swallowing/preventDefault while allowing the existing short handoff layer | `src/server/app.ts` intentionally arms the layer briefly; AC-3 now allows that if first vertical wheel moves parent scroll and iframe internal scroll remains zero |

## Cycle 3 fixes applied

- Updated `thoughts/plans/plan-surface-first-wheel-scroll-block.html` locked decision `decision-no-desktop-vertical-overlay` to match the implemented contract.
- Searched for sibling stale target/interception wording; only normal-state pointer-inert check remains and is consistent.

## Review cycle 4

Scope: narrow plan/artifact truthfulness check after stale touch-layer wording fixes.

### GPT reviewer

Verdict: `CLEAN_FOR_PR`

No P1/P2/P3 findings. GPT confirmed AC-3, locked decision wording, installed-service follow-up, stacked scope, and handoff-layer implementation are now consistent.

### GLM reviewer

Verdict: `CLEAN_FOR_PR`

No P1/P2/P3 findings. GLM confirmed plan/artifact truthfulness and implementation consistency.

### Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---:|---:|---:|---|---|
| None | GPT, GLM | — | — | Clean | Both final narrow reviewers returned `CLEAN_FOR_PR` |

## Final verification after last fix

- PASS: `bun run build && node --test dist/__tests__/contracts.test.js` — 143/143 tests passed.
- PASS: `bun run build && node dist/test-fixtures/e2e-run.js` — `e2e scenarios passed: plan index, dom annotation, image annotation, plan sync, deferred notes resume sync`.

## Remaining non-blocking follow-ups

- Release/deploy validation: before promoting a Homebrew-served build, repeat the passive native-input recorder against the installed service using `scripts/record-current-viewer-wheel.sh`. This is documented in `thoughts/plans/plan-surface-first-wheel-scroll-block.html` as deploy/release validation, not a pre-PR source blocker.

## Final gate result

`OPEN_PR_READY`

GPT verdict: `CLEAN_FOR_PR`
GLM verdict: `CLEAN_FOR_PR`

Next step: `OPEN_PR_READY` — continue with final status review, commit/push/PR creation if this workflow is proceeding to PR.
