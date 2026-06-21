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
