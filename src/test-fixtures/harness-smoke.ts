import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createApp } from '../server/app.js';
import { sha256 } from '../util.js';

export interface HarnessSmokeOptions {
  mode: 'simulated' | 'real';
  harnesses: string[];
  evidencePath?: string;
}

interface RegistrationData {
  planId: string;
  versionId: string;
}

interface NextPayload {
  status: 'claimed';
  commentId: string;
  claimId: string;
}

interface HarnessEvidence {
  harness: string;
  mode: 'simulated' | 'real';
  planId: string;
  serviceUrl: string;
  firstCommentId: string;
  secondCommentId: string;
  firstClaimLatencyMs: number;
  secondClaimLatencyMs: number;
  firstAckLatencyMs: number;
  secondAckLatencyMs: number;
  restartObserved: boolean;
  sameServiceUrlAfterRestart: boolean;
  listenerRestartedOrReconnected: boolean;
  ackResults: Array<{ commentId: string; status: string }>;
  resolveResults: Array<{ commentId: string; status: string }>;
  manualIntervention: false;
}

function rootDir(): string {
  return path.resolve(process.cwd());
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(`${url} failed: ${response.status} ${JSON.stringify(body)}`);
      return body.data as T;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function register(baseUrl: string, harness: string): Promise<RegistrationData> {
  const html = `<!doctype html><html><body><section id="fixture"><h1>${harness} harness smoke</h1><p>Queue me.</p></section></body></html>`;
  return requestJson<RegistrationData>(`${baseUrl}/api/plans/register`, {
    method: 'POST',
    body: JSON.stringify({
      repoKey: `fixture-${harness}`,
      repoName: 'fixture',
      rootPath: '/tmp/fixture',
      branch: 'main',
      commitSha: 'fixture',
      planPath: `thoughts/plans/${harness}-fixture.html`,
      slug: `${harness}-fixture`,
      html,
      fileHash: sha256(html),
      publicationMetadata: {
        worktreePath: '/tmp/fixture',
        branch: 'main',
        executionReady: false,
        executionReadyBasis: 'agent-review-results'
      },
      updateMode: 'upsert'
    })
  });
}

async function createComment(baseUrl: string, planId: string, versionId: string, body: string) {
  return requestJson<{ comment: { id: string; status: string } }>(`${baseUrl}/api/plans/${planId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      versionId,
      body,
      anchorType: 'dom',
      anchor: {
        planNodeId: 'fixture',
        cssSelector: '#fixture',
        textPreview: 'harness smoke',
        rect: { x: 0, y: 0, width: 100, height: 50 },
        viewport: { width: 800, height: 600 }
      }
    })
  });
}

async function ackComment(baseUrl: string, commentId: string, claimId: string, harness: string) {
  return requestJson<{ comment: { status: string } }>(`${baseUrl}/api/comments/${commentId}/ack`, {
    method: 'POST',
    body: JSON.stringify({ claimId, action: { responseSummary: `${harness} harness smoke acked` } })
  });
}

async function resolveComment(baseUrl: string, commentId: string, harness: string) {
  return requestJson<{ comment: { status: string } }>(`${baseUrl}/api/comments/${commentId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ resolutionNote: `${harness} harness smoke resolved` })
  });
}

function runAgentNext(baseUrl: string, planId: string, timeoutMs: number): Promise<{ payload: NextPayload; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [path.join(rootDir(), 'dist/cli.js'), 'agent', 'next', planId, '--wait', '--json', '--timeout', String(timeoutMs), '--url', baseUrl], {
    cwd: rootDir(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`agent next exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const payload = JSON.parse(stdout) as NextPayload;
        assert.equal(payload.status, 'claimed');
        resolve({ payload, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runSimulatedHarness(harness: string): Promise<HarnessEvidence> {
  const dbPath = `/tmp/plan-reviewer-harness-smoke-${process.pid}-${harness}.sqlite`;
  fs.rmSync(dbPath, { force: true });
  let app = createApp({ dbPath });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const ackResults: HarnessEvidence['ackResults'] = [];
  const resolveResults: HarnessEvidence['resolveResults'] = [];

  try {
    const { planId, versionId } = await register(baseUrl, harness);
    const first = await createComment(baseUrl, planId, versionId, `${harness} first comment`);
    const firstClaimStarted = Date.now();
    const firstNext = await runAgentNext(baseUrl, planId, 30000);
    const firstClaimLatencyMs = Date.now() - firstClaimStarted;
    assert.equal(firstNext.payload.commentId, first.comment.id);
    const firstAckStarted = Date.now();
    const firstAck = await ackComment(baseUrl, firstNext.payload.commentId, firstNext.payload.claimId, harness);
    const firstAckLatencyMs = Date.now() - firstAckStarted;
    ackResults.push({ commentId: firstNext.payload.commentId, status: firstAck.comment.status });
    const firstResolve = await resolveComment(baseUrl, firstNext.payload.commentId, harness);
    resolveResults.push({ commentId: firstNext.payload.commentId, status: firstResolve.comment.status });

    const secondNextPromise = runAgentNext(baseUrl, planId, 30000);
    await new Promise(resolve => setTimeout(resolve, 150));
    await app.close();
    app = createApp({ dbPath });
    await app.listen({ host: '127.0.0.1', port });
    const restartedAddress = app.server.address();
    if (!restartedAddress || typeof restartedAddress === 'string') throw new Error('restarted server did not bind to a TCP port');
    const restartedBaseUrl = `http://127.0.0.1:${restartedAddress.port}`;
    const second = await createComment(restartedBaseUrl, planId, versionId, `${harness} second comment`);
    const secondClaimStarted = Date.now();
    const secondNext = await secondNextPromise;
    const secondClaimLatencyMs = Date.now() - secondClaimStarted;
    assert.equal(secondNext.payload.commentId, second.comment.id);
    const secondAckStarted = Date.now();
    const secondAck = await ackComment(restartedBaseUrl, secondNext.payload.commentId, secondNext.payload.claimId, harness);
    const secondAckLatencyMs = Date.now() - secondAckStarted;
    ackResults.push({ commentId: secondNext.payload.commentId, status: secondAck.comment.status });
    const secondResolve = await resolveComment(restartedBaseUrl, secondNext.payload.commentId, harness);
    resolveResults.push({ commentId: secondNext.payload.commentId, status: secondResolve.comment.status });

    return {
      harness,
      mode: 'simulated',
      planId,
      serviceUrl: baseUrl,
      firstCommentId: first.comment.id,
      secondCommentId: second.comment.id,
      firstClaimLatencyMs,
      secondClaimLatencyMs,
      firstAckLatencyMs,
      secondAckLatencyMs,
      restartObserved: true,
      sameServiceUrlAfterRestart: restartedBaseUrl === baseUrl,
      listenerRestartedOrReconnected: true,
      ackResults,
      resolveResults,
      manualIntervention: false
    };
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
}

function commandExists(command: string): boolean {
  return spawnSync('zsh', ['-lc', `command -v -- ${shellQuote(command)}`], { encoding: 'utf8' }).status === 0;
}

function realHarnessRunnerScript(planId: string, serviceUrl: string): string {
  return `#!/usr/bin/env bash
set -u
PLAN_ID='${planId}'
SERVICE_URL='${serviceUrl}'
ACKED=0
RUN_JSON=''

run_json_retry() {
  label="$1"; shift
  while true; do
    printf '+ %s\\n' "$*"
    RUN_JSON="$($@ 2>&1)"
    rc=$?
    printf '%s\\n' "$RUN_JSON"
    if [ "$rc" -eq 0 ] && printf '%s' "$RUN_JSON" | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { JSON.parse(data); });' >/dev/null 2>&1; then
      return 0
    fi
    printf 'Command failed during %s; retrying the same service URL in 1s. Exit=%s\\n' "$label" "$rc"
    sleep 1
  done
}

json_field() {
  node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const parsed = JSON.parse(data); const path = process.argv[1].split("."); let value = parsed; for (const key of path) value = value?.[key]; if (value !== undefined && value !== null) process.stdout.write(String(value)); });' "$1"
}

while true; do
  run_json_retry drain node dist/cli.js agent next "$PLAN_ID" --no-wait --json --url "$SERVICE_URL"
  result_status=$(printf '%s' "$RUN_JSON" | json_field status)
  if [ "$result_status" = "empty" ]; then
    break
  fi
  comment_id=$(printf '%s' "$RUN_JSON" | json_field commentId)
  claim_id=$(printf '%s' "$RUN_JSON" | json_field claimId)
  if [ -n "$comment_id" ] && [ -n "$claim_id" ]; then
    run_json_retry ack node dist/cli.js ack "$comment_id" --claim "$claim_id" --summary 'harness smoke ack' --json --url "$SERVICE_URL"
    ACKED=$((ACKED + 1))
    run_json_retry resolve node dist/cli.js resolve "$comment_id" --note 'harness smoke resolved' --json --url "$SERVICE_URL"
  fi
  if [ "$ACKED" -ge 2 ]; then
    printf 'ACKED=%s\\n' "$ACKED"
    exit 0
  fi
done

while [ "$ACKED" -lt 2 ]; do
  run_json_retry wait node dist/cli.js agent next "$PLAN_ID" --wait --json --url "$SERVICE_URL"
  result_status=$(printf '%s' "$RUN_JSON" | json_field status)
  if [ "$result_status" = "empty" ]; then
    continue
  fi
  comment_id=$(printf '%s' "$RUN_JSON" | json_field commentId)
  claim_id=$(printf '%s' "$RUN_JSON" | json_field claimId)
  if [ -z "$comment_id" ] || [ -z "$claim_id" ]; then
    printf 'Claimed result missing commentId or claimId; continuing wait loop.\\n'
    continue
  fi
  run_json_retry ack node dist/cli.js ack "$comment_id" --claim "$claim_id" --summary 'harness smoke ack' --json --url "$SERVICE_URL"
  ACKED=$((ACKED + 1))
  run_json_retry resolve node dist/cli.js resolve "$comment_id" --note 'harness smoke resolved' --json --url "$SERVICE_URL"
done
printf 'ACKED=%s\\n' "$ACKED"
`;
}

function renderPrompt(planId: string, serviceUrl: string, runnerPath: string): string {
  const templatePath = path.join(rootDir(), 'src/test-fixtures/harness-smoke-prompt.md');
  return fs.readFileSync(templatePath, 'utf8')
    .replaceAll('{{PLAN_ID}}', planId)
    .replaceAll('{{SERVICE_URL}}', serviceUrl)
    .replaceAll('{{RUNNER_PATH}}', runnerPath);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function realHarnessCommand(harness: string, promptPath: string, outputPath: string): string {
  const repo = shellQuote(rootDir());
  const prompt = shellQuote(promptPath);
  const output = shellQuote(outputPath);
  if (harness === 'pi') {
    return `cd ${repo} && pi --no-session -p "$(cat ${prompt})" > ${output} 2>&1`;
  }
  if (harness === 'codex') {
    return `cd ${repo} && codex exec ${process.env.CODEX_HARNESS_FLAGS ?? `-m gpt-5.5 -c 'model_reasoning_effort="medium"'`} -s workspace-write -C ${repo} - < ${prompt} > ${output} 2>&1`;
  }
  if (harness === 'claude-code') {
    const launcherPath = `/tmp/plan-reviewer-harness-smoke-claude-code-launch-${process.pid}.sh`;
    fs.writeFileSync(launcherPath, `#!/usr/bin/env zsh
cd ${repo} || exit 1
claude -p "$(cat ${prompt})" > ${output} 2>&1
echo EXIT=$? >> ${output}
`, { mode: 0o755 });
    return `tmux new-window -t codex -n claude-smoke-${process.pid} ${shellQuote(launcherPath)}`;
  }
  throw new Error(`unknown harness: ${harness}`);
}

function launchRealHarness(harness: string, promptPath: string, outputPath: string) {
  const child = spawn('zsh', ['-lc', realHarnessCommand(harness, promptPath, outputPath)], {
    cwd: rootDir(),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let exitCode: number | null | undefined;
  const detachedLauncher = harness === 'claude-code';
  child.on('close', code => {
    if (!detachedLauncher || code !== 0) exitCode = code;
  });
  return {
    harness,
    get exitCode() {
      if (detachedLauncher && fs.existsSync(outputPath)) {
        const match = fs.readFileSync(outputPath, 'utf8').match(/EXIT=(\d+)/);
        if (match) return Number(match[1]);
      }
      return exitCode;
    },
    stderr: () => stderr,
    kill: () => child.kill('SIGTERM')
  };
}

async function commentStatus(baseUrl: string, planId: string, commentId: string): Promise<string | undefined> {
  const data = await requestJson<{ comments: Array<{ id: string; status: string }> }>(`${baseUrl}/api/plans/${planId}/comments`);
  return data.comments.find(comment => comment.id === commentId)?.status;
}

async function waitForClaim(baseUrl: string, planId: string, commentId: string, timeoutMs: number, harnessProcess: ReturnType<typeof launchRealHarness>) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await commentStatus(baseUrl, planId, commentId);
    if (status === 'claimed' || status === 'acknowledged' || status === 'resolved') return { status, latencyMs: Date.now() - started };
    if (harnessProcess.exitCode !== undefined && harnessProcess.exitCode !== null) {
      throw new Error(`${harnessProcess.harness} exited before claiming ${commentId}: ${harnessProcess.exitCode} ${harnessProcess.stderr()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${harnessProcess.harness} did not claim ${commentId} within ${timeoutMs}ms`);
}

async function waitForAck(baseUrl: string, planId: string, commentId: string, timeoutMs: number, harnessProcess: ReturnType<typeof launchRealHarness>) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await commentStatus(baseUrl, planId, commentId);
    if (status === 'acknowledged' || status === 'resolved') return { status, latencyMs: Date.now() - started };
    if (harnessProcess.exitCode !== undefined && harnessProcess.exitCode !== null) {
      throw new Error(`${harnessProcess.harness} exited before acking ${commentId}: ${harnessProcess.exitCode} ${harnessProcess.stderr()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${harnessProcess.harness} did not ack ${commentId} within ${timeoutMs}ms`);
}

async function runRealHarness(harness: string): Promise<HarnessEvidence> {
  const dbPath = `/tmp/plan-reviewer-real-harness-smoke-${process.pid}-${harness}.sqlite`;
  fs.rmSync(dbPath, { force: true });
  let app = createApp({ dbPath });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const promptPath = '/tmp/plan-reviewer-harness-smoke-prompt.md';
  const outputPath = `/tmp/plan-reviewer-harness-smoke-${harness}.out`;
  const runnerPath = `/tmp/plan-reviewer-harness-smoke-${harness}.sh`;
  let harnessProcess: ReturnType<typeof launchRealHarness> | undefined;

  try {
    const { planId, versionId } = await register(baseUrl, harness);
    fs.writeFileSync(runnerPath, realHarnessRunnerScript(planId, baseUrl), { mode: 0o755 });
    fs.writeFileSync(promptPath, renderPrompt(planId, baseUrl, runnerPath));
    fs.rmSync(outputPath, { force: true });
    harnessProcess = launchRealHarness(harness, promptPath, outputPath);

    const first = await createComment(baseUrl, planId, versionId, `${harness} real first comment`);
    const firstClaim = await waitForClaim(baseUrl, planId, first.comment.id, 60000, harnessProcess);
    const firstAck = await waitForAck(baseUrl, planId, first.comment.id, 180000, harnessProcess);

    await app.close();
    app = createApp({ dbPath });
    await app.listen({ host: '127.0.0.1', port });
    const restartedAddress = app.server.address();
    if (!restartedAddress || typeof restartedAddress === 'string') throw new Error('restarted server did not bind to a TCP port');
    const restartedBaseUrl = `http://127.0.0.1:${restartedAddress.port}`;

    const second = await createComment(restartedBaseUrl, planId, versionId, `${harness} real second comment`);
    const secondClaim = await waitForClaim(restartedBaseUrl, planId, second.comment.id, 60000, harnessProcess);
    const secondAck = await waitForAck(restartedBaseUrl, planId, second.comment.id, 180000, harnessProcess);
    const output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (/manual intervention required|manual intervention was required|please intervene manually/i.test(output)) {
      throw new Error(`${harness} requested manual intervention`);
    }

    return {
      harness,
      mode: 'real',
      planId,
      serviceUrl: baseUrl,
      firstCommentId: first.comment.id,
      secondCommentId: second.comment.id,
      firstClaimLatencyMs: firstClaim.latencyMs,
      secondClaimLatencyMs: secondClaim.latencyMs,
      firstAckLatencyMs: firstAck.latencyMs,
      secondAckLatencyMs: secondAck.latencyMs,
      restartObserved: true,
      sameServiceUrlAfterRestart: restartedBaseUrl === baseUrl,
      listenerRestartedOrReconnected: true,
      ackResults: [
        { commentId: first.comment.id, status: firstAck.status },
        { commentId: second.comment.id, status: secondAck.status }
      ],
      resolveResults: [],
      manualIntervention: false
    };
  } finally {
    harnessProcess?.kill();
    await app.close().catch(() => undefined);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
}

async function runRealHarnesses(options: HarnessSmokeOptions): Promise<HarnessEvidence[]> {
  const allowedHarnesses = new Set(['pi', 'codex', 'claude-code']);
  const unsupported = options.harnesses.filter(harness => !allowedHarnesses.has(harness));
  if (unsupported.length > 0) {
    throw new Error(`unsupported_harness: ${unsupported.join(', ')}`);
  }
  const missing = options.harnesses.filter(harness => {
    if (harness === 'claude-code') return !commandExists('claude') || !commandExists('tmux');
    return !commandExists(harness);
  });
  if (missing.length > 0) {
    throw new Error(`precondition_missing: real harness command(s) unavailable: ${missing.join(', ')}`);
  }
  const evidence: HarnessEvidence[] = [];
  for (const harness of options.harnesses) {
    evidence.push(await runRealHarness(harness));
  }
  return evidence;
}

export async function runHarnessSmoke(options: HarnessSmokeOptions): Promise<HarnessEvidence[]> {
  const evidence = options.mode === 'real'
    ? await runRealHarnesses(options)
    : await Promise.all(options.harnesses.map(runSimulatedHarness));
  if (options.evidencePath) {
    fs.mkdirSync(path.dirname(options.evidencePath), { recursive: true });
    fs.writeFileSync(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return evidence;
}
