# Pre-PR Implementation Review — visible-comment-status

- **Date:** 2026-06-24
- **Branch:** visible-comment-status (merge base 9d6ff0a = main)
- **Plan:** thoughts/plans/visible-comment-status.html
- **Scope:** color the comment marker (`.comment-anchor-label` circle + `.comment-anchor` dotted outline) by lifecycle (purple=Pending, yellow=Claimed, green=Acknowledged, blue=Resolved); retire the two-class `pending`/`addressed` scheme for explicit per-status classes; add a top-of-plan Red/Yellow/Green status banner driven by aggregate comment states (Red=pending only, Yellow=some claimed/acked not all resolved, Green=all resolved or empty). Out of scope: sidebar rows, transient draft `.marker`, queue/source-sync/API/index.

## Changed files
- `src/server/app.ts` — per-status CSS (iframe-injected + parent-shell), `anchorStatusClass()` + `addCommentAnchor()` wiring, top-of-plan `#comment-status-banner` element + CSS + `updateCommentStatusBanner()` called from `renderComments()`.
- `src/test-fixtures/e2e-run.ts` — four-state anchor-class assertions (incl. acknowledged create→claim→ack fixture and claimed≠pending counterexample), isolated banner Red/Green/live-transition scenario.

## Verification (all green)
- `bun run build` — tsc clean
- `bun run test` — 121 pass / 0 fail
- `node --test dist/__tests__/contracts.test.js` — 120 pass / 0 fail
- `bun run test:e2e` — exit 0, all scenarios pass incl. new acknowledged fixture, counterexample, banner Red/Green/live

## Scoped quality-review loop (scoped-plan-run steps 5–8)
| Cycle | GPT (quality-reviewer) | GLM (quality-reviewer-glm) |
|---|---|---|
| 1 | PASS_SCOPED | FIX_IN_SCOPE_FINDINGS (1 IN_PLAN: missing banner e2e for AC9/AC11/AC12) |
| 2 (after adding isolated banner Red/Green/live scenario) | PASS_SCOPED | PASS_SCOPED |

Integrated GLM cycle-1 IN_PLAN finding by adding an isolated banner scenario (fresh plan; Green empty → Red pending → Yellow claim → Green ack+resolve, no page reload). GLM's cycle-1 QUESTION (pending+resolved→Red intent) resolved in implementation's favor: the explicit P4 boolean/AC9 is authoritative (resolved does not factor into Red; Red is the only truthful state for pending+resolved+no-active-work).

## Pre-PR gate (P1/P2/P3 + scope)
| Reviewer | Verdict | Findings |
|---|---|---|
| GPT-5.5 (quality-reviewer) | CLEAN_FOR_PR | none |
| GLM-5.2 (quality-reviewer-glm, xhigh) | CLEAN_FOR_PR | none |

## Remaining out-of-scope follow-ups
- None blocking. Non-blocking note (not a finding): mobile e2e coverage for AC12 is intentionally a manual visual gate per the plan's verification strategy (P4 work-item 5); the banner has no viewport-conditional code path, so no divergent mobile logic exists to test.

## Final gate result
**OPEN_PR_READY** — both reviewers clean, all verification green. Proceed to commit, push, PR creation, and post-PR monitoring.