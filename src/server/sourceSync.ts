import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { findImageSources } from '../htmlImages.js';
import { renderPlan } from '../render/render.js';
import type { RegisterPlanInput } from '../schemas.js';
import { PlanReviewStore, type StoredEvent } from '../storage/database.js';
import { sha256 } from '../util.js';

interface EventEmitterTarget {
  emitEvent(event: StoredEvent): void;
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

class IncompleteSourceWriteError extends Error {
  code = 'incomplete_source_write';

  constructor(sourcePath: string) {
    super(`Incomplete source write observed for ${sourcePath}; kept serving the last good render.`);
  }
}

class StaleSourceSnapshotError extends Error {
  code = 'stale_source_snapshot';

  constructor(sourcePath: string) {
    super(`Source file changed during source sync for ${sourcePath}; kept serving the last good render and will retry.`);
  }
}

export interface StableSourceSnapshot {
  html: string;
  fileHash: string;
  sourceMtimeMs: number;
  sourceSize: number;
}

export function readStableSourceSnapshot(sourcePath: string): StableSourceSnapshot {
  const before = fs.statSync(sourcePath);
  if (!before.isFile()) throw new Error(`Source path is not a file: ${sourcePath}`);
  const bytes = fs.readFileSync(sourcePath);
  const after = fs.statSync(sourcePath);
  if (!after.isFile()) throw new Error(`Source path is not a file: ${sourcePath}`);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
    throw new StaleSourceSnapshotError(sourcePath);
  }
  const html = bytes.toString('utf8');
  return {
    html,
    fileHash: sha256(html),
    sourceMtimeMs: after.mtimeMs,
    sourceSize: after.size
  };
}

function assertSourceSnapshotCurrent(sourcePath: string, snapshot: StableSourceSnapshot): void {
  const current = readStableSourceSnapshot(sourcePath);
  if (
    current.fileHash !== snapshot.fileHash ||
    current.sourceMtimeMs !== snapshot.sourceMtimeMs ||
    current.sourceSize !== snapshot.sourceSize
  ) {
    throw new StaleSourceSnapshotError(sourcePath);
  }
}

function trimTrailingWhitespaceAndComments(value: string): string {
  let current = value.trimEnd();
  while (current.endsWith('-->')) {
    const commentStart = current.lastIndexOf('<!--');
    if (commentStart === -1) return current;
    current = current.slice(0, commentStart).trimEnd();
  }
  return current;
}

function removeTrailingCloseTag(value: string, tagName: 'body' | 'html'): string | undefined {
  const current = trimTrailingWhitespaceAndComments(value);
  const match = new RegExp(`</${tagName}\\s*>$`, 'i').exec(current);
  if (!match || match.index === undefined) return undefined;
  return current.slice(0, match.index);
}

function isCompleteHtmlSource(html: string): boolean {
  const withoutHtml = removeTrailingCloseTag(html, 'html');
  if (withoutHtml === undefined) return false;
  return removeTrailingCloseTag(withoutHtml, 'body') !== undefined;
}

export function discoverSourceAssets(html: string, sourcePath: string) {
  const planDir = path.dirname(sourcePath);
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
    if (!isLocalImagePath(sourceUrl)) {
      assets.push({ sourceUrl });
      continue;
    }
    if (!fs.existsSync(absolutePath)) {
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

export class SourceSyncService {
  private watchers = new Map<string, FSWatcher>();
  private recoveryWatchers = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private chains = new Map<string, Promise<void>>();

  constructor(private store: PlanReviewStore, private bus: EventEmitterTarget) {}

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const watchers = [...this.watchers.values()];
    this.watchers.clear();
    this.recoveryWatchers.clear();
    await Promise.all(watchers.map(watcher => watcher.close()));
  }

  async rehydrateFromStore(): Promise<void> {
    for (const item of this.store.listFilesystemPlans()) {
      await this.register(item.planId);
      void this.syncNow(item.planId, 'startup');
    }
  }

  async register(planId: string): Promise<void> {
    await this.unregister(planId);
    const { plan } = this.store.getPlan(planId);
    if (plan.archivedAt || plan.lifecycleState === 'deferred' || plan.watchMode !== 'filesystem' || !plan.sourcePath) return;
    const watchPaths = [plan.sourcePath];
    try {
      const html = fs.readFileSync(plan.sourcePath, 'utf8');
      for (const asset of discoverSourceAssets(html, plan.sourcePath)) {
        if (asset.absolutePath) watchPaths.push(asset.absolutePath);
      }
    } catch (error) {
      this.fail(planId, error, 'watch_register');
      const watcher = chokidar.watch(plan.sourcePath, {
        ignoreInitial: true,
        awaitWriteFinish: false
      });
      const recover = () => {
        void this.register(planId).then(() => this.schedule(planId));
      };
      watcher.on('add', recover);
      watcher.on('change', recover);
      watcher.on('unlink', () => this.fail(planId, new Error(`Source file is missing: ${plan.sourcePath}`)));
      watcher.on('error', (watchError: unknown) => this.fail(planId, watchError));
      this.watchers.set(planId, watcher);
      this.recoveryWatchers.add(planId);
      await new Promise<void>(resolve => watcher.once('ready', resolve));
      await new Promise(resolve => setTimeout(resolve, 100));
      return;
    }
    const watcher = chokidar.watch([...new Set(watchPaths)], {
      ignoreInitial: true,
      awaitWriteFinish: false
    });
    watcher.on('add', () => this.schedule(planId));
    watcher.on('change', () => this.schedule(planId));
    watcher.on('unlink', changedPath => {
      if (path.resolve(changedPath) === path.resolve(plan.sourcePath!)) {
        this.fail(planId, new Error(`Source file is missing: ${plan.sourcePath}`));
      } else {
        this.schedule(planId);
      }
    });
    watcher.on('error', (error: unknown) => this.fail(planId, error));
    this.watchers.set(planId, watcher);
    await new Promise<void>(resolve => watcher.once('ready', resolve));
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  async unregister(planId: string): Promise<void> {
    const timer = this.timers.get(planId);
    if (timer) clearTimeout(timer);
    this.timers.delete(planId);
    this.recoveryWatchers.delete(planId);
    const watcher = this.watchers.get(planId);
    if (!watcher) return;
    this.watchers.delete(planId);
    await watcher.close();
  }

  schedule(planId: string): void {
    const existing = this.timers.get(planId);
    if (existing) clearTimeout(existing);
    this.timers.set(planId, setTimeout(() => {
      this.timers.delete(planId);
      void this.syncNow(planId, 'filesystem_watch');
    }, 500));
  }

  syncNow(planId: string, reason: 'startup' | 'filesystem_watch' | 'manual'): Promise<void> {
    const previous = this.chains.get(planId) ?? Promise.resolve();
    const next = previous.then(() => this.performSync(planId, reason), () => this.performSync(planId, reason));
    this.chains.set(planId, next.finally(() => {
      if (this.chains.get(planId) === next) this.chains.delete(planId);
    }));
    return next;
  }

  private async performSync(planId: string, reason: string): Promise<void> {
    const { plan, version } = this.store.getPlan(planId);
    if (plan.archivedAt || plan.lifecycleState === 'deferred' || plan.watchMode !== 'filesystem' || !plan.sourcePath) return;
    try {
      const snapshot = readStableSourceSnapshot(plan.sourcePath);
      if (!isCompleteHtmlSource(snapshot.html)) throw new IncompleteSourceWriteError(plan.sourcePath);
      const htmlChanged = snapshot.fileHash !== version.fileHash;
      const needsWatcherRefresh = this.recoveryWatchers.has(plan.id);
      const assets = discoverSourceAssets(snapshot.html, plan.sourcePath);
      const payload: RegisterPlanInput = {
        repoKey: plan.repoKey,
        repoName: plan.repoName,
        remoteUrl: plan.remoteUrl,
        rootPath: plan.rootPath,
        branch: plan.branch,
        commitSha: plan.commitSha,
        planPath: plan.planPath,
        publicationMetadata: plan.publicationMetadata,
        reviewMode: plan.reviewMode,
        slug: plan.slug,
        html: snapshot.html,
        fileHash: snapshot.fileHash,
        sourcePath: plan.sourcePath,
        sourceMtimeMs: snapshot.sourceMtimeMs,
        sourceSize: snapshot.sourceSize,
        watchMode: 'filesystem',
        assets,
        updateMode: 'upsert'
      };
      const rendered = renderPlan(payload);
      const renderedUnchanged = sha256(rendered.renderedHtml) === sha256(this.store.getRenderedHtml(plan.id, version.id));
      const sourceMetadataUnchanged = version.sourceMtimeMs === snapshot.sourceMtimeMs && version.sourceSize === snapshot.sourceSize;
      if (snapshot.fileHash === version.fileHash && renderedUnchanged && sourceMetadataUnchanged) {
        if (this.store.getPlan(plan.id).plan.lifecycleState !== 'active') return;
        assertSourceSnapshotCurrent(plan.sourcePath, snapshot);
        this.bus.emitEvent(this.store.markPlanSyncSucceeded(plan.id, version.id));
        if (needsWatcherRefresh) await this.register(plan.id);
        return;
      }
      if (this.store.getPlan(plan.id).plan.lifecycleState !== 'active') return;
      const result = this.store.registerPlan(
        payload,
        rendered.renderedHtml,
        rendered.warnings,
        'filesystem_watch',
        () => assertSourceSnapshotCurrent(plan.sourcePath!, snapshot)
      );
      const committed = this.store.getPlan(plan.id);
      if (
        committed.version.fileHash !== snapshot.fileHash ||
        committed.version.sourceMtimeMs !== snapshot.sourceMtimeMs ||
        committed.version.sourceSize !== snapshot.sourceSize ||
        sha256(this.store.getRenderedHtml(plan.id, committed.version.id)) !== sha256(rendered.renderedHtml)
      ) {
        throw new StaleSourceSnapshotError(plan.sourcePath);
      }
      this.bus.emitEvent(result.event);
      if (htmlChanged || needsWatcherRefresh) await this.register(plan.id);
    } catch (error) {
      this.fail(plan.id, error, reason);
      if (error instanceof StaleSourceSnapshotError) this.schedule(plan.id);
    }
  }

  private fail(planId: string, error: unknown, reason = 'filesystem_watch'): void {
    if (this.store.getPlan(planId).plan.lifecycleState !== 'active') return;
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
    const nextAction = code === 'incomplete_source_write'
      ? 'The last good render is still being served. Finish the source write with closing </body> and </html> tags; source sync will retry on the next stable complete change.'
      : code === 'stale_source_snapshot'
        ? 'The last good render is still being served. Source sync observed the file changing during ingestion and will retry automatically on the next stable read.'
        : 'Fix source file permissions/path or run plan-review register <path> --snapshot to keep a detached review.';
    const event = this.store.markPlanSyncFailed(planId, {
      message,
      code,
      reason,
      nextAction
    });
    this.bus.emitEvent(event);
  }
}
