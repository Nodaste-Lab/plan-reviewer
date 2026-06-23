# Pre-PR implementation review — filter-tweaks

Date: 2026-06-22
Branch: `filter-tweaks`
Base/range: `origin/main...HEAD` plus unstaged working-tree changes
Plan/scope: standalone request — plan review shell filters should default State to Active, and direct/linked plan views should default Project to the viewed plan's project instead of all projects. Follow-up scope: remove unnecessary all-plan loads where practical and clean fallback-only navigator paths.

## Changed files

- `src/server/app.ts`
- `src/storage/database.ts`
- `src/__tests__/contracts.test.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/validation/pre-pr-reviews/2026-06-22-filter-tweaks.md`

No staged changes.

## Review cycle 1

- GPT verdict: `P1_P2_FOUND`
- GLM verdict: `P1_P2_FOUND`

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| Partial URL filters collapsed omitted dimensions to All on the client | GPT | P2 | `REGRESSION_FROM_THIS_DIFF` | Fixed | `urlNavigatorFilters()` returned blank values for omitted params, so `?projectKey=...` cleared State and `?lifecycle=archived` cleared Project after JS loaded. |
| `__all__` sentinel could collide with an explicit project key | GLM | P2 | `PLAN_PREREQUISITE` | Fixed by removing sentinel | `setPlanProjectSchema` allowed arbitrary non-empty `projectKey`; `projectKey=__all__` would decode as All projects. |
| Dead sessionStorage write / misleading e2e assertion | GLM | P3 | `REGRESSION_FROM_THIS_DIFF` | Fixed incidentally | Removed sessionStorage restore path and replaced the e2e assertion with URL/href behavior assertions. |
| Server/client explicit-All href parity gap | GLM | P3 | `IN_PLAN` | Fixed during P2 follow-up | Server href generation now preserves empty `projectKey=`/`lifecycle=` when filters are active. |
| Extra all-plans fetch on default-filter page load | GLM | P3 | `REGRESSION_FROM_THIS_DIFF` | Later fixed | Initially accepted as non-blocking; later follow-up replaced the path with scoped navigator loads. |

Fixes applied:

- Replaced `__all__` with empty query params (`projectKey=` / `lifecycle=`) for explicit All selections.
- Changed client URL parsing to preserve parameter presence, so omitted params no longer overwrite server-rendered defaults.
- Removed stale sessionStorage filter persistence from the restore path.
- Added contract coverage for default current-project + active filters, project-only URLs, lifecycle-only URLs, and explicit All projects + All states.
- Updated e2e coverage for explicit All-project navigation and linked-plan default project selection.

## Review cycle 2

- GPT verdict: `P1_P2_FOUND`
- GLM verdict: `CLEAN_FOR_PR` with P3 notes

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| Explicit All projects + All states was treated as filters inactive | GPT | P2 | `IN_PLAN` | Fixed | `projectKey=&lifecycle=` showed controls indicating All while server/client truthiness checks used active-only navigator data. |
| Server/client href parity gap for explicit All filters | GLM | P3 | `OUT_OF_SCOPE_FOLLOW_UP` | Fixed as part of P2 | Server hrefs now preserve empty explicit-All params when filters are active. |

Fixes applied:

- Added `active?: boolean` to review-shell navigator filters.
- Server-normalized `/p/:planId` filters now set `active: true`, preserving explicit empty filters as an active filter state.
- `reviewShellNavigatorFilterSearch()` emits `projectKey=` and `lifecycle=` when filters are active and the corresponding dimension is All.
- Client `navigatorFiltersActive()` treats present empty URL params as active filter state.
- All filter options now render `selected` when explicit All is selected.
- Added contract assertion that `?projectKey=&lifecycle=` includes active, archived, deferred, and other-project plans.

## Review cycle 3

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`

Remaining non-blocking notes at that point:

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| Unbounded all-plans load on `/p` render | GLM | P3 | `OUT_OF_SCOPE_FOLLOW_UP` | Fixed in follow-up | Added store-side scoped filters and changed `/p` to render bounded scoped navigator data. |
| Inactive navigator branches were fallback-only on `/p` | GLM | P3 | `OUT_OF_SCOPE_FOLLOW_UP` | Fixed in follow-up | Simplified server navigator item loading to use `listPlans({ limit, currentPlanId })` and scoped filtered list queries. |

## Cleanup follow-up

Changes applied:

- Added SQL-level store filters for `projectKey`, `reviewMode`, and `boardColumnKey` in `listPlans()`.
- Added cheap aggregate/list helpers: `countPlansByLifecycle()`, `listPlanProjects()`, and `countActivePlanningPlansByColumn()`.
- Narrowed `/`, `/deferred`, `/archive`, `/columns`, and `/api/plans` to scoped queries or aggregate counts where practical.
- Changed `/p/:planId` to use `listPlanProjects()` for project filter options and bounded scoped navigator data.
- Extended `/api/plans/navigator` with `projectKey`, `lifecycle`, `boardColumnKey`, `currentPlanId`, and `limit` support.
- Changed the review-shell client to fetch filtered navigator data from `/api/plans/navigator` instead of forcing quick-open's all-document `/api/plans` pagination.
- Kept quick-open as the only intentional all-document paginated source.

## Review cycle 4

- GPT verdict: `P1_P2_FOUND`
- GLM verdict: `CLEAN_FOR_PR`

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| Scoped navigator request promise could render stale filter results | GPT | P2 | `REGRESSION_FROM_THIS_DIFF` | Fixed | `loadNavigatorFilterSource()` reused one global in-flight promise even when `navigatorApiUrl()` changed, and `loadPlanNavigator()` could apply stale responses/errors after filter changes. |

Fixes applied:

- Added `navigatorLoadGeneration` and `navigatorFilterLoadUrl` in the client script.
- `loadNavigatorFilterSource()` now reuses an in-flight request only when the URL matches the current scoped URL.
- Scoped navigator responses return `{ url, generation, plans }` and are discarded if URL/generation is stale before rendering.
- `loadPlanNavigator()` applies the same URL/generation stale-response guard for successes and errors.
- Added contract assertions for the generation/url guard and that navigator filtering no longer calls `loadQuickOpenItems({ force: true })`.

## Review cycle 5

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`

Reviewer conclusions:

- Defaults and explicit-All query semantics are correct.
- Scoped `/api/plans/navigator` is bounded, validates lifecycle, and includes the current plan when needed.
- Client navigator loads discard stale scoped responses/errors.
- Quick-open remains the only all-document paginated load path.
- No P1/P2 blockers remain.

## Final verification

Run after the last fix and clean rereview:

```text
bun run build && node --test --test-name-pattern "navigator|review client consumes organization events" dist/__tests__/contracts.test.js
bun run test:e2e
bun run test
```

Results:

- Targeted contracts: passed, 7/7.
- E2E fixture: passed.
- Full test suite: passed, 120/120 tests.

## Final gate result

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`
- Final gate: PASS
