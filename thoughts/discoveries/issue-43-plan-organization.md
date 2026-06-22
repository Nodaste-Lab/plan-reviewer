# Issue 43 plan organization discoveries

## 2026-06-21 pre-PR review follow-ups

Verification passed after implementation fixes:

- `bun run test` — PASS
- `bun run test:e2e` — PASS
- `bun run test:fixtures` — PASS
- GPT-5.5 pre-PR rereview — `CLEAN_FOR_PR`
- GLM-5.2 pre-PR rereview — `CLEAN_FOR_PR`

Non-blocking follow-ups from rereview:

1. `plan.columns.changed` is declared but not emitted for board-column configuration changes. Persisted column configuration works; concurrent Kanban tabs may need manual reload to see order/label changes.
2. The review-shell Status organization control is currently a free-text board-column-key input. Invalid labels fail safely through the existing organizer alert; a follow-up can replace it with visible configured column choices.
3. Pin/project API and CLI commands currently apply to collaboration documents too, while board-column moves remain planning-only. Decide in a follow-up whether this is intended cross-document organization or should be planning-only.

## 2026-06-21 PR feedback follow-up

PR review found a P2 regression: the left navigator included archived/deferred documents instead of staying active-only. The follow-up fix keeps `/api/plans/navigator` active-only and appends only the current archived/deferred document so deep-linked hidden documents retain orientation without turning the left nav into global search. Cmd-O remains the all-lifecycle discovery surface.

The requested PM/product and adversarial implementation reviews found one additional P2 after the navigator fix: the generic State selector/API/CLI could defer a plan without an agent-visible note. The fix requires a note for `PUT /api/plans/:planId/lifecycle` when `lifecycleState` is `deferred`, routes that path through `store.deferPlan`, prompts in the review shell, and requires `--note` in `plan-review lifecycle set ... deferred`.

Verification after PR-feedback fixes:

- `bun run build && node --test dist/__tests__/contracts.test.js` — PASS
- `bun run test:e2e` — PASS after one unrelated comment-storm timeout passed on rerun
- `bun run test:fixtures` — PASS
- `bun run test` — PASS
- PM/product rereview — `PRODUCT_CLEAN`
- Adversarial implementation rereview — `CLEAN_FOR_PR_UPDATE`

## 2026-06-21 demo feedback: review-shell top bar

Demo feedback clarified that the top-bar Project and Status controls had drifted from the plan mock. Project was incorrectly implemented as an editable project-name text field, and Status was incorrectly implemented as a free-text board-column key field.

Fix applied:

- Project override remains available through API/CLI, not as the top-bar control.
- Plan text now explicitly records this distinction.
- Superseded by later demo feedback: Project, State, and Status are now explicitly labeled filters that narrow the navigator/list and do not navigate away or call project/lifecycle/column mutation endpoints.

Verification:

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "review shell exposes titled left navigator"` — PASS
- `bun run test:e2e` — PASS

## 2026-06-21 demo feedback: Kanban board polish and column hiding

Demo feedback clarified three Kanban issues:

- The white squares on cards were default-styled pin buttons, and Kanban cards should not expose pin controls at all.
- The Kanban board was constrained by the normal centered `<main>` max width instead of using the browser width.
- Users need to hide columns they are not using.

Fix applied:

- Kanban pages now use a full-width `.kanban-page` layout and responsive column grid.
- Kanban cards no longer render pin buttons, pinned badges, pinned styling, or pinned-first sorting.
- `/columns` now includes a visibility editor backed by persisted board-column `hiddenAt` state.
- Empty columns can be hidden; occupied columns show a disabled hide control with move-first guidance so plans do not silently disappear.
- Plan text and contract coverage now lock the intended behavior.

Verification:

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "organization APIs persist"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- PM/product rereview — `PRODUCT_CLEAN`
- Adversarial implementation rereview — `CLEAN_FOR_PR_UPDATE`

## 2026-06-21 demo feedback: top-bar filters and icon actions

Demo feedback clarified that the review-shell Project, State, and Status controls are filters, not current-plan mutation controls:

- Project filters the navigator/list by project and must not navigate to the Kanban view.
- State filters the navigator/list by lifecycle state and must not defer/archive/resume the current plan.
- Status filters the navigator/list by configured board column and must not move the current plan.
- All documents top-bar actions must match the planned icon-action style instead of old text buttons.

Fix applied:

- Review-shell controls are now named and labeled `Filter: Project`, `Filter: State`, and `Filter: Status` in UI, code, and plan text.
- Filter controls update the navigator/list client-side and do not call project/lifecycle/column mutation endpoints.
- Active filters load the all-documents source so deferred/archived/status filters have complete results while preserving the current document in the navigator.
- All documents Deferred/Archived actions now render as icon actions with accessible labels/tooltips.

Verification:

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "deferred lifecycle hides|archive page renders|organization APIs persist|review shell exposes titled"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- GPT plan-faithfulness review — `CONSENSUS_CLEAN`
- GLM plan-faithfulness review — `CONSENSUS_CLEAN`

## 2026-06-21 demo feedback: mode selector style

Demo feedback clarified that the shared `Kanban | All documents` selector itself still did not match the plan prototype. Root cause: index pages used segmented selector styles, but the review shell stylesheet only had a generic `#plan-navbar a` rule, so selector anchors rendered like ordinary blue text links. The index selector also used 6px vertical segment padding while the plan prototype uses 5px.

Fix applied:

- Review shell CSS now defines the same `.doc-kind-switcher`, `.doc-kind-seg`, and `.doc-kind-seg.active` segmented/pill styles scoped under `#plan-navbar` so they override generic navbar link styling.
- Shared index selector segment padding now matches the plan prototype (`5px 10px`) and preserves nowrap segment labels.
- Contract tests assert the review-shell and index selector CSS so this cannot silently regress to text-link styling.

Verification:

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "review shell exposes titled left navigator|organization APIs persist"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- GPT selector plan-faithfulness review — `CONSENSUS_CLEAN`
- GLM selector plan-faithfulness review — `CONSENSUS_CLEAN`

## 2026-06-21 demo feedback: project means parent repo, not worktree

Demo feedback clarified that the Project filter is misleading if inferred from linked-worktree folder names such as `issue-43-organization`. Product intent is to group by the parent repository/project when the service can derive it.

Fix applied:

- Project inference now probes `git rev-parse --path-format=absolute --git-common-dir` for the registered root/worktree path.
- Linked worktrees derive `projectName`/`projectKey` from the parent repository directory, e.g. `parent-repo`, not the worktree folder.
- If Git metadata is unavailable, inference falls back to `repoName`, then the registered root basename, then source path heuristics.
- Startup backfill re-derives non-overridden project metadata, so rows that previously stored a worktree folder are repaired when the parent repo can still be derived.
- Contract coverage creates a real linked git worktree and verifies the Project filter options include the parent repo and exclude the worktree folder for both fresh registration and a simulated legacy non-overridden row.

Verification:

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "project inference uses the parent git repo"` — PASS after legacy-row backfill coverage

## 2026-06-21 demo feedback: top buttons by screen

Demo feedback clarified that the top action cluster must be screen-specific. Some screens had valid global navigation mixed with actions that did not make sense in that context.

Fix applied:

- Kanban now shows only Configure columns in the top action cluster; Deferred and Archived shortcuts are omitted from the workflow board.
- Kanban, All Documents, Deferred, Archived, and board-column configuration screens no longer show the menu/collapse-left-nav button because those screens do not have a left navigator; All Documents and lifecycle list pages anchor `Kanban | All documents` as the first topbar control.
- The mode selector is simplified to `Kanban | All documents`; collaboration documents are selected with the All Documents `Filter by type` control (`Plan` or `Collaborative`).
- Plan/document review pages show the same two selector options as unselected navigation choices because neither index view is active while reading a specific document.
- All Documents renders the complete active document list at full browser width and applies Type client-side so users can switch between Plan and Collaborative without a reload; legacy `view=collab` only preselects the Collaborative filter.
- All documents remains the mixed-discovery lifecycle hub and keeps Deferred/Archived shortcuts.
- Deferred and Archived list pages no longer show a duplicate Active-index/home icon or an action for the current screen; each only links to the sibling lifecycle list.
- Contract coverage asserts the absence of irrelevant top actions on Kanban and All Documents, the left-anchored two-state selector on All Documents, full-width All Documents styling, unselected plan-shell selector links, and the All Documents type filter.

Verification:

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "organization APIs persist"` — PASS

## 2026-06-21 demo feedback: navigator filters persist across plan switches

Demo feedback clarified that the review-shell top filters are navigator/list state, not per-plan state. Switching plans in the left navigator must keep selected Project/State/Status filters instead of rebuilding them at defaults.

Fix applied:

- The review shell stores non-empty Project/State/Status filter selections in same-tab session storage.
- The shell restores those selections before the navigator loads on a plan page.
- Left-navigator clicks save the current filter state before the browser navigates to the next plan.
- E2E coverage selects a State filter, switches plans via the left navigator, and asserts the filter remains selected on the destination plan page.
