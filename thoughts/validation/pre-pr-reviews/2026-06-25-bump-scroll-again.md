# Pre-PR implementation review — bump-scroll-again

Date: 2026-06-25
Branch: `bump-scroll-again`
Base/range: `origin/main...HEAD` for committed changes; unstaged working-tree diff included separately.
Scope: WebKit bump/pull scroll regression reproduction plus product fix.

## Changed files

Committed diff vs `origin/main...HEAD`: none.

Unstaged working-tree diff:

- `src/test-fixtures/e2e-run.ts` — imports Playwright WebKit and adds a WebKit e2e regression that reproduces the first wheel/trackpad input being swallowed after a desktop shell `window.scrollTo`, while a second same-direction input scrolls the native owner.
- `src/server/app.ts` — defers desktop shell `window.scrollTo` by one `requestAnimationFrame`, preserving immediate mobile behavior, so WebKit does not swallow the next trackpad/wheel input.

## RED/GREEN evidence

### Baseline RED

Command run with the product fix temporarily removed while keeping the new test:

```bash
bun run build && node dist/test-fixtures/e2e-run.js
```

Result: `exit(1)`.

Failure evidence:

```text
firstWebkitWheel.before: hitTarget plan-frame, windowScrollY 240, frameInternalScrollY 0, wheelEvents []
firstWebkitWheel.after:  hitTarget plan-frame, windowScrollY 240, frameInternalScrollY 0, wheelEvents []
secondWebkitWheel.before: hitTarget plan-frame, windowScrollY 240, frameInternalScrollY 0, wheelEvents []
secondWebkitWheel.after:  hitTarget plan-frame, windowScrollY 252, frameInternalScrollY 0,
  wheelEvents [{ deltaY: 12, defaultPrevented: false, target: plan-frame, scrollY: 252, frameInternalScrollY: 0 }]
```

Interpretation: pointer is over the rendered plan surface; first input produces no native scroll and no iframe scroll; second same-direction input scrolls the outer window by 12px while iframe internal scroll remains `0`.

### Fixed GREEN

Command:

```bash
bun run test:e2e
```

Result: pass.

```text
e2e scenarios passed: plan index, dom annotation, image annotation, plan sync, deferred notes resume sync
```

Full unit gate:

```bash
bun run test
```

Result: pass, `129` tests / `0` failures.

## Review history

### Reproduction-only review checkpoint

Initial GPT and GLM reviews agreed the WebKit repro was valid and current-code RED after instrumentation hardening. Both blocked merge readiness because the default e2e gate was intentionally red while the branch only contained the reproduction.

Resolved by co-landing the product fix instead of hiding the repro behind an opt-in flag.

### Product-fix review cycle

GPT and GLM reviewed the fix plus regression test.

- GPT verdict: `CLEAN_FOR_PR`.
- GLM verdict: `CLEAN_FOR_PR` with two non-blocking P3 notes:
  - document the breadth/constraint of the desktop `window.scrollTo` override;
  - make the WebKit wait key on the scroll invariant rather than wheel-event delivery.

Both P3 notes were addressed:

- `src/server/app.ts` now documents that current shell callers pass absolute coordinates and do not require same-tick `scrollY` reads after `scrollTo`.
- `src/test-fixtures/e2e-run.ts` now waits only for `window.scrollY !== startingScrollY`; the wheel probe remains diagnostic-only.

### Final exact-diff review

Final GPT review verdict: `CLEAN_FOR_PR`.

Evidence cited:

- reviewed exact scoped diff in `src/server/app.ts` and `src/test-fixtures/e2e-run.ts`;
- mobile scroll remains synchronous;
- desktop deferral is one frame and current callers tolerate it;
- WebKit regression closes its browser in `finally` and asserts the real first-wheel invariant;
- baseline fails, fixed app passes `bun run test:e2e`, and `bun run test` passes.

Final GLM review verdict: `CLEAN_FOR_PR`.

Evidence cited:

- build clean and `bun run test` passes `129` tests;
- override is served through the real `/client.js` review shell path;
- all production `window.scrollTo` callers audited and use absolute coordinates or iframe-local `contentWindow.scrollTo` unaffected by the top-level override;
- no same-tick `scrollY` consumers found;
- WebKit regression is a sound red/green gate and resource cleanup is correct.

### Formal skill invocation review cycle

Base/comparison packet:

- Branch: `bump-scroll-again`
- Base ref: `origin/main` (`f7ab52313901c64b8c7198bf720834c63bab776b`)
- Committed comparison: `origin/main...HEAD`
- Committed diff: empty
- Staged diff: empty
- Unstaged diff:
  - `src/server/app.ts`
  - `src/test-fixtures/e2e-run.ts`
- Untracked artifact:
  - `thoughts/validation/pre-pr-reviews/2026-06-25-bump-scroll-again.md`

GPT skill-pass verdict: `CLEAN_FOR_PR`.

Evidence cited:

- committed and staged diffs are empty; reviewed unstaged code and validation artifact;
- audited changed `window.scrollTo` behavior and shell callers;
- mobile remains synchronous;
- desktop callers use absolute positions/options and do not require same-tick `scrollY` reads;
- iframe-local `contentWindow.scrollTo` calls are unaffected;
- WebKit regression checks the first-wheel scroll invariant, proves the second wheel scrolls, asserts iframe internal scroll remains zero, and closes WebKit in `finally`;
- read-only checks `tsc --noEmit` and `git diff --check` passed.

GLM skill-pass verdict: `CLEAN_FOR_PR`.

Evidence cited:

- independently ran `bun run build`, `bun run test`, and `bun run test:e2e`; all passed;
- audited all production `window.scrollTo` callers in served `/client.js` shell code;
- found no `window.scroll` / `window.scrollBy` shell callers;
- confirmed existing e2e `window.scrollTo` sites wait for resulting state and tolerate one-frame deferral;
- found no security, data-loss, API/contract, generic key-remap, fail-closed, or round-trip parity issues in this diff.

Triage:

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---:|---:|---|---|---|
| None | GPT | — | — | Clean | GPT found no P1/P2/P3 findings |
| WebKit browser setup docs | GLM | P3 | OUT_OF_SCOPE_FOLLOW_UP | Non-blocking follow-up | Existing e2e already required Playwright Chromium without setup docs; repo has no CI workflow; absent WebKit fails loudly with Playwright install guidance. Tracking destination: README/AGENTS e2e setup note. |
| One-frame target drift possibility | GLM | P3 | QUESTION | Rejected as non-blocking after confirmation | Current production shell callers use absolute coordinates, no same-tick `scrollY` reads, fragment path is already-rendered, and final `bun run test:e2e` plus `bun run test` pass. |

Remaining non-blocking out-of-scope follow-up:

- Document Playwright browser setup for e2e contributors, including WebKit, in README/AGENTS e2e setup guidance. Evidence making this non-blocking: repo already had an undocumented Chromium browser requirement, there is no CI workflow to break, and Playwright fails loudly with installation guidance when a browser binary is missing.

## Final gate result

`CLEAN_FOR_PR`

GPT verdict: `CLEAN_FOR_PR`.
GLM verdict: `CLEAN_FOR_PR`.

No unresolved in-scope P1/P2/P3 findings remain.

Next step: `OPEN_PR_READY`.
