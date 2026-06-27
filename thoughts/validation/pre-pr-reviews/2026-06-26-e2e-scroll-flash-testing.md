# Pre-PR implementation review — e2e-scroll-flash-testing

Date: 2026-06-26
Branch: e2e-scroll-flash-testing
Plan: thoughts/plans/e2e-scroll-flash-testing.html
Base: 1f34e629a52cf49c1b90b8ff052f55877db68919

## Changed files summary

- `src/server/app.ts` — navigator label parity, scoped scroll handoff, iframe-context target link fallback, passive touch listeners, Kanban menu internal/open-time scroll guards.
- `src/test-fixtures/e2e-run.ts` — Playwright coverage for navigator refresh stability, WebKit first-wheel oracle, popup/link behavior, representative controls/menu behavior.
- `src/__tests__/contracts.test.ts` — generated shell/static guards for status logic, passive touch listeners, and scroll helper/no global scroll override.
- `thoughts/plans/e2e-scroll-flash-testing.html` and `thoughts/plans/assets/e2e-scroll-flash-testing/*` — reviewed plan and evidence artifacts.

## Verification

Passed before first scoped review:

- `bun run build && node dist/test-fixtures/e2e-run.js`
- `bun run test`
- `bun run test:fixtures -- --scenario seeded-comment-stream`
- `bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated`

Passed after scoped-review fixes:

- `bun run build && node dist/test-fixtures/e2e-run.js`
- `bun run test`

Final verification after this pre-PR gate:

- `bun run test` passed.
- `bun run test:e2e` initially exposed a Kanban context-menu open-time scroll dismissal issue.
- Fixed the Kanban menu to ignore the first 150ms open-time scroll burst while preserving later outside-scroll dismissal and menu-internal scroll.
- Post-fix `bun run test:e2e` passed.
- Post-fix `bun run test` passed.
- Post-fix `bun run test:fixtures -- --scenario seeded-comment-stream` passed.
- Post-fix `bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated` passed.

## Runtime scoped review loop

### Cycle 1

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT quality-reviewer | `FIX_IN_SCOPE_FINDINGS` | Found parent `window.open` sandbox/noopener regression and WebKit first-wheel oracle false-green risk. |
| GLM quality-reviewer-glm | `FIX_IN_SCOPE_FINDINGS` | Same two findings: iframe target fallback opened from parent, WebKit test waited for restored scroll. |

Triage:

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---|---|---|---|
| Parent `window.open` for rendered-plan target links bypassed iframe context | GPT + GLM | P1 | `REGRESSION_FROM_THIS_DIFF` | Fixed | `activateFrameInteractiveTarget` now uses `frame.contentWindow?.open(href, targetName, 'noopener,noreferrer')`. |
| WebKit first-wheel test could false-green and product had second rAF restore | GPT + GLM | P2 | `IN_PLAN` | Fixed | Removed second rAF scroll restore; WebKit test computes intended restored target and wheels immediately after fragment click. |

### Cycle 2

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT quality-reviewer | `PASS_SCOPED` | Previous findings verified fixed; no new in-scope issue. |
| GLM quality-reviewer-glm | infrastructure failure | Empty output; rerun narrowly per workflow. |
| GLM quality-reviewer-glm narrow rerun | `PASS_SCOPED` | Verified iframe popup fallback, no second rAF restore, and immediate WebKit wheel oracle. |

## Pre-PR GPT/GLM gate

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT quality-reviewer | `CLEAN_FOR_PR` | No findings. Checked navigator parity, scroll lifecycle, popup/sandbox behavior, passive listeners, tests, and artifacts. |
| GLM quality-reviewer-glm | `CLEAN_FOR_PR` | No findings. Checked same surfaces and spot-checked popup opener/referrer behavior. |

## Post-gate Kanban follow-up

Final e2e verification exposed a Kanban context-menu open-time scroll dismissal issue in the small-viewport menu scrollability smoke. The product fix records `kanbanMenuOpenedAt`, ignores scroll events during the first 150ms after opening, and still closes on later outside/page scrolls while preserving menu-internal scroll.

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT quality-reviewer narrow follow-up | `CLEAN_FOR_PR` | No P1/P2/P3 findings. Short ignore window is bounded and outside scroll after the window still closes the menu. |
| GLM quality-reviewer-glm narrow follow-up | `CLEAN_FOR_PR` | No P1/P2/P3 findings. Fast deliberate outside scroll inside 150ms is recoverable and not PR-blocking. |

## Post-rebase conflict follow-up

The branch was rebased onto current `origin/main`; the only conflict was the generated Kanban script in `src/server/app.ts`. The resolution retained main's `mark-done` context-menu behavior and this branch's `kanbanMenuOpenedAt`, passive `touchstart`, and menu scroll-dismissal guards.

Post-rebase verification passed:

- `bun run test`
- `bun run test:e2e`
- `bun run test:fixtures -- --scenario seeded-comment-stream`
- `bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated`

Narrow conflict-resolution review passed:

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT quality-reviewer narrow follow-up | `CLEAN_FOR_PR` | No PR-blocking issue in the merged Kanban script behavior. |
| GLM quality-reviewer-glm narrow follow-up | `CLEAN_FOR_PR` | Verified generated script syntax, mark-done behavior, passive `touchstart`, and menu scroll behavior. |

## Remaining follow-ups

None.

## Final gate result

GPT verdict: `CLEAN_FOR_PR`
GLM verdict: `CLEAN_FOR_PR`
Final synthesized status: `OPEN_PR_READY`.
