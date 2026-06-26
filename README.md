# Plan Reviewer

Local HTML review daemon and CLI for planning-mode implementation plans under `thoughts/plans` and collaboration-mode HTML documents.

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

## Updates

Check the installed version and update status from the CLI:

```bash
plan-review --version
plan-review update check
plan-review update check --json
```

Normal Homebrew installs use the stable formula as the source of truth. The checker reports an update only when `Formula/plan-reviewer.rb` points at a newer tag tarball that `brew upgrade` can install; a newer commit, tag, or GitHub Release by itself is not enough for stable users. Explicit Homebrew `--HEAD` installs are checked against upstream `main` by commit ancestry and use the HEAD-specific upgrade command.

When an update is available, plan-reviewer only shows instructions. It never runs `brew upgrade`, restarts services, or mutates user data automatically.

Stable install update:

```bash
brew update && brew upgrade Nodaste-Lab/plan-reviewer/plan-reviewer
brew services restart plan-reviewer
plan-review --version && curl -fsS http://127.0.0.1:4317/health
```

HEAD install update:

```bash
brew update && brew upgrade --fetch-HEAD Nodaste-Lab/plan-reviewer/plan-reviewer
brew services restart plan-reviewer
plan-review --version && curl -fsS http://127.0.0.1:4317/health
```

Maintainer/local HEAD deployment should use the checked-in deploy guard instead of copying files into `/opt/homebrew/Cellar` manually:

```bash
bun run deploy:homebrew:head
```

The guard uses Homebrew to install or upgrade the HEAD formula, relinks the formula to repair stale plan-reviewer symlinks left by older manual deploys, restarts the service, verifies `/health`, and fails if the linked keg is missing Homebrew's `.brew/plan-reviewer.rb` or `INSTALL_RECEIPT.json` metadata. Do not manually rewrite `/opt/homebrew/opt/plan-reviewer` or `/opt/homebrew/bin/plan-review`; those symlinks must remain Homebrew-managed so `brew services restart plan-reviewer` can locate the formula service definition.

Development checkouts, unsupported install shapes, local-ahead HEAD builds, and metadata failures fail closed with `unknown`, `unsupported_channel`, or `check_failed` plus a next action. They do not show the browser update-available indicator.

The running service exposes the same status at:

```http
GET /api/runtime/update
```

The browser index and review shell show a fixed green up-arrow only for confirmed `update_available` status. The Configuration page at `/configuration` includes an **Update checks** section where automatic public GitHub/Homebrew metadata checks can be disabled. The setting persists in `~/.config/plan-reviewer/config.json`:

```json
{
  "updateChecks": {
    "enabled": false
  }
}
```

Manual `plan-review update check` remains available even when automatic service/browser checks are disabled.

## Maintainer release process

Stable updates require a new Homebrew-installable formula version. Keep this process repo-visible; user-local release skills may mirror it, but should not be the only source of truth.

1. Start from a clean tree on the release branch and verify the target version, for example `0.1.1` / `v0.1.1`.
2. Run preflight gates:

   ```bash
   bun install
   bun run build
   bun run test
   bun run test:e2e
   ```

3. Bump `package.json` and `package-lock.json` to the target version without creating a tag yet, then commit the release change.
4. Create and push a version tag that matches the formula URL:

   ```bash
   git tag v0.1.1
   git push origin HEAD
   git push origin v0.1.1
   ```

5. Calculate the tag tarball checksum:

   ```bash
   curl -L https://github.com/Nodaste-Lab/plan-reviewer/archive/refs/tags/v0.1.1.tar.gz | shasum -a 256
   ```

6. Update `Formula/plan-reviewer.rb` to the tag URL and checksum. When the tarball contains the current package metadata, keep the formula license aligned with `package.json` (`Apache-2.0` for current releases). The checked-in `v0.1.0` formula is intentionally still `MIT` because that tarball predates the repository license migration.
7. Validate formula syntax and package behavior:

   ```bash
   ruby -c Formula/plan-reviewer.rb
   brew update
   brew upgrade Nodaste-Lab/plan-reviewer/plan-reviewer
   plan-review --version
   curl -fsS http://127.0.0.1:4317/health
   ```

8. If validation fails after publishing, fix the formula with a follow-up commit or cut a new version tag. Do not move an already-pushed release tag that users may have fetched.

GitHub Release objects and packaged binary assets are optional. The default release is the tag plus formula URL/checksum update that `brew update && brew upgrade` can consume.

## Register and Review

```bash
plan-review register thoughts/plans/my-plan.html --repo auto --branch auto --commit auto --execution-ready false
plan-review index
```

Open the printed review URL. Records have an explicit `reviewMode`: `planning` preserves reviewed-plan behavior, while `collaboration` hosts general HTML documents for anchored human/agent conversations. If omitted, the server infers `planning` for records with execution-readiness metadata or `thoughts/plans/` paths, and `collaboration` for general HTML without planning metadata. Override or correct mode without editing source HTML:

```bash
plan-review register docs/brief.html --review-mode collaboration
plan-review mode plan_123 collaboration --json
```

Planning-mode publishing requires metadata for the worktree path, branch, optional Linear issue, and whether codex/claude-code review results say the plan is execution ready. The CLI fills worktree and branch from git; pass `--linear-issue <issue>` when applicable and pass `--execution-ready true|false` based only on agent-review results. Collaboration mode may omit execution-readiness metadata and hides planning-specific buttons/status chrome.

The registration response is also the canonical source of listener instructions for agents: successful CLI registration prints a `REQUIRED NEXT ACTION:` block with copy-paste `agent next` commands, and API registration returns `agentInstructions` inside the existing `{ ok, data }` response envelope. Human CLI output wraps printed plan URLs in angle brackets, such as `<http://127.0.0.1:4317/p/plan_123_>`, so terminal linkifiers include generated IDs that end in `_`; omit the brackets only when pasting into tools that do not accept bracketed URLs. Agents should drain pending queue work and start the listener command before continuing plan work.

By default, registration live-links the local source file: the repo HTML file is authoritative, service blobs are derived cache/history, and later edits to the file sync into the latest rendered version automatically. Open review pages reload their iframe when a synced version is available.

Use `--snapshot` only when you want a detached historical review that will not watch the source file:

```bash
plan-review register thoughts/plans/my-plan.html --snapshot --execution-ready false
```

Use the review shell's compact **Download raw plan** action, or the matching CLI command, to save a dated copy of the current source artifact for email or file sharing:

```bash
plan-review download plan_123 --output ./exports --url http://127.0.0.1:4317
```

Plans without copied local image assets download as `<slug>-YYYY-MM-DD-HHmmssZ.html`. Plans with supported copied local image assets download as `<slug>-YYYY-MM-DD-HHmmssZ.zip`; the archive contains one root directory with `<root>/<root>.html` and copied images under `<root>/assets/`, and the HTML references those relative asset paths. The CLI always treats `--output` as a directory, creates it when missing, uses the server-provided filename, prints the saved path, and refuses to overwrite an existing target file.

Exports are generated from the stored source HTML for the displayed version, not from the review shell, comments sidebar, screenshots, or sanitized iframe wrapper. Missing local images, external/protocol-relative/absolute/blob asset references, and unsupported local asset-bearing references such as stylesheets, scripts, media/object/embed refs, `srcset`, or CSS `url(...)` fail with `export_not_portable`; fix or inline those assets and re-register before downloading again.

The browser shell renders sanitized HTML in a no-script iframe and keeps the comment UI in the parent page. Selecting a DOM element opens the composer; image and text comments use the same comment API with `anchorType: "image"` or `anchorType: "text_range"`. Each open select → comment composer gets one browser-generated `clientMutationId`; retries from that same composer reuse the identifier, so repeated Submit clicks, keyboard submit, or network retries create at most one comment. If the service cannot read a live-linked source file, it keeps serving the last good rendered version and exposes the sync failure in the API and sidebar.

Agents can discover stable DOM targets without opening the browser by reading plan detail metadata:

```bash
plan-review show plan_123 --json --url http://127.0.0.1:4317
```

The JSON includes `anchorTargets` from the latest rendered HTML. Each target has a stable `planNodeId`, optional exact `#id` selector, heading/context previews, sanitized outer HTML preview, and an `anchorCommand` template. Native agent-created comments use the same pending comment lifecycle, queue delivery, sidebar markers, duplicate guards, and thread history as browser comments:

```bash
plan-review comments add plan_123 --plan-node-id ac-2 --body "Clarify this acceptance criterion" --agent Codex --json --url http://127.0.0.1:4317
```

Use `--selector #id` only as an exact-id convenience alternative to `--plan-node-id`; the two target flags are mutually exclusive. Agent identity is required and stored durably as `createdBy.type = "agent"`, the first thread entry role `agent`, and `conversationPayload.createdBy`. Native text-range and image-region authoring remain browser-only for this slice.

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

Browser navigation keeps lifecycle buckets separate: `/` opens the active planning Kanban board when Kanban is enabled and the All documents list when Kanban is disabled, `/?view=all` opens the All documents list, `/deferred` shows paused plans with resume controls and latest notes, and `/archive` shows archived plans. Plan detail pages expose notes plus lifecycle actions: active plans can be deferred, deferred plans can be resumed or archived, and archived plans can be restored.

## Organize Plans and Documents

The index has two primary document views:

- `Kanban` is the planning board. When enabled, it shows active planning documents grouped into configurable columns.
- `All documents` is the mixed discovery list. Use `Filter by type` to show only `Plan` or `Collaborative` documents.

Board columns are workflow status only. They are independent from lifecycle (`active`, `deferred`, `archived`) and independent from execution readiness. A plan can be in a "ready" board column while still reporting `executionReady: false` until the reviewed-plan gate has passed.

Use the browser Configuration panel (`/configuration`) to edit labels and hide columns in the Board columns section. The older `/columns` path remains compatible and renders the same configuration surface. Hidden columns and their assigned active plans are omitted from the Kanban board until shown again, but hidden columns remain selectable from a plan's Current plan status control when Kanban is enabled; deferred/archived plans in a hidden column are moved to the first visible column if they are resumed/restored. Use the CLI for ordering, label editing, and inspection:

```bash
plan-review columns list --json
plan-review columns save-order backlog,ready_to_pull,in_progress,done --json
plan-review columns rename in_progress "Doing" --json
plan-review column set plan_123 in_progress --json
```

When Kanban is disabled, board navigation, drag/drop, and Status filters are hidden, `/` defaults to All documents, and `plan-review column set` fails with `feature_disabled`. Column definitions and plan assignments are retained; `columns list`, `columns save-order`, and `columns rename` remain available so operators can prepare or repair columns before re-enabling Kanban.

## Configuration Panel

Open the icon-only Configuration gear from the Kanban board, All documents, lifecycle pages, the Configuration page, or a plan review shell. The panel stores service-local settings in SQLite:

- Review shell defaults: `showPlanNavigatorByDefault` and `showCommentsByDefault`, both `false` by default.
- Action button skill routing: `executionReadySkillName` defaults to `plan-reviewer-execution-ready`; `buildPlanSkillName` defaults to `plan-reviewer-build`.
- Kanban availability: `kanbanEnabled`, `true` by default.
- Board columns: the existing column label, key, order, done behavior, and visibility controls.

The API exposes the same source of truth:

```http
GET /api/configuration
PUT /api/configuration
```

`PUT /api/configuration` requires the full configuration payload and rejects unknown keys. Skill names must use lowercase letters, numbers, underscores, or dashes. Action buttons still create fixed request-comment bodies; only the skill-name token changes, and registered plan paths must be single-line values without control characters before an action comment is created.

Set a user-facing project label without editing source HTML:

```bash
plan-review project set plan_123 "Plan Reviewer" --json
```

Use the unified lifecycle command when scripting state changes. Deferring still requires a durable note:

```bash
plan-review lifecycle set plan_123 active --json
plan-review lifecycle set plan_123 deferred --note "Waiting on design review" --json
plan-review lifecycle set plan_123 archived --json
```

Pinning is a planning-document visibility aid, not a readiness signal:

```bash
plan-review pin plan_123 --json
plan-review unpin plan_123 --json
```

In a review page, the left navigator's Project, State, and Status controls are filters. They narrow the navigator only; they do not change project labels, lifecycle, or board columns. Project override, pin, and board-column commands apply to planning documents; collaboration documents remain discoverable through All documents and reject planning-only organization commands with a clear not-applicable error. When you switch plans through the left navigator, the filter state is carried in the destination URL so the next page renders already filtered. Press <kbd>⌘O</kbd> in the review shell for global quick open across active, deferred, archived, planning, and collaboration documents regardless of the current view/filter.

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

A claimed result includes `commentId`, `claimId`, the original `browser.comment.v1` `conversationPayload`, `reviewMode`/source metadata when available, and copy-paste `ackCommand` / `resolveCommand` guidance. After acting on the comment, optionally append a visible thread reply, ack with the returned claim ID, optionally resolve after ack, then immediately run the wait command again. Active claims are not double-claimed by reruns; released or expired claims return to pending through normal queue state.

```bash
plan-review reply cmt_123 --body "Updated the document." --claim claim_123 --adapter hermes --json
```

A single watcher can claim eligible work across active documents for an adapter without pre-claiming documents that lack an enabled target:

```bash
plan-review agent next --all --adapter hermes --json --url http://127.0.0.1:4317
```

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

SSE frames use `id: <sequence>`, `event: comment.created|comment.claimed|comment.thread_entry.created|comment.acknowledged|comment.resolved|comment.released|comment.deleted`, and JSON `data`. Non-queue event streams also include `plan.version.registered`, `plan.version.synced`, and `plan.sync.failed` for debug consumers; the browser review shell uses finite `/events/poll` requests for freshness instead of persistent SSE. On reconnect, `Last-Event-ID` replays later events. Heartbeats are sent every 15 seconds. If SSE is unavailable, agents poll:

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

Duplicate comment creation is idempotent only for the same `clientMutationId` and the same fingerprint: `versionId`, `body`, `anchorType`, and canonicalized `anchor`. Canonicalized anchors compare JSON values with recursively sorted object keys, preserved array order, exact primitive values, and no dropped fields. `markerScreenshot` and `createdBy` differences are treated as retry noise; the first stored screenshot and creator win, including for agent comments retried with a different display name. A mismatched fingerprint returns `409 duplicate_comment_conflict` with an actionable next step. If the original comment for that `clientMutationId` was soft-deleted, retrying returns `409 duplicate_comment_deleted` and does not recreate or undelete it.

Pending unclaimed comments can be deleted from the browser UI or with `DELETE /api/comments/:commentId`. Claimed, acknowledged, resolved, and already deleted comments return `409 invalid_state`. Deletion is API/browser-only in this scope; there is no CLI delete command.

## Browser Comment Bridge

Every comment event carries `conversationPayload.type = "browser.comment.v1"`. The original browser comment creates the first durable human thread entry. Native agent comments created through `POST /api/plans/:planId/comments/dom` or `plan-review comments add` create the first durable agent thread entry and carry the same agent identity in `comment.createdBy`, `threadEntries[0].createdBy`, and `conversationPayload.createdBy`. Agent replies should be appended with `POST /api/comments/:commentId/replies` or `plan-review reply`; ack/resolve remain lifecycle metadata and do not replace visible replies. Legacy `agent_response_json` response summaries remain display metadata for older integrations.

## Codex Delivery

Codex delivery is opt-in per plan and disabled by default at the service level. It uses the same queue claim lifecycle as `agent next`: a browser comment creates one delivery outbox row, the worker claims that exact comment, sends one normal Codex text turn to the configured thread, then acks only after Codex completes.

```bash
plan-review delivery target set plan_123 --adapter codex --thread <threadId> --mode sdk --json
plan-review delivery list plan_123 --json
plan-review delivery retry plan_123 --adapter codex --comment cmt_123 --json
```

For the packaged service, enable the worker persistently in `~/.config/plan-reviewer/config.json`:

```json
{
  "codexDelivery": {
    "enabled": true,
    "mode": "sdk",
    "intervalMs": 10000
  }
}
```

For ad hoc runs, `PLAN_REVIEW_CODEX_DELIVERY=1 plan-review serve ...` still works and overrides the config file.

Registration convenience flags are also available:

```bash
plan-review register thoughts/plans/my-plan.html --execution-ready false --codex-thread <threadId> --codex-delivery enabled
```

Hermes delivery uses the same target/outbox commands with `--adapter hermes`. The first slice supports `--mode fake` for fixtures and `--mode webhook`, where `--thread` is the trusted local webhook URL. Hermes payloads include plan/comment/claim IDs, review mode, source path, anchor/context, screenshot metadata, and thread history; `replyBody` results are appended as visible agent replies before ack.

```bash
plan-review delivery target set plan_123 --adapter hermes --thread http://127.0.0.1:8787/plan-review --mode webhook --json
```

See [docs/review-modes.md](docs/review-modes.md) for mode workflows and [docs/codex-delivery.md](docs/codex-delivery.md) for Codex setup, fake-adapter smoke tests, SDK/app-server notes, manual recovery, and security guidance.

## Authoring HTML Plans

Use stable `id` attributes on major sections, phase cards, acceptance criteria, diagrams, and mockups. The renderer preserves those IDs as `data-plan-node-id`; otherwise it derives deterministic IDs from headings, sibling paths, and short content hashes. Prefer semantic `section`, `article`, `figure`, `figcaption`, headings, lists, and tables so comments capture useful heading paths.

Keep images relative to the plan file when they are repo assets. Include `alt`, `width`, and `height` where possible. Plan-authored scripts, event handlers, forms, and active embeds are stripped from the review render; put interactive review behavior in the plan-reviewer shell, not in the plan artifact.

## Security Seams

The MVP is intentionally unauthenticated. Anyone who can reach the service can view registered planning/collaboration documents, create comments, claim work, append replies, and change modes. Future bearer tokens, private share links, or network restrictions should plug in at Fastify request hooks before the route handlers and at CLI service-discovery/config boundaries. Until then, use `--host 127.0.0.1` for local-only use or the Homebrew default `0.0.0.0` only on a trusted network.

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
