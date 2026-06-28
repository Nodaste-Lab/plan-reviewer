# Product Intent

## Status

- active

## Why this exists

`plan-reviewer` exists so humans can review local HTML implementation plans in a browser, attach precise comments to plan content, and deliver those comments to coding agents through a reliable queue. The repository is the standalone daemon and CLI that make reviewed-plan workflows operational instead of relying on ad hoc screenshots, chat-only notes, or fragile watch streams.

## Users and jobs-to-be-done

- Plan reviewers need to open a local plan, select the exact section/image/text that needs attention, leave a comment, and trust that an agent will receive it once.
- Coding agents need to publish a plan, discover, claim, process, acknowledge, release, and resolve browser comments without losing work or double-processing comments.
- Plan authors need compact Markdoc or legacy HTML sources to stay synchronized with generated browser-review HTML while preserving review context and safe rendered output.
- Operators need installable CLI/service behavior with actionable diagnostics and minimal hidden state.
- Repo maintainers need source-linked plans, stable metadata, and tests that prove API, CLI, browser, and queue surfaces stay aligned.

## Desired outcomes

- Agents publish non-trivial plans as reviewable HTML artifacts with stable URLs and source sync, whether the editable source is compact Markdoc or legacy HTML.
- Review comments are durable, deduplicated, queue-visible, and recoverable across browser, CLI, service, and agent restarts.
- The simplest reviewer workflow—register plan, open review URL, select content, submit comment—works without extra setup or tribal knowledge.
- The simplest agent workflow—drain pending comments, wait for one claim, act, ack, repeat—is authoritative and safe under retries, missed events, and lease expiry.
- Registration responses make the required next monitoring action explicit enough that agents do not need to infer it from external docs.
- The plan index truthfully reports plan status, source sync state, comment counts, repository metadata, and execution-readiness state.
- Live source sync updates open review pages only when the source is complete and safe to render; Markdoc compile failures and malformed HTML both keep serving the last good version with truthful status.

## Experience principles

- Make the golden path unavoidable: registering a plan should immediately tell the agent how to monitor feedback.
- Browser review actions should be idempotent by default; retries must not create duplicate work.
- Queue state should be canonical server state, not inferred from transient browser or stream state.
- Keep files authoritative: a repo `.markdoc` plan is the source of truth when present, its generated `.html` is the registered review artifact, and HTML-only plans remain source-authoritative when no Markdoc source exists. Rendered service copies are derived cache/history unless explicitly snapshotted.
- Routine recoverable failures should self-heal or retry inside the normal flow before asking users for manual remediation.
- Every failure shown to a reviewer, operator, or agent should explain the next safe action.
- HTTP API, CLI, browser UI, README guidance, and tests should describe the same lifecycle semantics.

## Boundaries and non-goals

- The MVP is intentionally unauthenticated; do not treat it as a public multi-tenant service without an explicit security plan.
- The product is not a general chat system. Browser comments produce agent-visible payloads, and agents respond through ack/resolve metadata.
- The service is not a general document editor; plan content is authored in repo files and reviewed in the browser shell.
- The browser shell owns review interactivity; plan-authored scripts, MDX/JSX execution, forms, and active embeds are not part of the supported plan artifact contract.
- `plan-review watch` is a diagnostic stream, not the correctness-critical agent delivery path.
- The service should not execute plan implementation work; it coordinates review artifacts and comment delivery.

## Quality and trust bar

- Do not lose comments. Queue-backed `agent next` is the correctness-critical delivery path; `watch` is debug/low-latency support.
- Comment creation, claim, ack, release, resolve, delete, and event replay semantics must be covered by contract tests when changed.
- Browser comment interactions and rendered-plan markers must be covered by e2e tests when changed.
- Source sync must fail safe: never replace a good rendered plan with partial, malformed, or unsafe content.
- Sanitized render output must remain script-free and safe for the parent review shell.
- Queue operations must tolerate retries and missed events without duplicate claims or lost pending comments.
- Keep public command examples copy-paste ready and backed by automated contract tests when they define behavior.
- Preserve local data integrity for the SQLite store and avoid committing runtime data.

## How plans must use this document

- Every plan under `thoughts/plans/` must include a `Product intent alignment` section.
- Plans must cite which desired outcomes and experience principles they advance.
- Plans that change queue/comment/source-sync/security behavior must explicitly describe safe defaults, recovery behavior, and fail-closed boundaries.
- If a plan conflicts with product intent, update this document first or log the deviation as a blocking decision before execution readiness.

## Change log

- 2026-06-28: Added source-by-extension authority for Markdoc-authored plans: `.markdoc` is authoritative when present, generated `.html` is the registered review artifact, and legacy HTML-only plans remain authoritative.
- 2026-06-08: Created active product intent so repo planning has a required source of truth and agents do not fall back to chat-only plans.
