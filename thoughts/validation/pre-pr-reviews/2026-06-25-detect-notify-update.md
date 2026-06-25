# Pre-PR implementation review: detect-notify-update

Date: 2026-06-25
Branch: `detect-notify-update`
Base: `origin/main` (`HEAD == origin/main` before the staged feature diff)
Plan: `thoughts/plans/detect-notify-update.html`

## Scope

Detect and notify when a Homebrew-installed `plan-reviewer` has a newer installable version/commit available. Scope includes stable and HEAD channel detection, CLI/API/browser status surfaces, browser configuration opt-out, Homebrew formula metadata, release/operator documentation, and the user-local release skill.

## Verification before final review

- `bun run build && node --test --test-name-pattern "README documents update checks|build metadata|update checker|CLI update check|runtime update|browser configuration|Homebrew formula" dist/__tests__/contracts.test.js` — passed, 12/12.
- `bun run build && bun run test && bun run test:e2e` — passed, 140 contract tests plus e2e scenarios.
- `git diff --cached --check` — passed.

## Review cycle summary

Earlier review findings were resolved before this final gate:

- Branch stale/revert risk: resolved by rebasing `detect-notify-update` onto current `origin/main` before final review.
- HEAD human output showed package version instead of installed commit: fixed in `formatUpdateStatus` and covered by the HEAD contract test.
- Cold-cache page rendering could block on metadata fetch: fixed by rendering only cached status and refreshing through `/api/runtime/update`.
- User config writes were not atomic: fixed with temp-file write plus rename.
- Formula parsing could read nested stanza versions/URLs: fixed by ignoring nested `resource`, `test do`, and `bottle do` stanzas.
- AC7 layout-measurement gap: accepted as a scoped deviation; fixed-position CSS/layout invariants and full e2e coverage were recorded in the plan and discovery notes.
- Rebase integration: the update-check opt-out is integrated into the existing `/configuration` page instead of introducing a competing `/settings` surface.

## Final GPT review

Verdict: `CLEAN_FOR_PR`

Finding count: 0

Notes: GPT verified `HEAD == origin/main`, reviewed the staged implementation paths, and found no P1/P2/P3 defects. It called out the non-blocking render path, metadata fetch timeouts, no auto-upgrade behavior, atomic opt-out persistence, and stable/HEAD CLI/API/UI parity.

## Final GLM review

Verdict: `CLEAN_FOR_PR`

Finding count: 0

Notes: GLM independently verified the full gate, Ruby formula syntax, release-skill placement, HEAD compare semantics, stable formula source-of-truth behavior, Homebrew install-channel evidence, XSS/injection safety, non-blocking runtime behavior, opt-out persistence, and CLI/API/UI command parity. No blocking findings remained.

## Disposition

Pre-PR implementation review gate is clean. Proceed to commit, push, and PR creation after staging this artifact and final plan/run-note updates.
