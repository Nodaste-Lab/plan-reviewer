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
