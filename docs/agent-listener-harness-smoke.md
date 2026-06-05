# Agent listener harness smoke

This release gate verifies that Pi, Codex, and Claude Code can use the shared queue-backed listener command without harness-specific production adapters.

## Simulated mode

```bash
bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode simulated --evidence /tmp/plan-reviewer-harness-smoke-simulated.json
```

Simulated mode starts a local plan-review service, launches three labeled workers (`pi`, `codex`, `claude-code`) that invoke `node dist/cli.js agent next <planId> --wait --json --timeout 30000 --url <baseUrl>`, creates a comment, acks and resolves with the returned claim ID, restarts the service on the same host/port and database, then verifies a still-running listener command claims and acks a second comment.

## Real mode preconditions

The real harness controller requires local authenticated CLIs:

- Pi CLI (`pi`)
- Codex CLI (`codex`), with optional `CODEX_HARNESS_FLAGS`
- Claude Code (`claude`) plus an authenticated user-owned `codex` tmux session for the tmux launch path

The controller writes `/tmp/plan-reviewer-harness-smoke-prompt.md` from `src/test-fixtures/harness-smoke-prompt.md`, writes per-harness runner scripts under `/tmp/plan-reviewer-harness-smoke-<harness>.sh`, starts the plan-review service it owns, launches the requested harness commands, creates comments through the API, restarts the service on the same URL/port, polls API comment state, captures stdout/stderr, and writes evidence JSON.

```bash
bun run test:fixtures -- --scenario agent-listener-harness-smoke --harness-mode real --harnesses pi,codex,claude-code --evidence /tmp/plan-reviewer-harness-smoke.json
```

## Required command templates

```bash
# Pi
pi --no-session -p "$(cat /tmp/plan-reviewer-harness-smoke-prompt.md)"

# Codex; model/config flags may be overridden by CODEX_HARNESS_FLAGS for local installs
codex exec ${CODEX_HARNESS_FLAGS:--m gpt-5.5 -c 'model_reasoning_effort="medium"'} -s workspace-write -C "$REPO" - < /tmp/plan-reviewer-harness-smoke-prompt.md

# Claude Code, launched through authenticated user tmux session via a generated launcher script
launcher=/tmp/plan-reviewer-harness-smoke-claude-code-launch-<pid>.sh
tmux new-window -t codex -n claude-smoke-<pid> "$launcher"

# Each prompt tells the harness to run its generated queue listener script:
bash /tmp/plan-reviewer-harness-smoke-<harness>.sh
```

## Evidence JSON

Both modes write evidence entries with:

- `harness`
- `mode`
- `planId`
- `serviceUrl`
- `firstCommentId`
- `secondCommentId`
- `firstClaimLatencyMs`
- `secondClaimLatencyMs`
- `firstAckLatencyMs`
- `secondAckLatencyMs`
- `restartObserved`
- `sameServiceUrlAfterRestart`
- `listenerRestartedOrReconnected`
- `ackResults`
- `resolveResults`
- `manualIntervention: false`

Simulated mode fails if either comment is not claimed and acked within 30 seconds. Real mode fails if either comment is not claimed within 60 seconds or not acked within 180 seconds, if resolve is attempted before ack, if the service does not restart at the same URL/port, or if manual intervention is required after harness startup.
