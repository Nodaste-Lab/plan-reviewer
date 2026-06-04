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

The registration response is also the canonical source of watcher instructions for agents: successful CLI registration prints a `REQUIRED NEXT ACTION:` block with copy-paste watcher commands, and API registration returns `agentInstructions` inside the existing `{ ok, data }` response envelope. Agents should start a watcher before continuing plan work.

By default, registration live-links the local source file: the repo HTML file is authoritative, service blobs are derived cache/history, and later edits to the file sync into the latest rendered version automatically. Open review pages reload their iframe when a synced version is available.

Use `--snapshot` only when you want a detached historical review that will not watch the source file:

```bash
plan-review register thoughts/plans/my-plan.html --snapshot --execution-ready false
```

The browser shell renders sanitized HTML in a no-script iframe and keeps the comment UI in the parent page. Selecting a DOM element opens the composer; image and text comments use the same comment API with `anchorType: "image"` or `anchorType: "text_range"`. If the service cannot read a live-linked source file, it keeps serving the last good rendered version and exposes the sync failure in the API and sidebar.

## Agent Watch Contract

Agents can keep an open SSE connection for queue events. Prefer the `agentInstructions.preferredCommand` returned by registration; API command templates are service-local and adapters should render them with `--url <registration service URL>` before execution. CLI human output already renders copy-paste commands with the resolved `--url`.

```bash
plan-review watch plan_123 --mode queue --format browser-comment --json --url http://127.0.0.1:4317
```

Raw HTTP contract:

```http
GET /api/plans/:planId/events?mode=queue
Accept: text/event-stream
Last-Event-ID: <last-seen-sequence>
```

SSE frames use `id: <sequence>`, `event: comment.created|comment.claimed|comment.acknowledged|comment.resolved|comment.released`, and JSON `data`. Non-queue event streams also include `plan.version.registered`, `plan.version.synced`, and `plan.sync.failed` for browser refresh/status updates. On reconnect, `Last-Event-ID` replays later events. Heartbeats are sent every 15 seconds. If SSE is unavailable, agents poll:

```http
GET /api/plans/:planId/events/poll?afterSequence=<last-seen-sequence>&mode=queue
```

Poll responses include `{ events, latestSequence, retryAfterMs }`. The CLI falls back to 10-second REST polling when the stream is unavailable.

## Queue Lifecycle

Comments are delivered at least once. An agent should claim, process, ack, then optionally resolve. Browser-comment watcher payloads include `commentId`; claim that exact ID and read the claim ID from `claimed[0].claim.id` in CLI JSON (raw API path: `data.claimed[0].claim.id`).

```bash
plan-review queue claim plan_123 --ids cmt_123 --json
plan-review ack cmt_123 --claim claim_123 --note "Updated the plan" --json
plan-review resolve cmt_123 --note "Done" --json
```

Direct ack without an active matching claim returns `409 claim_required`. Claims have a default 5-minute lease and expired claims return to `pending`.

## Browser Comment Bridge

Every comment event carries `conversationPayload.type = "browser.comment.v1"`. Host adapters for Codex, Claude, or Pi can append that payload into the active conversation, let the agent answer there, and call `ack` or `resolve` with a response summary, changed files, run ID, and optional commit SHA. The service stores the response metadata but does not implement a separate chat product.

## Authoring HTML Plans

Use stable `id` attributes on major sections, phase cards, acceptance criteria, diagrams, and mockups. The renderer preserves those IDs as `data-plan-node-id`; otherwise it derives deterministic IDs from headings, sibling paths, and short content hashes. Prefer semantic `section`, `article`, `figure`, `figcaption`, headings, lists, and tables so comments capture useful heading paths.

Keep images relative to the plan file when they are repo assets. Include `alt`, `width`, and `height` where possible. Plan-authored scripts, event handlers, forms, and active embeds are stripped from the review render; put interactive review behavior in the plan-reviewer shell, not in the plan artifact.

## Security Seams

The MVP is intentionally unauthenticated. Future bearer tokens, private share links, or network restrictions should plug in at Fastify request hooks before the route handlers and at CLI service-discovery/config boundaries. Until then, use `--host 127.0.0.1` for local-only use or the Homebrew default `0.0.0.0` only on a trusted network.

## Development

```bash
bun install
bun run test
bun run test:e2e -- --grep "dom annotation|image annotation|plan index"
bun run test:fixtures -- --scenario seeded-comment-stream
```

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.
