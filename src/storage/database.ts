import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
import type {
  AckCommentInput,
  ClaimCommentsInput,
  CreateCommentInput,
  RegisterPlanInput,
  ResolveCommentInput
} from '../schemas.js';
import { ensureDir, PlanReviewError, sha256, shortHash, slugify } from '../util.js';

export interface PlanRecord {
  id: string;
  repoId: string;
  slug: string;
  planPath: string;
  repoName: string;
  repoKey: string;
  branch: string;
  commitSha?: string;
  sourcePath?: string;
  watchMode: 'filesystem' | 'snapshot';
  lastSyncAt?: string;
  lastSyncStatus?: string;
  lastSyncError?: Record<string, unknown> | null;
  archivedAt?: string;
}

export interface PlanProgress {
  totalPhases: number;
  completedPhases: number;
  phases: Array<{ label: string; complete: boolean }>;
}

export interface VersionRecord {
  id: string;
  planId: string;
  fileHash: string;
  branch: string;
  commitSha?: string;
  renderedBlobPath: string;
  htmlBlobPath: string;
  renderWarnings: unknown[];
  sourceMtimeMs?: number;
  sourceSize?: number;
  syncOrigin: 'manual_register' | 'filesystem_watch';
}

export interface StoredEvent {
  id: string;
  planId: string;
  sequence: number;
  eventType: string;
  commentId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StoredComment {
  id: string;
  planId: string;
  versionId: string;
  sequence: number;
  status: string;
  body: string;
  anchorType: string;
  anchorState: string;
  anchor: Record<string, unknown>;
  screenshotAssetId?: string;
  conversationPayload: Record<string, unknown>;
  agentResponse?: Record<string, unknown>;
  createdBy: Record<string, unknown>;
  createdAt: string;
  claim?: { id: string; agentId: string; leaseExpiresAt: string } | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return 'unknown-host';
  }
}

function inferAssetContentType(sourceUrl: string, bytes: Buffer): string | null {
  const ext = path.extname(sourceUrl.split(/[?#]/, 1)[0] || '').toLowerCase();
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || ext === '.png') return 'image/png';
  if ((bytes[0] === 0xff && bytes[1] === 0xd8) || ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a' || ext === '.gif') return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' || ext === '.webp') return 'image/webp';
  if (bytes.subarray(0, 512).toString('utf8').trimStart().startsWith('<svg') || ext === '.svg') return 'image/svg+xml';
  return null;
}

function inferAssetDimensions(bytes: Buffer): { width?: number; height?: number } {
  const isPng = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) return {};
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function progressScope(html: string): string {
  const htmlHeading = /<h[1-6]\b[^>]*>\s*Progress\s*<\/h[1-6]>/i.exec(html);
  if (htmlHeading) {
    const afterHeading = html.slice(htmlHeading.index);
    const sectionEnd = afterHeading.search(/<\/section>/i);
    return sectionEnd >= 0 ? afterHeading.slice(0, sectionEnd) : afterHeading;
  }
  const markdownHeading = /^##\s+Progress\s*$/im.exec(html);
  if (markdownHeading) {
    const afterHeading = html.slice(markdownHeading.index + markdownHeading[0].length);
    const nextHeading = afterHeading.search(/^##\s+/m);
    return nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  }
  return html;
}

function extractPlanProgress(html: string): PlanProgress {
  const scope = progressScope(html);
  const phases: PlanProgress['phases'] = [];
  for (const match of scope.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const itemHtml = match[1] ?? '';
    const checkbox = /<input\b(?=[^>]*\btype=["']?checkbox)[^>]*>/i.exec(itemHtml)?.[0];
    if (!checkbox) continue;
    const label = stripHtml(itemHtml).replace(/^\s*checked\s*/i, '').trim();
    if (!/\b(?:P\d+|Phase\s+\d+)\b/i.test(label)) continue;
    phases.push({ label, complete: /\bchecked(?:\s|=|>|\/)/i.test(checkbox) });
  }
  if (phases.length === 0) {
    for (const match of scope.matchAll(/(?:^|\n)\s*[-*]\s*\[([ xX])\]\s*([^\n]+)/g)) {
      const label = String(match[2] ?? '').trim();
      if (!/\b(?:P\d+|Phase\s+\d+)\b/i.test(label)) continue;
      phases.push({ label, complete: String(match[1]).toLowerCase() === 'x' });
    }
  }
  return {
    totalPhases: phases.length,
    completedPhases: phases.filter(phase => phase.complete).length,
    phases
  };
}

export class PlanReviewStore {
  private db: Database.Database;
  private blobDir: string;

  constructor(public dbPath: string) {
    ensureDir(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.blobDir = path.join(path.dirname(dbPath), 'blobs');
    ensureDir(this.blobDir);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        repo_key TEXT NOT NULL UNIQUE,
        repo_name TEXT NOT NULL,
        remote_url TEXT,
        root_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id),
        slug TEXT NOT NULL,
        plan_path TEXT NOT NULL,
        source_path TEXT,
        watch_mode TEXT NOT NULL DEFAULT 'snapshot',
        last_sync_at TEXT,
        last_sync_status TEXT,
        last_sync_error_json TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_id, plan_path, slug)
      );
      CREATE TABLE IF NOT EXISTS plan_versions (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        file_hash TEXT NOT NULL,
        branch TEXT NOT NULL,
        commit_sha TEXT,
        html_blob_path TEXT NOT NULL,
        rendered_blob_path TEXT NOT NULL,
        render_warnings_json TEXT NOT NULL,
        source_mtime_ms REAL,
        source_size INTEGER,
        sync_origin TEXT NOT NULL DEFAULT 'manual_register',
        created_at TEXT NOT NULL,
        UNIQUE(plan_id, file_hash, branch, commit_sha)
      );
      CREATE TABLE IF NOT EXISTS plan_assets (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES plan_versions(id),
        source_url TEXT NOT NULL,
        asset_hash TEXT,
        content_type TEXT,
        width INTEGER,
        height INTEGER,
        blob_path TEXT,
        status TEXT NOT NULL,
        warning_json TEXT,
        UNIQUE(version_id, source_url)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        version_id TEXT NOT NULL REFERENCES plan_versions(id),
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        anchor_type TEXT NOT NULL,
        anchor_state TEXT NOT NULL,
        anchor_json TEXT NOT NULL,
        screenshot_asset_id TEXT,
        conversation_payload_json TEXT NOT NULL,
        agent_response_json TEXT,
        created_by_json TEXT NOT NULL,
        client_mutation_id TEXT,
        claim_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(plan_id, sequence),
        UNIQUE(plan_id, client_mutation_id)
      );
      CREATE TABLE IF NOT EXISTS comment_assets (
        id TEXT PRIMARY KEY,
        comment_id TEXT REFERENCES comments(id),
        asset_type TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        capture_rect_json TEXT,
        viewport_json TEXT,
        blob_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comment_events (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        comment_id TEXT,
        client_mutation_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(plan_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL REFERENCES comments(id),
        agent_id TEXT NOT NULL,
        ack_client_mutation_id TEXT,
        lease_expires_at TEXT NOT NULL,
        released_at TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_claim
        ON claims(comment_id)
        WHERE released_at IS NULL AND acknowledged_at IS NULL;
    `);
    this.ensureColumn('plans', 'source_path', 'TEXT');
    this.ensureColumn('plans', 'watch_mode', "TEXT NOT NULL DEFAULT 'snapshot'");
    this.ensureColumn('plans', 'last_sync_at', 'TEXT');
    this.ensureColumn('plans', 'last_sync_status', 'TEXT');
    this.ensureColumn('plans', 'last_sync_error_json', 'TEXT');
    this.ensureColumn('plans', 'archived_at', 'TEXT');
    this.ensureColumn('plan_versions', 'source_mtime_ms', 'REAL');
    this.ensureColumn('plan_versions', 'source_size', 'INTEGER');
    this.ensureColumn('plan_versions', 'sync_origin', "TEXT NOT NULL DEFAULT 'manual_register'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(item => item.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }

  private nextEventSequence(planId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM comment_events WHERE plan_id = ?')
      .get(planId) as { next: number };
    return row.next;
  }

  private nextCommentSequence(planId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM comments WHERE plan_id = ?')
      .get(planId) as { next: number };
    return row.next;
  }

  private addEvent(planId: string, eventType: string, payload: Record<string, unknown>, commentId?: string): StoredEvent {
    const event: StoredEvent = {
      id: id('evt'),
      planId,
      sequence: this.nextEventSequence(planId),
      eventType,
      commentId,
      payload: { ...payload, sequence: undefined },
      createdAt: nowIso()
    };
    const payloadJson = JSON.stringify({ ...payload, sequence: event.sequence });
    this.db
      .prepare(`INSERT INTO comment_events (id, plan_id, sequence, event_type, comment_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, planId, event.sequence, eventType, commentId ?? null, payloadJson, event.createdAt);
    this.pruneEvents(planId);
    event.payload = parseJson(payloadJson, {});
    return event;
  }

  private eventFromRow(row: Record<string, unknown>): StoredEvent {
    return {
      id: String(row.id),
      planId: String(row.plan_id),
      sequence: Number(row.sequence),
      eventType: String(row.event_type),
      commentId: row.comment_id ? String(row.comment_id) : undefined,
      payload: parseJson(String(row.payload_json), {}),
      createdAt: String(row.created_at)
    };
  }

  private getCommentCreatedEvent(commentId: string): StoredEvent {
    const row = this.db.prepare(`
      SELECT * FROM comment_events
      WHERE comment_id = ? AND event_type = 'comment.created'
      ORDER BY sequence ASC
      LIMIT 1
    `).get(commentId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new PlanReviewError('not_found', `Created event for comment '${commentId}' was not found`, 404);
    }
    return this.eventFromRow(row);
  }

  private pruneEvents(planId: string): void {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare(`DELETE FROM comment_events
        WHERE plan_id = ?
          AND created_at < ?
          AND id NOT IN (
            SELECT id FROM comment_events WHERE plan_id = ? ORDER BY sequence DESC LIMIT 10000
          )`)
      .run(planId, cutoff, planId);
  }

  private writeBlob(kind: string, name: string, content: Buffer | string): string {
    const dir = path.join(this.blobDir, kind);
    ensureDir(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  registerPlan(input: RegisterPlanInput, renderedHtml: string, renderWarnings: unknown[], syncOrigin: 'manual_register' | 'filesystem_watch' = 'manual_register') {
    const tx = this.db.transaction(() => {
      const now = nowIso();
      const repoKey =
        input.repoKey ||
        input.remoteUrl ||
        `${input.rootPath || process.cwd()}@${hostname()}`;
      const repoId =
        (this.db.prepare('SELECT id FROM repos WHERE repo_key = ?').get(repoKey) as { id: string } | undefined)
          ?.id || id('repo');
      this.db
        .prepare(`INSERT INTO repos (id, repo_key, repo_name, remote_url, root_path, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_key) DO UPDATE SET repo_name = excluded.repo_name, remote_url = excluded.remote_url,
            root_path = excluded.root_path, updated_at = excluded.updated_at`)
        .run(repoId, repoKey, input.repoName, input.remoteUrl ?? null, input.rootPath ?? null, now, now);

      const baseSlug = input.slug || slugify(path.basename(input.planPath, path.extname(input.planPath)));
      const existingPlan =
        input.updateMode === 'new-thread'
          ? undefined
          : (this.db
              .prepare('SELECT id FROM plans WHERE repo_id = ? AND plan_path = ? AND slug = ?')
              .get(repoId, input.planPath, baseSlug) as { id: string } | undefined);
      const planId = existingPlan?.id || id('plan');
      const slug = input.updateMode === 'new-thread' ? `${baseSlug}-${shortHash(planId)}` : baseSlug;
      const watchMode = input.watchMode ?? 'snapshot';
      const lastSyncStatus = watchMode === 'filesystem' ? 'synced' : 'snapshot';
      this.db
        .prepare(`INSERT INTO plans (id, repo_id, slug, plan_path, source_path, watch_mode, last_sync_at, last_sync_status, last_sync_error_json, archived_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(repo_id, plan_path, slug) DO UPDATE SET updated_at = excluded.updated_at,
            source_path = excluded.source_path, watch_mode = excluded.watch_mode,
            last_sync_at = excluded.last_sync_at, last_sync_status = excluded.last_sync_status,
            last_sync_error_json = excluded.last_sync_error_json,
            archived_at = plans.archived_at`)
        .run(planId, repoId, slug, input.planPath, input.sourcePath ?? null, watchMode, now, lastSyncStatus, null, now, now);

      const htmlName = `${input.fileHash}.html`;
      const renderedName = `${sha256(renderedHtml)}.rendered.html`;
      const htmlBlobPath = this.writeBlob('html', htmlName, input.html);
      const renderedBlobPath = this.writeBlob('rendered', renderedName, renderedHtml);
      const commitSha = input.commitSha ?? '';
      const existingVersion = this.db
        .prepare('SELECT id FROM plan_versions WHERE plan_id = ? AND file_hash = ? AND branch = ? AND commit_sha = ?')
        .get(planId, input.fileHash, input.branch, commitSha) as { id: string } | undefined;
      const versionId = existingVersion?.id || id('ver');
      this.db
        .prepare(`INSERT INTO plan_versions
          (id, plan_id, file_hash, branch, commit_sha, html_blob_path, rendered_blob_path, render_warnings_json, source_mtime_ms, source_size, sync_origin, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(plan_id, file_hash, branch, commit_sha) DO UPDATE SET
            html_blob_path = excluded.html_blob_path, rendered_blob_path = excluded.rendered_blob_path,
            source_mtime_ms = excluded.source_mtime_ms, source_size = excluded.source_size,
            sync_origin = excluded.sync_origin, created_at = excluded.created_at,
            render_warnings_json = excluded.render_warnings_json`)
        .run(
          versionId,
          planId,
          input.fileHash,
          input.branch,
          commitSha,
          htmlBlobPath,
          renderedBlobPath,
          JSON.stringify(renderWarnings),
          input.sourceMtimeMs ?? null,
          input.sourceSize ?? null,
          syncOrigin,
          now
        );

      for (const asset of input.assets ?? []) {
        const bytes = asset.bytesBase64 ? Buffer.from(asset.bytesBase64, 'base64') : Buffer.from('');
        const assetHash = bytes.length > 0 ? sha256(bytes) : null;
        const blobPath = bytes.length > 0 && assetHash ? this.writeBlob('assets', assetHash, bytes) : null;
        const contentType = bytes.length > 0 ? inferAssetContentType(asset.sourceUrl, bytes) : null;
        const dimensions = bytes.length > 0 ? inferAssetDimensions(bytes) : {};
        this.db
          .prepare(`INSERT INTO plan_assets (id, version_id, source_url, asset_hash, content_type, width, height, blob_path, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(version_id, source_url) DO UPDATE SET asset_hash = excluded.asset_hash,
              content_type = excluded.content_type, width = excluded.width, height = excluded.height,
              blob_path = excluded.blob_path, status = excluded.status`)
          .run(id('asset'), versionId, asset.sourceUrl, assetHash, contentType, dimensions.width ?? null, dimensions.height ?? null, blobPath, blobPath ? 'copied' : 'missing');
      }

      const eventType = syncOrigin === 'filesystem_watch' ? 'plan.version.synced' : 'plan.version.registered';
      const event = this.addEvent(planId, eventType, {
        planId,
        versionId,
        eventType,
        sourcePath: input.sourcePath,
        watchMode,
        lastSyncStatus
      });

      return {
        planId,
        versionId,
        repoId,
        repoKey,
        slug,
        sourceSync: { watchMode, sourcePath: input.sourcePath, status: lastSyncStatus, active: watchMode === 'filesystem' },
        event,
        reviewUrl: `/p/${planId}`,
        indexUrl: '/',
        watchCommand: `plan-review watch ${planId} --mode queue`
      };
    });
    return tx();
  }

  listPlans(options: { includeArchived?: boolean } = {}) {
    const archiveFilter = options.includeArchived ? '' : 'WHERE p.archived_at IS NULL';
    const rows = this.db.prepare(`
      SELECT p.id, p.slug, p.plan_path AS planPath, p.source_path AS sourcePath, p.watch_mode AS watchMode,
        p.last_sync_at AS lastSyncAt, p.last_sync_status AS lastSyncStatus, p.last_sync_error_json AS lastSyncErrorJson,
        p.archived_at AS archivedAt,
        r.repo_name AS repoName, r.repo_key AS repoKey,
        v.id AS versionId, v.branch, v.commit_sha AS commitSha, v.file_hash AS fileHash,
        v.html_blob_path AS htmlBlobPath,
        v.source_mtime_ms AS sourceMtimeMs, v.source_size AS sourceSize, v.sync_origin AS syncOrigin,
        p.updated_at AS planUpdatedAt,
        SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN c.status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN c.status = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
        SUM(CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
        MAX(COALESCE(c.updated_at, c.created_at)) AS commentActivityAt
      FROM plans p
      JOIN repos r ON r.id = p.repo_id
      LEFT JOIN plan_versions v ON v.id = (
        SELECT id FROM plan_versions WHERE plan_id = p.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN comments c ON c.plan_id = p.id
      ${archiveFilter}
      GROUP BY p.id
    `).all() as Array<Record<string, unknown>>;
    return rows.map(row => {
      const planUpdatedAt = String(row.planUpdatedAt ?? '');
      const commentActivityAt = row.commentActivityAt ? String(row.commentActivityAt) : '';
      const activityAt = commentActivityAt > planUpdatedAt ? commentActivityAt : planUpdatedAt;
      const htmlBlobPath = optionalString(row.htmlBlobPath);
      const progress = htmlBlobPath ? extractPlanProgress(fs.readFileSync(htmlBlobPath, 'utf8')) : { totalPhases: 0, completedPhases: 0, phases: [] };
      return {
      plan: {
        id: row.id,
        slug: row.slug,
        planPath: row.planPath,
        repoName: row.repoName,
        repoKey: row.repoKey,
        sourcePath: optionalString(row.sourcePath),
        watchMode: (row.watchMode ?? 'snapshot') as 'filesystem' | 'snapshot',
        lastSyncAt: optionalString(row.lastSyncAt),
        lastSyncStatus: optionalString(row.lastSyncStatus),
        lastSyncError: parseJson(row.lastSyncErrorJson as string | null, null),
        archivedAt: optionalString(row.archivedAt)
      },
      latestVersion: {
        id: row.versionId,
        branch: row.branch,
        commitSha: row.commitSha,
        fileHash: row.fileHash,
        sourceMtimeMs: optionalNumber(row.sourceMtimeMs),
        sourceSize: optionalNumber(row.sourceSize),
        syncOrigin: (row.syncOrigin ?? 'manual_register') as 'manual_register' | 'filesystem_watch'
      },
      counts: {
        pending: Number(row.pending ?? 0),
        claimed: Number(row.claimed ?? 0),
        acknowledged: Number(row.acknowledged ?? 0),
        resolved: Number(row.resolved ?? 0)
      },
      progress,
      activityAt,
      reviewUrl: `/p/${row.id}`
      };
    }).sort((a, b) => String(b.activityAt).localeCompare(String(a.activityAt)));
  }

  listPlanAssets(versionId: string) {
    const rows = this.db
      .prepare(`SELECT id, source_url AS sourceUrl, asset_hash AS assetHash, content_type AS contentType,
        width, height, status, warning_json AS warningJson
        FROM plan_assets WHERE version_id = ? ORDER BY source_url`)
      .all(versionId) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      id: String(row.id),
      sourceUrl: String(row.sourceUrl),
      assetHash: row.assetHash ?? undefined,
      contentType: row.contentType ?? undefined,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      status: String(row.status),
      warning: parseJson(row.warningJson as string | null, null)
    }));
  }

  getPlan(identifier: string): { plan: PlanRecord; version: VersionRecord } {
    const row = this.db.prepare(`
      SELECT p.id, p.repo_id AS repoId, p.slug, p.plan_path AS planPath, p.source_path AS sourcePath,
        p.watch_mode AS watchMode, p.last_sync_at AS lastSyncAt, p.last_sync_status AS lastSyncStatus,
        p.last_sync_error_json AS lastSyncErrorJson, p.archived_at AS archivedAt, r.repo_name AS repoName, r.repo_key AS repoKey,
        v.id AS versionId, v.file_hash AS fileHash, v.branch, v.commit_sha AS commitSha,
        v.html_blob_path AS htmlBlobPath, v.rendered_blob_path AS renderedBlobPath,
        v.render_warnings_json AS renderWarningsJson, v.source_mtime_ms AS sourceMtimeMs,
        v.source_size AS sourceSize, v.sync_origin AS syncOrigin
      FROM plans p
      JOIN repos r ON r.id = p.repo_id
      JOIN plan_versions v ON v.id = (
        SELECT id FROM plan_versions WHERE plan_id = p.id ORDER BY created_at DESC LIMIT 1
      )
      WHERE p.id = ?
      LIMIT 1
    `).get(identifier) as Record<string, string> | undefined;
    const slugRows = row ? [] : this.db.prepare(`
      SELECT p.id, p.repo_id AS repoId, p.slug, p.plan_path AS planPath, p.source_path AS sourcePath,
        p.watch_mode AS watchMode, p.last_sync_at AS lastSyncAt, p.last_sync_status AS lastSyncStatus,
        p.last_sync_error_json AS lastSyncErrorJson, p.archived_at AS archivedAt, r.repo_name AS repoName, r.repo_key AS repoKey,
        v.id AS versionId, v.file_hash AS fileHash, v.branch, v.commit_sha AS commitSha,
        v.html_blob_path AS htmlBlobPath, v.rendered_blob_path AS renderedBlobPath,
        v.render_warnings_json AS renderWarningsJson, v.source_mtime_ms AS sourceMtimeMs,
        v.source_size AS sourceSize, v.sync_origin AS syncOrigin
      FROM plans p
      JOIN repos r ON r.id = p.repo_id
      JOIN plan_versions v ON v.id = (
        SELECT id FROM plan_versions WHERE plan_id = p.id ORDER BY created_at DESC LIMIT 1
      )
      WHERE p.slug = ?
      ORDER BY p.updated_at DESC
      LIMIT 2
    `).all(identifier) as Array<Record<string, string>>;
    if (!row && slugRows.length > 1) {
      throw new PlanReviewError('ambiguous_plan_slug', `Plan slug '${identifier}' matches multiple registered plans`, 409, {
        matches: slugRows.map(item => ({ planId: item.id, repoKey: item.repoKey, planPath: item.planPath }))
      }, 'Use the plan ID from plan-review index instead of the ambiguous slug.');
    }
    const selectedRow = row ?? slugRows[0];
    if (!selectedRow) {
      throw new PlanReviewError('not_found', `Plan '${identifier}' was not found`, 404, {}, 'Register the plan first.');
    }
    return {
      plan: {
        id: selectedRow.id,
        repoId: selectedRow.repoId,
        slug: selectedRow.slug,
        planPath: selectedRow.planPath,
        repoName: selectedRow.repoName,
        repoKey: selectedRow.repoKey,
        branch: selectedRow.branch,
        commitSha: selectedRow.commitSha ?? undefined,
        sourcePath: optionalString(selectedRow.sourcePath),
        watchMode: (selectedRow.watchMode ?? 'snapshot') as 'filesystem' | 'snapshot',
        lastSyncAt: optionalString(selectedRow.lastSyncAt),
        lastSyncStatus: optionalString(selectedRow.lastSyncStatus),
        lastSyncError: parseJson(selectedRow.lastSyncErrorJson, null),
        archivedAt: optionalString(selectedRow.archivedAt)
      },
      version: {
        id: selectedRow.versionId,
        planId: selectedRow.id,
        fileHash: selectedRow.fileHash,
        branch: selectedRow.branch,
        commitSha: selectedRow.commitSha ?? undefined,
        htmlBlobPath: selectedRow.htmlBlobPath,
        renderedBlobPath: selectedRow.renderedBlobPath,
        renderWarnings: parseJson(selectedRow.renderWarningsJson, []),
        sourceMtimeMs: optionalNumber(selectedRow.sourceMtimeMs),
        sourceSize: optionalNumber(selectedRow.sourceSize),
        syncOrigin: (selectedRow.syncOrigin ?? 'manual_register') as 'manual_register' | 'filesystem_watch'
      }
    };
  }

  getRenderedHtml(identifier: string, versionId?: string): string {
    const { plan, version } = this.getPlan(identifier);
    if (!versionId) return fs.readFileSync(version.renderedBlobPath, 'utf8');
    const row = this.db.prepare('SELECT rendered_blob_path AS renderedBlobPath FROM plan_versions WHERE id = ? AND plan_id = ?')
      .get(versionId, plan.id) as { renderedBlobPath: string } | undefined;
    if (!row) throw new PlanReviewError('not_found', `Version '${versionId}' was not found for plan '${plan.id}'`, 404);
    return fs.readFileSync(row.renderedBlobPath, 'utf8');
  }

  archivePlan(identifier: string): { plan: PlanRecord; event: StoredEvent } {
    const { plan } = this.getPlan(identifier);
    const archivedAt = plan.archivedAt ?? nowIso();
    if (!plan.archivedAt) {
      this.db.prepare('UPDATE plans SET archived_at = ?, updated_at = ? WHERE id = ?').run(archivedAt, archivedAt, plan.id);
    }
    const updated = this.getPlan(plan.id).plan;
    const event = this.addEvent(plan.id, 'plan.archived', { eventType: 'plan.archived', planId: plan.id, archivedAt });
    return { plan: updated, event };
  }

  unarchivePlan(identifier: string): { plan: PlanRecord; event: StoredEvent } {
    const { plan } = this.getPlan(identifier);
    const unarchivedAt = nowIso();
    if (plan.archivedAt) {
      this.db.prepare('UPDATE plans SET archived_at = NULL, updated_at = ? WHERE id = ?').run(unarchivedAt, plan.id);
    }
    const updated = this.getPlan(plan.id).plan;
    const event = this.addEvent(plan.id, 'plan.unarchived', { eventType: 'plan.unarchived', planId: plan.id, unarchivedAt });
    return { plan: updated, event };
  }

  listFilesystemPlans(): Array<{ planId: string }> {
    const rows = this.db.prepare("SELECT id AS planId FROM plans WHERE watch_mode = 'filesystem' AND source_path IS NOT NULL AND archived_at IS NULL ORDER BY updated_at DESC").all() as Array<{ planId: string }>;
    return rows;
  }

  markPlanSyncSucceeded(planId: string, versionId?: string): StoredEvent {
    const now = nowIso();
    this.db.prepare("UPDATE plans SET last_sync_at = ?, last_sync_status = 'synced', last_sync_error_json = NULL, updated_at = ? WHERE id = ?")
      .run(now, now, planId);
    return this.addEvent(planId, 'plan.version.synced', {
      eventType: 'plan.version.synced',
      planId,
      versionId,
      lastSyncStatus: 'synced'
    });
  }

  markPlanSyncFailed(planId: string, error: Record<string, unknown>): StoredEvent {
    const now = nowIso();
    this.db.prepare("UPDATE plans SET last_sync_at = ?, last_sync_status = 'failed', last_sync_error_json = ?, updated_at = ? WHERE id = ?")
      .run(now, JSON.stringify(error), now, planId);
    return this.addEvent(planId, 'plan.sync.failed', {
      eventType: 'plan.sync.failed',
      planId,
      lastSyncStatus: 'failed',
      error
    });
  }

  createComment(planId: string, input: CreateCommentInput): { comment: StoredComment; event: StoredEvent; created: boolean } {
    const tx = this.db.transaction(() => {
      const version = this.db
        .prepare('SELECT id FROM plan_versions WHERE id = ? AND plan_id = ?')
        .get(input.versionId, planId) as { id: string } | undefined;
      if (!version) {
        throw new PlanReviewError('validation_failed', 'Comment versionId must belong to the requested plan', 400, {
          planId,
          versionId: input.versionId
        });
      }
      const duplicate = input.clientMutationId
        ? this.db.prepare('SELECT id FROM comments WHERE plan_id = ? AND client_mutation_id = ?').get(planId, input.clientMutationId) as { id: string } | undefined
        : undefined;
      if (duplicate) {
        return { comment: this.getComment(duplicate.id), event: this.getCommentCreatedEvent(duplicate.id), created: false };
      }

      const now = nowIso();
      const commentId = id('cmt');
      const sequence = this.nextCommentSequence(planId);
      let screenshotAssetId: string | undefined;
      let screenshotAsset: {
        contentHash: string;
        blobPath: string;
        width: number;
        height: number;
        captureRect: unknown;
        viewport: unknown;
      } | undefined;
      if (input.markerScreenshot) {
        screenshotAssetId = id('asset');
        const bytes = Buffer.from(input.markerScreenshot.bytesBase64, 'base64');
        const contentHash = sha256(bytes);
        const blobPath = this.writeBlob('comment-assets', `${contentHash}.png`, bytes);
        screenshotAsset = {
          contentHash,
          blobPath,
          width: input.markerScreenshot.width,
          height: input.markerScreenshot.height,
          captureRect: input.markerScreenshot.captureRect,
          viewport: input.markerScreenshot.viewport
        };
      }

      const createdByName = input.createdBy?.displayName?.trim() || 'Anonymous reviewer';
      const conversationPayload = this.buildConversationPayload(planId, commentId, sequence, input, screenshotAssetId);
      this.db
        .prepare(`INSERT INTO comments
          (id, plan_id, version_id, sequence, status, body, anchor_type, anchor_state, anchor_json,
            screenshot_asset_id, conversation_payload_json, created_by_json, client_mutation_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, 'mapped', ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          commentId,
          planId,
          input.versionId,
          sequence,
          input.body,
          input.anchorType,
          JSON.stringify(input.anchor),
          screenshotAssetId ?? null,
          JSON.stringify(conversationPayload),
          JSON.stringify({ type: 'reviewer', displayName: createdByName }),
          input.clientMutationId ?? null,
          now,
          now
        );
      if (screenshotAssetId && screenshotAsset) {
        this.db
          .prepare(`INSERT INTO comment_assets
            (id, comment_id, asset_type, content_hash, content_type, width, height, capture_rect_json, viewport_json, blob_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            screenshotAssetId,
            commentId,
            'marker_screenshot',
            screenshotAsset.contentHash,
            'image/png',
            screenshotAsset.width,
            screenshotAsset.height,
            JSON.stringify(screenshotAsset.captureRect),
            JSON.stringify(screenshotAsset.viewport),
            screenshotAsset.blobPath,
            now
          );
      }
      const comment = this.getComment(commentId);
      const event = this.addEvent(planId, 'comment.created', {
        eventType: 'comment.created',
        planId,
        commentId,
        comment
      }, commentId);
      return { comment, event, created: true };
    });
    return tx();
  }

  private buildConversationPayload(
    planId: string,
    commentId: string,
    markerNumber: number,
    input: CreateCommentInput,
    screenshotAssetId?: string
  ) {
    const textPreview =
      String(input.anchor.textPreview ?? input.anchor.selectedText ?? input.anchor.cssSelector ?? input.anchorType);
    return {
      type: 'browser.comment.v1',
      commentId,
      conversationHint: {
        mode: 'append-to-active-thread',
        title: `Comment ${markerNumber} on ${textPreview.slice(0, 80)}`,
        summary: input.body.slice(0, 240)
      },
      evidence: {
        reviewUrl: `/p/${planId}`,
        selector: input.anchor.cssSelector,
        markerNumber,
        textPreview,
        screenshotAssetId
      },
      body: input.body
    };
  }

  getComment(commentId: string): StoredComment {
    const row = this.db.prepare(`
      SELECT c.*, cl.id AS activeClaimId, cl.agent_id AS activeAgentId, cl.lease_expires_at AS activeLeaseExpiresAt
      FROM comments c
      LEFT JOIN claims cl ON cl.id = c.claim_id AND cl.released_at IS NULL AND cl.acknowledged_at IS NULL
      WHERE c.id = ?
    `).get(commentId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new PlanReviewError('not_found', `Comment '${commentId}' was not found`, 404);
    }
    return this.commentFromRow(row);
  }

  private commentFromRow(row: Record<string, unknown>): StoredComment {
    return {
      id: String(row.id),
      planId: String(row.plan_id),
      versionId: String(row.version_id),
      sequence: Number(row.sequence),
      status: String(row.status),
      body: String(row.body),
      anchorType: String(row.anchor_type),
      anchorState: String(row.anchor_state),
      anchor: parseJson(String(row.anchor_json), {}),
      screenshotAssetId: row.screenshot_asset_id ? String(row.screenshot_asset_id) : undefined,
      conversationPayload: parseJson(String(row.conversation_payload_json), {}),
      agentResponse: row.agent_response_json ? parseJson(String(row.agent_response_json), {}) : undefined,
      createdBy: parseJson(String(row.created_by_json), {}),
      createdAt: String(row.created_at),
      claim: row.activeClaimId
        ? {
            id: String(row.activeClaimId),
            agentId: String(row.activeAgentId),
            leaseExpiresAt: String(row.activeLeaseExpiresAt)
          }
        : null
    };
  }

  private remapAnchorState(comment: StoredComment, currentVersion: VersionRecord, renderedHtml: string): StoredComment {
    if (comment.versionId === currentVersion.id) return comment;

    const anchor = comment.anchor;
    const planNodeId = typeof anchor.planNodeId === 'string' ? anchor.planNodeId : undefined;
    const cssSelector = typeof anchor.cssSelector === 'string' ? anchor.cssSelector : undefined;
    const cssId = cssSelector?.startsWith('#') ? cssSelector.slice(1) : undefined;
    const imageHash = typeof anchor.imageHash === 'string' ? anchor.imageHash : undefined;
    const sourceUrl = typeof anchor.sourceUrl === 'string' ? anchor.sourceUrl : undefined;
    const exact = typeof (anchor.textQuote as { exact?: unknown } | undefined)?.exact === 'string'
      ? (anchor.textQuote as { exact: string }).exact
      : undefined;
    const selectedText = typeof anchor.selectedText === 'string' ? anchor.selectedText : undefined;
    const textPreview = typeof anchor.textPreview === 'string' ? anchor.textPreview : undefined;

    const nodeMatches = Boolean(planNodeId && renderedHtml.includes(`data-plan-node-id="${planNodeId}"`));
    const quoteMatches = Boolean(
      (exact && renderedHtml.includes(exact)) ||
      (selectedText && renderedHtml.includes(selectedText)) ||
      (textPreview && renderedHtml.includes(textPreview))
    );

    if ((imageHash && renderedHtml.includes(imageHash)) || (nodeMatches && quoteMatches)) {
      return { ...comment, anchorState: 'mapped' };
    }

    if (
      nodeMatches ||
      (cssId && renderedHtml.includes(`id="${cssId}"`)) ||
      (sourceUrl && renderedHtml.includes(sourceUrl)) ||
      (exact && renderedHtml.includes(exact)) ||
      (selectedText && renderedHtml.includes(selectedText)) ||
      (textPreview && renderedHtml.includes(textPreview))
    ) {
      return { ...comment, anchorState: 'stale' };
    }

    return { ...comment, anchorState: 'unmapped' };
  }

  listComments(planId: string, filters: { status?: string; anchorState?: string; sinceSequence?: number; versionId?: string } = {}) {
    const clauses = ['c.plan_id = ?'];
    const params: unknown[] = [planId];
    if (filters.versionId) {
      clauses.push('c.version_id = ?');
      params.push(filters.versionId);
    }
    if (filters.status) {
      clauses.push('c.status = ?');
      params.push(filters.status);
    }
    if (filters.sinceSequence) {
      clauses.push('c.sequence > ?');
      params.push(filters.sinceSequence);
    }
    const rows = this.db
      .prepare(`
        SELECT c.*, cl.id AS activeClaimId, cl.agent_id AS activeAgentId, cl.lease_expires_at AS activeLeaseExpiresAt
        FROM comments c
        LEFT JOIN claims cl ON cl.id = c.claim_id AND cl.released_at IS NULL AND cl.acknowledged_at IS NULL
        WHERE ${clauses.join(' AND ')}
        ORDER BY c.sequence ASC
      `)
      .all(...params) as Array<Record<string, unknown>>;
    const currentVersion = this.getPlan(planId).version;
    const renderedHtml = fs.readFileSync(currentVersion.renderedBlobPath, 'utf8');
    const comments = rows.map(row => this.remapAnchorState(this.commentFromRow(row), currentVersion, renderedHtml));
    return filters.anchorState ? comments.filter(comment => comment.anchorState === filters.anchorState) : comments;
  }

  releaseExpiredClaims(planId?: string): StoredEvent[] {
    const now = nowIso();
    const rows = this.db.prepare(`
      SELECT cl.id, cl.comment_id AS commentId, c.plan_id AS planId
      FROM claims cl
      JOIN comments c ON c.id = cl.comment_id
      WHERE cl.released_at IS NULL AND cl.acknowledged_at IS NULL AND cl.lease_expires_at <= ?
        ${planId ? 'AND c.plan_id = ?' : ''}
    `).all(...(planId ? [now, planId] : [now])) as Array<{ id: string; commentId: string; planId: string }>;
    const tx = this.db.transaction(() => {
      const events: StoredEvent[] = [];
      for (const row of rows) {
        this.db.prepare('UPDATE claims SET released_at = ? WHERE id = ?').run(now, row.id);
        this.db.prepare("UPDATE comments SET status = 'pending', claim_id = NULL, updated_at = ? WHERE id = ?").run(now, row.commentId);
        events.push(this.addEvent(row.planId, 'comment.released', {
          eventType: 'comment.released',
          planId: row.planId,
          commentId: row.commentId,
          reason: 'lease_expired'
        }, row.commentId));
      }
      return events;
    });
    return tx();
  }

  claimComments(planId: string, input: ClaimCommentsInput, agentId = 'plan-review-cli') {
    const tx = this.db.transaction(() => {
      const expiredEvents = this.releaseExpiredClaims(planId);
      if (input.mode === 'one' && input.commentIds?.length) {
        throw new PlanReviewError('validation_failed', 'mode=one does not accept commentIds', 400);
      }
      if (input.mode === 'selected' && (!input.commentIds || input.commentIds.length === 0)) {
        throw new PlanReviewError('validation_failed', 'mode=selected requires commentIds', 400);
      }
      if (input.mode === 'selected' && input.limit) {
        throw new PlanReviewError('validation_failed', 'mode=selected does not accept limit', 400);
      }
      if (input.mode === 'bulk' && input.commentIds?.length) {
        throw new PlanReviewError('validation_failed', 'mode=bulk does not accept commentIds', 400);
      }

      const limit = input.mode === 'one' ? 1 : input.limit ?? 50;
      const comments =
        input.mode === 'selected'
          ? input.commentIds!.map(commentId => this.getComment(commentId))
          : this.listComments(planId, { status: 'pending' }).slice(0, limit);
      const leaseExpiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
      const claimed: StoredComment[] = [];
      const events: StoredEvent[] = [...expiredEvents];
      const skipped: Array<{ commentId: string; reason: string }> = [];
      for (const comment of comments) {
        if (comment.planId !== planId || comment.status !== 'pending') {
          if (input.mode === 'selected' && comment.status === 'claimed') {
            throw new PlanReviewError('claim_conflict', `Comment ${comment.id} is already claimed`, 409, {
              currentHolder: comment.claim?.agentId,
              leaseExpiresAt: comment.claim?.leaseExpiresAt
            });
          }
          skipped.push({ commentId: comment.id, reason: 'not_pending' });
          continue;
        }
        const claimId = id('claim');
        try {
          this.db
            .prepare(`INSERT INTO claims (id, comment_id, agent_id, lease_expires_at, created_at)
              VALUES (?, ?, ?, ?, ?)`)
            .run(claimId, comment.id, agentId, leaseExpiresAt, nowIso());
        } catch {
          if (input.mode === 'selected') {
            throw new PlanReviewError('claim_conflict', `Comment ${comment.id} is already claimed`, 409);
          }
          skipped.push({ commentId: comment.id, reason: 'claim_conflict' });
          continue;
        }
        this.db
          .prepare("UPDATE comments SET status = 'claimed', claim_id = ?, updated_at = ? WHERE id = ?")
          .run(claimId, nowIso(), comment.id);
        const updated = this.getComment(comment.id);
        claimed.push(updated);
        const event = this.addEvent(planId, 'comment.claimed', {
          eventType: 'comment.claimed',
          planId,
          commentId: comment.id,
          comment: updated
        }, comment.id);
        events.push(event);
      }
      return { claimed, events, leaseExpiresAt, skipped };
    });
    return tx();
  }

  ackComment(commentId: string, input: AckCommentInput) {
    const tx = this.db.transaction(() => {
      let comment = this.getComment(commentId);
      const expiredEvents = this.releaseExpiredClaims(comment.planId);
      comment = this.getComment(commentId);
      if (comment.status === 'acknowledged' || comment.status === 'resolved') {
        return { comment, alreadyAcknowledged: true, expiredEvents };
      }
      const claim = this.db
        .prepare(`SELECT * FROM claims WHERE id = ? AND comment_id = ? AND released_at IS NULL AND acknowledged_at IS NULL`)
        .get(input.claimId, commentId) as Record<string, unknown> | undefined;
      if (!claim) {
        throw new PlanReviewError('claim_required', 'Ack requires an active matching claim', 409, { commentId }, 'Claim the comment, then retry ack with --claim <claim-id>.');
      }
      const now = nowIso();
      this.db.prepare('UPDATE claims SET acknowledged_at = ?, ack_client_mutation_id = ? WHERE id = ?')
        .run(now, input.clientMutationId ?? null, input.claimId);
      this.db
        .prepare("UPDATE comments SET status = 'acknowledged', agent_response_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(input.action ?? {}), now, commentId);
      const updated = this.getComment(commentId);
      const event = this.addEvent(comment.planId, 'comment.acknowledged', {
        eventType: 'comment.acknowledged',
        planId: comment.planId,
        commentId,
        comment: updated
      }, commentId);
      return { comment: updated, alreadyAcknowledged: false, event, expiredEvents };
    });
    return tx();
  }

  resolveComment(commentId: string, input: ResolveCommentInput) {
    const tx = this.db.transaction(() => {
      const comment = this.getComment(commentId);
      if (comment.status === 'resolved') {
        return { comment, alreadyResolved: true };
      }
      if (comment.status === 'claimed') {
        throw new PlanReviewError(
          'invalid_state',
          'Claimed comments must be acknowledged before they can be resolved',
          409,
          { commentId, status: comment.status },
          'Ack the active claim, or release it back to pending before resolving.'
        );
      }
      const now = nowIso();
      this.db
        .prepare("UPDATE comments SET status = 'resolved', agent_response_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ resolutionNote: input.resolutionNote, ...(input.action ?? {}) }), now, commentId);
      const updated = this.getComment(commentId);
      const event = this.addEvent(comment.planId, 'comment.resolved', {
        eventType: 'comment.resolved',
        planId: comment.planId,
        commentId,
        comment: updated
      }, commentId);
      return { comment: updated, alreadyResolved: false, event };
    });
    return tx();
  }

  releaseComment(commentId: string, claimId: string, reason = 'released') {
    const tx = this.db.transaction(() => {
      const comment = this.getComment(commentId);
      if (comment.status === 'acknowledged' || comment.status === 'resolved') {
        throw new PlanReviewError('invalid_state', 'Acknowledged or resolved comments cannot be released back to pending', 409, { commentId, status: comment.status });
      }
      const claim = this.db
        .prepare(`SELECT id FROM claims WHERE id = ? AND comment_id = ? AND released_at IS NULL AND acknowledged_at IS NULL`)
        .get(claimId, commentId) as { id: string } | undefined;
      if (!claim) {
        throw new PlanReviewError('claim_required', 'Release requires an active matching claim', 409, { commentId }, 'Claim the comment, then retry release with the active claim id.');
      }
      const now = nowIso();
      this.db.prepare('UPDATE claims SET released_at = ? WHERE id = ? AND comment_id = ?').run(now, claimId, commentId);
      this.db.prepare("UPDATE comments SET status = 'pending', claim_id = NULL, updated_at = ? WHERE id = ?").run(now, commentId);
      const updated = this.getComment(commentId);
      const event = this.addEvent(comment.planId, 'comment.released', {
        eventType: 'comment.released',
        planId: comment.planId,
        commentId,
        reason,
        comment: updated
      }, commentId);
      return { comment: updated, event };
    });
    return tx();
  }

  eventsAfter(planId: string, afterSequence = 0, mode: 'all' | 'queue' = 'all', limit = 200): StoredEvent[] {
    const eventFilter = mode === 'queue'
      ? "AND event_type IN ('comment.created','comment.claimed','comment.acknowledged','comment.resolved','comment.released')"
      : '';
    const rows = this.db
      .prepare(`SELECT * FROM comment_events WHERE plan_id = ? AND sequence > ? ${eventFilter} ORDER BY sequence ASC LIMIT ?`)
      .all(planId, afterSequence, limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.eventFromRow(row));
  }

  queueSnapshot(filters: { repoKey?: string; planId?: string; limit?: number }) {
    this.releaseExpiredClaims(filters.planId);
    const clauses = ["c.status = 'pending'"];
    const params: unknown[] = [];
    if (filters.planId) {
      clauses.push('c.plan_id = ?');
      params.push(filters.planId);
    }
    if (filters.repoKey) {
      clauses.push('r.repo_key = ?');
      params.push(filters.repoKey);
    }
    params.push(filters.limit ?? 50);
    const rows = this.db.prepare(`
      SELECT c.*, cl.id AS activeClaimId, cl.agent_id AS activeAgentId, cl.lease_expires_at AS activeLeaseExpiresAt
      FROM comments c
      JOIN plans p ON p.id = c.plan_id
      JOIN repos r ON r.id = p.repo_id
      LEFT JOIN claims cl ON cl.id = c.claim_id AND cl.released_at IS NULL AND cl.acknowledged_at IS NULL
      WHERE ${clauses.join(' AND ')}
      ORDER BY c.sequence ASC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;
    const latestRows = this.db.prepare(`
      SELECT plan_id AS planId, MAX(sequence) AS latestSequence
      FROM comment_events
      GROUP BY plan_id
    `).all() as Array<{ planId: string; latestSequence: number }>;
    return {
      items: rows.map(row => this.commentFromRow(row)),
      latestSequenceByPlan: Object.fromEntries(latestRows.map(row => [row.planId, row.latestSequence]))
    };
  }

  getAsset(assetId: string): { contentType: string; blobPath: string } {
    const row = this.db.prepare(`
      SELECT content_type AS contentType, blob_path AS blobPath FROM comment_assets WHERE id = ?
      UNION ALL
      SELECT content_type AS contentType, blob_path AS blobPath FROM plan_assets WHERE id = ?
      UNION ALL
      SELECT content_type AS contentType, blob_path AS blobPath FROM plan_assets WHERE asset_hash = ?
    `).get(assetId, assetId, assetId) as { contentType?: string; blobPath: string | null } | undefined;
    if (!row?.blobPath) throw new PlanReviewError('not_found', `Asset '${assetId}' was not found`, 404);
    return { contentType: row.contentType || 'application/octet-stream', blobPath: row.blobPath };
  }
}
