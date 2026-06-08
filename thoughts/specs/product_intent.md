# Product Intent

## Status

active

## Why this exists

`plan-reviewer` gives agents and humans a shared browser surface for reviewing implementation plans before code execution. It exists because unreviewed local plan files are easy to miss, hard to annotate precisely, and poor at keeping agents accountable to reviewer feedback.

This repository owns the local daemon, CLI, browser review UI, queue-backed comment delivery, and registration metadata that make reviewed HTML plans operational.

## Users and jobs-to-be-done

- Human reviewers need to open a plan in the browser, annotate exact sections or images, and trust that the agent will see and process the comments.
- Coding agents need a deterministic way to publish a plan, receive browser comments, ack/resolve them, and carry execution-readiness metadata into the next workflow step.
- Repo maintainers need source-linked plans, stable metadata, and tests that prove API, CLI, and browser surfaces stay aligned.

## Desired outcomes

- Agents publish non-trivial plans as reviewable HTML artifacts with stable URLs and source sync.
- Browser comments are delivered through an at-least-once queue flow that agents can claim, process, acknowledge, and resolve without losing work.
- Registration responses make the required next monitoring action explicit enough that agents do not need to infer it from external docs.
- The plan index truthfully reports plan status, source sync state, comment counts, repository metadata, and execution-readiness state.

## Experience principles

- Make the golden path unavoidable: registering a plan should immediately tell the agent how to monitor feedback.
- Keep files authoritative: the repo HTML plan is the source of truth; rendered service copies are derived cache/history unless explicitly snapshotted.
- Fail safely and visibly: source-sync, queue, and rendering failures should keep the last good plan available and expose actionable status.
- Preserve cross-surface parity: CLI output, API JSON, README guidance, and tests should describe the same workflow.

## Boundaries and non-goals

- The MVP is unauthenticated and intended for trusted local or private-network use.
- The service is not a general document editor; plan content is authored in repo files and reviewed in the browser shell.
- The browser shell owns review interactivity; plan-authored scripts, forms, and active embeds are not part of the supported plan artifact contract.
- Durable external orchestration beyond the returned listener commands is left to host agents and harnesses.

## Quality and trust bar

- Do not lose comments. Queue-backed `agent next` is the correctness-critical delivery path; `watch` is debug/low-latency support.
- Do not silently publish malformed or partially written source HTML over a last good render.
- Keep public command examples copy-paste ready and backed by automated contract tests when they define behavior.
- Preserve local data integrity for the SQLite store and avoid committing runtime data.

## How plans must use this document

- Every active plan under `thoughts/plans/` must include a Product intent alignment section.
- Plans must cite which outcomes and principles they advance.
- If a plan conflicts with product intent, update this document first or log the deviation explicitly before marking the plan execution-ready.

## Change log

- 2026-06-08: Added repo product intent so future reviewed HTML plans have a local source of truth.
