# Pre-PR implementation review — remove-archive-prompt-undo

Date: 2026-06-22

## Scope

Plan: `thoughts/plans/archive-toast-undo.html`

Review range: `75f1539^..7920098` (merged PR #41 implementation commits on branch `remove-archive-prompt-undo`).

PR: https://github.com/Nodaste-Lab/plan-reviewer/pull/41 (state: merged)

Current worktree: clean; no staged or unstaged changes at review start.

## Changed files

- `src/server/app.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/plans/archive-toast-undo.html`

## Scope contract

Replace archive confirmation prompts with non-blocking top-bar Undo toasts across active index, deferred index, and detail review shell. Use existing archive/unarchive APIs. Keep archive failures and Undo failures non-alerting and truthful. Preserve navigator/quick-open truth and mobile/touch dismissal coverage. Do not redesign lifecycle, source sync, comments, queue, API schema, or global notification architecture.

## Verification before this gate

- `bun run build && node dist/test-fixtures/e2e-run.js` — passed
- `bun run test` — passed
- `bun run test:e2e` — passed
- Codex scoped implementation review `/tmp/archive-toast-undo-codex-postfix-review.md` — `VERDICT: PASS_SCOPED`
- Claude Code required review attempts after final changes failed due launcher boundary extraction; last usable Claude review had implementation-correct observations but predated final coverage additions.

## Review cycle 1

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Stale navigator response can re-add archived current plan after detail archive | GPT-5.5 | P2 | IN_PLAN | Fixed | GPT reproduced by holding the first `/api/plans/navigator` response, archiving the plan, then releasing the stale response; archived plan reappeared in active navigator/quick-open. |
| GLM reviewer produced no verdict | GLM-5.2 | n/a | n/a | Infrastructure blocker | `quality-reviewer-glm` returned no output and no tool use twice (`a07d52dd-71ba-4c9`, `e36f0e72-78ce-4ea`). |

### Fixes applied

- Added `localPlanArchived` client state in `src/server/app.ts`.
- Filter `/api/plans/navigator` responses through `activeNavigatorItems()` before assigning/rendering navigator state.
- Avoid replacing the rendered navigator with an empty cache during archive; remove the current plan row from existing rendered navigator instead.
- Added delayed/stale navigator e2e coverage in `src/test-fixtures/e2e-run.ts`.

### Verification after fix

- `bun run build && node dist/test-fixtures/e2e-run.js` — passed.
- `bun run test && bun run test:e2e` — passed.

## Review cycle 2

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Stale navigator regression after fix | GPT-5.5 | n/a | n/a | Clean | GPT rereview `32fa8393-88fe-489`: findings none, `VERDICT: CLEAN_FOR_PR`; reviewer verified local archived state filters later navigator responses and quick-open derives from filtered cache. |
| GLM reviewer produced no verdict | GLM-5.2 | n/a | n/a | Retried | `quality-reviewer-glm` returned no output and no tool use twice (`a07d52dd-71ba-4c9`, `e36f0e72-78ce-4ea`); final smaller-prompt retry produced a valid clean verdict. |
| Final GLM review | GLM-5.2 | n/a | n/a | Clean | GLM retry `34acef94-c148-45c`: findings none for in-scope P1/P2, `VERDICT: CLEAN_FOR_PR`; verified stale navigator fix, failure handling, dismissal, keyboard access, and tests. |

### Verification after latest fix

- `bun run build && node dist/test-fixtures/e2e-run.js` — passed.
- `bun run test && bun run test:e2e` — passed.
- GPT rereview also ran `npx tsc --noEmit` — passed.
- GLM final retry ran `bun run build` and `npx tsc --noEmit` — passed.

## Rebase and PR #48 follow-up

The follow-up fix was rebased onto `origin/main` after PR #48 initially reported conflicts. Main had added navigator generation/filtering and a separate quick-open cache, so the local archive filter was merged into those newer paths instead of replacing them:

- Preserve `navigatorLoadGeneration` stale-response guards.
- Apply `activeNavigatorItems()` to `loadPlanNavigator()`, `loadNavigatorFilterSource()`, and `loadQuickOpenItems()`.
- Filter the existing `quickOpenItems` cache immediately when archiving in-place.
- Keep the stale navigator regression expectation that the archived current plan is not re-added to navigator or quick-open after a held pre-archive response is released.

Post-rebase verification:

- `bun run build && node dist/test-fixtures/e2e-run.js` — passed.
- `bun run test && bun run test:e2e` — passed.

## PR #48 automated review follow-up

Codex GitHub review on commit `63fd7e8` found one P2 in the regression test: the held navigator request was not guaranteed to start before the archive click, so the test could pass without proving a stale pre-archive response. Fixed by opening quick-open after reload, waiting until the navigator route handler has captured and held the request, closing quick-open, then archiving and releasing the held response.

Codex GitHub review on commit `8cd4054` found one P2 in the product fix: initializing `localPlanArchived` from server-rendered archived state would hide the current document from direct/reloaded archived detail pages, even though the navigator API intentionally includes `currentPlanId` for the current page. Fixed by initializing `localPlanArchived` to `false` and setting it only for an archive action performed in the current page session. Added regression coverage that a reloaded archived detail page keeps the current document visible in navigator and quick-open.

Verification after these PR-review fixes:

- `bun run build && node dist/test-fixtures/e2e-run.js` — passed.
- `bun run test && bun run test:e2e` — passed.

## Final gate result

- GPT verdict: `CLEAN_FOR_PR`.
- GLM verdict: `CLEAN_FOR_PR`.
- Gate status: passed.
- Remaining P3/out-of-scope follow-ups: GLM noted three non-blocking follow-ups: restore button failure still uses pre-existing `alert()` outside archive/Undo scope; cross-session archive/unarchive shell staleness is a pre-existing general reload concern; a harmless narrow orphan-listener race can leave no-op listeners until the next toast show.
