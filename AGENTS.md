# AGENTS.md

This is the repo-specific operating guide for coding agents in `plan-reviewer`. It fills the missing local routing that should make agents use the HTML plan-review flow instead of creating unregistered Markdown plans.

## Purpose

`plan-reviewer` is the local HTML plan review daemon and CLI for reviewable plans under `thoughts/plans/`. Repository work should dogfood that workflow: non-trivial changes are planned as HTML, registered in the reviewer, annotated in the browser, and only then executed when the plan is marked execution-ready.

## Safety and repo reality

- Do not commit secrets, local databases, service logs, or Homebrew runtime state. Treat `~/.plan-reviewer/plan-reviewer.sqlite` as local data, not repo data.
- The service is intentionally unauthenticated in the MVP. Use `127.0.0.1` for local-only tests and the trusted-network URL only for user-facing review links.
- Preserve existing user changes. Check `git status --short` before editing and do not overwrite unrelated modified files.
- Keep `dist/` generated from `src/`; edit TypeScript source first.

## Canonical commands

```bash
bun install
bun run build
bun run test
bun run test:e2e -- --grep "dom annotation|image annotation|plan index"
bun run test:fixtures -- --scenario seeded-comment-stream
bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated
```

Development server:

```bash
bun run dev -- serve --host 127.0.0.1 --port 4317
```

Register a plan during local development:

```bash
bun run dev -- register thoughts/plans/<slug>.html --url http://127.0.0.1:4317 --repo auto --branch auto --commit auto --execution-ready false
```

Installed CLI registration:

```bash
plan-review register thoughts/plans/<slug>.html --repo auto --branch auto --commit auto --execution-ready false
```

## Required planning workflow

When asked to create, update, review, or execute a non-trivial plan in this repo:

1. Load the `reviewed-html-plan` skill. It is the canonical pre-execution workflow for this repo.
2. Load its required companion skills when their surface is reached, especially `html-plan-reviewer`, `planning-workflow`, and `product-principles`.
3. Create or update one semantic HTML plan at `thoughts/plans/<slug>.html`. Do not create Markdown-only plans for new work unless the user explicitly asks for Markdown.
4. Follow `thoughts/plans/AGENTS.md` for plan-file structure, status, progress, stable IDs, and reviewer-friendly HTML requirements.
5. Register the plan through `plan-review register ... --execution-ready false` before claiming the plan is ready for browser feedback.
6. Use the canonical user-facing review URL from the `html-plan-reviewer` skill. On this host, shared links should use `http://mbp.braid-python.ts.net:4317/`, not `localhost` or `127.0.0.1`.
7. Immediately drain pending browser comments and start the queue-backed listener from registration `agentInstructions`; in Pi, use the `process` tool for `plan-review agent next <planId> --wait --json --url http://mbp.braid-python.ts.net:4317`.
8. Process browser comments through claim -> edit/decide -> ack -> resolve. Do not treat `plan-review watch` as the correctness-critical listener.
9. Run PM/product-intent, Codex, and Claude plan-review gates required by `reviewed-html-plan` before re-registering with `--execution-ready true`.
10. Only execution-ready plans can hand off to implementation.

Planning boundaries:

- Plan mode is read-only discovery and research.
- Plan materialization may write only the plan artifact and plan-supporting docs.
- Product code changes start only after the reviewed HTML plan is execution-ready or the user explicitly requests a smaller direct fix.
- Active plans must cite `thoughts/specs/product_intent.md` in a Product intent alignment section.

## Execution workflow

For an execution-ready plan:

1. Implement one phase at a time.
2. Prefer tests first where practical and record RED -> GREEN evidence in the phase notes.
3. Run the phase's stated verification plus the relevant repo gate.
4. Run a scoped implementation review before advancing phases.
5. Advance only when the latest review verdict is clean, or when every low-risk deferral is logged in both the plan Decisions / Deviations Log and `thoughts/discoveries/<plan-or-feature>.md`.
6. Update the plan Progress and Resume Instructions after each phase.

Substantive review misses must reassess the original test scope and original plan; repeated or cross-surface misses should widen coverage before the phase advances.

## Quality gates

Use the smallest gate that proves the touched surface, then run the full gate before final handoff when changes are not docs-only:

```bash
bun run test
```

For UI/comment-shell work, also run the focused e2e gate:

```bash
bun run test:e2e -- --grep "dom annotation|image annotation|plan index"
```

For agent-listener or queue work, also run fixture smoke coverage:

```bash
bun run test:fixtures -- --scenario seeded-comment-stream
bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated
```

Docs-only guidance changes may be verified with targeted inspection instead of the full test suite.

## Architecture notes

- CLI entry point: `src/cli.ts`.
- Server routes and browser shell: `src/server/app.ts`.
- Queue-backed comment delivery: `src/agentNext.ts` and related server routes.
- Registration guidance returned to agents: `src/registrationInstructions.ts`.
- Contract tests: `src/__tests__/contracts.test.ts`.
- Harness fixtures: `src/test-fixtures/`.

Keep API, CLI, README, and fixture behavior aligned when changing public contracts.
