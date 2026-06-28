# Pre-PR implementation review: nudge-markdoc

Date: 2026-06-28
Branch: `nudge-markdoc`
Base/range: `origin/main` (no committed diff; review scope is unstaged + untracked working-tree changes)
Plan path: none; standalone user scope

## Scope

User request: nudge agents that publish legacy HTML documents to plan-reviewer to ask their operator whether to uptake the recommended Markdoc optimization, and provide a skills endpoint agents can fetch to update skills and repo configuration to use Markdoc instead of HTML going forward.

## Changed files summary

Unstaged tracked files:

- `README.md`
- `src/__tests__/contracts.test.ts`
- `src/cli.ts`
- `src/registrationInstructions.ts`
- `src/server/app.ts`

Untracked files:

- `src/markdocOptimizationSkill.ts`

No staged changes.

## Review cycle 1

### GPT reviewer verdict

`VERDICT: CLEAN_FOR_PR`

Coverage: registration instruction nudge, CLI output, skill endpoints, skill guidance safety, contract tests, README, and verification truthfulness. No findings.

### GLM reviewer verdict

`VERDICT: CLEAN_FOR_PR`

Coverage: registration instruction nudge gating, CLI parity, Fastify endpoints, migration guidance safety, contract coverage, README alignment. No P1/P2 findings.

GLM minor observation: JSON skill endpoint does not explicitly set `Cache-Control: no-store` while markdown endpoint does. Decision: non-blocking. Evidence: endpoint returns static guidance, browser caching is not a correctness risk for the review scope, and the markdown endpoint used by agents has `no-store`.

## Triage table

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| None | GPT | - | - | No action | `CLEAN_FOR_PR` |
| JSON skill endpoint lacks explicit `no-store` header | GLM | P3 observation | REGRESSION_FROM_THIS_DIFF | Non-blocking follow-up not required | Static JSON guidance endpoint; markdown endpoint is the primary agent fetch endpoint and has `no-store`; no user-visible correctness, safety, or contract failure |

## Fixes applied

None.

## Verification

- `bun run test` — passed, 152 tests.

## Remaining follow-ups

None required.

## Final gate result

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`
- Blocking in-scope P1/P2 findings: none
- Final status: `OPEN_PR_READY`
