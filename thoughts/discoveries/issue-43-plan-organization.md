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
- Regression tests assert there are no `project-control` or `column-control` text inputs, Status contains configured column labels, and client code navigates for project selection instead of calling the project override endpoint.

Verification:

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "review shell exposes titled left navigator"` — PASS
- `bun run test:e2e` — PASS
