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

Demo feedback clarified that the top-bar Project and Status controls had drifted from the plan mock. Project was incorrectly implemented as an editable project-name text field, but its intended role is project navigation/scoping: choosing a project opens the Kanban board filtered to that project. Status was incorrectly implemented as a free-text board-column key field, but its intended role is selecting one of the configured board columns.

Fix applied:

- Review shell Project now renders as a `<select>` of registered project groups and navigates to `/?projectKey=...`.
- Review shell Status now renders as a `<select>` populated from persisted board columns.
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

Demo feedback clarified that the shared `Kanban | All documents | Collab docs` selector itself still did not match the plan prototype. Root cause: index pages used segmented selector styles, but the review shell stylesheet only had a generic `#plan-navbar a` rule, so selector anchors rendered like ordinary blue text links. The index selector also used 6px vertical segment padding while the plan prototype uses 5px.

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
