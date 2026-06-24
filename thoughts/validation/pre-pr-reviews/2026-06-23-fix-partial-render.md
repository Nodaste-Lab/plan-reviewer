# Pre-PR Review — fix-partial-render

Date: 2026-06-23
Branch: `fix-partial-render`
Base / comparison: current working tree diff against `HEAD`; no staged changes at review start.
Plan / scope: standalone desktop review-shell fix for plans being clipped inside a fixed-height iframe. The plan iframe should be laid out at full rendered content height on desktop, the browser page should own vertical scrolling, mobile/coarse-pointer `#review` native scrolling should remain intact, comments/nav/lightbox/composer should remain usable, in-place render refresh should preserve scroll position, and in-plan fragment links should remain visibly navigable under the parent-owned scroll model.

## Changed files

- `src/server/app.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/validation/pre-pr-reviews/2026-06-23-fix-partial-render.md`

## Final verification

```bash
bun run test:e2e
# PASS — e2e scenarios passed: plan index, dom annotation, image annotation, plan sync, deferred notes resume sync

bun run build && bun run test
# PASS — 121 tests passed
```

## Regression coverage added

`src/test-fixtures/e2e-run.ts` now verifies the desktop and mobile scroll contracts:

- `#plan-frame` CSS no longer contains desktop `height: calc(100vh - 86px)`.
- The iframe is sized to its rendered document `scrollHeight`.
- The top-level document is vertically scrollable on desktop.
- Wheel input over the desktop plan moves `window.scrollY`.
- `iframe.contentWindow.scrollY` stays `0`.
- Sticky plan-nav/sidebar columns fill the viewport-minus-navbar height.
- In-place render refresh preserves top-level shell scroll.
- No-overlay shell transitions are covered: opening the comments sidebar on a fresh/no-comment plan with width-sensitive content must resync the iframe to the new content height and keep iframe internal scroll at `0`, then closing comments must do the same.
- Desktop fragment links scroll the parent window to the target while iframe scroll stays `0`.
- Mobile fragment links scroll `#review` correctly after `#review` is already scrolled.
- Mobile `href="#"` / empty-fragment links scroll `#review` back to the top while iframe scroll stays `0` and no composer opens.

## Review cycle 1

### GPT-5.5 verdict

`VERDICT: CLEAN_FOR_PR`

Summary: GPT found no P1/P2 issues. It confirmed the desktop iframe is content-height, mobile/coarse-pointer behavior remains scoped to `#review`, overlay positioning remains consistent, and the primary regression test would fail on the old fixed-height iframe behavior.

### GLM-5.2 verdict

`VERDICT: P1_P2_FOUND`

| Finding | Reviewer | Severity | Scope | Decision |
| --- | --- | --- | --- | --- |
| `reflowAfterShellTransition()` skipped all reflow when there were no overlays, so opening comments/nav on a fresh plan could change iframe width and content height without rerunning `syncFrameHeight()`. | GLM | P2 | `REGRESSION_FROM_THIS_DIFF` | Fixed |
| Sticky sidebars used hardcoded `86px` navbar offset. | GLM | P3 | `IN_PLAN` | Accepted as non-blocking shell convention. |
| Selection-box transitions can visually trail during continuous scroll. | GLM | P3 | `IN_PLAN` / pre-existing | Accepted as non-blocking. |

Fix: removed the overlay-only guard in `reflowAfterShellTransition()` and added a 260ms fallback, plus no-overlay sidebar-toggle e2e coverage.

## Review cycle 2

### GPT-5.5 verdict

`VERDICT: CLEAN_FOR_PR`

### GLM-5.2 verdict

`VERDICT: CLEAN_FOR_PR`

Summary: both reviewers confirmed the no-overlay P2 was fixed. GLM left one non-blocking P3: sticky sidebars no longer stretched divider borders down the full visible column.

Follow-up: fixed the P3 by giving desktop sticky plan-nav/sidebar columns `height: calc(100vh - 86px)` instead of only max/content height, with mobile sidebar overriding to `height:auto`. Added e2e assertions for those sticky-column heights.

## Review cycle 3

### GPT-5.5 verdict

`VERDICT: P1_P2_FOUND`

| Finding | Reviewer | Severity | Scope | Decision |
| --- | --- | --- | --- | --- |
| Desktop in-plan fragment links updated the iframe hash but could fail to visibly navigate because the iframe now has no internal scroll. | GPT | P2 | `REGRESSION_FROM_THIS_DIFF` | Fixed |

Fix: added same-render-document fragment-link interception that preserves modifier/target behavior, updates iframe history, and scrolls the parent owner (`window` on desktop, `#review` on mobile). Added desktop e2e coverage requiring parent scroll to the target while iframe scroll stays `0`.

### GLM-5.2 verdict

Redirected to the latest diff after GPT found fragment-link issues.

## Review cycle 4

### GPT-5.5 verdict

`VERDICT: P1_P2_FOUND`

| Finding | Reviewer | Severity | Scope | Decision |
| --- | --- | --- | --- | --- |
| Mobile fragment scrolling double-counted current `#review.scrollTop` after the user had already scrolled. | GPT | P2 | `REGRESSION_FROM_THIS_DIFF` | Fixed |
| Empty fragment links like `href="#"` were not intercepted because `new URL('#', base).hash` is empty. | GPT | P2 | `REGRESSION_FROM_THIS_DIFF` | Fixed |

Fixes:

- Changed mobile fragment scrolling to compute target position relative to `#review` with `review.scrollTop + frameRect.top - reviewRect.top + targetRect.top`, avoiding scroll-offset double-counting.
- Treated `href="#"` / empty fragments as `documentElement` targets.
- Added mobile e2e coverage for scrolled-state fragment navigation and empty-fragment back-to-top behavior.

## Final review cycle

### GPT-5.5 verdict

`VERDICT: CLEAN_FOR_PR`

Summary: GPT found no remaining reachable P1/P2 regression in shell links, target handling, mobile tap routing, marker positioning, fragment interception, or empty-fragment handling.

### GLM-5.2 verdict

`VERDICT: CLEAN_FOR_PR`

Summary: GLM confirmed the no-overlay reflow skip, mobile scroll double-counting, empty-fragment handling, and desktop fragment navigation issues are fixed and covered by e2e tests. It noted only non-blocking P3s: no `popstate` scroll restoration for prior fragment history entries, hardcoded sticky-column `86px` offset, and minor transition-listener inefficiency on rapid toggles.

## Final gate result

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`
- Latest verification: `bun run test:e2e` PASS; `bun run build && bun run test` PASS with 121 tests.
- Blocking P1/P2 issues: none remaining.
