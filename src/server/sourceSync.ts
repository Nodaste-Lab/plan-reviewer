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
    if (plan.archivedAt || plan.watchMode !== 'filesystem' || !plan.sourcePath) return;
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
    if (plan.archivedAt || plan.watchMode !== 'filesystem' || !plan.sourcePath) return;
    try {
      const stat = fs.statSync(plan.sourcePath);
      if (!stat.isFile()) throw new Error(`Source path is not a file: ${plan.sourcePath}`);
      const html = fs.readFileSync(plan.sourcePath, 'utf8');
      const fileHash = sha256(html);
      const htmlChanged = fileHash !== version.fileHash;
      const needsWatcherRefresh = this.recoveryWatchers.has(plan.id);
      const assets = discoverSourceAssets(html, plan.sourcePath);
      const payload: RegisterPlanInput = {
        repoKey: plan.repoKey,
        repoName: plan.repoName,
        branch: plan.branch,
        commitSha: plan.commitSha,
        planPath: plan.planPath,
        slug: plan.slug,
        html,
        fileHash,
        sourcePath: plan.sourcePath,
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
        watchMode: 'filesystem',
        assets,
        updateMode: 'upsert'
      };
      const rendered = renderPlan(payload);
      if (fileHash === version.fileHash && sha256(rendered.renderedHtml) === sha256(this.store.getRenderedHtml(plan.id, version.id))) {
        if (this.store.getPlan(plan.id).plan.archivedAt) return;
        this.bus.emitEvent(this.store.markPlanSyncSucceeded(plan.id, version.id));
        if (needsWatcherRefresh) await this.register(plan.id);
        return;
      }
      if (this.store.getPlan(plan.id).plan.archivedAt) return;
      const result = this.store.registerPlan(payload, rendered.renderedHtml, rendered.warnings, 'filesystem_watch');
      this.bus.emitEvent(result.event);
      if (htmlChanged || needsWatcherRefresh) await this.register(plan.id);
    } catch (error) {
      this.fail(plan.id, error, reason);
    }
  }

  private fail(planId: string, error: unknown, reason = 'filesystem_watch'): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
    const event = this.store.markPlanSyncFailed(planId, {
      message,
      code,
      reason,
      nextAction: 'Fix source file permissions/path or run plan-review register <path> --snapshot to keep a detached review.'
    });
    this.bus.emitEvent(event);
  }
}
