# thoughts/plans AGENTS.md

This directory contains browser-reviewable plans. New plans should be authored as `.markdoc` and compiled to reviewable `.html`; legacy HTML-only plans remain supported only when no sibling Markdoc source exists. All new plans in this repo must use the reviewed plan-reviewer workflow.

## Required skill routing

- For any new or substantially revised plan, load `reviewed-html-plan` first.
- For any plan registration, browser-review URL, comment monitoring, or reviewer annotation processing, load `html-plan-reviewer` and follow its current commands exactly.
- Do not substitute a Markdown plan or an unregistered local HTML file for the reviewer workflow unless the user explicitly asks to skip browser review.

## Plan artifact rules

- Use `thoughts/plans/<slug>.markdoc` for new compact authoring. Registering or compiling it generates semantic HTML at `thoughts/plans/<slug>.html`.
- When a sibling `.markdoc` exists, edit the `.markdoc` source and treat `.html` as generated review output. When no `.markdoc` exists, the `.html` file remains authoritative.
- Legacy/raw plans may still be written directly as semantic HTML at `thoughts/plans/<slug>.html`.
- Use a dark-mode default theme with explicit dark background, light foreground, readable muted text, accessible accent/link colors, and `color-scheme: dark`.
- Add stable `id` attributes to major sections, phase wrappers, acceptance criteria, BDD scenarios, diagrams, figures, mockups, and other likely comment targets.
- Include a `Progress` section with the only checkboxes.
- Include status, goal, a near-top Solution narrative, authority/inputs, current implementation reality, product intent alignment, locked decisions, acceptance criteria, BDD scenarios, test coverage matrix, phases, verification strategy, non-goals, resume instructions, and an append-only Decisions / Deviations Log.
- For UI-impacting work, include reviewer-friendly current-state and target-state UI evidence, using screenshots or realistic mocks, and make each mock full width in the plan content column so browser annotations have enough visual detail.
- For toolbar, navigation, or visible-control additions/removals, include shipped-surface browser verification that proves roles, labels, visibility, clickability, disabled state, and lifecycle transitions; contract tests alone are not sufficient.
- Include a Linear issue reference using canonical `NOD-NNN` form near the top of the plan, or explicitly state why no Linear issue exists. The plan-review index detects and links `NOD-NNN` keys to Linear; do not invent an issue key when the work intentionally has no issue.
- Each phase must include End State, Tests first, Expected files, Work, and Verify.
- `execution-ready` plans must not contain unresolved open questions.

## Plan templates

Register reusable repo templates here, not in the plan-review service. Store templates under `thoughts/plans/templates/<template-name>.markdoc`, list each template in this section with its intended use and placeholders, then copy a template to `thoughts/plans/<slug>.markdoc` before compiling/registering a concrete plan. Do not register template files themselves as review plans.

- Default template: not yet materialized in this repo. Until one exists, follow the Markdoc examples in `docs/plan-authoring.md` and the generated structure from `src/__tests__/fixtures/markdoc/simple-plan.markdoc`.

## Browser-review registration

After creating or updating a plan for review, register the Markdoc source:

```bash
plan-review register thoughts/plans/<slug>.markdoc --repo auto --branch auto --commit auto --execution-ready false --json
```

Use the `.html` form only for legacy HTML-only plans with no sibling `.markdoc` source:

```bash
plan-review register thoughts/plans/<slug>.html --repo auto --branch auto --commit auto --execution-ready false --json
```

Use `--execution-ready true` only after the required plan-review gates agree the plan is ready by substance. When sharing links with the user, use the canonical reviewer URL from the `html-plan-reviewer` skill, not a loopback or relative URL.

Immediately after registration, drain pending comments and start the queue-backed listener from the returned `agentInstructions`. Process every claimed comment through claim -> plan update or decision -> ack -> resolve.

## Existing plan policy

Do not rewrite completed historical plans only to match this file or convert them to Markdoc. For active plans, add missing reviewer structure before continuing execution. Markdoc compile/register refuses to overwrite a non-generated sibling HTML file unless `--force` is used for an intentional migration.
