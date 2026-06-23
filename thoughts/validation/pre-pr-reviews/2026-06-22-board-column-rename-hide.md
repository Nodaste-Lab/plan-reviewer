# Pre-PR Implementation Review — board column rename/hide

Date: 2026-06-22
Branch/worktree reviewed: `board-column-rename-hide` at `/Users/anichols/code/plan-reviewer`
Base/range: `origin/main...HEAD` plus unstaged PR-feedback fixes
Plan/scope: PR #46 — board column label changes rename stable keys and migrate assigned plans; occupied columns can be hidden while preserving assignments; PR feedback required simultaneous column-key handoffs to work when the final key set is unique.

## Review packet

`git status --short --branch`:

```text
## board-column-rename-hide...origin/board-column-rename-hide
 M src/__tests__/contracts.test.ts
 M src/storage/database.ts
?? thoughts/plans/pi-plan-mode-registration-monitor-fix.html
```

Committed diff vs `origin/main`:

```text
src/__tests__/contracts.test.ts                    |  76 +++++++++++++--
src/cli.ts                                         |  11 ++-
src/schemas.ts                                     |   1 +
src/server/app.ts                                  |  13 +--
src/storage/database.ts                            |  29 ++++--
thoughts/plans/issue-43-plan-organization.html     |  14 +--
thoughts/validation/pre-pr-reviews/2026-06-22-main.md | 102 +++++++++++++++++++++
```

Unstaged PR-feedback fix before final commit:

```text
src/__tests__/contracts.test.ts | 16 ++++++++++++++++
src/storage/database.ts         | 38 ++++++++++++++++++++++++++------------
```

Changed files in scope:

- `src/storage/database.ts`
- `src/server/app.ts`
- `src/schemas.ts`
- `src/cli.ts`
- `src/__tests__/contracts.test.ts`
- `thoughts/plans/issue-43-plan-organization.html`
- `thoughts/validation/pre-pr-reviews/2026-06-22-board-column-rename-hide.md`

Untracked unrelated file excluded from review scope:

- `thoughts/plans/pi-plan-mode-registration-monitor-fix.html`

## PR feedback addressed

Codex review left one P2 on PR #46: `saveBoardColumns()` rejected valid multi-column handoffs, such as `backlog -> ready_to_pull` and `ready_to_pull -> ready`, because it checked the requested target key against the current key set before considering that a later rename in the same payload frees that key.

Fix:

- Validate duplicate final keys and duplicate original keys before mutation.
- Compute all rename sources up front.
- Permit a target key when its current occupant is also a rename source in the same save.
- Move all renamed source rows and assigned plans through transaction-local temporary keys, then move each temp key to its final key.
- Add a regression test for `triage -> ready_to_pull` plus `ready_to_pull -> ready` in one request, asserting the assigned plan follows `triage` to `ready_to_pull`.

## Cycle 1 verdicts from prior commit

- GPT verdict: `P1_P2_FOUND`
- GLM verdict: `CLEAN_FOR_PR` by gate severity, with the same lifecycle issue classified as P3.

### Cycle 1 triage

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Hidden-column assignment was remapped to a visible default on active transition, resume, or unarchive | GPT | P2 | REGRESSION_FROM_THIS_DIFF | Fixed in commit `982286f` | `visibleBoardColumnKey()` only checked visible columns, while the feature now permits valid plans assigned to hidden columns. |
| Hidden-column assignment lifecycle behavior was newly reachable and untested | GLM | P3 | REGRESSION_FROM_THIS_DIFF | Fixed as part of GPT P2 | Same reachable path; fixed to preserve hidden-column assignment and covered with tests. |
| Multi-column swap/chained renames require multiple saves | GLM | P3 | IN_PLAN / UX limitation | Fixed after PR feedback | Codex PR feedback reclassified this as P2 because the final mapping can be unique and valid in one browser save. |
| CLI cannot rename hidden columns because it fetches visible-only columns | GLM | P3 | OUT_OF_SCOPE_FOLLOW_UP | Deferred | CLI-visible limitation with a clear error; UI can rename hidden columns. |

## Verification after PR-feedback fix

```bash
bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "board column rename migrates"
```

Result: pass. Node's test-name pattern still enumerated the contracts file; 119 pass, 0 fail. The targeted chained-rename assertion passed.

```bash
bun run test
```

Result: pass, 120/120.

## Cycle 2 pre-PR review after PR-feedback fix

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`

### Cycle 2 triage

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| No unresolved P1/P2 issues | GPT | n/a | n/a | Gate clean | GPT traced committed diff plus unstaged fix and found the two-phase rename supports simultaneous handoffs. |
| Stale `originalKey` from another tab can create an empty column | GLM | P3 | OUT_OF_SCOPE_FOLLOW_UP | Deferred | No plan loss or data corruption; concurrent rename already migrated plans. Track as future stale-form UX hardening. |
| CLI cannot rename hidden columns because it fetches visible-only columns | GLM | P3 | OUT_OF_SCOPE_FOLLOW_UP | Deferred | Pre-existing limitation; UI can rename hidden columns. Track as future CLI parity polish. |
| `plan.columns.changed` events are emitted for every plan on every save | GLM | P3 | OUT_OF_SCOPE_FOLLOW_UP | Deferred | Pre-existing event noisiness; not a correctness regression. |

## Final gate result

PASS — both reviewers report no unresolved in-scope P1/P2 issues.

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`
- Verification after last fix: `bun run test` passed, 120/120.

Remaining non-blocking follow-ups:

- Add stale-form detection when a submitted `originalKey` no longer exists after another tab renames it.
- Add CLI support for renaming hidden columns.
- Consider narrowing `plan.columns.changed` event emission to affected plans.
