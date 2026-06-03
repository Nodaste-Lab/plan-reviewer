import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { serve } from './server/serve.js';
import { defaultDbPath, PlanReviewError, sha256, slugify } from './util.js';
import { resolveServiceUrl } from './config.js';
import { appendNdjson, requestJson } from './client/api.js';
import { findImageSources } from './htmlImages.js';

interface RegisterResponse {
  planId: string;
  versionId: string;
  repoId: string;
  reviewUrl: string;
  indexUrl: string;
  watchCommand: string;
  sourceSync?: { watchMode: 'filesystem' | 'snapshot'; sourcePath?: string; status?: string; active?: boolean };
  renderedWithWarnings: Array<{ code: string; detail: string }>;
}

function git(args: string[], cwd = process.cwd()): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function repoMetadata(cwd = process.cwd()) {
  const rootPath = git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  const remoteUrl = git(['config', '--get', 'remote.origin.url'], rootPath);
  const branch = git(['branch', '--show-current'], rootPath) ?? 'detached';
  const commitSha = git(['rev-parse', 'HEAD'], rootPath);
  const repoName = remoteUrl
    ? path.basename(remoteUrl.replace(/\.git$/, ''))
    : path.basename(rootPath);
  return {
    repoName,
    remoteUrl,
    rootPath,
    branch,
    commitSha,
    repoKey: remoteUrl || `${rootPath}@${os.hostname()}`
  };
}

function isLocalImagePath(sourceUrl: string): boolean {
  return ['.gif', '.jpg', '.jpeg', '.png', '.svg', '.webp'].includes(
    path.extname(sourceUrl.split(/[?#]/, 1)[0] || '').toLowerCase()
  );
}

function isInsideDirectory(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function discoverImageAssets(html: string, planFile: string) {
  const planDir = path.dirname(planFile);
  const absolutePlanDir = path.resolve(planDir);
  const realPlanDir = fs.realpathSync(planDir);
  const assets: Array<{ sourceUrl: string; absolutePath?: string; bytesBase64?: string }> = [];
  for (const sourceUrl of findImageSources(html)) {
    if (/^(data:|blob:|https?:\/\/|\/)/i.test(sourceUrl)) continue;
    const filesystemSource = sourceUrl.split(/[?#]/, 1)[0] || sourceUrl;
    const absolutePath = path.resolve(planDir, filesystemSource);
    if (!isInsideDirectory(absolutePlanDir, absolutePath)) {
      assets.push({ sourceUrl });
      continue;
    }
    if (!fs.existsSync(absolutePath) || !isLocalImagePath(sourceUrl)) {
      assets.push({ sourceUrl, absolutePath });
      continue;
    }
    const realAssetPath = fs.realpathSync(absolutePath);
    if (!isInsideDirectory(realPlanDir, realAssetPath) || !fs.statSync(realAssetPath).isFile()) {
      assets.push({ sourceUrl });
      continue;
    }
    assets.push({
      sourceUrl,
      absolutePath: realAssetPath,
      bytesBase64: fs.readFileSync(realAssetPath).toString('base64')
    });
  }
  return assets;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fullUrl(base: string, maybePath: string): string {
  return maybePath.startsWith('http') ? maybePath : `${base.replace(/\/$/, '')}${maybePath}`;
}

function enrichConversationPayload(value: any, serviceUrl: string) {
  const reviewUrl = value?.evidence?.reviewUrl;
  if (!reviewUrl || typeof reviewUrl !== 'string' || !reviewUrl.startsWith('/')) return value;
  return {
    ...value,
    evidence: {
      ...value.evidence,
      reviewUrl: fullUrl(serviceUrl, reviewUrl)
    }
  };
}

function defaultWatchStatePath(): string {
  return path.join(os.homedir(), '.plan-reviewer', 'watch-state.json');
}

function readWatchState(filePath: string): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeWatchState(filePath: string, key: string, sequence: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const state = readWatchState(filePath);
  state[key] = sequence;
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function registerPlan(filePath: string, options: { url?: string; json?: boolean; repo?: string; branch?: string; commit?: string; newThread?: boolean; snapshot?: boolean }) {
  const serviceUrl = resolveServiceUrl(options.url);
  const absolute = path.resolve(filePath);
  const html = fs.readFileSync(absolute, 'utf8');
  const stat = fs.statSync(absolute);
  const meta = repoMetadata(path.dirname(absolute));
  const branch = options.branch && options.branch !== 'auto' ? options.branch : meta.branch;
  const commitSha = options.commit && options.commit !== 'auto' ? options.commit : meta.commitSha;
  const repoName = options.repo && options.repo !== 'auto' ? options.repo : meta.repoName;
  const payload = {
    repoKey: meta.repoKey,
    repoName,
    remoteUrl: meta.remoteUrl,
    rootPath: meta.rootPath,
    branch,
    commitSha,
    planPath: path.relative(meta.rootPath, absolute) || filePath,
    slug: slugify(path.basename(filePath, path.extname(filePath))),
    html,
    fileHash: sha256(html),
    sourcePath: options.snapshot ? undefined : absolute,
    sourceMtimeMs: options.snapshot ? undefined : stat.mtimeMs,
    sourceSize: options.snapshot ? undefined : stat.size,
    watchMode: options.snapshot ? 'snapshot' as const : 'filesystem' as const,
    assets: discoverImageAssets(html, absolute),
    updateMode: options.newThread ? 'new-thread' as const : 'upsert' as const
  };
  const data = await requestJson<RegisterResponse>(`${serviceUrl}/api/plans/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (options.json) {
    printJson(data);
    return;
  }
  const sync = data.sourceSync?.active ? `active (${data.sourceSync.sourcePath})` : 'snapshot';
  process.stdout.write(`Plan ID: ${data.planId}\nIndex URL: ${fullUrl(serviceUrl, data.indexUrl)}\nReview URL: ${fullUrl(serviceUrl, data.reviewUrl)}\nSource sync: ${sync}\nWatch command: ${data.watchCommand} --url ${serviceUrl}\n`);
}

async function printIndex(options: { url?: string; json?: boolean; q?: string; repoKey?: string; limit?: string; cursor?: string }) {
  const serviceUrl = resolveServiceUrl(options.url);
  const params = new URLSearchParams();
  if (options.q) params.set('q', options.q);
  if (options.repoKey) params.set('repoKey', options.repoKey);
  if (options.limit) params.set('limit', options.limit);
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString();
  const data = await requestJson<{ plans?: Array<{ plan: { repoName: string; slug: string }; counts: { pending: number; claimed: number; acknowledged: number; resolved: number }; reviewUrl: string }>; nextCursor?: string }>(`${serviceUrl}/api/plans${query ? `?${query}` : ''}`);
  if (options.json) printJson(data);
  else {
    const rows = data.plans ?? [];
    const table = rows.map(item =>
      `${item.plan.repoName}\t${item.plan.slug}\tpending:${item.counts.pending} claimed:${item.counts.claimed} ack:${item.counts.acknowledged} resolved:${item.counts.resolved}\t${fullUrl(serviceUrl, item.reviewUrl)}`
    );
    process.stdout.write(`Index URL: ${serviceUrl}/\nRepo\tPlan\tStatus\tReview URL\n${table.join('\n')}${data.nextCursor ? `\nNext cursor: ${data.nextCursor}` : ''}\n`);
  }
}

function parseSse(buffer: string): { events: Array<{ id?: string; event?: string; data?: string }>; rest: string } {
  const events: Array<{ id?: string; event?: string; data?: string }> = [];
  let index: number;
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const raw = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    const event: { id?: string; event?: string; data?: string } = {};
    for (const line of raw.split('\n')) {
      if (line.startsWith('id:')) event.id = line.slice(3).trim();
      if (line.startsWith('event:')) event.event = line.slice(6).trim();
      if (line.startsWith('data:')) event.data = `${event.data ?? ''}${line.slice(5).trim()}`;
    }
    if (event.event || event.data) events.push(event);
  }
  return { events, rest: buffer };
}

async function pollEvents(serviceUrl: string, planId: string, afterSequence: number, mode: string) {
  return requestJson<{ events: any[]; latestSequence: number; retryAfterMs: number }>(
    `${serviceUrl}/api/plans/${planId}/events/poll?afterSequence=${afterSequence}&mode=${encodeURIComponent(mode)}`
  );
}

async function watchPlan(planId: string, options: {
  url?: string;
  json?: boolean;
  mode?: 'all' | 'queue';
  once?: boolean;
  timeout?: string;
  format?: string;
  conversationOut?: string;
  state?: string;
}) {
  const serviceUrl = resolveServiceUrl(options.url);
  const mode = options.mode ?? 'queue';
  const statePath = options.state ?? defaultWatchStatePath();
  const stateKey = `${serviceUrl}|${planId}|${mode}`;
  let latestSequence = readWatchState(statePath)[stateKey] ?? 0;
  const timeoutMs = options.timeout ? Number(options.timeout) : undefined;
  const started = Date.now();
  const emit = (event: any, source: 'sse' | 'poll') => {
    latestSequence = Number(event.sequence ?? latestSequence);
    if (latestSequence > 0) writeWatchState(statePath, stateKey, latestSequence);
    const conversation = (event.eventType ?? event.event) === 'comment.created'
      ? enrichConversationPayload(event.comment?.conversationPayload ?? event.conversationPayload, serviceUrl)
      : undefined;
    const output = options.format === 'browser-comment' ? conversation : { source, ...event };
    if (options.conversationOut && conversation) appendNdjson(options.conversationOut, conversation);
    if (options.format === 'browser-comment' && !conversation) return;
    if (options.json || options.format === 'browser-comment') process.stdout.write(`${JSON.stringify(output)}\n`);
    else process.stdout.write(`${event.eventType ?? event.event ?? 'event'} #${latestSequence}\n`);
  };
  const remainingTimeout = () => timeoutMs ? Math.max(0, timeoutMs - (Date.now() - started)) : undefined;

  let backoffMs = 1000;
  while (true) {
    try {
      const abort = new AbortController();
      const remaining = remainingTimeout();
      const timeout = remaining !== undefined ? setTimeout(() => abort.abort(), remaining) : undefined;
      try {
        const response = await fetch(`${serviceUrl}/api/plans/${planId}/events?mode=${mode}`, {
          headers: latestSequence ? { 'Last-Event-ID': String(latestSequence), accept: 'text/event-stream' } : { accept: 'text/event-stream' },
          signal: abort.signal
        });
        if (!response.ok || !response.body) throw new Error(`SSE unavailable (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let rest = '';
        while (true) {
          const remainingRead = remainingTimeout();
          if (remainingRead !== undefined && remainingRead <= 0) {
            throw new PlanReviewError('watch_timeout', 'No event arrived before timeout', 1);
          }
          const read = timeoutMs
            ? await Promise.race([
                reader.read(),
                new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) =>
                  setTimeout(() => reject(new PlanReviewError('watch_timeout', 'No event arrived before timeout', 1)), remainingRead)
                )
              ])
            : await reader.read();
          if (read.done) break;
          const parsed = parseSse(rest + decoder.decode(read.value));
          rest = parsed.rest;
          for (const raw of parsed.events) {
            if (raw.event === 'heartbeat' || raw.event === 'connected') continue;
            const data = raw.data ? JSON.parse(raw.data) : {};
            emit({
              ...data,
              sequence: raw.id ? Number(raw.id) : data.sequence,
              eventType: raw.event ?? data.eventType,
              event: raw.event ?? data.event
            }, 'sse');
            if (options.once) {
              await reader.cancel();
              return;
            }
          }
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof PlanReviewError && error.code === 'watch_timeout') throw error;
      const data = await pollEvents(serviceUrl, planId, latestSequence, mode);
      for (const event of data.events) {
        emit({
          ...(event.payload ?? {}),
          sequence: event.sequence,
          eventType: event.eventType,
          event: event.eventType
        }, 'poll');
        if (options.once) return;
      }
      const remaining = remainingTimeout();
      if (remaining !== undefined && remaining <= 0) {
        throw new PlanReviewError('watch_timeout', 'No event arrived before timeout', 1);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(remaining ?? 10000, data.retryAfterMs ?? backoffMs)));
      backoffMs = Math.min(30000, backoffMs * 2);
    }
  }
}

async function claim(planId: string, options: { url?: string; all?: boolean; one?: boolean; ids?: string; limit?: string; leaseSeconds?: string; json?: boolean }) {
  const serviceUrl = resolveServiceUrl(options.url);
  const body = options.ids
    ? { mode: 'selected', commentIds: options.ids.split(',').filter(Boolean), leaseSeconds: options.leaseSeconds ? Number(options.leaseSeconds) : undefined }
    : options.one
      ? { mode: 'one', leaseSeconds: options.leaseSeconds ? Number(options.leaseSeconds) : undefined }
      : { mode: 'bulk', limit: options.limit ? Number(options.limit) : undefined, leaseSeconds: options.leaseSeconds ? Number(options.leaseSeconds) : undefined };
  const data = await requestJson<unknown>(`${serviceUrl}/api/plans/${planId}/comments/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (options.json) printJson(data);
  else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function queueSnapshot(options: { url?: string; repoKey?: string; planId?: string; limit?: string; json?: boolean }) {
  const serviceUrl = resolveServiceUrl(options.url);
  const params = new URLSearchParams();
  if (options.repoKey) params.set('repoKey', options.repoKey);
  if (options.planId) params.set('planId', options.planId);
  if (options.limit) params.set('limit', options.limit);
  const query = params.toString();
  const data = await requestJson<unknown>(`${serviceUrl}/api/agent/queue${query ? `?${query}` : ''}`);
  if (options.json) printJson(data);
  else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function csv(value?: string): string[] | undefined {
  return value?.split(',').map(item => item.trim()).filter(Boolean);
}

function actionFromOptions(options: {
  note?: string;
  summary?: string;
  changedFiles?: string;
  commit?: string;
  runId?: string;
  handoff?: string;
}) {
  return {
    note: options.note,
    responseSummary: options.summary ?? options.note,
    changedFiles: csv(options.changedFiles),
    commitSha: options.commit,
    runId: options.runId,
    handoffPath: options.handoff
  };
}

async function ack(commentId: string, options: { url?: string; claim?: string; note?: string; summary?: string; changedFiles?: string; commit?: string; runId?: string; handoff?: string; json?: boolean }) {
  if (!options.claim) throw new PlanReviewError('claim_required', 'ack requires --claim <claim-id>', 1, { commentId }, 'Claim the comment first, then pass --claim <claim-id>.');
  const serviceUrl = resolveServiceUrl(options.url);
  const data = await requestJson<unknown>(`${serviceUrl}/api/comments/${commentId}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimId: options.claim, action: actionFromOptions(options) })
  });
  if (options.json) printJson(data);
  else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function resolveComment(commentId: string, options: { url?: string; note?: string; summary?: string; changedFiles?: string; commit?: string; runId?: string; json?: boolean }) {
  const serviceUrl = resolveServiceUrl(options.url);
  const data = await requestJson<unknown>(`${serviceUrl}/api/comments/${commentId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resolutionNote: options.note ?? 'resolved', action: actionFromOptions(options) })
  });
  if (options.json) printJson(data);
  else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function releaseComment(commentId: string, options: { url?: string; claim?: string; reason?: string; json?: boolean }) {
  if (!options.claim) throw new PlanReviewError('claim_required', 'release requires --claim <claim-id>', 1, { commentId }, 'Pass the active claim id with --claim <claim-id>.');
  const serviceUrl = resolveServiceUrl(options.url);
  const data = await requestJson<unknown>(`${serviceUrl}/api/comments/${commentId}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimId: options.claim, reason: options.reason })
  });
  if (options.json) printJson(data);
  else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const program = new Command();
  program.name('plan-review').description('Local HTML plan review daemon and CLI');

  program.command('serve')
    .option('--host <host>', 'host to bind', '0.0.0.0')
    .option('--port <port>', 'port to bind', value => Number(value), 4317)
    .option('--db <path>', 'SQLite database path', defaultDbPath())
    .action(async options => {
      await serve({ host: options.host, port: options.port, dbPath: options.db });
    });

  program.command('register <path>')
    .option('--url <url>')
    .option('--repo <repo>')
    .option('--branch <branch>')
    .option('--commit <commit>')
    .option('--new-thread')
    .option('--snapshot', 'register a detached snapshot instead of live filesystem sync')
    .option('--json')
    .action(registerPlan);

  program.command('index')
    .option('--url <url>')
    .option('--q <query>')
    .option('--repo-key <repoKey>')
    .option('--limit <limit>')
    .option('--cursor <cursor>')
    .option('--json')
    .action(printIndex);

  program.command('watch <planId>')
    .option('--url <url>')
    .option('--json')
    .option('--mode <mode>', 'all|queue', 'queue')
    .option('--once')
    .option('--timeout <ms>')
    .option('--format <format>')
    .option('--conversation-out <path>')
    .option('--state <path>')
    .action(watchPlan);

  const queue = program.command('queue');
  queue.command('list')
    .option('--url <url>')
    .option('--repo-key <repoKey>')
    .option('--plan-id <planId>')
    .option('--limit <limit>')
    .option('--json')
    .action(queueSnapshot);

  queue.command('claim <planId>')
    .option('--url <url>')
    .option('--all')
    .option('--one')
    .option('--ids <ids>')
    .option('--limit <limit>')
    .option('--lease-seconds <seconds>')
    .option('--json')
    .action(claim);

  program.command('ack <commentId>')
    .option('--url <url>')
    .option('--claim <claimId>')
    .option('--note <note>')
    .option('--summary <summary>')
    .option('--changed-files <paths>')
    .option('--commit <sha>')
    .option('--run-id <id>')
    .option('--handoff <path>')
    .option('--json')
    .action(ack);

  program.command('resolve <commentId>')
    .option('--url <url>')
    .option('--note <note>')
    .option('--summary <summary>')
    .option('--changed-files <paths>')
    .option('--commit <sha>')
    .option('--run-id <id>')
    .option('--json')
    .action(resolveComment);

  program.command('release <commentId>')
    .option('--url <url>')
    .option('--claim <claimId>')
    .option('--reason <reason>')
    .option('--json')
    .action(releaseComment);

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof PlanReviewError) {
      console.error(`ERROR: ${error.code} ${error.message}${error.nextAction ? `\nNEXT: ${error.nextAction}` : ''}`);
      process.exitCode = error.statusCode === 1 ? 1 : 2;
      return;
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
