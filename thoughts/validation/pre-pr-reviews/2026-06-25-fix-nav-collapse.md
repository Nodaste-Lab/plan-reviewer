# Pre-PR implementation review — fix-nav-collapse

Date: 2026-06-25
Branch: `fix-nav-collapse`
Base/range: `origin/main`; committed diff is empty, review scope is uncommitted working-tree changes.
Plan/scope: standalone bug fix. The review-shell plan navigator should still collapse by default for first-time/external page opens, but preserve the user's open/collapsed state while switching between plan/document detail pages in the same browser tab/session.

## Changed files

Working-tree diff:

```text
src/__tests__/contracts.test.ts |  4 ++++
src/server/app.ts               | 24 +++++++++++++++++++++---
src/test-fixtures/e2e-run.ts    | 11 +++++++++--
3 files changed, 34 insertions(+), 5 deletions(-)
```

Files:

```text
src/__tests__/contracts.test.ts
src/server/app.ts
src/test-fixtures/e2e-run.ts
```

Staged changes: none.

## Verification before review

- `bun run build && node --test dist/__tests__/contracts.test.js` — passed, 128/128.
- `bun run test:e2e` — passed.
- `bun run test` — passed, 129/129.

## Review cycle 1

### GPT-5.5 reviewer

Verdict: `CLEAN_FOR_PR`

Summary: no findings. Reviewer verified the navigator state is persisted only after explicit user toggle, first load with no session state still honors the server default, same-tab plan/document navigation restores prior session state, client asset version was bumped, and tests cover the behavior.

Reviewer verification:

- `npx tsc --noEmit` — passed.
- `node --import tsx --test src/__tests__/contracts.test.ts` — passed.
- temp compiled e2e run from `/tmp` — passed.

### GLM-5.2 reviewer

Verdict: `CLEAN_FOR_PR`

Summary: no in-scope P1/P2/P3 findings. Reviewer verified `sessionStorage` is the correct per-tab mechanism because plan navigation performs full page reloads, the nullish fallback distinguishes explicit `closed` from no stored state, read/write values round-trip strictly, and changed gates pass.

Reviewer verification:

- `bun run build` — passed.
- `node --test dist/__tests__/contracts.test.js` — passed, 128/128.
- `node dist/test-fixtures/e2e-run.js` — passed.

## Triage

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| None | GPT-5.5 | — | — | No action | Reviewer returned `VERDICT: CLEAN_FOR_PR`. |
| Comments panel does not persist across plan switches | GLM-5.2 | Non-blocking observation | OUT_OF_SCOPE_FOLLOW_UP / QUESTION | No action for this PR | Pre-existing comments behavior; current user scope is navigator state only. Tracking destination: future panel-state-persistence consistency decision if desired. |
| Closed-state cross-reload test is not symmetric with open-state test | GLM-5.2 | Non-blocking observation | QUESTION | No action for this PR | Implementation is symmetric (`open ? 'open' : 'closed'` and reader returns both true/false); contracts pin both read/write paths and e2e verifies open cross-doc persistence plus in-page collapsed state. |
| Cache-busting version bump redundant with `no-store` | GLM-5.2 | Non-issue | — | No action | Existing `/client.js` and `/client.css` responses are `Cache-Control: no-store`; version bump is harmless and within scope. |

## Fixes applied from review

None. Both reviewers returned clean verdicts with no unresolved in-scope P1/P2/P3 findings.

## Final verification after last fix

No fixes were applied after review. Final PR verification after the review artifact was written:

- `bun run test` — passed, 129/129.
- `bun run test:e2e` — passed.

Reviewers also reran targeted build/contracts/e2e checks during cycle 1 and reported passing results.

## Remaining non-blocking follow-ups

- Optional future decision: whether the comments panel should also persist across plan switches. Evidence: this is pre-existing behavior and outside the navigator-state bug fix.
- Optional future test hardening: add a symmetric collapse-then-switch assertion. Evidence: current implementation and contract tests cover both stored values; e2e covers open cross-doc persistence.

## Final gate result

GPT verdict: `CLEAN_FOR_PR`
GLM verdict: `CLEAN_FOR_PR`

Final result: `OPEN_PR_READY`
