# Pre-PR implementation review — html-plan-dsl

Date: 2026-06-28
Branch: `html-plan-dsl`
Base/range: `origin/main` plus uncommitted working-tree and untracked files
Plan: `thoughts/plans/markdoc-plan-authoring-dsl.html`
Final gate result: `OPEN_PR_READY`

## Changed files summary

Working tree changed files reviewed:

- `AGENTS.md`
- `README.md`
- `bun.lock`
- `package-lock.json`
- `package.json`
- `src/__tests__/contracts.test.ts`
- `src/__tests__/fixtures/markdoc/missing-phase-block.markdoc`
- `src/__tests__/fixtures/markdoc/simple-plan.markdoc`
- `src/__tests__/fixtures/markdoc/unsafe-raw-html.markdoc`
- `src/cli.ts`
- `src/planDsl/compileMarkdoc.ts`
- `src/planDsl/schema.ts`
- `src/planDsl/template.ts`
- `src/render/render.ts`
- `src/server/sourceSync.ts`
- `thoughts/plans/AGENTS.md`
- `thoughts/plans/markdoc-plan-authoring-dsl.html`
- `thoughts/specs/product_intent.md`

Implementation adds Markdoc plan compilation, CLI compile/register support, Markdoc-aware source sync, sanitizer support for mock controls, tests/fixtures, and docs/guidance for source-by-extension authority.

## Review cycle 1

GPT verdict: `FINDINGS_TO_RESOLVE`
GLM verdict: `FINDINGS_TO_RESOLVE`

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| Registering generated `.html` with sibling `.markdoc` made HTML source-authoritative | GPT | P2 | IN_PLAN | Fixed | `src/cli.ts` now rejects this path with `markdoc_source_required`; regression test at `src/__tests__/contracts.test.ts:5031`. |
| Markdoc source sync wrote generated HTML before stale/register checks | GPT, GLM | P2 | IN_PLAN | Fixed | Generated HTML write is now deferred until after successful register/stale verification and uses atomic rename at `src/server/sourceSync.ts:99` and `src/server/sourceSync.ts:309`; regression race test at `src/__tests__/contracts.test.ts:6556`. |
| Raw HTML preprocessing corrupted fenced code examples | GPT | P3 | REGRESSION_FROM_THIS_DIFF | Fixed as cheap regression | Fenced code delimiters are masked before preprocessing and restored after render at `src/planDsl/compileMarkdoc.ts:22`, `:133`, and `:237`; regression assertion added in Markdoc validation test. |

## Fixes applied

- `src/cli.ts`: reject `.html` registration when a same-basename `.markdoc` exists, preserving the Markdoc source as authoritative.
- `src/server/sourceSync.ts`: validate target generated HTML writability early, but write generated HTML only after render/register/stale checks succeed; write via temp file + rename.
- `src/planDsl/compileMarkdoc.ts`: avoid interpreting `{% html %}` examples inside fenced code as real escape hatches or unsupported Markdoc tags.
- `src/__tests__/contracts.test.ts`: added regression coverage for all three review findings.

## Verification after fixes

- `bun run build && node --test dist/__tests__/contracts.test.js --test-name-pattern "markdoc validation|register compiles markdoc|sibling markdoc|source sync preserves"` — passed; Node loaded the full contract file and reported 149/149 passing.
- `bun run build && bun run test && bun run test:e2e` — passed after fixes; final run reported 150/150 tests passing and e2e scenarios passed.

## Review cycle 2 — narrowed rereview

GPT verdict: `CLEAN_FOR_PR`
GLM verdict: `CLEAN_FOR_PR`

Scope was limited to prior findings and immediate regressions in `src/cli.ts`, `src/server/sourceSync.ts`, `src/planDsl/compileMarkdoc.ts`, and `src/__tests__/contracts.test.ts`.

## Remaining follow-ups

None identified as blocking or non-blocking out-of-scope follow-ups by the final narrowed rereview.

## Final gate status

GPT verdict: `CLEAN_FOR_PR`
GLM verdict: `CLEAN_FOR_PR`
Verification rerun after last fix: `bun run build && bun run test && bun run test:e2e` passed.

Next step: `OPEN_PR_READY`
