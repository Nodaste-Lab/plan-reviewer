import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { claimCommentsSchema, createCommentSchema, planPullRequestSchema, registerPlanSchema } from '../schemas.js';
import { renderPlan } from '../render/render.js';
import { normalizeLinearIssueKey, PlanReviewStore } from '../storage/database.js';
import { createApp } from '../server/app.js';
import { SourceSyncService } from '../server/sourceSync.js';
import { findImageSources } from '../htmlImages.js';
import { resolveServiceUrl } from '../config.js';
import { discoverImageAssets } from '../cli.js';
import { discoverPullRequest, parseGitHubPrUrl, pullRequestStatus } from '../githubPr.js';
import { buildRegistrationAgentInstructions, renderRegistrationInstructionCommands } from '../registrationInstructions.js';
import { buildAgentNextClaimed, buildAgentNextEmpty } from '../agentNext.js';
import { sha256 } from '../util.js';
import { domAnchor, registeredApp, sampleHtml, sampleRegisterPayload, tempDbPath } from './helpers.js';

test('schemas validate locked registration, comment, and claim contracts', () => {
  const register = registerPlanSchema.parse(sampleRegisterPayload());
  assert.equal(register.updateMode, 'upsert');
  assert.equal(register.publicationMetadata.executionReadyBasis, 'agent-review-results');
  assert.throws(
    () => registerPlanSchema.parse(sampleRegisterPayload({ publicationMetadata: undefined })),
    /publicationMetadata/
  );
  assert.throws(
    () => registerPlanSchema.parse(sampleRegisterPayload({ publicationMetadata: { ...register.publicationMetadata, branch: 'other' } })),
    /publicationMetadata.branch must match branch/
  );
  assert.throws(
    () => registerPlanSchema.parse(sampleRegisterPayload({ watchMode: 'filesystem' })),
    /sourcePath is required/
  );

  const comment = createCommentSchema.parse({
    versionId: 'ver_1',
    body: 'This section needs more acceptance detail.',
    anchorType: 'dom',
    anchor: domAnchor(),
    createdBy: { displayName: '' }
  });
  assert.equal(comment.anchorType, 'dom');

  assert.equal(claimCommentsSchema.parse({ mode: 'one' }).leaseSeconds, 300);
  assert.throws(() => claimCommentsSchema.parse({ mode: 'bulk', limit: 0 }));
});

test('PR schema, URL parsing, stale derivation, and adversarial GitHub discovery are locked', async () => {
  const pullRequest = planPullRequestSchema.parse({
    provider: 'github',
    url: 'https://github.com/demo/sample/pull/12',
    owner: 'demo',
    repo: 'sample',
    number: 12,
    headRef: 'feature/x',
    headRepo: 'demo/sample',
    baseRef: 'main',
    state: 'closed',
    merged: false,
    lastCheckedAt: new Date().toISOString(),
    source: 'explicit'
  });
  assert.equal(pullRequestStatus(pullRequest), 'closed');
  assert.equal(pullRequestStatus({ ...pullRequest, state: 'closed', merged: true, lastCheckedAt: '2000-01-01T00:00:00.000Z' }), 'merged');
  assert.equal(pullRequestStatus({ ...pullRequest, state: 'open', merged: false, lastCheckedAt: '2000-01-01T00:00:00.000Z' }), 'stale');
  assert.equal(pullRequestStatus({ ...pullRequest, state: 'unknown', merged: false, lastCheckedAt: undefined }), 'stale');
  assert.deepEqual(parseGitHubPrUrl('https://github.com/demo/sample/pull/12'), { owner: 'demo', repo: 'sample', number: 12, url: 'https://github.com/demo/sample/pull/12' });
  assert.throws(() => parseGitHubPrUrl('https://github.com.evil/demo/sample/pull/12'), /canonical GitHub PR URL/);
  assert.throws(() => planPullRequestSchema.parse({ ...pullRequest, merged: true }), /mergedAt is required/);

  const wrongRepoFetch = async () => new Response(JSON.stringify([
    { html_url: 'https://github.com/other/sample/pull/9', number: 9, state: 'open', head: { ref: 'feature/x', repo: { full_name: 'other/sample' } }, base: { ref: 'main' } }
  ]), { status: 200 });
  await assert.rejects(
    () => discoverPullRequest({ owner: 'demo', repo: 'sample' }, 'feature/x', { fetchImpl: wrongRepoFetch, token: 't' }),
    /No GitHub PR matched/
  );

  const ambiguousFetch = async () => new Response(JSON.stringify([
    { html_url: 'https://github.com/demo/sample/pull/1', number: 1, state: 'open', head: { ref: 'feature/x', repo: { full_name: 'demo/sample' } }, base: { ref: 'main' } },
    { html_url: 'https://github.com/demo/sample/pull/2', number: 2, state: 'open', head: { ref: 'feature/x', repo: { full_name: 'demo/sample' } }, base: { ref: 'main' } }
  ]), { status: 200 });
  await assert.rejects(
    () => discoverPullRequest({ owner: 'demo', repo: 'sample' }, 'feature/x', { fetchImpl: ambiguousFetch, token: 't' }),
    /Multiple GitHub PRs matched/
  );
});

test('Linear issue detection normalizes only NOD numeric keys', () => {
  assert.equal(normalizeLinearIssueKey('nod-123'), 'NOD-123');
  assert.equal(normalizeLinearIssueKey('NOD-ABC', '<p>see nod-456</p>'), 'NOD-456');
  assert.equal(normalizeLinearIssueKey('NOD-', 'NOD-ABC'), undefined);
});

test('registered plans expose normalized Linear links from metadata or non-code HTML text only', async () => {
  const app = createApp({ dbPath: tempDbPath('linear-detection') });
  try {
    const baseMetadata = { worktreePath: '/tmp/sample', branch: 'main', executionReady: false, executionReadyBasis: 'agent-review-results' as const };
    const falsePositive = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        slug: 'linear-code-sample',
        planPath: 'thoughts/plans/linear-code-sample.html',
        html: '<!doctype html><html><body><p>No issue.</p><code>NOD-999</code><pre>nod-888</pre></body></html>',
        fileHash: 'linear-code-sample',
        publicationMetadata: baseMetadata
      })
    });
    assert.equal(falsePositive.statusCode, 200);
    const falsePositivePlan = await app.inject({ method: 'GET', url: `/api/plans/${falsePositive.json().data.planId}` });
    assert.equal(falsePositivePlan.json().data.plan.linearIssueKey, undefined);

    const detected = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        slug: 'linear-text',
        planPath: 'thoughts/plans/linear-text.html',
        html: '<!doctype html><html><body><p>Tracks nod-456 in Linear.</p></body></html>',
        fileHash: 'linear-text',
        publicationMetadata: baseMetadata
      })
    });
    assert.equal(detected.statusCode, 200);
    const detectedPlan = await app.inject({ method: 'GET', url: `/api/plans/${detected.json().data.planId}` });
    assert.equal(detectedPlan.json().data.plan.linearIssueKey, 'NOD-456');
    assert.equal(detectedPlan.json().data.plan.linearIssueUrl, 'https://linear.app/nodaste/issue/NOD-456');
  } finally {
    await app.close();
  }
});

test('PR persistence API exposes one current PR and clear behavior', async () => {
  const { app, planId } = await registeredApp('pr-persistence');
  try {
    const payload = planPullRequestSchema.parse({
      provider: 'github',
      url: 'https://github.com/demo/sample/pull/12',
      owner: 'demo',
      repo: 'sample',
      number: 12,
      headRef: 'feature/x',
      headRepo: 'demo/sample',
      baseRef: 'main',
      state: 'open',
      merged: false,
      lastCheckedAt: new Date().toISOString(),
      source: 'explicit'
    });
    const put = await app.inject({ method: 'PUT', url: `/api/plans/${planId}/pull-request`, payload });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().data.pullRequest.status, 'open');

    const replacement = { ...payload, url: 'https://github.com/demo/sample/pull/13', number: 13, state: 'closed' as const, lastCheckedAt: '2000-01-01T00:00:00.000Z' };
    const putAgain = await app.inject({ method: 'PUT', url: `/api/plans/${planId}/pull-request`, payload: replacement });
    assert.equal(putAgain.statusCode, 200);
    assert.equal(putAgain.json().data.pullRequest.number, 13);
    assert.equal(putAgain.json().data.pullRequest.status, 'closed');

    const get = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(get.json().data.plan.pullRequest.number, 13);
    const list = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(list.json().data.plans[0].plan.pullRequest.number, 13);
    assert.equal((await app.inject({ method: 'GET', url: '/api/plans?q=PR%20closed' })).json().data.plans.length, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/api/plans?q=unmerged' })).json().data.plans.length, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/api/plans?q=merged' })).json().data.plans.length, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/api/plans?q=https%3A%2F%2Fgithub.com%2Fdemo%2Fsample%2Fpull%2F13' })).json().data.plans.length, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/api/plans?q=NOD-123' })).json().data.plans.length, 1);

    const del = await app.inject({ method: 'DELETE', url: `/api/plans/${planId}/pull-request` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().data.pullRequest, null);
    const after = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(after.json().data.plan.pullRequest, null);
  } finally {
    await app.close();
  }
});

test('agent next helpers build locked empty and claimed contracts', () => {
  assert.deepEqual(buildAgentNextEmpty('plan_abc'), {
    type: 'plan-review.agent.next.v1',
    status: 'empty',
    planId: 'plan_abc'
  });

  const claimed = buildAgentNextClaimed({
    planId: 'plan_abc',
    commentId: 'cmt_abc',
    claimId: 'claim_abc',
    serviceUrl: 'http://reviewer.example:4317',
    conversationPayload: { type: 'browser.comment.v1', evidence: { reviewUrl: 'http://reviewer.example:4317/p/plan_abc' } }
  });
  assert.equal(claimed.type, 'plan-review.agent.next.v1');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.commentId, 'cmt_abc');
  assert.equal(claimed.claimId, 'claim_abc');
  assert.equal(claimed.conversationPayload.type, 'browser.comment.v1');
  assert.match(claimed.ackCommand, /plan-review ack cmt_abc --claim claim_abc/);
  assert.match(claimed.resolveCommand, /plan-review resolve cmt_abc --note "Done"/);
  assert.equal(claimed.resolveAfterAck, true);
});

test('registration instruction helper builds canonical agent-next guidance and rendered commands', () => {
  const instructions = buildRegistrationAgentInstructions({ planId: 'plan_abc', reviewUrl: '/p/plan_abc' });
  assert.equal(instructions.type, 'plan-review.registration.instructions.v1');
  assert.equal(instructions.required, true);
  assert.match(instructions.summary, /queue-backed agent next/);
  assert.match(instructions.nextAction, /Drain pending comments/);
  assert.match(instructions.nextAction, /process and ack it before starting another listener/);
  assert.equal(instructions.serviceUrlRequired, true);
  assert.match(instructions.serviceUrlInstruction, /optional watch command is debug-only/);
  assert.equal(instructions.reviewUrl, '/p/plan_abc');
  assert.equal(instructions.preferredCommand, 'plan-review agent next plan_abc --wait --json');
  assert.equal(instructions.drainCommand, 'plan-review agent next plan_abc --no-wait --json');
  assert.equal(instructions.listenCommand, instructions.preferredCommand);
  assert.equal(instructions.optionalWatchCommand, 'plan-review watch plan_abc --mode queue --format browser-comment --json');
  assert.match(instructions.durableCommand, /until plan-review agent next plan_abc --wait --json; do sleep 1; done/);
  assert.equal(instructions.referenceImplementations.length, 3);
  assert.equal(instructions.referenceImplementations[0].tool, 'process');
  assert.equal(instructions.referenceImplementations[0].command, instructions.preferredCommand);
  assert.equal(instructions.referenceImplementations[1].tool, 'shell-loop');
  assert.equal(instructions.referenceImplementations[1].command, instructions.durableCommand);
  assert.equal(instructions.referenceImplementations[2].command, instructions.optionalWatchCommand);
  assert.match(instructions.processingLoop.join('\n'), /browser\.comment\.v1/);
  assert.match(instructions.processingLoop.join('\n'), /commentId and claimId/);
  assert.match(instructions.processingLoop.join('\n'), /exits successfully after exactly one claim/);
  assert.match(instructions.processingLoop.join('\n'), /do not blindly loop successful claim commands/);
  assert.match(instructions.processingLoop.join('\n'), /plan-review ack <commentId> --claim <claimId> --summary/);
  assert.match(instructions.processingLoop.join('\n'), /Resolve only after a successful ack/);
  assert.match(instructions.processingLoop.join('\n'), /plan-review pr link plan_abc --url <github-pr-url> --json/);
  assert.match(instructions.processingLoop.join('\n'), /plan-review pr refresh plan_abc --json/);
  assert.match(instructions.processingLoop.join('\n'), /plan-review watch only as an optional/);

  const rendered = renderRegistrationInstructionCommands(instructions, 'http://reviewer.example:4317');
  assert.equal(rendered.preferredCommand, 'plan-review agent next plan_abc --wait --json --url http://reviewer.example:4317');
  assert.equal(rendered.drainCommand, 'plan-review agent next plan_abc --no-wait --json --url http://reviewer.example:4317');
  assert.equal(rendered.listenCommand, rendered.preferredCommand);
  assert.equal(rendered.optionalWatchCommand, 'plan-review watch plan_abc --mode queue --format browser-comment --json --url http://reviewer.example:4317');
  assert.match(rendered.durableCommand, /until plan-review agent next plan_abc --wait --json --url http:\/\/reviewer\.example:4317; do sleep 1; done/);
  assert.equal(rendered.referenceImplementations[0].command, rendered.preferredCommand);
  assert.equal(rendered.referenceImplementations[1].command, rendered.durableCommand);
});

test('registration API returns agent instructions additively across registration variants', async () => {
  const app = createApp({ dbPath: tempDbPath('registration-instructions') });
  try {
    const snapshot = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ watchMode: 'snapshot' })
    });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().ok, true);
    const snapshotData = snapshot.json().data;
    assert.equal(snapshotData.agentInstructions.type, 'plan-review.registration.instructions.v1');
    assert.equal(snapshotData.agentInstructions.required, true);
    assert.match(snapshotData.agentInstructions.summary, /queue-backed agent next/);
    assert.match(snapshotData.agentInstructions.nextAction, /Drain pending comments/);
    assert.equal(snapshotData.agentInstructions.serviceUrlRequired, true);
    assert.match(snapshotData.agentInstructions.serviceUrlInstruction, /debug-only/);
    assert.match(snapshotData.agentInstructions.preferredCommand, /agent next .* --wait --json/);
    assert.match(snapshotData.agentInstructions.drainCommand, /agent next .* --no-wait --json/);
    assert.doesNotMatch(snapshotData.agentInstructions.preferredCommand, /--url/);
    assert.equal(snapshotData.agentInstructions.reviewUrl, snapshotData.reviewUrl);
    assert.equal(snapshotData.watchCommand, `plan-review watch ${snapshotData.planId} --mode queue`);
    assert.equal(snapshotData.sourceSync.watchMode, 'snapshot');
    assert.equal(snapshotData.publicationMetadata.worktreePath, '/tmp/sample');
    assert.equal(snapshotData.publicationMetadata.executionReadyBasis, 'agent-review-results');
    assert.equal(Object.prototype.hasOwnProperty.call(snapshotData.sourceSync, 'error'), true);
    assert.equal(snapshotData.renderedWithWarnings[0].code, 'blocked_script');
    assert.equal(typeof snapshotData.versionId, 'string');
    assert.equal(typeof snapshotData.repoId, 'string');

    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-registration-instructions-'));
    const sourcePath = path.join(sourceRoot, 'thoughts/plans/sample-plan.html');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, sampleHtml());
    const filesystem = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        rootPath: sourceRoot,
        planPath: 'thoughts/plans/sample-plan.html',
        watchMode: 'filesystem',
        sourcePath,
        sourceMtimeMs: 1,
        sourceSize: 10,
        fileHash: 'filesystem-instructions'
      })
    });
    assert.equal(filesystem.statusCode, 200);
    const filesystemData = filesystem.json().data;
    assert.equal(filesystemData.agentInstructions.planId, filesystemData.planId);
    assert.equal(filesystemData.sourceSync.watchMode, 'filesystem');
    assert.equal(filesystemData.sourceSync.sourcePath, sourcePath);
    assert.equal(filesystemData.sourceSync.active, true);

    const reregister = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        rootPath: sourceRoot,
        planPath: 'thoughts/plans/sample-plan.html',
        watchMode: 'filesystem',
        sourcePath,
        sourceMtimeMs: 2,
        sourceSize: 11,
        fileHash: 'filesystem-instructions-reregister'
      })
    });
    assert.equal(reregister.statusCode, 200);
    const reregisterData = reregister.json().data;
    assert.equal(reregisterData.planId, filesystemData.planId);
    assert.equal(reregisterData.agentInstructions.planId, reregisterData.planId);
    assert.match(reregisterData.agentInstructions.durableCommand, /until plan-review agent next/);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: { ...sampleRegisterPayload(), html: '' }
    });
    assert.notEqual(invalid.statusCode, 200);
    assert.equal(invalid.json().ok, false);
    assert.equal(invalid.json().data?.agentInstructions, undefined);
    assert.equal(JSON.stringify(invalid.json()).includes('REQUIRED NEXT ACTION:'), false);
  } finally {
    await app.close();
  }
});

test('renderer strips active content, rewrites images, and adds deterministic node ids', () => {
  const output = renderPlan(sampleRegisterPayload());

  assert.equal(output.warnings.some(item => item.code === 'blocked_script'), true);
  assert.equal(output.renderedHtml.includes('<script>'), false);
  assert.match(output.renderedHtml, /<style[^>]*>body\{color:white\}<\/style>/);
  assert.match(output.renderedHtml, /<title[^>]*>Sample Plan<\/title>/);
  assert.equal(output.renderedHtml.includes('src="/assets/'), true);
  assert.equal(output.renderedHtml.includes('data-plan-image-hash='), true);
  assert.equal(output.renderedHtml.includes('data-plan-node-id="phase-p1"'), true);

  const repeated = renderPlan(sampleRegisterPayload({ html: sampleHtml() }));
  assert.equal(output.renderedHtml, repeated.renderedHtml);

  const external = renderPlan(sampleRegisterPayload({
    html: '<!doctype html><html><body><img src="https://example.com/track.png" alt="external"></body></html>'
  }));
  assert.equal(external.warnings.some(item => item.code === 'blocked_external_image'), true);
  assert.equal(external.renderedHtml.includes('src="https://example.com/track.png"'), false);

  const unquotedImage = renderPlan(sampleRegisterPayload({
    html: '<!doctype html><html><body><img src=diagram.png alt=Diagram></body></html>',
    fileHash: 'unquoted-image'
  }));
  assert.equal(unquotedImage.renderedHtml.includes('src="/assets/'), true);
  assert.equal(unquotedImage.renderedHtml.includes('data-plan-image-source="diagram.png"'), true);
  assert.deepEqual(findImageSources('<img src=diagram.png><img src="./two.png"><img alt=x src=\'three.png\'><img data-src="placeholder.png" alt="preview src=placeholder.png > ok" src="actual.png">'), [
    'diagram.png',
    './two.png',
    'three.png',
    'actual.png'
  ]);

  const lazyImage = renderPlan(sampleRegisterPayload({
    html: '<!doctype html><html><body><img data-src="placeholder.png" alt="lazy preview src=placeholder.png" src="diagram.png"></body></html>',
    fileHash: 'lazy-image'
  }));
  assert.equal(lazyImage.renderedHtml.includes('data-src="placeholder.png"'), true);
  assert.equal(lazyImage.renderedHtml.includes('alt="lazy preview src=placeholder.png"'), true);
  assert.equal(lazyImage.renderedHtml.includes('data-plan-image-source="diagram.png"'), true);

  const quotedAttributeImage = renderPlan(sampleRegisterPayload({
    html: '<!doctype html><html><body><img alt=\'preview src="diagram.png" > still attribute\' src="diagram.png"></body></html>',
    fileHash: 'quoted-attribute-image'
  }));
  assert.equal(quotedAttributeImage.renderedHtml.includes('data-plan-image-source="diagram.png"'), true);
  assert.equal(quotedAttributeImage.renderedHtml.includes('alt="preview src=&quot;/assets/'), false);

  const unsafeLink = renderPlan(sampleRegisterPayload({
    html: '<!doctype html><html><body><a href="data:text/html,bad">bad link</a><img src="data:image/png;base64,abc" alt="inline"></body></html>'
  }));
  assert.equal(unsafeLink.renderedHtml.includes('href="data:text/html,bad"'), false);
  assert.equal(unsafeLink.renderedHtml.includes('src="data:image/png;base64,abc"'), true);

  assert.throws(
    () => renderPlan(sampleRegisterPayload({ html: '<!doctype html><html><body><div id="x" id="y"></div></body></html>', fileHash: 'invalid-html' })),
    /Plan HTML could not be parsed safely/
  );
});

test('registration upserts by default and creates a distinct plan for new-thread', async () => {
  const { app } = await registeredApp('new-thread');
  try {
    const upsert = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload()
    });
    assert.equal(upsert.statusCode, 200);

    const newThread = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ updateMode: 'new-thread' })
    });
    assert.equal(newThread.statusCode, 200);

    const plans = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(plans.statusCode, 200);
    assert.equal(plans.json().data.plans.length, 2);
    assert.notEqual(newThread.json().data.planId, upsert.json().data.planId);
  } finally {
    await app.close();
  }
});

test('index exposes phase progress and archive hides plans by default', async () => {
  const app = createApp({ dbPath: tempDbPath('archive-progress') });
  const html = `<!doctype html><html><body><section id="progress"><h2>Progress</h2><ul>
    <li><input type="checkbox" checked /> P1 - Done</li>
    <li><input type="checkbox" /> P2 - Pending</li>
    <li><input type="checkbox" checked /> P3 - Done</li>
  </ul></section></body></html>`;
  try {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html, fileHash: sha256(html) })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;

    const apiIndex = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(apiIndex.statusCode, 200);
    assert.equal(apiIndex.json().data.plans[0].progress.totalPhases, 3);
    assert.equal(apiIndex.json().data.plans[0].progress.completedPhases, 2);
    assert.equal(apiIndex.json().data.plans[0].plan.publicationMetadata.worktreePath, '/tmp/sample');
    assert.equal(apiIndex.json().data.plans[0].plan.publicationMetadata.branch, 'main');
    assert.equal(apiIndex.json().data.plans[0].plan.publicationMetadata.linearIssue, 'NOD-123');
    assert.equal(apiIndex.json().data.plans[0].plan.publicationMetadata.executionReady, false);

    const htmlIndex = await app.inject({ method: 'GET', url: '/' });
    assert.equal(htmlIndex.statusCode, 200);
    assert.match(htmlIndex.body, /2 of 3 phases complete/);
    assert.match(htmlIndex.body, /\/tmp\/sample\/thoughts\/plans\/sample-plan\.html/);
    assert.match(htmlIndex.body, /Worktree/);
    assert.match(htmlIndex.body, /NOD-123/);
    assert.match(htmlIndex.body, /Execution ready/);
    assert.match(htmlIndex.body, /data-archive-plan=/);
    assert.match(htmlIndex.body, /<div class="plan-actions"><span class="status-pill">Incomplete<\/span><button class="archive-plan"/);
    assert.match(htmlIndex.body, /<p class="comment-counts"><span class="row-label">Comments<\/span> pending 0 · claimed 0 · acknowledged 0 · resolved 0<\/p>/);
    assert.match(htmlIndex.body, /<p class="timestamp-row"><span class="row-label">Last updated<\/span> <time datetime="[^"]+" data-local-timestamp>/);
    assert.match(htmlIndex.body, /Intl\.DateTimeFormat\(undefined,\{dateStyle:'medium',timeStyle:'short'\}\)/);
    assert.doesNotMatch(htmlIndex.body, /Branch <code>main<\/code> · pending/);

    const archived = await app.inject({ method: 'POST', url: `/api/plans/${planId}/archive` });
    assert.equal(archived.statusCode, 200);
    assert.ok(archived.json().data.plan.archivedAt);

    const hidden = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(hidden.json().data.plans.length, 0);

    const included = await app.inject({ method: 'GET', url: '/api/plans?includeArchived=true' });
    assert.equal(included.json().data.plans.length, 1);
    assert.ok(included.json().data.plans[0].plan.archivedAt);

    const restored = await app.inject({ method: 'POST', url: `/api/plans/${planId}/unarchive` });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().data.plan.archivedAt, undefined);

    const restoredAgain = await app.inject({ method: 'POST', url: `/api/plans/${planId}/unarchive` });
    assert.equal(restoredAgain.statusCode, 200);
    assert.equal(restoredAgain.json().data.plan.archivedAt, undefined);

    const visibleAgain = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(visibleAgain.json().data.plans.length, 1);
    assert.equal(visibleAgain.json().data.plans[0].plan.archivedAt, undefined);
  } finally {
    await app.close();
  }
});

test('index prioritizes started plan progress from most complete to least complete', async () => {
  const app = createApp({ dbPath: tempDbPath('index-progress-order') });
  const progressPlan = (slug: string, completed: number, repoName = 'sample', total = 4) => {
    const items = Array.from({ length: total }, (_, index) => {
      const checked = index < completed ? ' checked' : '';
      return `<li><input type="checkbox"${checked} /> P${index + 1} - ${checked ? 'Done' : 'Pending'}</li>`;
    }).join('\n');
    const html = `<!doctype html><html><body><section id="progress"><h2>Progress</h2><ul>${items}</ul></section></body></html>`;
    return sampleRegisterPayload({
      repoKey: `git@example.com:demo/${repoName}.git`,
      repoName,
      remoteUrl: `git@example.com:demo/${repoName}.git`,
      rootPath: `/tmp/${repoName}`,
      slug,
      planPath: `thoughts/plans/${slug}.html`,
      html,
      fileHash: sha256(html)
    });
  };
  try {
    for (const payload of [
      progressPlan('quarter-complete-plan', 1),
      progressPlan('mostly-complete-plan', 3, 'other'),
      progressPlan('done-plan', 4),
      progressPlan('not-started-plan', 0, 'third')
    ]) {
      const registered = await app.inject({ method: 'POST', url: '/api/plans/register', payload });
      assert.equal(registered.statusCode, 200);
    }

    const htmlIndex = await app.inject({ method: 'GET', url: '/' });
    assert.equal(htmlIndex.statusCode, 200);
    const positions = ['done-plan', 'mostly-complete-plan', 'quarter-complete-plan', 'not-started-plan'].map(slug => htmlIndex.body.indexOf(slug));
    assert.deepEqual(positions.map(position => position >= 0), [true, true, true, true]);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);

    const apiIndex = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.deepEqual(
      apiIndex.json().data.plans.map((item: { plan: { slug: string } }) => item.plan.slug),
      ['done-plan', 'mostly-complete-plan', 'quarter-complete-plan', 'not-started-plan']
    );
  } finally {
    await app.close();
  }
});

test('index uses plan source modified time instead of comment activity', async () => {
  const app = createApp({ dbPath: tempDbPath('index-modified-time') });
  const olderMtime = Date.UTC(2024, 0, 2, 3, 4, 5);
  const newerMtime = Date.UTC(2024, 5, 6, 7, 8, 9);
  try {
    const older = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        slug: 'older-modified-plan',
        planPath: 'thoughts/plans/older-modified-plan.html',
        fileHash: 'older-modified-hash',
        sourceMtimeMs: olderMtime
      })
    });
    assert.equal(older.statusCode, 200);
    const newer = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        slug: 'newer-modified-plan',
        planPath: 'thoughts/plans/newer-modified-plan.html',
        fileHash: 'newer-modified-hash',
        sourceMtimeMs: newerMtime
      })
    });
    assert.equal(newer.statusCode, 200);
    const invalidMtime = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        slug: 'invalid-mtime-plan',
        planPath: 'thoughts/plans/invalid-mtime-plan.html',
        fileHash: 'invalid-mtime-hash',
        sourceMtimeMs: Number.MAX_VALUE
      })
    });
    assert.equal(invalidMtime.statusCode, 200);

    const olderData = older.json().data as { planId: string; versionId: string };
    const comment = await app.inject({
      method: 'POST',
      url: `/api/plans/${olderData.planId}/comments`,
      payload: {
        versionId: olderData.versionId,
        body: 'This comment should not change the modified timestamp.',
        anchorType: 'dom',
        anchor: domAnchor(),
        createdBy: { displayName: 'Reviewer' }
      }
    });
    assert.equal(comment.statusCode, 200);

    const apiIndex = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(apiIndex.statusCode, 200);
    const olderPlan = apiIndex.json().data.plans.find((item: { plan: { slug: string } }) => item.plan.slug === 'older-modified-plan');
    const invalidPlan = apiIndex.json().data.plans.find((item: { plan: { slug: string } }) => item.plan.slug === 'invalid-mtime-plan');
    assert.equal(olderPlan.modifiedAt, new Date(olderMtime).toISOString());
    assert.notEqual(olderPlan.modifiedAt, olderPlan.activityAt);
    assert.match(invalidPlan.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);

    const htmlIndex = await app.inject({ method: 'GET', url: '/' });
    assert.match(htmlIndex.body, new RegExp(`<time datetime="${new Date(olderMtime).toISOString()}" data-local-timestamp>`));
    assert.match(htmlIndex.body, new RegExp(`<time datetime="${new Date(newerMtime).toISOString()}" data-local-timestamp>`));
  } finally {
    await app.close();
  }
});

test('index makes failed filesystem source sync obvious before opening a plan', async () => {
  const app = createApp({ dbPath: tempDbPath('index-source-health') });
  const sourcePath = path.join(os.tmpdir(), `plan-review-index-missing-${process.pid}.html`);
  const html = `<!doctype html><html><body><section id="progress"><h2>Progress</h2><ul>
    <li><input type="checkbox" checked /> P1 - Done</li>
    <li><input type="checkbox" checked /> P2 - Done</li>
  </ul></section></body></html>`;
  try {
    fs.rmSync(sourcePath, { force: true });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        slug: 'missing-source-plan',
        planPath: 'thoughts/plans/missing-source-plan.html',
        html,
        fileHash: sha256(html),
        sourcePath,
        sourceMtimeMs: 0,
        sourceSize: 0,
        watchMode: 'filesystem'
      })
    });
    assert.equal(registered.statusCode, 200);
    assert.equal(registered.json().data.sourceSync.status, 'failed');

    const index = await app.inject({ method: 'GET', url: '/' });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /1 plan · source file missing/);
    assert.match(index.body, /data-attention-filter/);
    assert.match(index.body, /data-needs-attention="true"/);
    assert.match(index.body, /status-pill attention/);
    assert.match(index.body, /Source missing/);
    assert.match(index.body, /Showing cached copy/);
    assert.match(index.body, /plan-review register thoughts\/plans\/missing-source-plan\.html/);
    assert.match(index.body, /2 of 2 phases complete/);
    assert.doesNotMatch(index.body, /class="plan-card complete"[^>]*data-needs-attention="true"/);
    assert.match(index.body, /attentionOnly/);
  } finally {
    await app.close();
  }
});

test('archive page keeps archived context while noting failed source sync', async () => {
  const app = createApp({ dbPath: tempDbPath('archive-source-health') });
  const sourcePath = path.join(os.tmpdir(), `plan-review-archive-missing-${process.pid}.html`);
  try {
    fs.rmSync(sourcePath, { force: true });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        slug: 'archived-missing-source',
        planPath: 'thoughts/plans/archived-missing-source.html',
        sourcePath,
        sourceMtimeMs: 0,
        sourceSize: 0,
        watchMode: 'filesystem'
      })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;
    assert.equal((await app.inject({ method: 'POST', url: `/api/plans/${planId}/archive` })).statusCode, 200);

    const index = await app.inject({ method: 'GET', url: '/' });
    assert.doesNotMatch(index.body, /archived-missing-source/);

    const archive = await app.inject({ method: 'GET', url: '/archive' });
    assert.equal(archive.statusCode, 200);
    assert.match(archive.body, /Archived Plans/);
    assert.match(archive.body, /archived-missing-source/);
    assert.match(archive.body, /Archived /);
    assert.match(archive.body, /Source unavailable/);
    assert.match(archive.body, /thoughts\/plans\/archived-missing-source\.html/);
  } finally {
    await app.close();
  }
});

test('archive page renders archived plans and restore controls without mixing active plans', async () => {
  const app = createApp({ dbPath: tempDbPath('archive-page') });
  try {
    const active = await app.inject({ method: 'POST', url: '/api/plans/register', payload: sampleRegisterPayload({ slug: 'active-plan', planPath: 'thoughts/plans/active.html', fileHash: 'active-hash' }) });
    assert.equal(active.statusCode, 200);
    const older = await app.inject({ method: 'POST', url: '/api/plans/register', payload: sampleRegisterPayload({ slug: 'older-archive', planPath: 'thoughts/plans/older.html', fileHash: 'older-hash' }) });
    assert.equal(older.statusCode, 200);
    const newer = await app.inject({ method: 'POST', url: '/api/plans/register', payload: sampleRegisterPayload({ slug: 'newer-archive', planPath: 'thoughts/plans/newer.html', fileHash: 'newer-hash' }) });
    assert.equal(newer.statusCode, 200);

    const olderId = older.json().data.planId;
    const newerId = newer.json().data.planId;
    assert.equal((await app.inject({ method: 'POST', url: `/api/plans/${olderId}/archive` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/plans/${newerId}/archive` })).statusCode, 200);

    const index = await app.inject({ method: 'GET', url: '/' });
    assert.match(index.body, /Archived \(2\) →/);
    assert.match(index.body, /active-plan/);
    assert.doesNotMatch(index.body, /older-archive/);
    assert.doesNotMatch(index.body, /newer-archive/);

    const archive = await app.inject({ method: 'GET', url: '/archive' });
    assert.equal(archive.statusCode, 200);
    assert.match(archive.body, /Archived Plans/);
    assert.match(archive.body, /newer-archive/);
    assert.match(archive.body, /older-archive/);
    assert.doesNotMatch(archive.body, /active-plan/);
    assert.match(archive.body, /data-restore-plan=/);
    assert.match(archive.body, /No archived plans match the current filters/);
    assert.equal(archive.body.indexOf('newer-archive') < archive.body.indexOf('older-archive'), true);

    const restored = await app.inject({ method: 'POST', url: `/api/plans/${newerId}/unarchive` });
    assert.equal(restored.statusCode, 200);
    const postRestoreIndex = await app.inject({ method: 'GET', url: '/' });
    assert.match(postRestoreIndex.body, /newer-archive/);
    const postRestoreArchive = await app.inject({ method: 'GET', url: '/archive' });
    assert.doesNotMatch(postRestoreArchive.body, /newer-archive/);
    assert.match(postRestoreArchive.body, /older-archive/);
  } finally {
    await app.close();
  }
});

test('empty archive page is quiet and archived shell shows restore state', async () => {
  const app = createApp({ dbPath: tempDbPath('archive-empty-shell') });
  try {
    const empty = await app.inject({ method: 'GET', url: '/archive' });
    assert.equal(empty.statusCode, 200);
    assert.match(empty.body, /No archived plans yet/);

    const registered = await app.inject({ method: 'POST', url: '/api/plans/register', payload: sampleRegisterPayload() });
    const planId = registered.json().data.planId;
    await app.inject({ method: 'POST', url: `/api/plans/${planId}/archive` });
    const shell = await app.inject({ method: 'GET', url: `/p/${planId}` });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, /Archived/);
    assert.match(shell.body, /id="restore-plan"/);
    assert.doesNotMatch(shell.body, />Archive plan</);
  } finally {
    await app.close();
  }
});

test('review shell title uses rendered plan title with safe fallback and escaping', async () => {
  const app = createApp({ dbPath: tempDbPath('review-shell-title') });
  try {
    const titled = await app.inject({ method: 'POST', url: '/api/plans/register', payload: sampleRegisterPayload() });
    assert.equal(titled.statusCode, 200);
    const titledShell = await app.inject({ method: 'GET', url: `/p/${titled.json().data.planId}` });
    assert.equal(titledShell.statusCode, 200);
    assert.match(titledShell.body, /<title>Sample Plan · Plan Review<\/title>/);

    const blankTitleHtml = '<!doctype html><html><head><title>   </title></head><body><main><p>No title.</p></main></body></html>';
    const blank = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html: blankTitleHtml, fileHash: sha256(blankTitleHtml), slug: 'blank-title', planPath: 'thoughts/plans/blank-title.html' })
    });
    assert.equal(blank.statusCode, 200);
    const blankShell = await app.inject({ method: 'GET', url: `/p/${blank.json().data.planId}` });
    assert.match(blankShell.body, /<title>sample \/ blank-title · Plan Review<\/title>/);

    const bodyTitleHtml = '<!doctype html><html><body><main><svg><title>Icon Title</title></svg><p>No head title.</p></main></body></html>';
    const bodyTitle = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html: bodyTitleHtml, fileHash: sha256(bodyTitleHtml), slug: 'body-title', planPath: 'thoughts/plans/body-title.html' })
    });
    assert.equal(bodyTitle.statusCode, 200);
    const bodyTitleShell = await app.inject({ method: 'GET', url: `/p/${bodyTitle.json().data.planId}` });
    assert.match(bodyTitleShell.body, /<title>sample \/ body-title · Plan Review<\/title>/);
    assert.doesNotMatch(bodyTitleShell.body, /Icon Title/);

    const entityTitleHtml = '<!doctype html><html><head><title>Research&nbsp;Plan</title></head><body><main><p>Entity.</p></main></body></html>';
    const entity = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html: entityTitleHtml, fileHash: sha256(entityTitleHtml), slug: 'entity-title', planPath: 'thoughts/plans/entity-title.html' })
    });
    assert.equal(entity.statusCode, 200);
    const entityShell = await app.inject({ method: 'GET', url: `/p/${entity.json().data.planId}` });
    assert.match(entityShell.body, /<title>Research Plan · Plan Review<\/title>/);
    assert.doesNotMatch(entityShell.body, /&amp;nbsp;/);

    const escapedTitleHtml = '<!doctype html><html><head><title>Special &lt;Plan&gt; &amp; "Quotes"</title></head><body><main><p>Escaped.</p></main></body></html>';
    const escaped = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html: escapedTitleHtml, fileHash: sha256(escapedTitleHtml), slug: 'escaped-title', planPath: 'thoughts/plans/escaped-title.html' })
    });
    assert.equal(escaped.statusCode, 200);
    const escapedShell = await app.inject({ method: 'GET', url: `/p/${escaped.json().data.planId}` });
    assert.match(escapedShell.body, /<title>Special &lt;Plan&gt; &amp; &quot;Quotes&quot; · Plan Review<\/title>/);
    assert.doesNotMatch(escapedShell.body, /<title>Special <Plan>/);

    const suffixedTitleHtml = '<!doctype html><html><head><title>Already Plan Review</title></head><body><main><p>Suffixed.</p></main></body></html>';
    const suffixed = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html: suffixedTitleHtml, fileHash: sha256(suffixedTitleHtml), slug: 'suffixed-title', planPath: 'thoughts/plans/suffixed-title.html' })
    });
    assert.equal(suffixed.statusCode, 200);
    const suffixedShell = await app.inject({ method: 'GET', url: `/p/${suffixed.json().data.planId}` });
    assert.match(suffixedShell.body, /<title>Already Plan Review<\/title>/);
    assert.doesNotMatch(suffixedShell.body, /Already Plan Review · Plan Review/);
  } finally {
    await app.close();
  }
});

test('execution-review request button creates an agent-visible comment', async () => {
  const { app, planId } = await registeredApp('execution-review-request');
  try {
    const shell = await app.inject({ method: 'GET', url: `/p/${planId}` });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, /id="request-execution-review"/);

    const requested = await app.inject({ method: 'POST', url: `/api/plans/${planId}/request-execution-review` });
    assert.equal(requested.statusCode, 200);
    assert.equal(requested.json().data.created, true);
    assert.equal(requested.json().data.comment.body, 'Review this plan with both codex and claude code, iterating on the plan until both agents agree it is execution ready');
    assert.equal(requested.json().data.comment.status, 'pending');
    assert.equal(requested.json().data.comment.conversationPayload.type, 'browser.comment.v1');

    const queue = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=queue` });
    assert.deepEqual(queue.json().data.events.map((event: { eventType: string }) => event.eventType), ['comment.created']);
  } finally {
    await app.close();
  }
});

test('build plan button creates an agent-visible scoped-plan-run comment', async () => {
  const { app, planId } = await registeredApp('build-plan-request');
  try {
    const shell = await app.inject({ method: 'GET', url: `/p/${planId}` });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, /id="build-plan"/);

    const requested = await app.inject({ method: 'POST', url: `/api/plans/${planId}/request-build-plan` });
    assert.equal(requested.statusCode, 200);
    assert.equal(requested.json().data.created, true);
    assert.equal(requested.json().data.comment.body, '/skill:scoped-plan-run thoughts/plans/sample-plan.html');
    assert.equal(requested.json().data.comment.status, 'pending');
    assert.equal(requested.json().data.comment.conversationPayload.type, 'browser.comment.v1');

    const queue = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=queue` });
    assert.deepEqual(queue.json().data.events.map((event: { eventType: string }) => event.eventType), ['comment.created']);
  } finally {
    await app.close();
  }
});

test('register and filesystem discovery preserve archived state until explicit restore', () => {
  const store = new PlanReviewStore(tempDbPath('archive-register-preserve'));
  try {
    const payload = sampleRegisterPayload({ watchMode: 'filesystem', sourcePath: '/tmp/sample/plan.html', sourceMtimeMs: 1, sourceSize: 10 });
    const rendered = renderPlan(payload);
    const registered = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);
    const archived = store.archivePlan(registered.planId).plan;
    assert.ok(archived.archivedAt);
    assert.deepEqual(store.listFilesystemPlans(), []);

    const changedPayload = { ...payload, html: sampleHtml().replace('Register the plan.', 'Register the archived plan.'), fileHash: 'archived-sync-change', sourceMtimeMs: 2, sourceSize: 20 };
    const changedRendered = renderPlan(changedPayload);
    store.registerPlan(changedPayload, changedRendered.renderedHtml, changedRendered.warnings, 'filesystem_watch');

    const stillArchived = store.getPlan(registered.planId).plan;
    assert.equal(stillArchived.archivedAt, archived.archivedAt);
    assert.equal(store.listPlans().length, 0);
    assert.equal(store.listPlans({ includeArchived: true })[0].plan.archivedAt, archived.archivedAt);

    const restored = store.unarchivePlan(registered.planId).plan;
    assert.equal(restored.archivedAt, undefined);
    assert.equal(store.listPlans().length, 1);
    assert.equal(store.listFilesystemPlans()[0].planId, registered.planId);
  } finally {
    store.close();
  }
});

test('restored filesystem plans resume watching after archived startup skip', async () => {
  const dbPath = tempDbPath('archive-restore-watch');
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-restore-watch-'));
  const sourcePath = path.join(sourceDir, 'restore-watch.html');
  const html = '<!doctype html><html><body><main><p>Before restore watch.</p></main></body></html>';
  fs.writeFileSync(sourcePath, html);
  const stat = fs.statSync(sourcePath);
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('timed out waiting for restored source sync');
  };
  const initialApp = createApp({ dbPath });
  let initialClosed = false;
  let restoredApp: ReturnType<typeof createApp> | undefined;
  try {
    const registered = await initialApp.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        planPath: 'restore-watch.html',
        slug: 'restore-watch',
        html,
        fileHash: sha256(html),
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem',
        assets: []
      })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;
    assert.equal((await initialApp.inject({ method: 'POST', url: `/api/plans/${planId}/archive` })).statusCode, 200);
    await initialApp.close();
    initialClosed = true;

    const archivedChangeHtml = '<!doctype html><html><body><main><p>Archived change before restore.</p></main></body></html>';
    fs.writeFileSync(sourcePath, archivedChangeHtml);
    restoredApp = createApp({ dbPath });
    const hidden = await restoredApp.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(hidden.json().data.plans.length, 0);
    const restored = await restoredApp.inject({ method: 'POST', url: `/api/plans/${planId}/unarchive` });
    assert.equal(restored.statusCode, 200);
    const restoredRender = await restoredApp.inject({ method: 'GET', url: `/render/${planId}` });
    assert.match(restoredRender.body, /Archived change before restore/);
    assert.doesNotMatch(restoredRender.body, /Before restore watch/);
    const restoreSynced = await restoredApp.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(restoreSynced.json().data.latestVersion.syncOrigin, 'filesystem_watch');

    const changedHtml = '<!doctype html><html><body><main><p>After restore watch.</p></main></body></html>';
    fs.writeFileSync(sourcePath, changedHtml);
    await waitFor(async () => {
      const rendered = await restoredApp!.inject({ method: 'GET', url: `/render/${planId}` });
      return rendered.body.includes('After restore watch.');
    });
    const synced = await restoredApp.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(synced.json().data.latestVersion.syncOrigin, 'filesystem_watch');
  } finally {
    if (!initialClosed) await initialApp.close();
    if (restoredApp) await restoredApp.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('archived filesystem re-register stays inactive until explicit restore', async () => {
  const app = createApp({ dbPath: tempDbPath('archive-reregister-watch') });
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-archive-reregister-'));
  const sourcePath = path.join(sourceDir, 'archive-reregister.html');
  const html = '<!doctype html><html><body><main><p>Initial filesystem plan.</p></main></body></html>';
  fs.writeFileSync(sourcePath, html);
  const stat = fs.statSync(sourcePath);
  try {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        planPath: 'archive-reregister.html',
        slug: 'archive-reregister',
        html,
        fileHash: sha256(html),
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem',
        assets: []
      })
    });
    assert.equal(registered.statusCode, 200);
    assert.equal(registered.json().data.sourceSync.active, true);
    const planId = registered.json().data.planId;
    assert.equal((await app.inject({ method: 'POST', url: `/api/plans/${planId}/archive` })).statusCode, 200);

    const archivedHtml = '<!doctype html><html><body><main><p>Archived manual registration.</p></main></body></html>';
    fs.writeFileSync(sourcePath, archivedHtml);
    const archivedStat = fs.statSync(sourcePath);
    const reregistered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        planPath: 'archive-reregister.html',
        slug: 'archive-reregister',
        html: archivedHtml,
        fileHash: sha256(archivedHtml),
        sourcePath,
        sourceMtimeMs: archivedStat.mtimeMs,
        sourceSize: archivedStat.size,
        watchMode: 'filesystem',
        assets: []
      })
    });
    assert.equal(reregistered.statusCode, 200);
    assert.equal(reregistered.json().data.sourceSync.active, false);
    assert.ok((await app.inject({ method: 'GET', url: `/api/plans/${planId}` })).json().data.plan.archivedAt);

    fs.writeFileSync(sourcePath, '<!doctype html><html><body><main><p>Should not sync while archived.</p></main></body></html>');
    await new Promise(resolve => setTimeout(resolve, 500));
    const rendered = await app.inject({ method: 'GET', url: `/render/${planId}` });
    assert.match(rendered.body, /Archived manual registration/);
    assert.doesNotMatch(rendered.body, /Should not sync while archived/);
  } finally {
    await app.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('source sync register rechecks archive state after unregister', async () => {
  const store = new PlanReviewStore(tempDbPath('archive-register-race'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-archive-register-race-'));
  const sourcePath = path.join(sourceDir, 'archive-register-race.html');
  const html = '<!doctype html><html><body><main><p>Register race.</p></main></body></html>';
  fs.writeFileSync(sourcePath, html);
  const stat = fs.statSync(sourcePath);
  const sourceSync = new SourceSyncService(store, { emitEvent() {} });
  try {
    const payload = sampleRegisterPayload({
      planPath: 'archive-register-race.html',
      slug: 'archive-register-race',
      html,
      fileHash: sha256(html),
      sourcePath,
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
      watchMode: 'filesystem',
      assets: []
    });
    const rendered = renderPlan(payload);
    const registered = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);
    const originalUnregister = sourceSync.unregister.bind(sourceSync);
    sourceSync.unregister = (async (planId: string) => {
      await originalUnregister(planId);
      store.archivePlan(registered.planId);
    }) as typeof sourceSync.unregister;

    await sourceSync.register(registered.planId);

    assert.ok(store.getPlan(registered.planId).plan.archivedAt);
    assert.equal((sourceSync as unknown as { watchers: Map<string, unknown> }).watchers.has(registered.planId), false);
  } finally {
    await sourceSync.close();
    store.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('queued filesystem sync does not update archived plans', async () => {
  const store = new PlanReviewStore(tempDbPath('archive-queued-sync'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-archive-queued-sync-'));
  const sourcePath = path.join(sourceDir, 'archive-queued-sync.html');
  const html = '<!doctype html><html><body><main><p>Before queued sync.</p></main></body></html>';
  fs.writeFileSync(sourcePath, html);
  const stat = fs.statSync(sourcePath);
  const sourceSync = new SourceSyncService(store, { emitEvent() {} });
  try {
    const payload = sampleRegisterPayload({
      planPath: 'archive-queued-sync.html',
      slug: 'archive-queued-sync',
      html,
      fileHash: sha256(html),
      sourcePath,
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
      watchMode: 'filesystem',
      assets: []
    });
    const rendered = renderPlan(payload);
    const registered = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);
    store.archivePlan(registered.planId);

    fs.writeFileSync(sourcePath, '<!doctype html><html><body><main><p>Queued sync should not update archived content.</p></main></body></html>');
    await sourceSync.syncNow(registered.planId, 'manual');

    assert.ok(store.getPlan(registered.planId).plan.archivedAt);
    assert.match(store.getRenderedHtml(registered.planId), /Before queued sync/);
    assert.doesNotMatch(store.getRenderedHtml(registered.planId), /Queued sync should not update/);
  } finally {
    await sourceSync.close();
    store.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('in-flight filesystem sync rechecks archive state before committing', async () => {
  const store = new PlanReviewStore(tempDbPath('archive-inflight-commit'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-archive-inflight-commit-'));
  const sourcePath = path.join(sourceDir, 'archive-inflight-commit.html');
  const html = '<!doctype html><html><body><main><p>Before in-flight sync.</p></main></body></html>';
  fs.writeFileSync(sourcePath, html);
  const stat = fs.statSync(sourcePath);
  const sourceSync = new SourceSyncService(store, { emitEvent() {} });
  try {
    const payload = sampleRegisterPayload({
      planPath: 'archive-inflight-commit.html',
      slug: 'archive-inflight-commit',
      html,
      fileHash: sha256(html),
      sourcePath,
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
      watchMode: 'filesystem',
      assets: []
    });
    const rendered = renderPlan(payload);
    const registered = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);
    const originalGetPlan = store.getPlan.bind(store);
    let getPlanCalls = 0;
    store.getPlan = ((identifier: string) => {
      getPlanCalls += 1;
      if (getPlanCalls === 2) store.archivePlan(registered.planId);
      return originalGetPlan(identifier);
    }) as typeof store.getPlan;

    fs.writeFileSync(sourcePath, '<!doctype html><html><body><main><p>In-flight sync should not commit after archive.</p></main></body></html>');
    await sourceSync.syncNow(registered.planId, 'manual');

    assert.ok(originalGetPlan(registered.planId).plan.archivedAt);
    assert.match(store.getRenderedHtml(registered.planId), /Before in-flight sync/);
    assert.doesNotMatch(store.getRenderedHtml(registered.planId), /In-flight sync should not commit/);
  } finally {
    await sourceSync.close();
    store.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('HTTP API reports schema errors as validation_failed and renders canonical escaped plan ids', async () => {
  const app = createApp({ dbPath: tempDbPath('validation-shell') });
  try {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: { html: '<html></html>' }
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'validation_failed');
    assert.match(invalid.json().error.nextAction, /documented endpoint contract/);

    const unsafeSlug = 'bad" onmouseover="alert(1)';
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ slug: unsafeSlug, fileHash: 'unsafe-slug' })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;

    const shell = await app.inject({
      method: 'GET',
      url: `/p/${encodeURIComponent(unsafeSlug)}`
    });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, new RegExp(`data-plan-id="${planId}"`));
    assert.match(shell.body, new RegExp(`src="/render/${planId}"`));
    assert.doesNotMatch(shell.body, /onmouseover/);
  } finally {
    await app.close();
  }
});

test('plan versions are distinct for the same content on a different branch or commit', () => {
  const store = new PlanReviewStore(tempDbPath('version-key'));
  try {
    const payload = sampleRegisterPayload();
    const rendered = renderPlan(payload);
    const first = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);
    const second = store.registerPlan(
      { ...payload, branch: 'feature/review', commitSha: 'def456' },
      rendered.renderedHtml,
      rendered.warnings
    );
    assert.equal(first.planId, second.planId);
    assert.notEqual(first.versionId, second.versionId);
  } finally {
    store.close();
  }
});

test('rendered blobs stay isolated when identical HTML uses different local assets', async () => {
  const app = createApp({ dbPath: tempDbPath('rendered-blob-isolation') });
  const html = '<!doctype html><html><body><main><img src="./diagram.png" alt="Diagram"></main></body></html>';
  const fileHash = sha256(html);
  const firstAssetHash = sha256(Buffer.from('first-image'));
  const secondAssetHash = sha256(Buffer.from('second-image'));
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        repoKey: 'git@example.com:demo/first.git',
        repoName: 'first',
        rootPath: '/tmp/first',
        planPath: 'thoughts/plans/shared.html',
        slug: 'shared',
        html,
        fileHash,
        assets: [{ sourceUrl: './diagram.png', absolutePath: '/tmp/first/thoughts/plans/diagram.png', bytesBase64: Buffer.from('first-image').toString('base64') }]
      })
    });
    assert.equal(first.statusCode, 200);
    const firstPlanId = first.json().data.planId;
    const firstRendered = await app.inject({ method: 'GET', url: `/render/${firstPlanId}` });
    assert.equal(firstRendered.statusCode, 200);
    assert.match(firstRendered.body, new RegExp(`/assets/${firstAssetHash}`));

    const second = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        repoKey: 'git@example.com:demo/second.git',
        repoName: 'second',
        rootPath: '/tmp/second',
        planPath: 'thoughts/plans/shared.html',
        slug: 'shared',
        html,
        fileHash,
        assets: [{ sourceUrl: './diagram.png', absolutePath: '/tmp/second/thoughts/plans/diagram.png', bytesBase64: Buffer.from('second-image').toString('base64') }]
      })
    });
    assert.equal(second.statusCode, 200);

    const firstRenderedAfterSecondRegister = await app.inject({ method: 'GET', url: `/render/${firstPlanId}` });
    assert.equal(firstRenderedAfterSecondRegister.statusCode, 200);
    assert.match(firstRenderedAfterSecondRegister.body, new RegExp(`/assets/${firstAssetHash}`));
    assert.doesNotMatch(firstRenderedAfterSecondRegister.body, new RegExp(`/assets/${secondAssetHash}`));

    const secondRendered = await app.inject({ method: 'GET', url: `/render/${second.json().data.planId}` });
    assert.equal(secondRendered.statusCode, 200);
    assert.match(secondRendered.body, new RegExp(`/assets/${secondAssetHash}`));
  } finally {
    await app.close();
  }
});

test('CLI local image discovery only reads supported images inside the plan directory', () => {
  const root = fs.mkdtempSync(path.join('/tmp', `plan-reviewer-assets-${process.pid}-`));
  const planDir = path.join(root, 'plans');
  fs.mkdirSync(planDir);
  fs.writeFileSync(path.join(planDir, 'diagram.png'), 'png-data');
  fs.writeFileSync(path.join(planDir, 'notes.txt'), 'not an image');
  fs.writeFileSync(path.join(root, 'secret.png'), 'outside');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside');

  const assets = discoverImageAssets(
    '<img src="./diagram.png"><img src="./diagram.png?v=2"><img src="./notes.txt"><img src="../secret.png"><img src="../secret.txt"><img src="../missing.png"><img src="./missing.png"><img src="https://example.com/remote.png">',
    path.join(planDir, 'plan.html')
  );
  const bySource = new Map(assets.map(asset => [asset.sourceUrl, asset]));

  assert.equal(bySource.get('./diagram.png')?.bytesBase64, Buffer.from('png-data').toString('base64'));
  assert.equal(bySource.get('./diagram.png?v=2')?.bytesBase64, Buffer.from('png-data').toString('base64'));
  assert.equal(bySource.get('./notes.txt')?.bytesBase64, undefined);
  assert.equal(bySource.get('../secret.png')?.bytesBase64, undefined);
  assert.equal(bySource.get('../secret.png')?.absolutePath, undefined);
  assert.equal(bySource.get('../secret.txt')?.absolutePath, undefined);
  assert.equal(bySource.get('../missing.png')?.absolutePath, undefined);
  assert.equal(bySource.get('./missing.png')?.bytesBase64, undefined);
  assert.equal(bySource.has('https://example.com/remote.png'), false);
});

test('HTTP API registers plans, creates comments, claims, acks, resolves, and polls events', async () => {
  const { app, planId, versionId } = await registeredApp('contracts');
  try {
    const index = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(index.statusCode, 200);
    assert.equal(index.json().data.plans.length, 1);

    const planMeta = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(planMeta.statusCode, 200);
    assert.equal(planMeta.json().data.assets.length, 1);
    assert.equal(planMeta.json().data.assets[0].sourceUrl, './diagram.png');
    assert.equal(planMeta.json().data.assets[0].contentType, 'image/png');
    const planAsset = await app.inject({ method: 'GET', url: `/assets/${planMeta.json().data.assets[0].id}` });
    assert.equal(planAsset.statusCode, 200);
    assert.equal(planAsset.headers['cache-control'], 'public, max-age=31536000, immutable');

    const html2canvas = await app.inject({ method: 'GET', url: '/vendor/html2canvas.js' });
    assert.equal(html2canvas.statusCode, 200);
    assert.match(html2canvas.body, /html2canvas/);
    const finder = await app.inject({ method: 'GET', url: '/vendor/finder.js' });
    assert.equal(finder.statusCode, 200);
    assert.match(finder.body, /export function finder/);
    const washi = await app.inject({ method: 'GET', url: '/vendor/washi.js' });
    assert.equal(washi.statusCode, 200);
    assert.match(washi.body, /export \{\s*Washi\s*\}/);

    const commentResponse = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: {
        versionId,
        body: 'Add the agent watch contract here.',
        anchorType: 'dom',
        anchor: domAnchor(),
        markerScreenshot: {
          contentType: 'image/png',
          bytesBase64: Buffer.from('screen').toString('base64'),
          width: 20,
          height: 10,
          captureRect: { x: 0, y: 0, width: 20, height: 10 },
          viewport: { width: 1280, height: 800 }
        },
        createdBy: { displayName: 'Reviewer' },
        clientMutationId: 'comment-1'
      }
    });
    assert.equal(commentResponse.statusCode, 200);
    const comment = commentResponse.json().data.comment;
    assert.equal(comment.status, 'pending');
    assert.equal(comment.sequence, 1);
    assert.equal(comment.conversationPayload.type, 'browser.comment.v1');
    const commentAsset = await app.inject({ method: 'GET', url: `/comment-assets/${comment.screenshotAssetId}` });
    assert.equal(commentAsset.statusCode, 200);
    assert.equal(commentAsset.headers['cache-control'], 'public, max-age=31536000, immutable');

    const wrongVersion = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: {
        versionId: 'ver_missing',
        body: 'wrong version',
        anchorType: 'dom',
        anchor: domAnchor()
      }
    });
    assert.equal(wrongVersion.statusCode, 400);
    assert.equal(wrongVersion.json().error.code, 'validation_failed');

    const ackWithoutClaim = await app.inject({
      method: 'POST',
      url: `/api/comments/${comment.id}/ack`,
      payload: { claimId: 'missing', action: { responseSummary: 'no claim' } }
    });
    assert.equal(ackWithoutClaim.statusCode, 409);
    assert.equal(ackWithoutClaim.json().error.code, 'claim_required');

    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments/claim`,
      headers: { 'x-agent-id': 'agent-a' },
      payload: { mode: 'one' }
    });
    assert.equal(claimResponse.statusCode, 200);
    const claimed = claimResponse.json().data.claimed[0];
    assert.equal(claimed.status, 'claimed');
    const claimedComments = await app.inject({ method: 'GET', url: `/api/plans/${planId}/comments` });
    assert.equal(claimedComments.json().data.comments[0].claim.id, claimed.claim.id);
    assert.equal(claimedComments.json().data.comments[0].claim.agentId, 'agent-a');

    const resolveClaimed = await app.inject({
      method: 'POST',
      url: `/api/comments/${comment.id}/resolve`,
      payload: { resolutionNote: 'skip ack' }
    });
    assert.equal(resolveClaimed.statusCode, 409);
    assert.equal(resolveClaimed.json().error.code, 'invalid_state');

    const ackResponse = await app.inject({
      method: 'POST',
      url: `/api/comments/${comment.id}/ack`,
      payload: {
        claimId: claimed.claim.id,
        action: { responseSummary: 'Updated the plan.', changedFiles: ['thoughts/plans/sample-plan.html'] }
      }
    });
    assert.equal(ackResponse.statusCode, 200);
    assert.equal(ackResponse.json().data.comment.status, 'acknowledged');

    const releaseAcknowledged = await app.inject({
      method: 'POST',
      url: `/api/comments/${comment.id}/release`,
      payload: { claimId: claimed.claim.id }
    });
    assert.equal(releaseAcknowledged.statusCode, 409);
    assert.equal(releaseAcknowledged.json().error.code, 'invalid_state');

    const resolveResponse = await app.inject({
      method: 'POST',
      url: `/api/comments/${comment.id}/resolve`,
      payload: { resolutionNote: 'done' }
    });
    assert.equal(resolveResponse.statusCode, 200);
    assert.equal(resolveResponse.json().data.comment.status, 'resolved');

    const eventsBeforeRetry = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=queue` });
    const lastQueueSequence = eventsBeforeRetry.json().data.events.at(-1).sequence;

    const duplicateCreate = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: {
        versionId,
        body: 'Add the agent watch contract here.',
        anchorType: 'dom',
        anchor: domAnchor(),
        clientMutationId: 'comment-1'
      }
    });
    assert.equal(duplicateCreate.statusCode, 200);
    assert.equal(duplicateCreate.json().data.created, false);
    assert.equal(duplicateCreate.json().data.comment.id, comment.id);
    assert.equal(duplicateCreate.json().data.event.eventType, 'comment.created');
    assert.equal(duplicateCreate.json().data.event.commentId, comment.id);

    const retryEvents = await app.inject({
      method: 'GET',
      url: `/api/plans/${planId}/events/poll?afterSequence=${lastQueueSequence}&mode=queue`
    });
    assert.equal(retryEvents.statusCode, 200);
    assert.deepEqual(retryEvents.json().data.events, []);

    const events = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=queue` });
    assert.equal(events.statusCode, 200);
    assert.deepEqual(
      events.json().data.events.map((event: { eventType: string }) => event.eventType),
      ['comment.created', 'comment.claimed', 'comment.acknowledged', 'comment.resolved']
    );
  } finally {
    await app.close();
  }
});

test('SSE cursor query skips historical events while default replay remains compatible', async () => {
  const app = createApp({ dbPath: tempDbPath('sse-cursor') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const register = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload()
    });
    assert.equal(register.statusCode, 200);
    const { planId, versionId } = register.json().data as { planId: string; versionId: string };
    for (const body of ['first cursor event', 'second cursor event', 'third cursor event']) {
      const comment = await app.inject({
        method: 'POST',
        url: `/api/plans/${planId}/comments`,
        payload: { versionId, body, anchorType: 'dom', anchor: domAnchor() }
      });
      assert.equal(comment.statusCode, 200);
    }

    const defaultEvents = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?mode=queue&afterSequence=0` });
    assert.equal(defaultEvents.statusCode, 200);
    assert.equal(defaultEvents.json().data.events.length, 3);
    const firstCommentSequence = defaultEvents.json().data.events[0].sequence;

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/plans/${planId}/events?mode=queue&afterSequence=${firstCommentSequence}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 4 && !text.includes('third cursor event'); i += 1) {
      const result = await reader.read();
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    await reader.cancel();
    controller.abort();
    assert.doesNotMatch(text, /first cursor event/);
    assert.match(text, /second cursor event/);
    assert.match(text, /third cursor event/);
  } finally {
    await app.close();
  }
});

test('plan detail counts and progress match index values for the same plan', async () => {
  const progressHtml = `<!doctype html><html><body><main>
    <section><h2>Progress</h2><ul>
      <li><input type="checkbox" checked> P1: Complete setup.</li>
      <li><input type="checkbox"> P2: Finish review.</li>
    </ul></section>
    <section id="phase-p1"><h2>Phase 1</h2><p>Register the plan.</p></section>
  </main></body></html>`;
  const { app, planId } = await registeredApp('detail-parity');
  try {
    const register = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html: progressHtml, fileHash: sha256(progressHtml) })
    });
    assert.equal(register.statusCode, 200);
    const updatedVersionId = register.json().data.versionId as string;
    for (const body of ['pending parity', 'claimed parity', 'acknowledged parity', 'resolved parity']) {
      const comment = await app.inject({
        method: 'POST',
        url: `/api/plans/${planId}/comments`,
        payload: { versionId: updatedVersionId, body, anchorType: 'dom', anchor: domAnchor() }
      });
      assert.equal(comment.statusCode, 200);
    }
    const pendingComments = await app.inject({ method: 'GET', url: `/api/plans/${planId}/comments` });
    const comments = pendingComments.json().data.comments as Array<{ id: string }>;
    const claim = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments/claim`,
      payload: { mode: 'selected', commentIds: [comments[1].id, comments[2].id] }
    });
    assert.equal(claim.statusCode, 200);
    const claimed = claim.json().data.claimed as Array<{ id: string; claim: { id: string } }>;
    const ack = await app.inject({
      method: 'POST',
      url: `/api/comments/${claimed[1].id}/ack`,
      payload: { claimId: claimed[1].claim.id, action: { responseSummary: 'ack parity' } }
    });
    assert.equal(ack.statusCode, 200);
    const release = await app.inject({
      method: 'POST',
      url: `/api/comments/${claimed[0].id}/release`,
      payload: { claimId: claimed[0].claim.id }
    });
    assert.equal(release.statusCode, 200);
    const resolve = await app.inject({
      method: 'POST',
      url: `/api/comments/${comments[3].id}/resolve`,
      payload: { resolutionNote: 'resolve parity' }
    });
    assert.equal(resolve.statusCode, 200);

    const index = await app.inject({ method: 'GET', url: '/api/plans?includeArchived=true' });
    const detail = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(index.statusCode, 200);
    assert.equal(detail.statusCode, 200);
    const indexPlan = index.json().data.plans.find((item: { plan: { id: string } }) => item.plan.id === planId);
    assert.ok(indexPlan);
    assert.deepEqual(detail.json().data.counts, indexPlan.counts);
    assert.deepEqual(detail.json().data.progress, indexPlan.progress);
  } finally {
    await app.close();
  }
});

test('duplicate client mutation ids compare fingerprints and reject conflicting reuse', async () => {
  const { app, planId, versionId } = await registeredApp('duplicate-fingerprints');
  try {
    const create = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: {
        versionId,
        body: 'Fingerprint baseline',
        anchorType: 'dom',
        anchor: domAnchor(),
        clientMutationId: 'fingerprint-1'
      }
    });
    assert.equal(create.statusCode, 200);
    const comment = create.json().data.comment;

    const reorderedAnchor = {
      outerHtmlPreview: '<section id="phase-p1"><h2>Phase 1</h2></section>',
      textPreview: 'Phase 1 Register the plan.',
      viewport: { height: 800, width: 1280 },
      rect: { width: 300, height: 80, y: 20, x: 10 },
      headingPath: ['Phase 1'],
      textQuote: { suffix: '', prefix: 'Phase 1', exact: 'Register the plan.' },
      domPath: 'html/body/main/section[1]',
      cssSelector: '#phase-p1',
      planNodeId: 'phase-p1'
    };
    const exactRetry = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: {
        versionId,
        body: 'Fingerprint baseline',
        anchorType: 'dom',
        anchor: reorderedAnchor,
        clientMutationId: 'fingerprint-1'
      }
    });
    assert.equal(exactRetry.statusCode, 200);
    assert.equal(exactRetry.json().data.created, false);
    assert.equal(exactRetry.json().data.comment.id, comment.id);

    const bodyConflict = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: { versionId, body: 'Changed body', anchorType: 'dom', anchor: domAnchor(), clientMutationId: 'fingerprint-1' }
    });
    assert.equal(bodyConflict.statusCode, 409);
    assert.equal(bodyConflict.json().error.code, 'duplicate_comment_conflict');
    assert.match(bodyConflict.json().error.nextAction, /Refresh the comments list/);

    const anchorConflict = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: { versionId, body: 'Fingerprint baseline', anchorType: 'dom', anchor: { ...domAnchor(), textPreview: 'Changed anchor' }, clientMutationId: 'fingerprint-1' }
    });
    assert.equal(anchorConflict.statusCode, 409);
    assert.equal(anchorConflict.json().error.code, 'duplicate_comment_conflict');

    const secondVersion = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ commitSha: 'def456', fileHash: 'second-version-fingerprint', html: sampleHtml().replace('Register the plan.', 'Register the plan again.') })
    });
    assert.equal(secondVersion.statusCode, 200);
    assert.equal(secondVersion.json().data.planId, planId);
    const versionConflict = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: { versionId: secondVersion.json().data.versionId, body: 'Fingerprint baseline', anchorType: 'dom', anchor: domAnchor(), clientMutationId: 'fingerprint-1' }
    });
    assert.equal(versionConflict.statusCode, 409);
    assert.equal(versionConflict.json().error.code, 'duplicate_comment_conflict');

    const events = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=queue` });
    assert.equal(events.statusCode, 200);
    assert.equal(events.json().data.events.filter((event: { eventType: string }) => event.eventType === 'comment.created').length, 1);
  } finally {
    await app.close();
  }
});

test('pending unclaimed comments can be deleted and are excluded from queue surfaces', async () => {
  const { app, planId, versionId } = await registeredApp('delete-comments');
  try {
    const initialMeta = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(initialMeta.statusCode, 200);
    const initialPendingCount = initialMeta.json().data.counts.pending;

    const createDeleted = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: { versionId, body: 'Delete me', anchorType: 'dom', anchor: domAnchor(), clientMutationId: 'delete-me' }
    });
    assert.equal(createDeleted.statusCode, 200);
    const deletedComment = createDeleted.json().data.comment;

    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/comments/${deletedComment.id}` });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.json().data.comment.deletedAt.length > 0, true);
    const afterDeleteEvents = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=all` });
    assert.equal(afterDeleteEvents.statusCode, 200);
    const sequenceAfterDelete = afterDeleteEvents.json().data.latestSequence;

    const list = await app.inject({ method: 'GET', url: `/api/plans/${planId}/comments` });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.comments.some((comment: { id: string }) => comment.id === deletedComment.id), false);
    const meta = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(meta.json().data.counts.pending, initialPendingCount);
    assert.equal(meta.json().data.comments.some((comment: { id: string }) => comment.id === deletedComment.id), false);
    const queue = await app.inject({ method: 'GET', url: `/api/agent/queue?planId=${planId}` });
    assert.equal(queue.statusCode, 200);
    assert.equal(queue.json().data.items.some((comment: { id: string }) => comment.id === deletedComment.id), false);

    const selectedClaimDeleted = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments/claim`,
      payload: { mode: 'selected', commentIds: [deletedComment.id] }
    });
    assert.equal(selectedClaimDeleted.statusCode, 409);
    assert.equal(selectedClaimDeleted.json().error.code, 'invalid_state');

    const duplicateAfterDelete = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: { versionId, body: 'Delete me', anchorType: 'dom', anchor: domAnchor(), clientMutationId: 'delete-me' }
    });
    assert.equal(duplicateAfterDelete.statusCode, 409);
    assert.equal(duplicateAfterDelete.json().error.code, 'duplicate_comment_deleted');
    const eventsAfterDuplicateDeleted = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=${sequenceAfterDelete}&mode=all` });
    assert.equal(eventsAfterDuplicateDeleted.statusCode, 200);
    assert.deepEqual(eventsAfterDuplicateDeleted.json().data.events, []);

    const ackDeleted = await app.inject({
      method: 'POST',
      url: `/api/comments/${deletedComment.id}/ack`,
      payload: { claimId: 'claim_stale' }
    });
    assert.equal(ackDeleted.statusCode, 409);
    assert.equal(ackDeleted.json().error.code, 'invalid_state');

    const resolveDeleted = await app.inject({
      method: 'POST',
      url: `/api/comments/${deletedComment.id}/resolve`,
      payload: { resolutionNote: 'stale resolve' }
    });
    assert.equal(resolveDeleted.statusCode, 409);
    assert.equal(resolveDeleted.json().error.code, 'invalid_state');

    const releaseDeleted = await app.inject({
      method: 'POST',
      url: `/api/comments/${deletedComment.id}/release`,
      payload: { claimId: 'claim_stale' }
    });
    assert.equal(releaseDeleted.statusCode, 409);
    assert.equal(releaseDeleted.json().error.code, 'invalid_state');

    const eventsAfterDeletedLifecycleAttempts = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=${sequenceAfterDelete}&mode=all` });
    assert.equal(eventsAfterDeletedLifecycleAttempts.statusCode, 200);
    assert.deepEqual(eventsAfterDeletedLifecycleAttempts.json().data.events, []);

    const claimedCreate = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: { versionId, body: 'Claimed cannot delete', anchorType: 'dom', anchor: domAnchor() }
    });
    assert.equal(claimedCreate.statusCode, 200);
    const claimedComment = claimedCreate.json().data.comment;
    const claim = await app.inject({ method: 'POST', url: `/api/plans/${planId}/comments/claim`, payload: { mode: 'selected', commentIds: [claimedComment.id] } });
    assert.equal(claim.statusCode, 200);
    const deleteClaimed = await app.inject({ method: 'DELETE', url: `/api/comments/${claimedComment.id}` });
    assert.equal(deleteClaimed.statusCode, 409);
    assert.equal(deleteClaimed.json().error.code, 'invalid_state');

    const acknowledgedCreate = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: { versionId, body: 'Acknowledged cannot delete', anchorType: 'dom', anchor: domAnchor() }
    });
    assert.equal(acknowledgedCreate.statusCode, 200);
    const acknowledged = acknowledgedCreate.json().data.comment;
    const acknowledgedClaim = await app.inject({ method: 'POST', url: `/api/plans/${planId}/comments/claim`, payload: { mode: 'selected', commentIds: [acknowledged.id] } });
    assert.equal(acknowledgedClaim.statusCode, 200);
    const ack = await app.inject({ method: 'POST', url: `/api/comments/${acknowledged.id}/ack`, payload: { claimId: acknowledgedClaim.json().data.claimed[0].claim.id } });
    assert.equal(ack.statusCode, 200);
    const deleteAcknowledged = await app.inject({ method: 'DELETE', url: `/api/comments/${acknowledged.id}` });
    assert.equal(deleteAcknowledged.statusCode, 409);
    assert.equal(deleteAcknowledged.json().error.code, 'invalid_state');
    const resolve = await app.inject({ method: 'POST', url: `/api/comments/${acknowledged.id}/resolve`, payload: { resolutionNote: 'resolved' } });
    assert.equal(resolve.statusCode, 200);
    const deleteResolved = await app.inject({ method: 'DELETE', url: `/api/comments/${acknowledged.id}` });
    assert.equal(deleteResolved.statusCode, 409);
    assert.equal(deleteResolved.json().error.code, 'invalid_state');

    const expiringCreate = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: { versionId, body: 'Delete after expired claim', anchorType: 'dom', anchor: domAnchor() }
    });
    assert.equal(expiringCreate.statusCode, 200);
    const expiring = expiringCreate.json().data.comment;
    const expiringClaim = await app.inject({ method: 'POST', url: `/api/plans/${planId}/comments/claim`, payload: { mode: 'selected', commentIds: [expiring.id], leaseSeconds: 1 } });
    assert.equal(expiringClaim.statusCode, 200);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const deleteExpired = await app.inject({ method: 'DELETE', url: `/api/comments/${expiring.id}` });
    assert.equal(deleteExpired.statusCode, 200);

    const events = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=all` });
    assert.equal(events.statusCode, 200);
    assert.equal(events.json().data.events.some((event: { eventType: string; commentId: string }) => event.eventType === 'comment.deleted' && event.commentId === deletedComment.id), true);
    const queueEvents = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=queue` });
    assert.equal(queueEvents.statusCode, 200);
    assert.equal(queueEvents.json().data.events.some((event: { eventType: string; commentId: string }) => event.eventType === 'comment.deleted' && event.commentId === deletedComment.id), true);
  } finally {
    await app.close();
  }
});

test('lease expiry emits a queue release event during polling', async () => {
  const { app, planId, versionId } = await registeredApp('lease-expiry');
  try {
    const commentResponse = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: {
        versionId,
        body: 'Claim should expire.',
        anchorType: 'dom',
        anchor: domAnchor()
      }
    });
    assert.equal(commentResponse.statusCode, 200);

    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments/claim`,
      payload: { mode: 'one', leaseSeconds: 1 }
    });
    assert.equal(claimResponse.statusCode, 200);
    const claim = claimResponse.json().data.claimed[0];

    await new Promise(resolve => setTimeout(resolve, 1100));
    const events = await app.inject({ method: 'GET', url: `/api/plans/${planId}/events/poll?afterSequence=0&mode=queue` });
    assert.equal(events.statusCode, 200);
    assert.deepEqual(
      events.json().data.events.map((event: { eventType: string }) => event.eventType),
      ['comment.created', 'comment.claimed', 'comment.released']
    );

    const comments = await app.inject({ method: 'GET', url: `/api/plans/${planId}/comments` });
    assert.equal(comments.json().data.comments[0].status, 'pending');

    const expiredAck = await app.inject({
      method: 'POST',
      url: `/api/comments/${claim.id}/ack`,
      payload: { claimId: claim.claim.id, action: { responseSummary: 'too late' } }
    });
    assert.equal(expiredAck.statusCode, 409);
    assert.equal(expiredAck.json().error.code, 'claim_required');
  } finally {
    await app.close();
  }
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI agent next --no-wait returns empty when claim API has no pending comments', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/plans/plan_1/comments/claim') {
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: { claimed: [], events: [], skipped: [] } }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const result = await runCli(['agent', 'next', 'plan_1', '--no-wait', '--json', '--url', `http://127.0.0.1:${address.port}`]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { type: 'plan-review.agent.next.v1', status: 'empty', planId: 'plan_1' });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI agent next --no-wait claims one comment and returns actionable JSON', async () => {
  let capturedBody = '';
  const server = http.createServer((request, response) => {
    if (request.url === '/api/plans/plan_1/comments/claim') {
      request.on('data', chunk => { capturedBody += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          ok: true,
          data: {
            claimed: [{
              id: 'cmt_1',
              planId: 'plan_1',
              status: 'claimed',
              conversationPayload: { type: 'browser.comment.v1', commentId: 'cmt_1', evidence: { reviewUrl: '/p/plan_1' } },
              claim: { id: 'claim_1' }
            }],
            events: [],
            skipped: []
          }
        }));
      });
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const serviceUrl = `http://127.0.0.1:${address.port}`;
    const result = await runCli(['agent', 'next', 'plan_1', '--no-wait', '--json', '--lease-seconds', '60', '--url', serviceUrl]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(capturedBody), { mode: 'one', leaseSeconds: 60 });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.type, 'plan-review.agent.next.v1');
    assert.equal(parsed.status, 'claimed');
    assert.equal(parsed.commentId, 'cmt_1');
    assert.equal(parsed.claimId, 'claim_1');
    assert.equal(parsed.conversationPayload.evidence.reviewUrl, `${serviceUrl}/p/plan_1`);
    assert.match(parsed.ackCommand, /plan-review ack cmt_1 --claim claim_1/);
    assert.match(parsed.ackCommand, new RegExp(`--url ${serviceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(parsed.resolveCommand, /plan-review resolve cmt_1/);
    assert.match(parsed.resolveCommand, new RegExp(`--url ${serviceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(parsed.resolveAfterAck, true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI agent next claimed result can be acknowledged with returned claim id', async () => {
  const app = createApp({ dbPath: tempDbPath('agent-next-ack') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    const serviceUrl = `http://127.0.0.1:${address.port}`;
    const registered = await app.inject({ method: 'POST', url: '/api/plans/register', payload: sampleRegisterPayload() });
    const { planId, versionId } = registered.json().data;
    await app.inject({ method: 'POST', url: `/api/plans/${planId}/comments`, payload: { versionId, body: 'Agent next please.', anchorType: 'dom', anchor: domAnchor() } });
    const next = await runCli(['agent', 'next', planId, '--no-wait', '--json', '--url', serviceUrl]);
    assert.equal(next.code, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.status, 'claimed');
    const ackResult = await runCli(['ack', payload.commentId, '--claim', payload.claimId, '--summary', 'acked', '--json', '--url', serviceUrl]);
    assert.equal(ackResult.code, 0, ackResult.stderr);
    assert.equal(JSON.parse(ackResult.stdout).comment.status, 'acknowledged');
  } finally {
    await app.close();
  }
});

test('CLI agent next --wait wakes via poll fallback and claims exactly one comment', async () => {
  let claims = 0;
  let polls = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/plans/plan_1/comments/claim') {
      claims += 1;
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ok: true,
        data: claims >= 2
          ? { claimed: [{ id: 'cmt_1', planId: 'plan_1', conversationPayload: { type: 'browser.comment.v1', commentId: 'cmt_1' }, claim: { id: 'claim_1' } }], events: [] }
          : { claimed: [], events: [] }
      }));
      return;
    }
    if (request.url?.startsWith('/api/plans/plan_1/events/poll')) {
      polls += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ok: true,
        data: polls === 1
          ? { events: [], latestSequence: 0, retryAfterMs: 10 }
          : { events: [{ sequence: 1, eventType: 'comment.created', payload: { commentId: 'cmt_1' } }], latestSequence: 1, retryAfterMs: 10 }
      }));
      return;
    }
    if (request.url?.startsWith('/api/plans/plan_1/events')) {
      response.statusCode = 503;
      response.end('sse unavailable');
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const result = await runCli(['agent', 'next', 'plan_1', '--wait', '--json', '--timeout', '1000', '--url', `http://127.0.0.1:${address.port}`]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).commentId, 'cmt_1');
    assert.equal(claims, 2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI agent next validates wait flags and timeout errors', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const conflicting = spawnSync(process.execPath, ['dist/cli.js', 'agent', 'next', 'plan_1', '--wait', '--no-wait', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(conflicting.status, 2);
  assert.match(conflicting.stderr, /validation_failed/);

  const missingJson = spawnSync(process.execPath, ['dist/cli.js', 'agent', 'next', 'plan_1', '--no-wait'], { cwd: root, encoding: 'utf8' });
  assert.equal(missingJson.status, 2);
  assert.match(missingJson.stderr, /agent next requires --json/);
});

test('CLI agent next --wait starts from queue tail instead of replaying stale poll events', async () => {
  let claims = 0;
  const pollAfterSequences: number[] = [];
  const sseLastEventIds: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/api/plans/plan_1/comments/claim') {
      claims += 1;
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: { claimed: [], events: [] } }));
      return;
    }
    if (request.url?.startsWith('/api/plans/plan_1/events/poll')) {
      const url = new URL(request.url, 'http://127.0.0.1');
      const afterSequence = Number(url.searchParams.get('afterSequence') ?? 0);
      pollAfterSequences.push(afterSequence);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ok: true,
        data: {
          events: afterSequence === 0 ? [{ sequence: 1, eventType: 'comment.created', payload: { commentId: 'already-acked' } }] : [],
          latestSequence: 1,
          retryAfterMs: 25
        }
      }));
      return;
    }
    if (request.url?.startsWith('/api/plans/plan_1/events')) {
      sseLastEventIds.push(request.headers['last-event-id']?.toString());
      response.statusCode = 503;
      response.end('sse unavailable');
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const result = await runCli(['agent', 'next', 'plan_1', '--wait', '--json', '--timeout', '100', '--url', `http://127.0.0.1:${address.port}`]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(claims < 8, true, `stale events caused rapid claim loop: ${claims} attempts`);
    assert.deepEqual(pollAfterSequences.slice(0, 2), [0, 1]);
    assert.equal(sseLastEventIds[0], '1');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI agent next --wait times out without claiming or empty output', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/plans/plan_1/comments/claim') {
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: { claimed: [], events: [] } }));
      return;
    }
    if (request.url?.startsWith('/api/plans/plan_1/events/poll')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: { events: [], latestSequence: 0, retryAfterMs: 10 } }));
      return;
    }
    if (request.url?.startsWith('/api/plans/plan_1/events')) {
      response.statusCode = 503;
      response.end('sse unavailable');
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const result = await runCli(['agent', 'next', 'plan_1', '--wait', '--json', '--timeout', '50', '--url', `http://127.0.0.1:${address.port}`]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ERROR: watch_timeout No pending browser comment arrived before timeout/);
    assert.match(result.stderr, /NEXT: Retry plan-review agent next plan_1 --wait --json/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI watch polling fallback keeps waiting for once until timeout or event', async () => {
  let polls = 0;
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/api/plans/plan_1/events/poll')) {
      polls += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ok: true,
        data: {
              events: polls >= 2 ? [{ sequence: 1, eventType: 'comment.created', payload: { eventType: 'comment.created', sequence: 1, comment: { conversationPayload: { type: 'browser.comment.v1', commentId: 'cmt_1', evidence: { reviewUrl: '/p/plan_1' } } } } }] : [],
          latestSequence: polls >= 2 ? 1 : 0,
          retryAfterMs: 25
        }
      }));
      return;
    }
    if (request.url?.startsWith('/api/plans/plan_1/events')) {
      response.statusCode = 503;
      response.end('sse unavailable');
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const conversationOut = path.join('/tmp', `plan-reviewer-conversation-${process.pid}.ndjson`);
  fs.rmSync(conversationOut, { force: true });
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, ['dist/cli.js', 'watch', 'plan_1', '--url', `http://127.0.0.1:${address.port}`, '--once', '--timeout', '1000', '--json', '--conversation-out', conversationOut], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /comment\.created/);
    const conversation = JSON.parse(fs.readFileSync(conversationOut, 'utf8').trim());
    assert.equal(conversation.type, 'browser.comment.v1');
    assert.equal(conversation.evidence.reviewUrl, `http://127.0.0.1:${address.port}/p/plan_1`);
    assert.equal(polls >= 2, true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI register prints required watcher instructions and preserves JSON payload', async () => {
  let registerRequests = 0;
  const registrationData = {
    planId: 'plan_cli',
    versionId: 'ver_cli',
    repoId: 'repo_cli',
    reviewUrl: '/p/plan_cli',
    indexUrl: '/',
    watchCommand: 'plan-review watch plan_cli --mode queue',
    sourceSync: { watchMode: 'snapshot', status: 'synced', error: null, active: false },
    renderedWithWarnings: [],
    agentInstructions: buildRegistrationAgentInstructions({ planId: 'plan_cli', reviewUrl: '/p/plan_cli' })
  };
  const server = http.createServer((request, response) => {
    if (request.url === '/api/plans/register') {
      registerRequests += 1;
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: registrationData }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const planDir = fs.mkdtempSync(path.join(root, '.tmp-cli-register-'));
  const planPath = path.join(planDir, 'plan.html');
  fs.writeFileSync(planPath, sampleHtml());
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const serviceUrl = `http://127.0.0.1:${address.port}`;

    const runRegister = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, ['dist/cli.js', 'register', planPath, '--url', serviceUrl, ...args], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });

    const human = await runRegister(['--execution-ready', 'false', '--linear-issue', 'NOD-999']);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Plan ID: plan_cli/);
    assert.match(human.stdout, /Review URL: http:\/\/127\.0\.0\.1:\d+\/p\/plan_cli/);
    assert.match(human.stdout, /Source sync: snapshot/);
    assert.doesNotMatch(human.stdout, /^Watch command:/m);
    assert.match(human.stdout, /REQUIRED NEXT ACTION:/);
    assert.match(human.stdout, /Drain pending comments with agent next --no-wait/);
    assert.match(human.stdout, /Drain pending comments:/);
    assert.match(human.stdout, /plan-review agent next plan_cli --no-wait --json --url http:\/\/127\.0\.0\.1:\d+/);
    assert.match(human.stdout, /Primary listener command:/);
    assert.match(human.stdout, /plan-review agent next plan_cli --wait --json --url http:\/\/127\.0\.0\.1:\d+/);
    assert.match(human.stdout, /Optional debug watch stream:/);
    assert.match(human.stdout, /plan-review watch plan_cli --mode queue --format browser-comment --json --url http:\/\/127\.0\.0\.1:\d+/);
    assert.match(human.stdout, /Comment lifecycle:/);
    assert.match(human.stdout, /commentId and claimId/);
    assert.match(human.stdout, /plan-review ack <commentId> --claim <claimId>/);

    const json = await runRegister(['--execution-ready', 'true', '--json']);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed, registrationData);
    assert.equal(parsed.agentInstructions.preferredCommand, 'plan-review agent next plan_cli --wait --json');
    assert.equal(parsed.agentInstructions.drainCommand, 'plan-review agent next plan_cli --no-wait --json');
    assert.doesNotMatch(parsed.agentInstructions.durableCommand, /--url/);
    assert.equal(registerRequests, 2);
  } finally {
    fs.rmSync(planDir, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI register failure does not print watcher instructions', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/plans/register') {
      request.resume();
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: false, error: { code: 'validation_failed', message: 'Invalid plan', details: {} } }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const planDir = fs.mkdtempSync(path.join(root, '.tmp-cli-register-fail-'));
  const planPath = path.join(planDir, 'plan.html');
  fs.writeFileSync(planPath, sampleHtml());
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, ['dist/cli.js', 'register', planPath, '--url', `http://127.0.0.1:${address.port}`, '--execution-ready', 'false'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ERROR: validation_failed Invalid plan/);
    assert.doesNotMatch(result.stdout, /REQUIRED NEXT ACTION:/);
    assert.doesNotMatch(result.stderr, /REQUIRED NEXT ACTION:/);
    assert.doesNotMatch(result.stdout, /agentInstructions/);
  } finally {
    fs.rmSync(planDir, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('CLI release maps to the REST release endpoint', async () => {
  let captured: { method?: string; url?: string; body?: string } = {};
  const server = http.createServer((request, response) => {
    if (request.url === '/api/comments/cmt_1/release') {
      captured = { method: request.method, url: request.url, body: '' };
      request.on('data', chunk => { captured.body += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, data: { comment: { id: 'cmt_1', status: 'pending' } } }));
      });
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, [
        'dist/cli.js',
        'release',
        'cmt_1',
        '--url',
        `http://127.0.0.1:${address.port}`,
        '--claim',
        'claim_1',
        '--reason',
        'needs-retry',
        '--json'
      ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(captured.method, 'POST');
    assert.equal(JSON.parse(captured.body ?? '{}').claimId, 'claim_1');
    assert.equal(JSON.parse(captured.body ?? '{}').reason, 'needs-retry');
    assert.equal(JSON.parse(result.stdout).comment.status, 'pending');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('new plan versions remap changed anchors to stale or unmapped', async () => {
  const { app, planId, versionId } = await registeredApp('anchor-remap');
  try {
    const commentResponse = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: {
        versionId,
        body: 'Old phase disappeared.',
        anchorType: 'dom',
        anchor: domAnchor()
      }
    });
    assert.equal(commentResponse.statusCode, 200);

    const changedTextHtml = '<!doctype html><html><body><main><section id="phase-p1"><h2>Phase 1</h2><p>Different copy remains.</p></section></main></body></html>';
    const staleRegister = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html: changedTextHtml, fileHash: 'changed-anchor-text' })
    });
    assert.equal(staleRegister.statusCode, 200);

    const staleComments = await app.inject({ method: 'GET', url: `/api/plans/${planId}/comments` });
    assert.equal(staleComments.json().data.comments[0].anchorState, 'stale');

    const missingHtml = '<!doctype html><html><body><main><section id="different"><h2>Different</h2><p>Nothing remains.</p></section></main></body></html>';
    const missingRegister = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({ html: missingHtml, fileHash: 'changed-anchor-missing' })
    });
    assert.equal(missingRegister.statusCode, 200);

    const unmappedComments = await app.inject({ method: 'GET', url: `/api/plans/${planId}/comments` });
    assert.equal(unmappedComments.json().data.comments[0].anchorState, 'unmapped');
  } finally {
    await app.close();
  }
});

test('index groups plans by repo and sorts API plans by comment activity', async () => {
  const { app, planId, versionId } = await registeredApp('index-activity');
  try {
    const second = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        repoKey: 'git@example.com:demo/other.git',
        repoName: 'other',
        remoteUrl: 'git@example.com:demo/other.git',
        rootPath: '/tmp/other',
        planPath: 'thoughts/plans/other.html',
        slug: 'other-plan',
        fileHash: 'other-plan-hash'
      })
    });
    assert.equal(second.statusCode, 200);
    await new Promise(resolve => setTimeout(resolve, 5));

    const commentResponse = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/comments`,
      payload: {
        versionId,
        body: 'Activity bump.',
        anchorType: 'dom',
        anchor: domAnchor()
      }
    });
    assert.equal(commentResponse.statusCode, 200);

    const apiIndex = await app.inject({ method: 'GET', url: '/api/plans' });
    assert.equal(apiIndex.json().data.plans[0].plan.id, planId);

    const repoFiltered = await app.inject({ method: 'GET', url: '/api/plans?repoKey=git%40example.com%3Ademo%2Fother.git' });
    assert.equal(repoFiltered.json().data.plans.length, 1);
    assert.equal(repoFiltered.json().data.plans[0].plan.repoName, 'other');

    const queryFiltered = await app.inject({ method: 'GET', url: '/api/plans?q=other&limit=1' });
    assert.equal(queryFiltered.json().data.plans.length, 1);
    assert.equal(queryFiltered.json().data.nextCursor, undefined);

    const paged = await app.inject({ method: 'GET', url: '/api/plans?limit=1' });
    assert.equal(paged.json().data.plans.length, 1);
    assert.equal(paged.json().data.nextCursor, '1');

    const invalidCursor = await app.inject({ method: 'GET', url: '/api/plans?cursor=abc' });
    assert.equal(invalidCursor.statusCode, 400);
    assert.equal(invalidCursor.json().error.code, 'validation_failed');

    const htmlIndex = await app.inject({ method: 'GET', url: '/' });
    assert.match(htmlIndex.body, /class="repo-group"/);
    assert.match(htmlIndex.body, />sample</);
    assert.match(htmlIndex.body, />other</);
  } finally {
    await app.close();
  }
});

test('bare plan slugs fail clearly when multiple repos register the same slug', async () => {
  const { app } = await registeredApp('ambiguous-slug');
  try {
    const duplicateSlug = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        repoKey: 'git@example.com:demo/other-slug.git',
        repoName: 'other-slug',
        remoteUrl: 'git@example.com:demo/other-slug.git',
        rootPath: '/tmp/other-slug',
        planPath: 'thoughts/plans/sample-plan.html',
        fileHash: 'other-slug-hash'
      })
    });
    assert.equal(duplicateSlug.statusCode, 200);

    const slugLookup = await app.inject({ method: 'GET', url: '/api/plans/sample-plan' });
    assert.equal(slugLookup.statusCode, 409);
    assert.equal(slugLookup.json().error.code, 'ambiguous_plan_slug');
  } finally {
    await app.close();
  }
});

test('service URL config ignores invalid url values and trims valid URLs', () => {
  const dir = path.join('/tmp', `plan-reviewer-config-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.plan-reviewer.json'), '{"url":{}}');
  assert.equal(resolveServiceUrl(undefined, dir), 'http://127.0.0.1:4317');

  fs.writeFileSync(path.join(dir, '.plan-reviewer.json'), '{"url":"http://127.0.0.1:9999/"}');
  assert.equal(resolveServiceUrl(undefined, dir), 'http://127.0.0.1:9999');
});

test('CLI help is wired through the installed bin entrypoint', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = spawnSync(process.execPath, ['dist/cli.js', '--help'], {
    cwd: root,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /plan-review/);
  assert.match(result.stdout, /watch/);
  assert.match(result.stdout, /agent/);
  assert.match(result.stdout, /ack/);
  assert.match(result.stdout, /resolve/);
  assert.match(result.stdout, /release/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'register', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--new-thread/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'index', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--repo-key/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'queue', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /list/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'agent', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /next/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'agent', 'next', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--wait/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'agent', 'next', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--no-wait/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'agent', 'next', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--timeout/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'agent', 'next', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--lease-seconds/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'ack', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--changed-files/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'resolve', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--commit/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'release', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--claim/);
});

test('Homebrew formula locks the daemon service contract', () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const formulaPath = [packageRoot, monorepoRoot]
    .map(root => path.join(root, 'Formula/plan-reviewer.rb'))
    .find(candidate => fs.existsSync(candidate));
  assert.ok(formulaPath, 'Formula/plan-reviewer.rb exists in package or monorepo root');
  const formula = fs.readFileSync(formulaPath, 'utf8');

  assert.match(formula, /class PlanReviewer < Formula/);
  assert.match(formula, /head "https:\/\/github\.com\/Nodaste-Lab\/plan-reviewer\.git", branch: "main"/);
  assert.match(formula, /bin\.install_symlink/);
  assert.match(formula, /"serve",\s+"--host", "0\.0\.0\.0",\s+"--port", "4317"/);
  assert.match(formula, /"\#\{Dir\.home\}\/\.plan-reviewer\/plan-reviewer\.sqlite"/);
  assert.match(formula, /keep_alive true/);
  assert.match(formula, /log_path var\/"log\/plan-reviewer\.log"/);
  assert.match(formula, /error_log_path var\/"log\/plan-reviewer\.err\.log"/);
  assert.match(formula, /brew services stop plan-reviewer/);
  assert.match(formula, /rm -rf ~\/\.plan-reviewer/);
});

test('registration stores authoritative source metadata and version origin', async () => {
  const app = createApp({ dbPath: tempDbPath('source-contract') });
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-source-'));
  const sourcePath = path.join(sourceDir, 'sample-plan.html');
  const html = sampleHtml();
  fs.writeFileSync(sourcePath, html);
  const stat = fs.statSync(sourcePath);
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem'
      })
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.sourceSync.active, true);
    const planId = first.json().data.planId;
    const versionId = first.json().data.versionId;

    const same = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem'
      })
    });
    assert.equal(same.statusCode, 200);
    assert.equal(same.json().data.planId, planId);
    assert.equal(same.json().data.versionId, versionId);

    const changedHtml = sampleHtml().replace('Register the plan.', 'Register and sync the plan.');
    const changedStat = fs.statSync(sourcePath);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        html: changedHtml,
        fileHash: sha256(changedHtml),
        sourcePath,
        sourceMtimeMs: changedStat.mtimeMs,
        sourceSize: changedStat.size,
        watchMode: 'filesystem'
      })
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().data.planId, planId);
    assert.notEqual(changed.json().data.versionId, versionId);

    const meta = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(meta.json().data.plan.sourcePath, sourcePath);
    assert.equal(meta.json().data.plan.watchMode, 'filesystem');
    assert.equal(meta.json().data.plan.lastSyncStatus, 'synced');
    assert.equal(meta.json().data.latestVersion.syncOrigin, 'manual_register');
  } finally {
    await app.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('registration reports failed source sync when API source path is unreadable', async () => {
  const app = createApp({ dbPath: tempDbPath('source-register-failure') });
  const sourcePath = path.join(os.tmpdir(), `plan-review-missing-${process.pid}.html`);
  try {
    fs.rmSync(sourcePath, { force: true });
    const response = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        sourcePath,
        sourceMtimeMs: 0,
        sourceSize: 0,
        watchMode: 'filesystem'
      })
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.sourceSync.active, false);
    assert.equal(response.json().data.sourceSync.status, 'failed');
    assert.match(response.json().data.sourceSync.error.message, /ENOENT|no such file/i);
  } finally {
    await app.close();
  }
});

function sourceSyncSentinelHtml(label: string, extra = ''): string {
  return `<!doctype html><html><head><title>Source sync ${label}</title></head><body><main><p id="top">TOP ${label}</p><p id="middle">MIDDLE ${label}</p>${extra}<p id="bottom">BOTTOM ${label}</p></main></body></html>`;
}

function sourceSyncPartialPrefix(label: string): string {
  return `<!doctype html><html><head><title>Source sync ${label}</title></head><body><main><p id="top">TOP ${label}</p>`;
}

function sourceSyncEmbeddedCloseTagPrefix(label: string): string {
  return `<!doctype html><html><head><title>Source sync ${label}</title></head><body><main><pre>&lt;/body&gt;&lt;/html&gt;</pre><p id="top">TOP ${label}</p>`;
}

function sourceSyncLiteralCloseTagPrefix(label: string): string {
  return `<!doctype html><html><head><title>Source sync ${label}</title></head><body><main><pre></body></html></pre><p id="top">TOP ${label}</p>`;
}

function sourceSyncRegisterPayload(sourcePath: string, html: string, slug: string) {
  const stat = fs.statSync(sourcePath);
  return sampleRegisterPayload({
    planPath: `${slug}.html`,
    slug,
    html,
    fileHash: sha256(html),
    sourcePath,
    sourceMtimeMs: stat.mtimeMs,
    sourceSize: stat.size,
    watchMode: 'filesystem',
    assets: []
  });
}

test('source sync rejects incomplete partial source writes and recovers complete source', async () => {
  const store = new PlanReviewStore(tempDbPath('source-incomplete-recovery'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-source-incomplete-'));
  const sourcePath = path.join(sourceDir, 'incomplete-recovery.html');
  const initialHtml = sourceSyncSentinelHtml('initial');
  fs.writeFileSync(sourcePath, initialHtml);
  const events: Array<{ eventType: string }> = [];
  const sourceSync = new SourceSyncService(store, { emitEvent(event) { events.push(event); } });
  try {
    const payload = sourceSyncRegisterPayload(sourcePath, initialHtml, 'incomplete-recovery');
    const rendered = renderPlan(payload);
    const registered = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);

    fs.writeFileSync(sourcePath, sourceSyncPartialPrefix('partial'));
    await sourceSync.syncNow(registered.planId, 'manual');

    const afterPartial = store.getPlan(registered.planId);
    assert.equal(afterPartial.version.id, registered.versionId);
    assert.equal(afterPartial.plan.lastSyncStatus, 'failed');
    assert.match(String(afterPartial.plan.lastSyncError?.message), /incomplete source write/i);
    assert.match(String(afterPartial.plan.lastSyncError?.nextAction), /last good render/i);
    assert.match(store.getRenderedHtml(registered.planId), /BOTTOM initial/);
    assert.doesNotMatch(store.getRenderedHtml(registered.planId), /TOP partial/);
    assert.equal(events.some(event => event.eventType === 'plan.version.synced'), false);

    const recoveredHtml = sourceSyncSentinelHtml('recovered');
    fs.writeFileSync(sourcePath, recoveredHtml);
    await sourceSync.syncNow(registered.planId, 'manual');

    const recovered = store.getPlan(registered.planId);
    assert.notEqual(recovered.version.id, registered.versionId);
    assert.equal(recovered.plan.lastSyncStatus, 'synced');
    assert.equal(recovered.plan.lastSyncError, null);
    assert.match(store.getRenderedHtml(registered.planId), /BOTTOM recovered/);
  } finally {
    await sourceSync.close();
    store.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('source sync rejects partial prefixes with embedded close-tag text but accepts complete small rewrites', async () => {
  const store = new PlanReviewStore(tempDbPath('source-embedded-close-tags'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-source-embedded-close-'));
  const sourcePath = path.join(sourceDir, 'embedded-close-tags.html');
  const initialHtml = sourceSyncSentinelHtml('large', '<section><p>Additional plan detail that can be intentionally removed later.</p></section>');
  fs.writeFileSync(sourcePath, initialHtml);
  const sourceSync = new SourceSyncService(store, { emitEvent() {} });
  try {
    const payload = sourceSyncRegisterPayload(sourcePath, initialHtml, 'embedded-close-tags');
    const rendered = renderPlan(payload);
    const registered = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);

    fs.writeFileSync(sourcePath, sourceSyncEmbeddedCloseTagPrefix('embedded'));
    await sourceSync.syncNow(registered.planId, 'manual');

    const rejected = store.getPlan(registered.planId);
    assert.equal(rejected.version.id, registered.versionId);
    assert.equal(rejected.plan.lastSyncStatus, 'failed');
    assert.match(String(rejected.plan.lastSyncError?.message), /incomplete source write/i);
    assert.match(store.getRenderedHtml(registered.planId), /BOTTOM large/);
    assert.doesNotMatch(store.getRenderedHtml(registered.planId), /TOP embedded/);

    fs.writeFileSync(sourcePath, sourceSyncLiteralCloseTagPrefix('literal'));
    await sourceSync.syncNow(registered.planId, 'manual');

    const literalRejected = store.getPlan(registered.planId);
    assert.equal(literalRejected.version.id, registered.versionId);
    assert.equal(literalRejected.plan.lastSyncStatus, 'failed');
    assert.match(String(literalRejected.plan.lastSyncError?.message), /incomplete source write/i);
    assert.match(store.getRenderedHtml(registered.planId), /BOTTOM large/);
    assert.doesNotMatch(store.getRenderedHtml(registered.planId), /TOP literal/);

    const smallerCompleteHtml = '<!doctype html><html><body><main><p>Small complete replacement.</p></main></body></html>';
    fs.writeFileSync(sourcePath, smallerCompleteHtml);
    await sourceSync.syncNow(registered.planId, 'manual');

    const accepted = store.getPlan(registered.planId);
    assert.notEqual(accepted.version.id, registered.versionId);
    assert.equal(accepted.plan.lastSyncStatus, 'synced');
    assert.match(store.getRenderedHtml(registered.planId), /Small complete replacement/);
    assert.doesNotMatch(store.getRenderedHtml(registered.planId), /BOTTOM large/);
  } finally {
    await sourceSync.close();
    store.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('startup source sync rejects quiescent incomplete source and keeps cached last good render', async () => {
  const dbPath = tempDbPath('source-startup-incomplete');
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-source-startup-incomplete-'));
  const sourcePath = path.join(sourceDir, 'startup-incomplete.html');
  const initialHtml = sourceSyncSentinelHtml('startup-good');
  fs.writeFileSync(sourcePath, initialHtml);
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('timed out waiting for startup incomplete source sync');
  };
  let app = createApp({ dbPath });
  try {
    const stat = fs.statSync(sourcePath);
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        planPath: 'startup-incomplete.html',
        slug: 'startup-incomplete',
        html: initialHtml,
        fileHash: sha256(initialHtml),
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem',
        assets: []
      })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;
    const firstVersionId = registered.json().data.versionId;
    await app.close();

    fs.writeFileSync(sourcePath, sourceSyncPartialPrefix('startup-partial'));
    app = createApp({ dbPath });
    await waitFor(async () => {
      const meta = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
      const data = meta.json().data;
      return data.plan.lastSyncStatus === 'failed' || data.latestVersion.id !== firstVersionId;
    });

    const meta = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(meta.json().data.latestVersion.id, firstVersionId);
    assert.equal(meta.json().data.plan.lastSyncStatus, 'failed');
    assert.match(String(meta.json().data.plan.lastSyncError.message), /incomplete source write/i);
    const rendered = await app.inject({ method: 'GET', url: `/render/${planId}` });
    assert.match(rendered.body, /BOTTOM startup-good/);
    assert.doesNotMatch(rendered.body, /TOP startup-partial/);
  } finally {
    await app.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('source sync does not emit partial version events during repeated incomplete writes or rapid recovery', async () => {
  const store = new PlanReviewStore(tempDbPath('source-incomplete-events'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-source-incomplete-events-'));
  const sourcePath = path.join(sourceDir, 'incomplete-events.html');
  const initialHtml = sourceSyncSentinelHtml('events-good');
  fs.writeFileSync(sourcePath, initialHtml);
  const events: Array<{ eventType: string }> = [];
  const sourceSync = new SourceSyncService(store, { emitEvent(event) { events.push(event); } });
  try {
    const payload = sourceSyncRegisterPayload(sourcePath, initialHtml, 'incomplete-events');
    const rendered = renderPlan(payload);
    const registered = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);

    fs.writeFileSync(sourcePath, sourceSyncPartialPrefix('partial-one'));
    await sourceSync.syncNow(registered.planId, 'manual');
    fs.writeFileSync(sourcePath, sourceSyncPartialPrefix('partial-two'));
    await sourceSync.syncNow(registered.planId, 'manual');

    assert.equal(store.getPlan(registered.planId).version.id, registered.versionId);
    assert.equal(events.filter(event => event.eventType === 'plan.sync.failed').length, 2);
    assert.equal(events.some(event => event.eventType === 'plan.version.synced'), false);
    assert.match(store.getRenderedHtml(registered.planId), /BOTTOM events-good/);

    const completeHtml = sourceSyncSentinelHtml('events-recovered');
    fs.writeFileSync(sourcePath, completeHtml);
    await sourceSync.syncNow(registered.planId, 'manual');

    assert.equal(events.filter(event => event.eventType === 'plan.version.synced').length, 1);
    assert.match(store.getRenderedHtml(registered.planId), /BOTTOM events-recovered/);
    assert.doesNotMatch(store.getRenderedHtml(registered.planId), /partial-one|partial-two/);
  } finally {
    await sourceSync.close();
    store.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('source sync failed render keeps last good render and actionable metadata', async () => {
  const store = new PlanReviewStore(tempDbPath('source-render-failure'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-source-render-failure-'));
  const sourcePath = path.join(sourceDir, 'render-failure.html');
  const initialHtml = sourceSyncSentinelHtml('render-good');
  fs.writeFileSync(sourcePath, initialHtml);
  const sourceSync = new SourceSyncService(store, { emitEvent() {} });
  try {
    const payload = sourceSyncRegisterPayload(sourcePath, initialHtml, 'render-failure');
    const rendered = renderPlan(payload);
    const registered = store.registerPlan(payload, rendered.renderedHtml, rendered.warnings);

    const invalidCompleteHtml = '<!doctype html><html><body><main><div id="dup" id="other"></div></main></body></html>';
    fs.writeFileSync(sourcePath, invalidCompleteHtml);
    await sourceSync.syncNow(registered.planId, 'manual');

    const failed = store.getPlan(registered.planId);
    assert.equal(failed.version.id, registered.versionId);
    assert.equal(failed.plan.lastSyncStatus, 'failed');
    assert.match(String(failed.plan.lastSyncError?.message), /parsed safely/i);
    assert.match(String(failed.plan.lastSyncError?.nextAction), /source file/i);
    assert.match(store.getRenderedHtml(registered.planId), /BOTTOM render-good/);
  } finally {
    await sourceSync.close();
    store.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('filesystem source recovery watcher syncs after startup read failure', async () => {
  const dbPath = tempDbPath('source-recovery-watch');
  const app = createApp({ dbPath });
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-source-recovery-'));
  const sourcePath = path.join(sourceDir, 'recovery-plan.html');
  const html = '<!doctype html><html><body><main><p>Original</p></main></body></html>';
  fs.writeFileSync(sourcePath, html);
  const stat = fs.statSync(sourcePath);
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('timed out waiting for recovery sync');
  };
  let recoveryApp = app;
  try {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        planPath: 'recovery-plan.html',
        slug: 'recovery-plan',
        html,
        fileHash: sha256(html),
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem',
        assets: []
      })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;
    await app.close();

    fs.rmSync(sourcePath);
    recoveryApp = createApp({ dbPath });
    await waitFor(async () => {
      const current = await recoveryApp.inject({ method: 'GET', url: `/api/plans/${planId}` });
      return current.json().data.plan.lastSyncStatus === 'failed';
    });
    const failedIndex = await recoveryApp.inject({ method: 'GET', url: '/' });
    assert.match(failedIndex.body, /Source missing/);
    assert.match(failedIndex.body, /data-needs-attention="true"/);

    const recoveredHtml = '<!doctype html><html><body><main><p>Recovered</p></main></body></html>';
    fs.writeFileSync(sourcePath, recoveredHtml);
    await waitFor(async () => {
      const rendered = await recoveryApp.inject({ method: 'GET', url: `/render/${planId}` });
      return rendered.body.includes('Recovered');
    });
    const recovered = await recoveryApp.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(recovered.json().data.plan.lastSyncStatus, 'synced');
    const recoveredIndex = await recoveryApp.inject({ method: 'GET', url: '/' });
    assert.doesNotMatch(recoveredIndex.body, /Source missing/);
    assert.doesNotMatch(recoveredIndex.body, /data-needs-attention="true"/);
  } finally {
    await recoveryApp.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('filesystem source watches missing relative image creation', async () => {
  const app = createApp({ dbPath: tempDbPath('source-missing-asset-watch') });
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-missing-asset-watch-'));
  const sourcePath = path.join(sourceDir, 'asset-plan.html');
  const imagePath = path.join(sourceDir, 'diagram.png');
  const html = '<!doctype html><html><body><main><img src="./diagram.png" alt="Diagram"></main></body></html>';
  fs.writeFileSync(sourcePath, html);
  const stat = fs.statSync(sourcePath);
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('timed out waiting for missing asset sync');
  };
  try {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        planPath: 'asset-plan.html',
        slug: 'asset-plan',
        html,
        fileHash: sha256(html),
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem',
        assets: [{ sourceUrl: './diagram.png', absolutePath: imagePath }]
      })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;
    const missingRendered = await app.inject({ method: 'GET', url: `/render/${planId}` });
    assert.match(missingRendered.body, /Missing image: \.\/diagram\.png/);

    fs.writeFileSync(imagePath, Buffer.from('created-image'));
    const createdHash = sha256(Buffer.from('created-image'));
    await waitFor(async () => {
      const rendered = await app.inject({ method: 'GET', url: `/render/${planId}` });
      return rendered.body.includes(`/assets/${createdHash}`);
    });
  } finally {
    await app.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('filesystem source watches relative image changes even when HTML is unchanged', async () => {
  const app = createApp({ dbPath: tempDbPath('source-asset-watch') });
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-asset-watch-'));
  const sourcePath = path.join(sourceDir, 'asset-plan.html');
  const imagePath = path.join(sourceDir, 'diagram.png');
  const html = '<!doctype html><html><body><main><img src="./diagram.png" alt="Diagram"></main></body></html>';
  fs.writeFileSync(sourcePath, html);
  fs.writeFileSync(imagePath, Buffer.from('first-image'));
  const stat = fs.statSync(sourcePath);
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('timed out waiting for asset sync');
  };
  try {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        planPath: 'asset-plan.html',
        slug: 'asset-plan',
        html,
        fileHash: sha256(html),
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem',
        assets: [{ sourceUrl: './diagram.png', absolutePath: imagePath, bytesBase64: Buffer.from('first-image').toString('base64') }]
      })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;
    const firstRendered = await app.inject({ method: 'GET', url: `/render/${planId}` });
    const firstHash = sha256(Buffer.from('first-image'));
    const secondHash = sha256(Buffer.from('second-image'));
    assert.match(firstRendered.body, new RegExp(`/assets/${firstHash}`));

    fs.writeFileSync(imagePath, Buffer.from('second-image'));
    await waitFor(async () => {
      const rendered = await app.inject({ method: 'GET', url: `/render/${planId}` });
      return rendered.body.includes(`/assets/${secondHash}`);
    });
    const synced = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(synced.json().data.latestVersion.syncOrigin, 'filesystem_watch');

    fs.rmSync(imagePath);
    await waitFor(async () => {
      const rendered = await app.inject({ method: 'GET', url: `/render/${planId}` });
      return /Missing image: \.\/diagram\.png/.test(rendered.body);
    });
    const deleted = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(deleted.json().data.plan.lastSyncStatus, 'synced');
  } finally {
    await app.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('filesystem source changes create a synced latest version and failures keep last good render', async () => {
  const app = createApp({ dbPath: tempDbPath('source-watch') });
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-watch-'));
  const sourcePath = path.join(sourceDir, 'sample-plan.html');
  fs.writeFileSync(sourcePath, sampleHtml());
  const stat = fs.statSync(sourcePath);
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('timed out waiting for source sync');
  };
  try {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/plans/register',
      payload: sampleRegisterPayload({
        sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem'
      })
    });
    assert.equal(registered.statusCode, 200);
    const planId = registered.json().data.planId;
    const firstVersionId = registered.json().data.versionId;

    const changedHtml = sampleHtml().replace('Reviewers can select this section.', 'Reviewers see live synced content.');
    fs.writeFileSync(sourcePath, changedHtml);
    await waitFor(async () => {
      const meta = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
      return meta.json().data.latestVersion.id !== firstVersionId;
    });
    const synced = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.equal(synced.json().data.latestVersion.syncOrigin, 'filesystem_watch');
    const rendered = await app.inject({ method: 'GET', url: `/render/${planId}?versionId=${synced.json().data.latestVersion.id}` });
    assert.match(rendered.body, /Reviewers see live synced content/);

    fs.rmSync(sourcePath);
    await waitFor(async () => {
      const meta = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
      return meta.json().data.plan.lastSyncStatus === 'failed';
    });
    const failed = await app.inject({ method: 'GET', url: `/api/plans/${planId}` });
    assert.match(failed.json().data.plan.lastSyncError.message, /missing|ENOENT|Source file/i);
    const lastGood = await app.inject({ method: 'GET', url: `/render/${planId}` });
    assert.match(lastGood.body, /Reviewers see live synced content/);
  } finally {
    await app.close();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});
