# Pre-PR implementation review — fix bump scroll behavior

Date: 2026-06-24
Branch: `fix-bump-scroll-behavior`
Plan: `thoughts/plans/fix-bump-scroll-behavior.html`
Base/comparison: `main` vs current worktree; implementation was uncommitted during review.

## Changed files reviewed

- `src/server/app.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/plans/fix-bump-scroll-behavior.html`
- `thoughts/discoveries/fix-bump-scroll-behavior.md`

## Scope

Implement the execution-ready plan for review-shell bump scroll behavior only: passive scroll-path touch observers, mobile/coarse `#review` overscroll containment, first reverse-direction e2e coverage, and preservation of native scroll owners plus mobile tap/link/comment behavior.

Out of scope: navbar/navigator redesign, queue/comment lifecycle/source-sync/storage changes, manual scroll emulation, dependency changes, and non-review-shell surfaces.

## Verification evidence

- RED before fix: `bun run build && node dist/test-fixtures/e2e-run.js` failed on non-passive `#plan-frame`, `#plan-touch-layer`, and rendered-document `touchstart`/`touchmove` listeners.
- GREEN targeted: `bun run build && node dist/test-fixtures/e2e-run.js` passed after implementation.
- Pre-review full gates: `bun run test` passed (121 tests); `bun run test:e2e` passed.
- Final verification after pre-PR gate: `bun run build`, `bun run test` (121 tests), and `bun run test:e2e` passed.

## Scoped implementation review cycle

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT quality reviewer | `PASS_SCOPED` | No findings. |
| GLM quality reviewer | `PASS_WITH_DOCUMENTED_OUT_OF_SCOPE_FOLLOW_UPS` | One sibling out-of-scope follow-up for index/deferred archive-toast `touchstart` listeners; P3 plan evidence finalized after review. |

## Pre-PR review cycle

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT-5.5 | `CLEAN_FOR_PR` | No blocking findings. Recognized documented P3 `OUT_OF_SCOPE_FOLLOW_UP`. |
| GLM-5.2 | `CLEAN_FOR_PR` | No in-scope P1/P2/P3 issues. Verified passive handlers do not call `preventDefault`, listener removal parity is preserved, and e2e instrumentation reaches iframe document listeners. |

## Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Sibling non-passive archive-toast `touchstart` listeners on organizer/deferred index surfaces | GLM scoped, GPT pre-PR, GLM pre-PR | P3 | `OUT_OF_SCOPE_FOLLOW_UP` | Do not fix in this PR; document for future scoped follow-up | `src/server/app.ts:408` and `src/server/app.ts:486` are separate non-review-shell scripts, predate this branch, and are not routed by this `/p/:id` review-shell diff. Tracked in `thoughts/discoveries/fix-bump-scroll-behavior.md` and the plan deviation log. |
| P3 plan progress/evidence needed | GLM scoped | P3 | `IN_PLAN` | Fixed | Plan P3 checkbox and Decisions / Deviations Log now record scoped review, pre-PR gate, and final verification evidence. |

## Remaining non-blocking follow-ups

- `OUT_OF_SCOPE_FOLLOW_UP`: future plan for index/organizer/deferred surface scroll-blocking touch listeners if those surfaces show similar pull/bump behavior. Tracking destination: `thoughts/discoveries/fix-bump-scroll-behavior.md`.

## Final gate result

GPT verdict: `CLEAN_FOR_PR`
GLM verdict: `CLEAN_FOR_PR`

Next step: `OPEN_PR_READY` — continue scoped-plan-run with final diff review, commit, push, PR creation, and post-PR monitoring.
