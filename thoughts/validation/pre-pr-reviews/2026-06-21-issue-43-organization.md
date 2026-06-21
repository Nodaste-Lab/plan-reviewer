# Pre-PR implementation review — issue-43-organization

## Scope

Plan: `thoughts/plans/issue-43-plan-organization.html`

Branch: `issue-43-organization`

Comparison: uncommitted working-tree diff on the feature branch, including the untracked plan and validation artifacts.

## Changed files

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
| User demo feedback | P2 | The shared `Kanban | All documents | Collab docs` mode selector still did not visually match the plan prototype. | Fixed | Review-shell CSS now defines the planned segmented selector under `#plan-navbar`, preventing generic blue navbar link styling from overriding the mode selector. Shared index selector segment padding now matches the plan prototype (`5px 10px`). Contract tests assert both shell and index selector CSS. |

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
| User demo feedback | P2 | Some top-screen buttons were present on screens where they did not make functional sense. | Fixed | Kanban now shows only Configure columns; All documents remains the lifecycle hub with Deferred/Archived shortcuts; Collab docs omits lifecycle and plan-only top actions; Deferred/Archived list pages only link to the sibling lifecycle list and no longer show duplicate Active-index/current-screen actions. Contract coverage asserts the absence of irrelevant top actions on Kanban, Collab docs, Deferred, and Archived screens. |

## Screen-specific top actions verification

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "organization APIs persist|deferred lifecycle hides|archive page renders"` — PASS
- `bun run test:e2e` — PASS
- `bun run test` — PASS
- GPT top-action review — `CONSENSUS_CLEAN`
- GLM top-action review — `CONSENSUS_CLEAN`

## Final gate result

PASS — GPT verdict `CLEAN_FOR_PR`; GLM verdict `CLEAN_FOR_PR`; PR-feedback PM verdict `PRODUCT_CLEAN`; PR-feedback adversarial verdict `CLEAN_FOR_PR_UPDATE`; demo feedback targeted gates PASS; Kanban demo PM/adversarial rereviews clean; top-bar GPT/GLM plan-faithfulness rereviews both `CONSENSUS_CLEAN`; mode-selector GPT/GLM plan-faithfulness rereviews both `CONSENSUS_CLEAN`; parent-project GPT/GLM rereviews both `CONSENSUS_CLEAN`; screen-specific top-action GPT/GLM rereviews both `CONSENSUS_CLEAN`.
