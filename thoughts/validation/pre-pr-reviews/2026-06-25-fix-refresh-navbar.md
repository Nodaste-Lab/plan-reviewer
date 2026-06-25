# Pre-PR implementation review — fix-refresh-navbar

- Date: 2026-06-25
- Branch: `fix-refresh-navbar`
- Plan: `thoughts/plans/smooth-plan-nav-state.html`
- Base/comparison: `origin/main...HEAD` plus uncommitted working-tree changes
- Scoped runner: `scoped-plan-run`
- Final gate result: `OPEN_PR_READY`

## Scope

Implement the reviewed HTML plan for smooth left plan navigator state. `/p/:planId` must render the left navigator open or closed correctly on first paint for browser open, refresh, and plan changes. After load, the only runtime path that changes `body.plan-nav-collapsed` is pressing `#desktop-plan-nav-toggle`.

In scope:

- Browser review shell left plan navigator state.
- Server-rendered first paint state for `/p/:planId`.
- Session cookie rendering hint with `Path=/`, `SameSite=Lax`, no durable expiry, and only `open` / `closed` values.
- Configuration fallback from `configuration.showPlanNavigatorByDefault`.
- Accessibility sync for `aria-expanded`, `aria-hidden`, and `inert`.
- Contract and browser E2E coverage for no startup class mutation.
- Plan progress/evidence updates.

Out of scope:

- Toolbar redesign, navigator content redesign, document filters, comments panel behavior.
- Client-side SPA navigation rewrite.
- Queue/comment/source-sync/security behavior changes.
- New mobile navigator drawer.

## Changed files

- `src/server/app.ts`
- `src/__tests__/contracts.test.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/plans/smooth-plan-nav-state.html`

## Review cycle 1

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT-5.5 (`quality-reviewer`) | `CLEAN_FOR_PR` | No findings. Confirmed server cookie/config first paint, startup accessibility-only sync, toggle-only runtime mutation, and focused coverage. |
| GLM-5.2 (`quality-reviewer-glm`) | `CLEAN_FOR_PR` | No findings. Confirmed cookie scope, invalid-cookie fallback, producer/consumer parity, no injection path, single first-paint path, and E2E mutation coverage. |

## Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| None | GPT-5.5 | n/a | n/a | n/a | `VERDICT: CLEAN_FOR_PR` |
| None | GLM-5.2 | n/a | n/a | n/a | `VERDICT: CLEAN_FOR_PR` |

## Fixes after review

None required.

## Verification

Before pre-PR gate, these passed:

- `bun run build && node --test dist/__tests__/contracts.test.js`
- `bun run build && node dist/test-fixtures/e2e-run.js`
- `bun run test`
- `bun run test:e2e`

Final verification after the clean pre-PR gate passed:

- `bun run build`
- `bun run test`
- `bun run test:e2e`

## Remaining out-of-scope follow-ups

None.

## Final gate result

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`
- Unresolved in-scope P1/P2/P3 findings: none
- Next step: `OPEN_PR_READY`
