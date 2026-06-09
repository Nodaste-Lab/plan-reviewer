---
date: 2026-06-09
author: plan-reviewer agents
original_plan: thoughts/plans/deferred-state-and-plan-notes.html
status: graduated
---

# Deferred Plan State and Plan Notes

## Purpose

Plan reviewer supports a first-class `deferred` lifecycle state for plans that should leave active work queues without becoming historical archive items. Deferred plans keep durable plan-scoped notes so operators and agents can understand why work paused, what the current status is, and what should happen next.

## Architecture

Deferred state and plan notes are implemented across the same source-of-truth surfaces as active and archived plans:

- `plans.lifecycle_state` stores `active`, `deferred`, or `archived` as the lifecycle source of truth while preserving legacy `archived_at` compatibility.
- `plans.deferred_at` and `plans.deferred_note_id` record when a plan was paused and which note captured the defer reason.
- `plan_notes` stores append-only notes tied to `plan_id`, independent of reviewer comments and plan versions.
- Plan list/detail payloads expose lifecycle state, deferred metadata, note count, latest note, and recent notes so agents can inspect context without browser scraping.
- API routes expose explicit lifecycle and note operations:
  - `POST /api/plans/:planId/defer`
  - `POST /api/plans/:planId/resume`
  - `POST /api/plans/:planId/notes`
  - `GET /api/plans/:planId/notes`
- CLI commands mirror those API routes for operator and agent workflows:
  - `plan-review defer <planId> --note <text> [--json]`
  - `plan-review resume <planId> [--note <text>] [--json]`
  - `plan-review notes add <planId> --note <text> [--json]`
  - `plan-review notes list <planId> [--json]`
- Browser UI separates lifecycle buckets: `/` for active plans, `/deferred` for paused plans, and `/archive` for archived plans.

## Decisions

- Deferred is a lifecycle state, not an archive alias. Active, deferred, and archived plans have distinct user intent and distinct index surfaces.
- Defer requires a non-empty note/reason. The defer reason is stored as a normal plan note and linked by `deferred_note_id`.
- Notes are append-only in the initial design. Editing, deletion, rich text, tags, and attachments are intentionally deferred.
- Plan notes are not reviewer comments and do not enter the agent comment queue. They provide durable context rather than work items requiring ack/resolve.
- Deferred and archived plans are quiet by default: source sync watchers are unregistered/skipped and queued comments are not claimable until resume/restore.
- Resume preserves all notes, clears deferred metadata, re-registers filesystem watching when applicable, and attempts a manual sync so the next view is current or truthfully reports sync failure.
- Reregistration and source changes preserve deferred state until an explicit resume. The system fails closed instead of auto-resuming work.

## Implementation Notes

- Legacy archived rows remain compatible because lifecycle derivation gives `archived_at` precedence and treats missing lifecycle state as active unless archived.
- Queue APIs reject direct claims against paused plans with `409 invalid_state` and actionable guidance to resume or restore first.
- Pending comments remain durable while a plan is deferred or archived; they become claimable again after explicit resume/restore.
- Source-sync guards recheck lifecycle before registering, syncing, or committing queued/in-flight filesystem updates.
- Browser plan shells show lifecycle-aware controls: active plans can defer/archive, deferred plans can resume/archive, and archived plans can restore.
- E2E coverage includes a live-linked plan that receives notes, is deferred, stays queue/source-sync quiet while paused, resumes, catches up source sync, and exposes pending queue work again.

## Verification

The completed implementation was verified with:

```bash
bun run build && node --test --test-name-pattern "lifecycle|note|defer" dist/__tests__/contracts.test.js
bun run build && node --test --test-name-pattern "defer|resume|notes|source sync" dist/__tests__/contracts.test.js
bun run build && node --test --test-name-pattern "CLI.*defer|CLI.*notes|CLI.*resume" dist/__tests__/contracts.test.js
bun run build && node --test --test-name-pattern "deferred lifecycle|review client polling refreshes notes and lifecycle shell controls|review client polling reloads metadata for plan lifecycle and note events" dist/__tests__/contracts.test.js
bun run test
bun run test:e2e
bun run test:fixtures -- --scenario seeded-comment-stream
bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated
```

## Related

- Original plan: `thoughts/plans/deferred-state-and-plan-notes.html`
- Product intent: `thoughts/specs/product_intent.md`
- Operator docs: `README.md`
