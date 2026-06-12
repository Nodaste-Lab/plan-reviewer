# Plan Reviewer

Local HTML plan review daemon and CLI for plans under `thoughts/plans`.

## Install

From the public Homebrew tap:

```bash
brew tap Nodaste-Lab/plan-reviewer https://github.com/Nodaste-Lab/plan-reviewer.git
brew install Nodaste-Lab/plan-reviewer/plan-reviewer
brew services start plan-reviewer
```

The service runs:

```bash
plan-review serve --host 0.0.0.0 --port 4317 --db ~/.plan-reviewer/plan-reviewer.sqlite
```

There is no authentication in the MVP. Anyone who can reach the service can view registered plans and create or process comments.

## Register and Review

```bash
plan-review register thoughts/plans/my-plan.html --repo auto --branch auto --commit auto --execution-ready false
plan-review index
```

Open the printed review URL. Publishing requires metadata for the worktree path, branch, optional Linear issue, and whether codex/claude-code review results say the plan is execution ready. The CLI fills worktree and branch from git; pass `--linear-issue <issue>` when applicable and always pass `--execution-ready true|false` based only on agent-review results.

The registration response is also the canonical source of listener instructions for agents: successful CLI registration prints a `REQUIRED NEXT ACTION:` block with copy-paste `agent next` commands, and API registration returns `agentInstructions` inside the existing `{ ok, data }` response envelope. Agents should drain pending queue work and start the listener command before continuing plan work.

By default, registration live-links the local source file: the repo HTML file is authoritative, service blobs are derived cache/history, and later edits to the file sync into the latest rendered version automatically. Open review pages reload their iframe when a synced version is available.

Use `--snapshot` only when you want a detached historical review that will not watch the source file:

```bash
plan-review register thoughts/plans/my-plan.html --snapshot --execution-ready false
```

The browser shell renders sanitized HTML in a no-script iframe and keeps the comment UI in the parent page. Selecting a DOM element opens the composer; image and text comments use the same comment API with `anchorType: "image"` or `anchorType: "text_range"`. Each open select → comment composer gets one browser-generated `clientMutationId`; retries from that same composer reuse the identifier, so repeated Submit clicks, keyboard submit, or network retries create at most one comment. If the service cannot read a live-linked source file, it keeps serving the last good rendered version and exposes the sync failure in the API and sidebar.

## Deferred Plans and Plan Notes

Use deferred state when a plan should leave the active queue but remain easy to pick up later. Deferring requires a durable note so operators and agents can see why work paused and what should happen next:

```bash
plan-review defer plan_123 --note "Blocked on PM review; resume at P3" --json
plan-review resume plan_123 --note "PM review complete" --json
```

Deferred filesystem-backed plans stop source watching while paused. Resuming registers the watcher again and runs a manual sync so the review page either catches up to current source or shows a truthful source-sync warning.

Plan notes are append-only plan-scoped records, separate from reviewer comments and queue claims. They stay with active, deferred, and archived plans and are available to agents without browser scraping:

```bash
plan-review notes add plan_123 --note "Current status: tests need AC-4 coverage" --json
plan-review notes list plan_123 --json
```

Browser navigation keeps lifecycle buckets separate: `/` shows active plans, `/deferred` shows paused plans with resume controls and latest notes, and `/archive` shows archived plans. Plan detail pages expose notes plus lifecycle actions: active plans can be deferred, deferred plans can be resumed or archived, and archived plans can be restored.

## Agent Listener Contract

Agents should use the queue-backed `agent next` command as the primary browser-comment delivery path. Prefer the `agentInstructions.preferredCommand` returned by registration; API command templates are service-local and adapters should render them with `--url <registration service URL>` before execution. CLI human output already renders copy-paste commands with the resolved `--url`.

On start or resume, drain any pending work until the command reports `empty`:

```bash
plan-review agent next plan_123 --no-wait --json --url http://127.0.0.1:4317
```

Then listen for the next actionable comment:

```bash
plan-review agent next plan_123 --wait --json --url http://127.0.0.1:4317
```

A claimed result includes `commentId`, `claimId`, the original `browser.comment.v1` `conversationPayload`, and copy-paste `ackCommand` / `resolveCommand` guidance. After acting on the comment, ack with the returned claim ID, optionally resolve after ack, then immediately run the wait command again. Active claims are not double-claimed by reruns; released or expired claims return to pending through normal queue state.

After an agent creates a GitHub PR for a plan, link and refresh the plan's PR metadata before final handoff so the index can report open/merged/closed state programmatically:

```bash
plan-review pr link plan_123 --url https://github.com/OWNER/REPO/pull/123 --json
plan-review pr refresh plan_123 --json
```

The older watch stream remains available as an optional low-latency/debug stream, not as the correctness-critical agent delivery path:

```bash
plan-review watch plan_123 --mode queue --format browser-comment --json --url http://127.0.0.1:4317
```

Raw HTTP contract:

```http
GET /api/plans/:planId/events?mode=queue
Accept: text/event-stream
Last-Event-ID: <last-seen-sequence>
```

SSE frames use `id: <sequence>`, `event: comment.created|comment.claimed|comment.acknowledged|comment.resolved|comment.released|comment.deleted`, and JSON `data`. Non-queue event streams also include `plan.version.registered`, `plan.version.synced`, and `plan.sync.failed` for debug consumers; the browser review shell uses finite `/events/poll` requests for freshness instead of persistent SSE. On reconnect, `Last-Event-ID` replays later events. Heartbeats are sent every 15 seconds. If SSE is unavailable, agents poll:

```http
GET /api/plans/:planId/events/poll?afterSequence=<last-seen-sequence>&mode=queue
```

Poll responses include `{ events, latestSequence, retryAfterMs }`. `agent next --wait` uses SSE and REST polling only to wake another authoritative queue claim attempt; missed events do not make comments unrecoverable.

## Queue Lifecycle

Comments are delivered at least once. An agent should claim, process, ack, then optionally resolve. `agent next` performs the claim and returns the claim ID directly.

```bash
plan-review agent next plan_123 --wait --json
plan-review ack cmt_123 --claim claim_123 --note "Updated the plan" --json
plan-review resolve cmt_123 --note "Done" --json
```

`plan-review queue claim` remains available for manual/debug flows:

```bash
plan-review queue claim plan_123 --ids cmt_123 --json
```

Direct ack without an active matching claim returns `409 claim_required`. Claims have a default 5-minute lease and expired claims return to `pending`.

Duplicate comment creation is idempotent only for the same `clientMutationId` and the same fingerprint: `versionId`, `body`, `anchorType`, and canonicalized `anchor`. Canonicalized anchors compare JSON values with recursively sorted object keys, preserved array order, exact primitive values, and no dropped fields. `markerScreenshot` and `createdBy` differences are treated as retry noise; the first stored screenshot and creator win. A mismatched fingerprint returns `409 duplicate_comment_conflict` with an actionable next step. If the original comment for that `clientMutationId` was soft-deleted, retrying returns `409 duplicate_comment_deleted` and does not recreate or undelete it.

Pending unclaimed comments can be deleted from the browser UI or with `DELETE /api/comments/:commentId`. Claimed, acknowledged, resolved, and already deleted comments return `409 invalid_state`. Deletion is API/browser-only in this scope; there is no CLI delete command.

## Browser Comment Bridge

Every comment event carries `conversationPayload.type = "browser.comment.v1"`. Host adapters for Codex, Claude, or Pi can append that payload into the active conversation, let the agent answer there, and call `ack` or `resolve` with a response summary, changed files, run ID, and optional commit SHA. The service stores the response metadata but does not implement a separate chat product.

## Codex Delivery

Codex delivery is opt-in per plan and disabled by default at the service level. It uses the same queue claim lifecycle as `agent next`: a browser comment creates one delivery outbox row, the worker claims that exact comment, sends one normal Codex text turn to the configured thread, then acks only after Codex completes.

```bash
PLAN_REVIEW_CODEX_DELIVERY=1 plan-review serve --host 127.0.0.1 --port 4317
plan-review delivery target set plan_123 --adapter codex --thread <threadId> --mode sdk --json
plan-review delivery list plan_123 --json
plan-review delivery retry plan_123 --adapter codex --comment cmt_123 --json
```

Registration convenience flags are also available:

```bash
plan-review register thoughts/plans/my-plan.html --execution-ready false --codex-thread <threadId> --codex-delivery enabled
```

See [docs/codex-delivery.md](docs/codex-delivery.md) for setup, fake-adapter smoke tests, SDK/app-server notes, manual recovery, and security guidance.

## Authoring HTML Plans

Use stable `id` attributes on major sections, phase cards, acceptance criteria, diagrams, and mockups. The renderer preserves those IDs as `data-plan-node-id`; otherwise it derives deterministic IDs from headings, sibling paths, and short content hashes. Prefer semantic `section`, `article`, `figure`, `figcaption`, headings, lists, and tables so comments capture useful heading paths.

Keep images relative to the plan file when they are repo assets. Include `alt`, `width`, and `height` where possible. Plan-authored scripts, event handlers, forms, and active embeds are stripped from the review render; put interactive review behavior in the plan-reviewer shell, not in the plan artifact.

## Security Seams

The MVP is intentionally unauthenticated. Future bearer tokens, private share links, or network restrictions should plug in at Fastify request hooks before the route handlers and at CLI service-discovery/config boundaries. Until then, use `--host 127.0.0.1` for local-only use or the Homebrew default `0.0.0.0` only on a trusted network.

## Development

```bash
bun install
bun run test
bun run test:e2e
bun run test:fixtures -- --scenario seeded-comment-stream
bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated
```

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.
