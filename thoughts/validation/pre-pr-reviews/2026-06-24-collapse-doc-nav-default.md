# Pre-PR implementation review — collapse-doc-nav-default

Date: 2026-06-24

## Scope

Plan: `thoughts/plans/configuration-panel-and-review-defaults.html`

Target/base: `origin/main`. The committed range `origin/main...HEAD` is empty; implementation changes are currently unstaged working-tree changes plus the untracked plan artifact.

Branch: `collapse-doc-nav-default`

## Changed files

- `README.md`
- `thoughts/plans/configuration-panel-and-review-defaults.html`
- `src/schemas.ts`
- `src/storage/database.ts`
- `src/server/app.ts`
- `src/__tests__/contracts.test.ts`
- `src/test-fixtures/e2e-run.ts`

Working-tree stat before pre-PR review:

```text
README.md                       |  26 +++-
src/__tests__/contracts.test.ts | 323 ++++++++++++++++++++++++++++++++++++++--
src/schemas.ts                  |  19 ++-
src/server/app.ts               | 249 ++++++++++++++++++++++---------
src/storage/database.ts         |  33 ++++
src/test-fixtures/e2e-run.ts    |  83 ++++++++---
6 files changed, 630 insertions(+), 103 deletions(-)
```

## Scope contract summary

- Add a local SQLite-backed Configuration panel at `/configuration`.
- Move board-column config into Configuration while keeping `/columns` compatible.
- Default desktop plan navigator and comments panel to hidden on plan entry; keep mobile/coarse-pointer entry behavior unchanged.
- Add strict persisted `GET`/`PUT /api/configuration` behavior with defaults, unknown-key rejection, and invalid-save preservation.
- Make action-button skill names configurable as validated tokens only, preserving fixed request body shape and rejecting unsafe single-line plan paths before creating comments.
- Keep Kanban enabled by default; when disabled, default `/` to All documents, hide/ignore Kanban status surfaces, block plan movement with `feature_disabled`, and preserve columns/assignments for re-enable.
- Update README and automated coverage.

Out of scope: authentication, per-user/repo/plan configuration, arbitrary prompt bodies, deleting columns/assignments, queue/comment lifecycle changes.

## Verification before pre-PR review

- `bun run build && node --test dist/__tests__/contracts.test.js` — pass, 126/126.
- `bun run build && bun run test:e2e` — pass.
- `bun run build && bun run test && bun run test:e2e` — pass, full suite 127/127 plus e2e.

## Scoped implementation review before pre-PR gate

- GPT scoped review final verdict: `PASS_SCOPED`.
- GLM scoped review final verdict: `PASS_SCOPED`.
- In-scope findings fixed before the pre-PR gate: Unicode action-plan-path separators, README hidden-column wording, mobile comments default opt-in, and stale `boardColumnKey` filters while Kanban is disabled.

## Pre-PR review cycle 1

### GPT-5.5 verdict

`VERDICT: CLEAN_FOR_PR`

Findings: none.

Summary: GPT reviewed unstaged changes plus the untracked plan artifact and found no security, data-loss, migration, API/schema drift, or acceptance-criteria gaps that would reasonably block the PR.

### GLM-5.2 verdict

`VERDICT: CLEAN_FOR_PR`

Findings: none.

Summary: GLM reviewed every changed file plus the plan artifact against AC1–AC10. It found no unresolved in-scope P1/P2/P3 findings. GLM noted two non-blocking UX observations — stale static skill preview after save and a possible transient mobile comments-sidebar flash when `showCommentsByDefault=true` — but explicitly did not classify either as a finding or gate blocker because persisted behavior and action-comment bodies are correct.

### Triage

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| None | GPT-5.5 | — | — | No action | `VERDICT: CLEAN_FOR_PR` |
| None | GLM-5.2 | — | — | No action | `VERDICT: CLEAN_FOR_PR`; non-blocking observations only |

## Fixes from pre-PR review

None required.

## Verification after pre-PR fixes

No pre-PR fixes were required. The latest verification after the final implementation fix remains:

- `bun run build && node --test dist/__tests__/contracts.test.js` — pass, 126/126.
- `bun run build && bun run test:e2e` — pass.
- `bun run build && bun run test && bun run test:e2e` — pass, full suite 127/127 plus e2e.

## Final gate result

- GPT verdict: `CLEAN_FOR_PR`.
- GLM verdict: `CLEAN_FOR_PR`.
- Remaining blocking findings: none.
- Remaining out-of-scope follow-ups: none.
- Scoped-run status: `OPEN_PR_READY`.
