# Pre-PR Implementation Review: toggle-annotations

## Scope

- Branch: `toggle-annotations`
- Base: `origin/main` at `849bc21`
- Plan: `thoughts/plans/toggle-plan-annotations.html`
- Changed files:
  - `src/server/app.ts`
  - `src/__tests__/contracts.test.ts`
  - `src/test-fixtures/e2e-run.ts`
  - `thoughts/plans/toggle-plan-annotations.html`

## Diff summary

Adds a plan-scoped annotation visibility toggle to the review shell. Annotations default on. Turning annotations off hides in-document comment anchors/labels/hover boxes, prevents new comment composer activation from plan-body interactions, preserves the comments sidebar, and restores normal reading/copy/link behavior. Mobile off-mode uses the iframe as the scroll container while disabling the touch overlay. Non-empty open composer drafts block disabling annotations and show the existing discard warning instead of stranding a draft.

## Verification evidence

- `bun run build` — passed
- Targeted contract checks for review shell toolbar / side panels — passed
- `node dist/test-fixtures/e2e-run.js` — passed
- `bun run build && node dist/test-fixtures/e2e-run.js` after mobile scroll fix — passed
- `bun run build && node dist/test-fixtures/e2e-run.js` after draft-state fix — passed
- Full gate after contract update: `bun run build && bun run test && bun run test:e2e && bun run test:fixtures -- --scenario seeded-comment-stream && bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated` — passed
- Final full gate after draft-state fix: same full command — passed. Output included 152 passing tests, e2e scenarios passed (`plan index`, `dom annotation`, `image annotation`, `plan sync`, `deferred notes resume sync`), `seeded-comment-stream` fixture passed, and `agent-listener-harness-smoke` simulated fixture passed.

## Review cycles

### Cycle 1

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT quality-reviewer | `FINDINGS_TO_RESOLVE` | P2 mobile annotation-off mode could make long plans unscrollable because iframe pointer events were restored while the parent `#review` remained the intended mobile scroll container. |
| GLM quality-reviewer-glm | `REVIEW_INCOMPLETE_RERUN_NEEDED` | No verified blocker, requested narrowed follow-up for mobile off-mode scrolling and open-composer submit state. |

Triage:

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---|---|---|---|
| Mobile annotation-off long-plan scrolling may break | GPT | P2 | `REGRESSION_FROM_THIS_DIFF` | Fixed | Mobile off-mode now uses viewport-height iframe scrolling and e2e asserts iframe scroll while composer remains closed. |

### Cycle 2: mobile scroll follow-up

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT quality-reviewer | `CLEAN_FOR_PR` | Mobile off-mode iframe scroll strategy and coverage accepted. |
| GLM quality-reviewer-glm | `REVIEW_INCOMPLETE_RERUN_NEEDED` | Requested final narrow follow-up for open composer with typed text and plan/source-authority edits. |

### Cycle 3: GLM narrow follow-up

| Reviewer | Verdict | Notes |
|---|---|---|
| GLM quality-reviewer-glm | `FINDINGS_TO_RESOLVE` | P2: toggling annotations off with non-empty composer cleared the pending anchor while leaving visible draft text, causing a stranded draft / possible rebinding to another anchor. |

Triage:

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---|---|---|---|
| Non-empty composer draft stranded by annotation-off toggle | GLM | P2 | `REGRESSION_FROM_THIS_DIFF` | Fixed | `setAnnotationsEnabled(false)` now shows discard warning and returns before mutating annotation state when a non-empty composer is open. E2E asserts toolbar/body state unchanged, warning visible, cancel then toggle off succeeds. |

### Cycle 4: draft-state follow-up

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT quality-reviewer | `CLEAN_FOR_PR` | Prior P2 path resolved; no new blocker found. |
| GLM quality-reviewer-glm | `CLEAN_FOR_PR` | Prior P2 path resolved; mobile/touch sanity check clean. |

## Codex PR feedback

Codex reviewed PR #72 and reported two P2 findings. First, when annotations were off, rendered-plan links to another review shell (`/p/<id>`) returned before `navigatePlanShellLink()`, so clicking an in-plan cross-link could load a nested review shell inside the iframe. Fixed by preserving interactive link handling before the annotation-off return and adding e2e coverage for clicking a plan cross-link while annotations are disabled. Second, mobile annotation-off mode changed the scroll container to the iframe while sidebar Jump still scrolled `#review`, so Jump could fail for anchors below the first viewport. Fixed by routing mobile annotation-off jumps to the iframe window and adding e2e coverage that creates a lower mobile comment, disables annotations, opens the comments tray, clicks Jump, and verifies iframe scroll while the composer remains closed. Targeted verification after each fix: `bun run build && node dist/test-fixtures/e2e-run.js` passed.

## Final gate result

`OPEN_PR_READY`: both GPT and GLM follow-up reviews are clean, and known Codex PR feedback has been addressed. Final post-Codex full gate for the shell-link fix passed with 152 tests, e2e scenarios, and both fixture scenarios green. Final full gate for the mobile Jump fix also passed with 152 tests, e2e scenarios, and both fixture scenarios green.

## Follow-ups

No blocking or non-blocking follow-ups recorded.
