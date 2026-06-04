import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { claimCommentsSchema, createCommentSchema, registerPlanSchema } from '../schemas.js';
import { renderPlan } from '../render/render.js';
import { PlanReviewStore } from '../storage/database.js';
import { createApp } from '../server/app.js';
import { SourceSyncService } from '../server/sourceSync.js';
import { findImageSources } from '../htmlImages.js';
import { resolveServiceUrl } from '../config.js';
import { discoverImageAssets } from '../cli.js';
import { buildRegistrationAgentInstructions, renderRegistrationInstructionCommands } from '../registrationInstructions.js';
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

test('registration instruction helper builds canonical watcher guidance and rendered commands', () => {
  const instructions = buildRegistrationAgentInstructions({ planId: 'plan_abc', reviewUrl: '/p/plan_abc' });
  assert.equal(instructions.type, 'plan-review.registration.instructions.v1');
  assert.equal(instructions.required, true);
  assert.match(instructions.summary, /Start a monitor/);
  assert.match(instructions.nextAction, /Start the comment watcher/);
  assert.equal(instructions.serviceUrlRequired, true);
  assert.match(instructions.serviceUrlInstruction, /durable tmux/);
  assert.equal(instructions.reviewUrl, '/p/plan_abc');
  assert.equal(instructions.preferredCommand, 'plan-review watch plan_abc --mode queue --format browser-comment --json');
  assert.equal(instructions.durableCommand, "mkdir -p ~/.plan-reviewer/watchers && tmux new-session -d -s plan-review-plan_abc 'plan-review watch plan_abc --mode queue --format browser-comment --conversation-out ~/.plan-reviewer/watchers/plan_abc.ndjson --json'");
  assert.equal(instructions.referenceImplementations.length, 2);
  assert.equal(instructions.referenceImplementations[0].tool, 'process');
  assert.equal(instructions.referenceImplementations[0].command, instructions.preferredCommand);
  assert.equal(instructions.referenceImplementations[1].tool, 'tmux');
  assert.equal(instructions.referenceImplementations[1].command, instructions.durableCommand);
  assert.match(instructions.processingLoop.join('\n'), /browser\.comment\.v1/);
  assert.match(instructions.processingLoop.join('\n'), /commentId/);
  assert.match(instructions.processingLoop.join('\n'), /claimed\[0\]\.claim\.id/);
  assert.match(instructions.processingLoop.join('\n'), /data\.claimed\[0\]\.claim\.id/);
  assert.match(instructions.processingLoop.join('\n'), /plan-review queue claim plan_abc --ids <commentId> --json/);
  assert.match(instructions.processingLoop.join('\n'), /plan-review ack <commentId> --claim <claimId> --summary/);
  assert.match(instructions.processingLoop.join('\n'), /plan-review resolve <commentId> --note/);

  const rendered = renderRegistrationInstructionCommands(instructions, 'http://reviewer.example:4317');
  assert.equal(rendered.preferredCommand, 'plan-review watch plan_abc --mode queue --format browser-comment --json --url http://reviewer.example:4317');
  assert.match(rendered.durableCommand, /^mkdir -p ~\/\.plan-reviewer\/watchers && tmux new-session -d -s plan-review-plan_abc '/);
  assert.match(rendered.durableCommand, /--conversation-out ~\/\.plan-reviewer\/watchers\/plan_abc\.ndjson --json --url http:\/\/reviewer\.example:4317'$/);
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
    assert.match(snapshotData.agentInstructions.summary, /Start a monitor/);
    assert.match(snapshotData.agentInstructions.nextAction, /Start the comment watcher/);
    assert.equal(snapshotData.agentInstructions.serviceUrlRequired, true);
    assert.match(snapshotData.agentInstructions.serviceUrlInstruction, /quoted inner watcher/);
    assert.match(snapshotData.agentInstructions.preferredCommand, /--mode queue --format browser-comment --json/);
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
    assert.match(reregisterData.agentInstructions.durableCommand, /--conversation-out/);

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
        body: 'Retry after resolution.',
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
    assert.match(human.stdout, /Start the comment watcher before continuing implementation or review work\./);
    assert.match(human.stdout, /plan-review watch plan_cli --mode queue --format browser-comment --json --url http:\/\/127\.0\.0\.1:\d+/);
    assert.match(human.stdout, /tmux new-session -d -s plan-review-plan_cli 'plan-review watch plan_cli --mode queue --format browser-comment --conversation-out ~\/\.plan-reviewer\/watchers\/plan_cli\.ndjson --json --url http:\/\/127\.0\.0\.1:\d+'/);
    assert.match(human.stdout, /Comment lifecycle:/);
    assert.match(human.stdout, /claimed\[0\]\.claim\.id/);
    assert.match(human.stdout, /plan-review ack <commentId> --claim <claimId>/);

    const json = await runRegister(['--execution-ready', 'true', '--json']);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed, registrationData);
    assert.equal(parsed.agentInstructions.preferredCommand, 'plan-review watch plan_cli --mode queue --format browser-comment --json');
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
  assert.match(result.stdout, /ack/);
  assert.match(result.stdout, /resolve/);
  assert.match(result.stdout, /release/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'register', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--new-thread/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'index', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /--repo-key/);
  assert.match(spawnSync(process.execPath, ['dist/cli.js', 'queue', '--help'], { cwd: root, encoding: 'utf8' }).stdout, /list/);
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
