# Pre-PR implementation review — issue-43-organization

## Scope

Plan: `thoughts/plans/issue-43-plan-organization.html`

Branch: `issue-43-organization`

Comparison: uncommitted working-tree diff on the feature branch, including the untracked plan and validation artifacts.

## Changed files

- `README.md`
- `src/schemas.ts`
- `src/storage/database.ts`
- `src/server/app.ts`
- `src/cli.ts`
- `src/__tests__/contracts.test.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/plans/issue-43-plan-organization.html`
- `thoughts/validation/pre-pr-reviews/2026-06-21-issue-43-organization.md`
- `thoughts/discoveries/issue-43-plan-organization.md`

## Verification before review

- `bun run test` — PASS
- `bun run test:e2e` — PASS
- `bun run test:fixtures` — PASS

## Review cycle 1

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT-5.5 quality-reviewer | `P1_P2_FOUND` | Found hidden default-column orphaning and quick-open 200-item cap. |
| GLM-5.2 quality-reviewer-glm | `P1_P2_FOUND` | Found lifecycle API source-sync parity gap and missing client consumption for new organization events. |

## Triage

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Hidden `backlog` could orphan new planning documents | GPT-5.5 | P2 | IN_PLAN | Fixed | Added visible fallback column selection for registration/mode-change/backfill and rejected configurations with no visible columns. Regression: `hidden backlog does not orphan new planning documents`. |
| Cmd-O only searched bounded 200-item navigator | GPT-5.5 | P2 | IN_PLAN | Fixed | Added paged quick-open source loading via `/api/plans?includeArchived=true&includeDeferred=true&limit=200`, separate from navigator errors. Regression: client text assertions and e2e quick-open behavior. |
| Lifecycle API `active` transition missed immediate filesystem sync | GLM-5.2 | P2 | REGRESSION_FROM_THIS_DIFF | Fixed | `PUT /api/plans/:planId/lifecycle` now calls `sourceSync.syncNow(..., 'manual')` after `sourceSync.register`. Regression: `lifecycle API active transition immediately syncs filesystem sources`. |
| New organization events were emitted but ignored by browser client | GLM-5.2 | P2 | IN_PLAN | Fixed | Client now schedules metadata reload for `plan.lifecycle.changed`, `plan.column.changed`, `plan.pin.changed`, and `plan.project.changed`. Regression: `review client consumes organization events and paginates quick-open source data`. |
| `plan.columns.changed` schema event is declared but not emitted | GLM-5.2 | P3 | IN_PLAN | Deferred | Non-blocking; no live SPA consumer currently depends on column-config events. |

## Verification after fixes

- `bun run build && node --test dist/__tests__/contracts.test.js` — PASS
- `bun run test` — PASS
- `bun run test:e2e` — PASS
- `bun run test:fixtures` — PASS

## Review cycle 2

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT-5.5 quality-reviewer | `CLEAN_FOR_PR` | No P1/P2 production-blocking issues found after fixes. |
| GLM-5.2 quality-reviewer-glm | `CLEAN_FOR_PR` | All four prior blockers verified fixed; no new P1/P2 issues found. |

## Remaining non-blocking observations

- `plan.columns.changed` is declared but not emitted for board-column configuration changes. Current column settings persist correctly; stale concurrent Kanban tabs require manual reload. Logged as follow-up.
- API/CLI pin/project commands can apply to collaboration documents, while board-column moves remain planning-only. This is a minor consistency follow-up, not a data-loss or security risk.

## PR feedback cycle

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| GitHub PR review | P2 | Left navigator included archived/deferred documents after the organization work, making the active review shell too noisy. | Fixed | `/api/plans/navigator` now uses the active feed and appends only the current lifecycle-hidden document. Reloaded review shells and the archive button event path both use the canonical navigator feed. Regression: `navigator keeps lifecycle-hidden documents out except the current page`; e2e archive-current navigator assertion. |
| PM product review | P2 | The direct archive button path still removed the current archived document from the left navigator. | Fixed | Client archive flow now reloads `/api/plans/navigator?currentPlanId=...` instead of locally filtering the current item. `bun run test:e2e` passed after the fix. |
| Adversarial implementation review | P2 | Generic State selector/API/CLI could defer a plan without an agent-visible note. | Fixed | `PUT /api/plans/:planId/lifecycle` requires `note` for `deferred` and routes through `store.deferPlan`; State selector prompts for a note; CLI `lifecycle set ... deferred` requires `--note`. Regression coverage added to organization API, lifecycle sync, and CLI organization tests. |

## PR feedback verification

- `bun run build && node --test dist/__tests__/contracts.test.js` — PASS
- `bun run test:e2e` — PASS after one unrelated comment-storm timeout passed on rerun
- `bun run test:fixtures` — PASS
- `bun run test` — PASS

## PR feedback rereview

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| PM/product rereview | `PRODUCT_CLEAN` | No P1/P2 product blockers found after fixes. |
| Adversarial implementation rereview | `CLEAN_FOR_PR_UPDATE` | No P1/P2 blockers found after fixes. |

## Demo feedback cycle

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| User demo feedback | P2 | Review-shell Project was editable/navigation-like, State changed the current plan, Status moved the current plan, and those controls were filters by product intent. The All documents top bar still used old text links instead of icon actions. | Fixed | Review-shell controls are now named/labeled `Filter: Project`, `Filter: State`, and `Filter: Status`; they filter the navigator/list without calling project/lifecycle/column mutation endpoints or navigating to Kanban. All documents Deferred/Archived actions render as icon actions with accessible labels/tooltips. Plan text and regression tests lock this intent. |
| User demo feedback | P2 | Kanban cards showed unexplained white square pin buttons, pins do not make sense on Kanban cards, the board did not use the full browser width, and there was no browser control to hide unused columns. | Fixed | Kanban uses a full-width responsive page, cards do not render pin controls/badges/styling/sort priority, `/columns` exposes persisted visibility toggles, and occupied columns cannot be hidden until plans are moved. |

## Demo feedback verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "review shell exposes titled left navigator|organization APIs persist|deferred lifecycle hides|archive page renders"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS

## Kanban demo feedback rereview

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| PM/product rereview | `PRODUCT_CLEAN` | No P1/P2 product blockers found after full-width Kanban, pin removal from Kanban cards, and column visibility fixes. |
| Adversarial implementation rereview | `CLEAN_FOR_PR_UPDATE` | No P1/P2 implementation blockers found in the latest diff. |

## Top-bar filter and icon-action rereview

| Reviewer | Verdict | Notes |
| --- | --- | --- |
| GPT plan-faithfulness review | `CONSENSUS_CLEAN` | Verified Project/State/Status are filters, mutation/navigation handlers were removed, All documents uses icon actions, Kanban no-pin behavior remains intact, and tests lock the intent. |
| GLM plan-faithfulness review | `CONSENSUS_CLEAN` | Verified UI/code/plan/test alignment for filter labels, navigator-only filtering, icon-action top bars, Kanban no-pin/responsive/column-hide behavior, and strengthened regression coverage. |

## Mode selector style correction

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| User demo feedback | P2 | The shared `Kanban | All documents` mode selector still did not visually match the plan prototype. | Fixed | Review-shell CSS now defines the planned segmented selector under `#plan-navbar`, preventing generic blue navbar link styling from overriding the mode selector. Shared index selector segment padding now matches the plan prototype (`5px 10px`). Contract tests assert both shell and index selector CSS. |

## Mode selector verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "review shell exposes titled left navigator|organization APIs persist"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- GPT selector plan-faithfulness review — `CONSENSUS_CLEAN`
- GLM selector plan-faithfulness review — `CONSENSUS_CLEAN`

## Project parent-repo correction

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| User demo feedback | P2 | The Project filter is not useful if project inference presents linked-worktree branch folders instead of the actual parent repo/project. | Fixed | Project inference now derives the parent repo with `git rev-parse --path-format=absolute --git-common-dir` when the registered root is a linked worktree, then falls back to `repoName` and root basename. Startup backfill re-derives non-overridden project metadata so previously stored worktree-folder projects are repaired when the parent can be derived. Contract coverage registers a real linked worktree and verifies the Project filter shows the parent repo while excluding the worktree folder for fresh and simulated legacy rows. |

## Project parent-repo verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "project inference uses the parent git repo"` — PASS after adding legacy non-overridden-row repair coverage
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- GPT parent-project plan-faithfulness review — first pass `BLOCKED` on legacy-row repair; rerun `CONSENSUS_CLEAN`
- GLM parent-project plan-faithfulness review — rerun `CONSENSUS_CLEAN`

## Screen-specific top actions correction

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| User demo feedback | P2 | Some top-screen buttons were present on screens where they did not make functional sense. | Fixed | Kanban now shows only Configure columns and no menu/collapse-left-nav button; All Documents has no menu/collapse-left-nav button and anchors `Kanban | All documents` first on the left; All Documents remains the lifecycle hub with Deferred/Archived shortcuts and adds `Filter by type` for Plan vs Collaborative documents; Deferred/Archived list pages also omit the menu/collapse-left-nav button and only link to the sibling lifecycle list. Contract coverage asserts the absence of irrelevant Kanban/All Documents/lifecycle-list controls plus the two-state selector and type filter. |

## Screen-specific top actions verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "organization APIs persist"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- GPT top-action review — `CONSENSUS_CLEAN`
- GLM top-action review — `CONSENSUS_CLEAN`

## Selector simplification and no-left-nav correction

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| User demo feedback | P2 | The third collaboration-document selector mode should be removed; collaboration documents should be filtered inside All Documents, and Kanban/All Documents should not show a left-nav collapse/menu button when there is no left nav. | Fixed | Shared selector renders only `Kanban` and `All documents`; All Documents renders `Filter by type` with `Plan` and `Collaborative`; legacy `view=collab` resolves to All Documents with the Collaborative type selected; Kanban, All Documents, Deferred, Archived, and column configuration omit the menu/collapse-left-nav button. Contract coverage asserts the two-state selector, type filter, collaboration access, no Kanban/All Documents/lifecycle-list menu button, and the All Documents selector anchored first in the topbar. |

## Selector simplification verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "organization APIs persist"` — PASS
- `bun run test:e2e && bun run test` — PASS
- GPT selector/type review — first rerun found stale plan copy; final rerun `CONSENSUS_CLEAN`
- GLM selector/type review — `CONSENSUS_CLEAN`

## All Documents no-left-nav verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "organization APIs persist|plan lifecycle"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- GPT All Documents/lifecycle topbar review — `CONSENSUS_CLEAN`
- GLM All Documents/lifecycle topbar review — `CONSENSUS_CLEAN`

## Plan-shell selector and All Documents width correction

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| User demo feedback | P2 | While viewing a specific plan, the `Kanban | All documents` selector looked like one active index mode instead of two navigation options; All Documents still inherited the narrow centered index width. | Fixed | Plan/document review shells render both selector links without an active segment; All Documents uses a `documents-page` full-width wrapper and a three-column responsive toolbar for text, repo, and Type filters. Contract/e2e coverage asserts no active shell selector segment, the two shell links, the full-width All Documents class/style, and the type-filter toolbar layout. |

## Plan-shell selector and All Documents width verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "review shell exposes compact download and plan navigator tools|organization APIs persist"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- Served smoke on `4318` — PASS for unselected plan-shell selector links, All Documents full-width wrapper, full-width CSS, and mobile toolbar override
- GPT plan-shell selector / All Documents width review — `CONSENSUS_CLEAN`
- GLM plan-shell selector / All Documents width review — `CONSENSUS_CLEAN`

## Plan-shell navigator filter persistence correction

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| User demo feedback | P2 | While viewing a plan, changing plans through the left navigator reset the top Project/State/Status filters even though those controls are navigator/list state. | Fixed | The review shell stores non-empty Project/State/Status filter selections in same-tab session storage, restores them before navigator loading on the destination plan page, saves them before left-nav plan clicks, and fails soft if storage is unavailable. E2E coverage selects a State filter, switches plans through the left navigator, and asserts the filter remains selected. |

## Plan-shell navigator filter persistence verification

- `bun run build` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- Served smoke on `4318` — PASS for shell filter controls, left-nav items, and served `/client.js` containing filter restore/save code
- GPT final filter-persistence review — `CONSENSUS_CLEAN`
- GLM final filter-persistence review — `CONSENSUS_CLEAN`

## Plan-shell navigator filtered-render correction

| Source | Severity | Finding | Decision | Evidence |
| --- | --- | --- | --- | --- |
| User demo feedback | P2 | Switching plans through the left navigator briefly showed all plans before the stored filters reapplied. | Fixed | Review-shell filter state is encoded in left-nav plan URLs as `projectKey`, `lifecycle`, and `boardColumnKey`; `/p/:planId` normalizes those query params, preselects the controls, and server-renders the destination navigator already filtered while preserving the current plan if it falls outside the filter. The client still keeps session-storage fallback, updates the visible URL on filter changes, and rewrites clicked nav links to the current filters before navigation. |

## Plan-shell navigator filtered-render verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "navigator keeps lifecycle-hidden|review shell exposes titled left navigator"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- Served smoke on `4318` — PASS for `/p/<planId>?lifecycle=active` selected filter and filtered left-nav links carrying `lifecycle=active`
- GPT filtered-render review — `CONSENSUS_CLEAN`
- GLM filtered-render review — `CONSENSUS_CLEAN`

## Formal pre-PR implementation review — final cycle

Comparison: `origin/main...HEAD`, plus the local README documentation fix before commit.

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| README documentation parity was incomplete for the new organization surfaces and CLI commands. | GLM-5.2 pre-PR review | P2 | IN_PLAN | Fixed | `README.md` now documents Kanban vs All documents, `Filter by type`, configurable columns and `/columns`, `columns list`, `columns save-order`, `column set`, `project set`, `lifecycle set` with deferred `--note`, `pin`/`unpin`, execution-readiness independence, left-nav filters, and global `⌘O`. README term checks and build passed. |
| Initial GPT pre-PR review returned no output. | GPT-5.5 pre-PR review | QUESTION | QUESTION | Reran after docs fix | Empty reviewer output was not counted as a gate verdict; the final GPT rereview returned `CLEAN_FOR_PR`. |
| `plan.columns.changed` event is declared but not emitted/consumed. | GLM-5.2 pre-PR review | P3 | IN_PLAN | Non-blocking follow-up | Column settings persist and the `/columns` page full-reloads; no live SPA consumer depends on the event. Tracked in this validation note's remaining non-blocking observations. |
| Column-label editing is API-only. | GLM-5.2 pre-PR review | P3 | IN_PLAN | Non-blocking follow-up | Visibility is exposed in `/columns`, ordering in CLI, and labels are preserved through the API payload. Not a merge blocker. |
| Minor stale/cosmetic/efficiency observations: initial server nav not pinned-first before client refresh, occupancy counts include deferred/archived plans, unused `/api/plans` filter parameters, startup project backfill runs synchronous git checks, filtered navigator can use a cached all-documents source, archive status pill can lag in a filtered navigator, active lifecycle set can resync no-op plans. | GLM-5.2 pre-PR review | P3 | IN_PLAN | Non-blocking follow-ups | No data loss, security issue, crash, or acceptance-blocking regression; final GLM rereview confirmed no P1/P2 remains. |

## Formal pre-PR implementation review verification

- README documentation term checks — PASS
- `bun run build` — PASS after README fix
- `bun run test` — PASS after final rereview
- `bun run test:e2e` — PASS after final rereview
- `bun run test:fixtures` — PASS after final rereview
- GPT-5.5 pre-PR rereview — `CLEAN_FOR_PR`
- GLM-5.2 pre-PR rereview — `CLEAN_FOR_PR`

## P3 follow-up resolution

Verification:

- `bun run test` — PASS
- `bun run test:e2e` — PASS
- `bun run test:fixtures` — PASS
- GPT P3 cleanup review — `CLEAN_FOR_PR`
- GLM P3 cleanup review — `CLEAN_FOR_PR`

| Prior P3 | Resolution | Evidence |
| --- | --- | --- |
| `plan.columns.changed` was declared but not emitted/consumed. | `saveBoardColumns` now emits `plan.columns.changed` events and the review shell consumes them through the metadata reload path. | Contract coverage asserts column-save responses include `plan.columns.changed`; client text coverage includes the event consumer. |
| Column-label editing was API-only. | `/columns` now renders editable label inputs and CLI adds `plan-review columns rename <key> <label>`. | Contract coverage asserts label inputs and CLI REST mapping for `columns rename`. |
| Server-rendered navigator did not apply pinned-first ordering. | Server navigator sorting now matches client pinned-first ordering. | Build/contracts passed after sort change. |
| Column occupancy counted deferred/archived plans. | Hide blocking now counts only active planning documents; deferred/archived plans in hidden columns are reassigned to a visible column on resume/unarchive/active lifecycle transition. | Contract coverage hides a deferred plan's column and asserts active transition moves it to `backlog`. |
| `/api/plans` had dead `reviewMode` and `boardColumnKey` filter parameters. | The route query now accepts and passes those filters to `filterPlans`. | Contract coverage exercises `reviewMode=planning&boardColumnKey=in_progress` and the inverse collaborative query. |
| Startup project backfill ran a git check per non-overridden row. | Backfill now caches git-parent repo lookups per root path. | Typecheck/contract suite passed. |
| Filtered navigator could reuse stale all-document source. | Filtered navigator loads force-refresh all-document source data instead of reusing the quick-open cache. | Build/contracts passed after client update. |
| Filtered archive status could lag cosmetically. | The same forced filtered source reload refreshes the archived item status after navigator reload. | Build/contracts passed after client update. |
| `lifecycle set active` could resync no-op active plans. | The server only registers/syncs/unregisters source watchers when lifecycle actually changes. | Contract coverage asserts a second active lifecycle call returns `changed: false`; build/contracts passed. |
| Pin/project commands applied to collaboration documents. | Planning-only organization commands now reject collaboration documents with `not_applicable`; changing a pinned plan to collaboration clears `pinnedAt`. | Contract coverage asserts collaborative column, pin, and project mutations reject. |

## Final gate result

PASS — GPT verdict `CLEAN_FOR_PR`; GLM verdict `CLEAN_FOR_PR`; PR-feedback PM verdict `PRODUCT_CLEAN`; PR-feedback adversarial verdict `CLEAN_FOR_PR_UPDATE`; demo feedback targeted gates PASS; Kanban demo PM/adversarial rereviews clean; top-bar GPT/GLM plan-faithfulness rereviews both `CONSENSUS_CLEAN`; mode-selector GPT/GLM plan-faithfulness rereviews both `CONSENSUS_CLEAN`; parent-project GPT/GLM rereviews both `CONSENSUS_CLEAN`; screen-specific top-action GPT/GLM rereviews both `CONSENSUS_CLEAN`; selector/type-filter GPT/GLM final rereviews both `CONSENSUS_CLEAN`; All Documents/lifecycle no-left-nav GPT/GLM rereviews both `CONSENSUS_CLEAN`; plan-shell selector / All Documents width GPT/GLM rereviews both `CONSENSUS_CLEAN`; plan-shell navigator filter persistence GPT/GLM rereviews both `CONSENSUS_CLEAN`; plan-shell navigator filtered-render GPT/GLM rereviews both `CONSENSUS_CLEAN`; formal pre-PR GPT/GLM rereviews both `CLEAN_FOR_PR`; P3 cleanup GPT/GLM reviews both `CLEAN_FOR_PR`.
