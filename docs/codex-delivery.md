# Codex Delivery

Codex delivery lets `plan-reviewer` wake a configured Codex thread only when a browser comment is pending and claimable. The service still owns queue state; Codex receives one ordinary text-input turn for one claimed comment.

## Safety Defaults

Delivery is disabled unless both conditions are true:

- The service is started with `PLAN_REVIEW_CODEX_DELIVERY=1`.
- The plan has an enabled `codex` target with an explicit `threadId`.

The MVP service is unauthenticated. Keep Codex delivery on loopback or a trusted network:

```bash
PLAN_REVIEW_CODEX_DELIVERY=1 plan-review serve --host 127.0.0.1 --port 4317
```

## Configure a Target

Use target-management commands with `--thread`:

```bash
plan-review delivery target set plan_123 --adapter codex --thread <threadId> --mode sdk --json
plan-review delivery target show plan_123 --adapter codex --json
```

Registration also has Codex-specific convenience flags:

```bash
plan-review register thoughts/plans/my-plan.html \
  --execution-ready false \
  --codex-thread <threadId> \
  --codex-delivery enabled
```

API JSON uses `threadId`; CLI target management uses `--thread`; registration uses `--codex-thread`.

## Thread ID

Use a throwaway or task-specific Codex thread. The SDK adapter verifies the observed resumed thread id when the SDK exposes it and fails closed if it differs from the configured `threadId`.

## Modes

- `sdk`: loads `@openai/codex-sdk` dynamically when delivery runs. Normal service startup does not require the package.
- `app-server`: uses JSON-RPC app-server protocol with `turn/start` input shaped as `[{ "type": "text", "text": "..." }]`.
- `fake`: test-only mode for fixtures and local verification.

## Inspect and Recover

List outbox state:

```bash
plan-review delivery list plan_123 --adapter codex --json
```

Retry failed, retry-wait, or ack-failed rows:

```bash
plan-review delivery retry plan_123 --adapter codex --comment cmt_123 --json
```

Disable delivery without deleting queue comments:

```bash
plan-review delivery target set plan_123 --adapter codex --disable --mode sdk --json
```

Manual fallback stays available:

```bash
plan-review agent next plan_123 --no-wait --json --url http://127.0.0.1:4317
plan-review agent next plan_123 --wait --json --url http://127.0.0.1:4317
```

## Test Smoke

Run the fake delivery fixture without Codex credentials:

```bash
bun run test:fixtures -- --scenario codex-delivery-fake
```

The fixture registers a plan, enables a fake Codex target, creates a comment, waits for the delivery worker to claim and ack it, and verifies response metadata.
