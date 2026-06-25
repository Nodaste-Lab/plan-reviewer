# Pre-PR implementation review: fix-nav-alignment

Date: 2026-06-25
Branch: `fix-nav-alignment`
Base/range: `origin/main...HEAD` for committed changes, plus staged/unstaged working-tree changes
Plan/scope: standalone direct fix for review-shell nav alignment. The reported issue was that the left navigator heading (`ACTIVE PLANS`) could be clipped under the sticky navbar when the top toolbar wrapped or grew. Scope was limited to deriving review-shell vertical offsets from the actual `#plan-navbar` height and updating regression coverage.

## Review packet

Initial packet:

```text
git status --short --branch
## fix-nav-alignment
 M src/__tests__/contracts.test.ts
 M src/server/app.ts
 M src/test-fixtures/e2e-run.ts

git diff --stat origin/main...HEAD
(no committed diff)

git diff --name-only origin/main...HEAD
(no committed diff)

git diff --stat
 src/__tests__/contracts.test.ts |  5 +++++
 src/server/app.ts               | 28 +++++++++++++++++++++-------
 src/test-fixtures/e2e-run.ts    | 22 +++++++++++++++-------
 3 files changed, 41 insertions(+), 14 deletions(-)

git diff --name-only
src/__tests__/contracts.test.ts
src/server/app.ts
src/test-fixtures/e2e-run.ts

git diff --cached --stat
(no staged diff)
```

Final changed files:

- `src/server/app.ts`
- `src/__tests__/contracts.test.ts`
- `src/test-fixtures/e2e-run.ts`
- `thoughts/validation/pre-pr-reviews/2026-06-25-fix-nav-alignment.md` (this artifact)

## Review cycles

### Cycle 1

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT-5.5 `quality-reviewer` | `CLEAN_FOR_PR` | No blocking findings. Confirmed the main fix replaced hard-coded review-shell offsets with measured `--plan-navbar-height`, guarded by tests. |
| GLM-5.2 `quality-reviewer-glm` | `CLEAN_FOR_PR` | Raised one non-blocking P3 sibling observation: desktop `#composer top:112px` still used the old navbar-offset family. Recommended one-line fix. |

Triage:

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| Desktop `#composer top:112px` remained hard-coded | GLM | P3 | Reviewer classified as `OUT_OF_SCOPE_FOLLOW_UP`; treated as in-scope polish because it is the same offset family | Fixed | `112px == 86px + 26px`; when navbar grows, composer could overlap the toolbar. |

Fix applied:

- `src/server/app.ts`: changed desktop composer offset to `top:calc(var(--plan-navbar-height) + 26px)`.
- `src/__tests__/contracts.test.ts`: added a contract assertion that `#composer` consumes `--plan-navbar-height`.

Verification after fix:

```bash
bun run build && node --test dist/__tests__/contracts.test.js
# passed: 128 tests

bun run test:e2e
# passed
```

### Cycle 2

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT-5.5 `quality-reviewer` | `CLEAN_FOR_PR` | No findings after composer fix. |
| GLM-5.2 `quality-reviewer-glm` | `CLEAN_FOR_PR` | Raised one non-blocking P3 coverage-depth observation: e2e asserted geometry at the default navbar height but did not force a taller/wrapped navbar. |

Triage:

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| E2E did not force dynamic navbar growth | GLM | P3 | Reviewer classified as `OUT_OF_SCOPE_FOLLOW_UP`; fixed to strengthen the gate | Fixed | Existing e2e geometry assertions could pass at the old `86px` default; structural contract tests guarded the dynamic path but behavioral coverage could be stronger. |

Fix applied:

- `src/test-fixtures/e2e-run.ts`: added behavioral e2e coverage that injects a temporary flex spacer into `#plan-navbar-actions`, waits for the `ResizeObserver` update, verifies `--plan-navbar-height` equals the expanded measured height, verifies the left navigator and sidebar sit below and resize against the expanded navbar, removes the spacer, and waits for the variable to shrink back.

Verification after fix:

```bash
bun run build && node --test dist/__tests__/contracts.test.js
# passed: 128 tests

bun run test:e2e
# passed
```

### Cycle 3

| Reviewer | Verdict | Notes |
|---|---|---|
| GPT-5.5 `quality-reviewer` | `CLEAN_FOR_PR` | No unresolved P1/P2/P3 findings. Ran `git diff --check`; no whitespace/conflict issues. |
| GLM-5.2 `quality-reviewer-glm` | `CLEAN_FOR_PR` | No in-scope P1/P2/P3 findings. Confirmed no missed navbar-offset siblings and verified contracts/e2e independently. Noted a non-blocking merge-logistics observation that the branch is behind `origin/main`. |

Final triage:

| Finding | Reviewer | Severity | Scope | Decision | Evidence |
|---|---|---:|---|---|---|
| Branch behind `origin/main` by newer commits | GLM | P3 | `QUESTION` / merge logistics, not an in-scope code defect | Non-blocking; rebase before PR/merge if desired | GLM reported `origin/main` contains later commits touching orthogonal regions; this implementation remains correct and reviewers returned `CLEAN_FOR_PR`. |

## Final verification

Latest verification after the last code/test change:

```bash
bun run build && node --test dist/__tests__/contracts.test.js
# passed: 128 tests

bun run test:e2e
# passed: plan index, dom annotation, image annotation, plan sync, deferred notes resume sync
```

## Remaining follow-ups

No blocking or in-scope P1/P2/P3 findings remain.

Non-blocking process note: rebase onto current `origin/main` before opening or merging the PR if a fresh PR diff is required. This is merge logistics, not a code correctness blocker from this review.

## Final gate result

- GPT verdict: `CLEAN_FOR_PR`
- GLM verdict: `CLEAN_FOR_PR`
- Final gate: `OPEN_PR_READY`
