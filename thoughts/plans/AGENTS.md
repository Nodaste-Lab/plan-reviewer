# thoughts/plans AGENTS.md

This directory contains browser-reviewable HTML plans. New plans in this repo must use the reviewed HTML workflow.

## Required skill routing

- For any new or substantially revised plan, load `reviewed-html-plan` first.
- For any plan registration, browser-review URL, comment monitoring, or reviewer annotation processing, load `html-plan-reviewer` and follow its current commands exactly.
- Do not substitute a Markdown plan or an unregistered local HTML file for the reviewer workflow unless the user explicitly asks to skip browser review.

## Plan artifact rules

- Write semantic HTML at `thoughts/plans/<slug>.html`.
- Use a dark-mode default theme with explicit dark background, light foreground, readable muted text, accessible accent/link colors, and `color-scheme: dark`.
- Add stable `id` attributes to major sections, phase wrappers, acceptance criteria, BDD scenarios, diagrams, figures, mockups, and other likely comment targets.
- Include a `Progress` section with the only checkboxes.
- Include status, goal, a near-top Solution narrative, authority/inputs, current implementation reality, product intent alignment, locked decisions, acceptance criteria, BDD scenarios, test coverage matrix, phases, verification strategy, non-goals, resume instructions, and an append-only Decisions / Deviations Log.
- For UI-impacting work, include reviewer-friendly UI mocks or screenshots and make each mock full width in the plan content column so browser annotations have enough visual detail.
- Include a Linear issue reference using canonical `NOD-NNN` form near the top of the plan, or explicitly state why no Linear issue exists. The plan-review index detects and links `NOD-NNN` keys to Linear; do not invent an issue key when the work intentionally has no issue.
- Each phase must include End State, Tests first, Expected files, Work, and Verify.
- `execution-ready` plans must not contain unresolved open questions.

## Browser-review registration

After creating or updating a plan for review:

```bash
plan-review register thoughts/plans/<slug>.html --repo auto --branch auto --commit auto --execution-ready false --json
```

Use `--execution-ready true` only after the required plan-review gates agree the plan is ready by substance. When sharing links with the user, use the canonical reviewer URL from the `html-plan-reviewer` skill, not a loopback or relative URL.

Immediately after registration, drain pending comments and start the queue-backed listener from the returned `agentInstructions`. Process every claimed comment through claim -> plan update or decision -> ack -> resolve.

## Existing plan policy

Do not rewrite completed historical plans only to match this file. For active plans, add missing reviewer structure before continuing execution.
