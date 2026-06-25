# Pre-PR implementation review: fix-archive-button

Date: 2026-06-24
Branch: `fix-archive-button`
Base/range: `origin/main` (`origin/main...HEAD` committed diff empty; review scope included unstaged working-tree changes)
Plan/scope: standalone direct fix for review-shell toolbar/action controls remaining icon-only glyphs with accessible `aria-label`/`title` tooltips. The archive status indicator must render as an icon, not visible text, across active/deferred/archived and dynamic archive transitions.

## Review packet

```text
git status --short --branch
## fix-archive-button
 M src/__tests__/contracts.test.ts
 M src/server/app.ts
 M src/test-fixtures/e2e-run.ts

git diff --stat origin/main...HEAD
(empty)

git diff --name-only origin/main...HEAD
(empty)

git diff --stat
src/__tests__/contracts.test.ts | 70 +++++++++++++++++++++++++++++++++++++++++
src/server/app.ts               | 20 +++++++++---
src/test-fixtures/e2e-run.ts    | 33 ++++++++++++++-----
3 files changed, 112 insertions(+), 11 deletions(-)

git diff --name-only
src/__tests__/contracts.test.ts
src/server/app.ts
src/test-fixtures/e2e-run.ts

git diff --cached --stat
(empty)
```

## Changed files summary

- `src/server/app.ts`: archive/deferred review-shell status indicator is icon-only with `role="status"`, `aria-label`, and `title`; active status remains hidden; dynamic archive transition preserves the same archived icon/ARIA contract; CSS includes `#archive-status[hidden]{display:none}`.
- `src/__tests__/contracts.test.ts`: added helper assertions and a regression test locking active/deferred/archived review-shell toolbar icon-only controls, tooltips, hidden active status, CSS hidden override, and status role.
- `src/test-fixtures/e2e-run.ts`: updated dynamic archive e2e assertions from old visible `Archived` navbar text to the new `#archive-status` icon/ARIA contract.

## Review cycle 1

GPT verdict: `FINDINGS_TO_RESOLVE`

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---:|---:|---|---|---|
| Generic `span` status glyph lacked reliable semantics after visible text was removed | GPT | P3 | IN_PLAN | Fixed | Added `role="status"` to server-rendered archived/deferred status and dynamic archived transition. |
| `#archive-status{display:inline-flex}` overrode `[hidden]`, making active plans show an empty pill | GLM | P2 | REGRESSION_FROM_THIS_DIFF | Fixed | Added `#archive-status[hidden]{display:none}` and contract assertions for active hidden status + CSS override. |

GLM verdict: `FINDINGS_TO_RESOLVE`

## Review cycle 2

GPT verdict: `CLEAN_FOR_PR`

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---:|---:|---|---|---|
| E2E fixture still asserted old visible `Archived` navbar text and `bun run test:e2e` failed | GLM | P2 | REGRESSION_FROM_THIS_DIFF | Fixed | Updated `src/test-fixtures/e2e-run.ts` to assert `#archive-status` `🗄`, `role="status"`, `aria-label="Archived"`, and `title="Archived"`; reran e2e green. |

GLM verdict: `FINDINGS_TO_RESOLVE`

## Review cycle 3

GPT verdict: `CLEAN_FOR_PR`
GLM verdict: `CLEAN_FOR_PR`

No remaining in-scope P1/P2/P3 findings.

## Fixes applied

1. Replaced review-shell archived/deferred status visible text with icon-only glyphs:
   - archived: `🗄` + `role="status"` + `aria-label="Archived"` + `title="Archived"`
   - deferred: `⏸` + `role="status"` + `aria-label="Deferred"` + `title="Deferred"`
2. Updated dynamic archive transition to set the same archived icon/ARIA contract.
3. Added `#archive-status[hidden]{display:none}` so active hidden status does not paint an empty box.
4. Added contract regression coverage for toolbar icons/tooltips across lifecycle states.
5. Updated e2e dynamic archive assertions to match icon-only status behavior.

## Verification after final fixes

```text
bun run test:e2e
# pass: e2e scenarios passed: plan index, dom annotation, image annotation, plan sync, deferred notes resume sync

bun run test
# pass: 129/129
```

## Remaining follow-ups

None.

## Final gate result

GPT verdict: `CLEAN_FOR_PR`
GLM verdict: `CLEAN_FOR_PR`
Final gate: `OPEN_PR_READY`
