# Detect/notify update availability scoped run notes

## Run state

- Plan: `thoughts/plans/detect-notify-update.html`
- Branch: `detect-notify-update`
- Target branch: repository default / normal integration branch (`main` unless verified otherwise before PR)
- Status: P1-P4 implemented; Codex PR feedback addressed and resolved; final post-feedback monitoring in progress
- PR URL: https://github.com/Nodaste-Lab/plan-reviewer/pull/60
- Latest verification: `bun run build && bun run test && bun run test:e2e` passed on 2026-06-25 after the PR feedback fix (141 contract tests plus e2e scenarios)
- Scoped reviewer-pair state: one scoped quality review found reversed GitHub compare semantics for HEAD checks; fixed and targeted update slice passed afterward. Pre-PR GLM review later found four in-scope items; all were fixed or logged as the AC7 verification deviation. Post-PR Codex feedback created a review-escape cycle; the direct fix passed targeted checks and the adversarial GPT reviewer returned `PASS_SCOPED`, while the GLM reviewer returned `PASS_WITH_DOCUMENTED_OUT_OF_SCOPE_FOLLOW_UPS` with no unresolved in-scope findings.
- Pre-PR GPT/GLM gate: final GPT and GLM reviews both returned `CLEAN_FOR_PR`; artifact at `thoughts/validation/pre-pr-reviews/2026-06-25-detect-notify-update.md`
- PR monitoring state: Codex inline P2 feedback on stable Homebrew current-version precedence was received, fixed, replied to, and marked resolved on GitHub; final mergeability recheck is pending.

## Scope contract

Goal: let operators and agents know when installed `plan-reviewer` is behind the version Homebrew can actually install, while distinguishing stable Homebrew installs, Homebrew `--HEAD` installs, development checkouts, and ambiguous builds.

In scope:
- P1 build identity and local install-channel detection from executable/package path shape. (Implemented in `src/updateStatus.ts`; targeted tests green.)
- P2 update checker and `plan-review update check [--json]` with stable formula and HEAD comparison semantics. (Implemented in `src/updateStatus.ts` and `src/cli.ts`; targeted tests green.)
- P3 cached service API, visible browser configuration opt-out, and fixed green up-arrow only for confirmed update availability. (Implemented in `src/server/app.ts`, `src/config.ts`, and targeted tests; green.)
- P4 repo-visible release/update documentation, formula metadata alignment, and user-local release skill mirror. (Implemented in `README.md`, `Formula/plan-reviewer.rb`, `src/__tests__/contracts.test.ts`, and `~/.agents/skills/plan-reviewer-release/SKILL.md`; green.)
- Automated tests using fake metadata endpoints and no real network dependency.

Out of scope:
- Automatic `brew upgrade`, service restart, migrations, or self-updating behavior.
- Public telemetry/analytics.
- Comment queue, source sync, rendered-plan sanitization, or review semantics unrelated to update notification.
- Promise that stable installs can consume arbitrary unreleased commits.
- Per-indicator dismiss/snooze preferences.

Required final gates:
- Phase targeted verification as documented in the plan.
- `bun run build`, `bun run test`, and `bun run test:e2e` before final handoff.
- Scoped GPT/GLM implementation reviews plus Pi pre-PR implementation review with no unresolved in-scope P1/P2/P3 findings.
- Commit, push, PR creation, plan-review PR link/refresh, and post-PR monitoring until feedback is addressed and mergeability is established.

Implementation review dispositions:
- GLM P2 render latency: fixed by making index/review render from cached status only; cold metadata refresh now happens through `/api/runtime/update` and the existing client fetch.
- GLM P3 config write atomicity: fixed with temp-file plus rename writes for the shared user config.
- GLM P3 formula parser key-name matching: fixed by ignoring nested `resource`, `test`, and `bottle` stanzas before parsing stable `version`/`url`.
- GLM P3 AC7 e2e measurement gap: logged as a verification deviation in the plan. CSS `position: fixed` is the locked invariant proving no document-flow layout shift; contract tests cover the fixed indicator and `bun run test:e2e` passed for the browser shell.
- Rebase integration: HEAD now matches `origin/main`; the browser opt-out is integrated into `/configuration` rather than the stale `/settings` page shape.
- Final review disposition: GPT clean, GLM clean, no unresolved in-scope P1/P2/P3 findings.
- PR review escape disposition: Codex PR feedback correctly identified that stable update checks should prefer Homebrew Cellar version over packaged `package.json` version. Fixed `checkStable`, `updateAvailableStatus`, and `formatUpdateStatus` to use `current.homebrew?.cellarVersion ?? current.packageVersion` for stable installs, and added a drift regression fixture where Cellar `0.1.1` plus package `0.1.0` is up to date against formula `0.1.1` and reports Cellar `0.1.1` when formula `0.1.2` is newer. Targeted and full verification passed.
- Documented non-blocking note from adversarial GLM: `plan-review --version` intentionally remains package-version output because AC1 asks to report package version and the maintainer release process requires package/Cellar parity for real stable releases. This is not a checker correctness issue and is tracked here only as a disposition record, not a follow-up requirement.
