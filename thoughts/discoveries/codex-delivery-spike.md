# Codex Delivery Transport Spike

Verdict: PROCEED

## Environment

- Date: 2026-06-12
- Repo cwd: `/Users/anichols/code/add-codex-delivery-adapter`
- Node: `v26.3.0`
- npm: `11.16.0`
- Bun: `1.3.14`
- Codex CLI: `codex-cli 0.139.0`
- Installed app-server daemon: running in ephemeral mode, CLI `0.139.0`, app-server `0.136.0`
- SDK package checked in `/tmp`: `@openai/codex-sdk@0.139.0`, Node engine `>=18`, depends on `@openai/codex@0.139.0`
- Official docs source: fresh Codex manual from OpenAI docs cache, sections `Codex App Server` and `Codex SDK`
- Auth/config reality: local active provider is `proxy`; OpenAI auth is not required for that provider. A clean empty `CODEX_HOME` without auth/config fails with upstream `401 Unauthorized`.
- Connector reality: the default user config currently starts a Cloudflare MCP/plugin path with invalid OAuth and can make SDK turns fail unless the delivery process disables or isolates that plugin/config.

## SDK result

- SDK API shape: package exports `Codex` and `Thread`; `Codex.startThread(options)`, `Codex.resumeThread(id, options)`, `Thread.run(input)`, and `Thread.runStreamed(input)` are available.
- SDK implementation shape: the TypeScript SDK wraps `codex exec --experimental-json`; it does not use app-server directly.
- Successful isolated run:
  - Config override disabled `plugins."cloudflare@openai-curated".enabled` and used supported `modelReasoningEffort: "low"`.
  - Thread options used `workingDirectory: /Users/anichols/code/add-codex-delivery-adapter`, `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `webSearchMode: "disabled"`.
  - Started thread id: `019eb93e-3c2a-7353-85d2-a9cc5b19cca1`.
  - First turn final response: `transport-ok isolated-start`.
  - Resumed the same thread id: `019eb93e-3c2a-7353-85d2-a9cc5b19cca1`.
  - Resume turn final response: `transport-ok isolated-resume`.
  - Result fields available from `Thread.run`: `items`, `finalResponse`, and `usage`.
  - Stream events available from `runStreamed`: `thread.started`, `turn.started`, `item.completed`, `turn.completed`, `turn.failed`, and `error`.
- SDK caveat:
  - `resumeThread("not-a-real-thread-id")` unexpectedly produced a new thread id `019eb940-d5ac-7b30-a7a7-2233f24322bb` and completed the prompt instead of failing.
  - Implementation must treat SDK resume as unsafe until it verifies `thread.id === requestedThreadId` after the first event. If the id differs, fail closed and do not ack the plan-reviewer comment.
- SDK unsupported input:
  - `modelReasoningEffort: "minimal"` failed for the active provider with `level "minimal" not supported, valid levels: low, medium, high, xhigh`.

## App-server result

- Generated local TypeScript protocol confirmed:
  - `thread/start` supports `cwd`, `approvalPolicy`, `sandbox`, `config`, `serviceName`, and `ephemeral`.
  - `thread/resume` requires `threadId` and supports `cwd`, `approvalPolicy`, `sandbox`, and `config`.
  - `turn/start` requires `threadId` and `input: Array<UserInput>`, where `UserInput` includes `{ type: "text", text: string }`.
  - `turn/completed` notification includes `{ threadId, turn }`.
  - Error info includes variants such as `serverOverloaded`, `unauthorized`, `badRequest`, and `activeTurnNotSteerable`.
- Successful stdio app-server run:
  - Sent `initialize`, then `initialized`.
  - Sent `thread/start` from repo cwd with `approvalPolicy: "never"`, `sandbox: "read-only"`, and `config` overrides.
  - Started persisted thread id: `019eb940-2af4-7503-b084-26f47371d665`.
  - Sent `turn/start` with `input: [{ type: "text", text: "..." }]`.
  - Observed `turn/started`, `item/agentMessage/delta`, `item/completed`, and `turn/completed`.
  - First final agent message: `app-server-ok persisted-start`.
  - Sent `thread/resume` for the same thread id.
  - Sent a second `turn/start`.
  - Second final agent message: `app-server-ok persisted-resume`.
- App-server caveats:
  - `ephemeral: true` threads cannot be resumed by thread id later; `thread/resume` returned `no rollout found for thread id ...`.
  - The running daemon version reported by `codex doctor` is `0.136.0` while the CLI/schema generator is `0.139.0`; implementation should generate and test against the installed runtime or prefer SDK unless app-server parity is explicitly required.
  - The Cloudflare MCP/plugin OAuth error still appeared on stderr in app-server runs even with plugin-disable config overrides, but did not block the successful turns.

## Failure probes

- Missing auth/config:
  - A clean temporary `CODEX_HOME` failed with `401 Unauthorized: Missing bearer or basic authentication in header`.
  - Classification: operator-actionable permanent configuration failure until auth/provider config is supplied.
- Wrong thread id:
  - SDK: unsafe behavior. A fake thread id started a new thread and completed. Classification: fail-closed in adapter by comparing requested and observed thread ids.
  - App-server: strict behavior for malformed id. `thread/resume` returned JSON-RPC `-32600` with `invalid session id`.
  - Classification: permanent target/config error.
- Active turn:
  - App-server accepted a second `turn/start` immediately after the first `turn/start` response instead of returning a conflict in the probe.
  - Classification: implementation must serialize one in-flight delivery per target thread in `plan-reviewer`; do not rely on app-server to reject concurrent turns.
- Unavailable app-server:
  - `codex app-server proxy --sock /tmp/plan-reviewer-no-such-app-server.sock` failed with `failed to connect to socket ... No such file or directory`.
  - Classification: retryable if app-server mode is enabled and the socket may appear later; operator-actionable if socket path is configured incorrectly.
- Timeout/cancellation:
  - SDK `AbortSignal` cancellation before turn start surfaced as `AbortError: The operation was aborted`.
  - Classification: retryable before Codex completion; if cancellation happens after a result is stored, retry only ack/recovery and do not start a duplicate Codex turn.

## Implementation decision

Proceed with the plan using the TypeScript SDK as the primary transport and app-server as an explicit fallback boundary.

Required plan constraints for later phases:

- Use only supported effort values for the active provider. Do not plan on `minimal`; use `low`, `medium`, `high`, or `xhigh`.
- Delivery workers must run Codex with a controlled config surface so unrelated user plugins/connectors cannot break comment delivery.
- For SDK resume, verify the observed thread id equals the configured target thread id before treating delivery as valid.
- Persist SDK `finalResponse`, `usage`, item types, and observed thread id. SDK does not expose a turn id through `Thread.run`; `adapter_turn_id` must be optional.
- In app-server mode, persist response `turn` metadata from `turn/start` / `turn/completed` where available.
- Serialize deliveries per target thread in plan-reviewer. Do not rely on Codex/app-server to reject concurrent turns.
- Treat auth/config errors and wrong thread ids as fail-closed operator-actionable failures; treat app-server unavailability and pre-completion timeout as retryable.

## Implementation review follow-ups

- Scoped implementation reviews after Phases 1-6 found one ack-failure edge: when `autoResolve` was enabled and Codex returned `fullyResolved`, an ack failure after Codex completion could be masked by a later `resolved` status. This was fixed in `src/delivery/worker.ts` by auto-resolving only after the row reloads as `delivered`, with regression coverage in `src/__tests__/contracts.test.ts`.
- Low-risk deferred cleanup remains: simplify duplicate retryable/permanent claim-release branches in the worker catch block, reuse the already-loaded row id inside the auto-resolve block, and optionally add an explicit call counter to the ack-failure auto-resolve test. These are readability/coverage polish only; the state-machine contract is covered by the current tests and post-fix reviews.
