import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nanoid } from 'nanoid';
import { appConfigurationSchema, defaultAppConfiguration } from '../schemas.js';
import type {
  AckCommentInput,
  AppConfiguration,
  AppendThreadEntryInput,
  ClaimCommentsInput,
  ClaimQueueInput,
  CreateCommentInput,
  CreatePlanNoteInput,
  DeferPlanInput,
  RegisterPlanInput,
  ResolveCommentInput,
  ResumePlanInput,
  PlanLifecycleState,
  PlanPublicationMetadata,
  SaveBoardColumnsInput,
  PlanPullRequest,
  DeliveryAdapter,
  DeliveryStatus,
  DeliveryTargetInput,
  ReviewMode,
  ThreadEntryRole
} from '../schemas.js';
import type { DeliveryErrorShape, DeliveryOutboxRow, DeliveryTargetRecord } from '../delivery/types.js';
import { pullRequestStatus } from '../githubPr.js';
import { ensureDir, PlanReviewError, sha256, shortHash, slugify } from '../util.js';
import { planTitleFallback, renderedHtmlTitle } from '../planTitles.js';

export interface PlanRecord {
  id: string;
  repoId: string;
  slug: string;
  planPath: string;
  repoName: string;
  repoKey: string;
  remoteUrl?: string;
  rootPath?: string;
  branch: string;
  commitSha?: string;
  sourcePath?: string;
  watchMode: 'filesystem' | 'snapshot';
  reviewMode: ReviewMode;
  publicationMetadata?: PlanPublicationMetadata;
  linearIssueKey?: string;
  linearIssueUrl?: string;
  pullRequest?: PlanPullRequest | null;
  lifecycleState: PlanLifecycleState;
  deferredAt?: string;
  deferredNoteId?: string;
  lastSyncAt?: string;
  lastSyncStatus?: string;
  lastSyncError?: Record<string, unknown> | null;
  archivedAt?: string;
  boardColumnKey?: string;
  pinnedAt?: string;
  projectKey: string;
  projectName: string;
  projectOverriddenAt?: string;
}

export interface BoardColumnRecord {
  key: string;
  label: string;
  position: number;
  isDone: boolean;
  isDefault: boolean;
  hiddenAt?: string;
}

export interface PlanProjectRecord {
  projectKey: string;
  projectName: string;
}

interface ListPlansOptions {
  includeArchived?: boolean;
  includeDeferred?: boolean;
  lifecycleState?: PlanLifecycleState;
  limit?: number;
  currentPlanId?: string;
  projectKey?: string;
  reviewMode?: ReviewMode;
  boardColumnKey?: string;
}

export interface PlanProgress {
  totalPhases: number;
  completedPhases: number;
  phases: Array<{ label: string; complete: boolean }>;
}

export interface PlanNoteRecord {
  id: string;
  planId: string;
  body: string;
  createdBy: Record<string, unknown>;
  createdAt: string;
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

export interface StoredCommentThreadEntry {
  id: string;
  planId: string;
  commentId: string;
  sequence: number;
  role: ThreadEntryRole;
  body: string;
  createdBy: Record<string, unknown>;
  claimId?: string;
  deliveryAdapter?: DeliveryAdapter;
  action?: Record<string, unknown>;
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
  threadEntries: StoredCommentThreadEntry[];
  createdBy: Record<string, unknown>;
  createdAt: string;
  deletedAt?: string;
  claim?: { id: string; agentId: string; leaseExpiresAt: string } | null;
}

export type { DeliveryOutboxRow, DeliveryTargetRecord };

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

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => normalizeJsonValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJsonValue(item)])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(parseJson(JSON.stringify(value), null)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function lifecycleStateFromRow(row: Record<string, unknown>): PlanLifecycleState {
  if (optionalString(row.archivedAt) || optionalString(row.archived_at)) return 'archived';
  return optionalString(row.lifecycleState) === 'deferred' || optionalString(row.lifecycle_state) === 'deferred' ? 'deferred' : 'active';
}

function normalizeProjectKey(value: string): string {
  const normalized = slugify(value).replace(/^-+|-+$/g, '');
  return normalized || 'uncategorized';
}

function gitParentRepoName(rootPath?: string | null): string | undefined {
  const root = optionalString(rootPath);
  if (!root) return undefined;
  try {
    if (!fs.statSync(root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) return undefined;
  const commonDir = result.stdout.trim();
  if (!commonDir) return undefined;
  const repoDir = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir.replace(/\.git$/, '');
  const repoName = path.basename(repoDir);
  return repoName || undefined;
}

function inferProjectName(input: { rootPath?: string | null; repoName?: string | null; sourcePath?: string | null; planPath?: string | null }, gitParentCache?: Map<string, string | undefined>): string {
  const rootCacheKey = optionalString(input.rootPath);
  const gitParent = rootCacheKey && gitParentCache
    ? (gitParentCache.has(rootCacheKey) ? gitParentCache.get(rootCacheKey) : (() => { const value = gitParentRepoName(rootCacheKey); gitParentCache.set(rootCacheKey, value); return value; })())
    : gitParentRepoName(input.rootPath);
  if (gitParent) return gitParent;
  const repoName = optionalString(input.repoName);
  if (repoName) return repoName;
  const root = optionalString(input.rootPath);
  if (root) {
    const base = path.basename(root);
    if (base) return base;
  }
  const source = optionalString(input.sourcePath) ?? optionalString(input.planPath);
  if (source) {
    const parts = source.split(/[\\/]/).filter(Boolean);
    const thoughtsIndex = parts.indexOf('thoughts');
    if (thoughtsIndex > 0) return parts[thoughtsIndex - 1];
  }
  return 'Uncategorized';
}

function defaultBoardColumnForProgress(progress: PlanProgress): string {
  if (progress.totalPhases > 0 && progress.completedPhases === progress.totalPhases) return 'done';
  if (progress.completedPhases > 0) return 'in_progress';
  return 'backlog';
}

function noteAuthor(input?: { displayName?: string }): Record<string, unknown> {
  return { type: 'operator', displayName: input?.displayName?.trim() || 'Plan reviewer' };
}

function commentAuthor(input?: { type?: 'reviewer' | 'agent'; displayName?: string; agentId?: string }): Record<string, unknown> {
  const type = input?.type === 'agent' ? 'agent' : 'reviewer';
  const displayName = input?.displayName?.trim() || (type === 'agent' ? 'Agent' : 'Anonymous reviewer');
  return input?.agentId && type === 'agent'
    ? { type, displayName, agentId: input.agentId }
    : { type, displayName };
}

function metadataFromRow(row: Record<string, unknown>, reviewMode: ReviewMode): PlanPublicationMetadata | undefined {
  if (reviewMode === 'collaboration') return undefined;
  const parsed = parseJson<PlanPublicationMetadata | null>(row.publicationMetadataJson as string | null, null);
  if (parsed) return parsed;
  return {
    worktreePath: optionalString(row.rootPath) ?? optionalString(row.sourcePath) ?? '',
    branch: String(row.branch ?? 'unknown'),
    executionReady: false,
    executionReadyBasis: 'agent-review-results'
  };
}

function inferReviewMode(input: Pick<RegisterPlanInput, 'reviewMode' | 'publicationMetadata' | 'planPath'>): ReviewMode {
  return input.reviewMode ?? (input.publicationMetadata?.executionReadyBasis || input.planPath.startsWith('thoughts/plans/') ? 'planning' : 'collaboration');
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function pullRequestFromRow(row: Record<string, unknown> | undefined): PlanPullRequest | null {
  if (!row) return null;
  const pr: PlanPullRequest = {
    provider: 'github',
    url: String(row.pr_url),
    owner: String(row.owner),
    repo: String(row.repo),
    number: Number(row.number),
    headRef: String(row.head_ref),
    headRepo: optionalString(row.head_repo),
    baseRef: String(row.base_ref),
    state: (row.state ?? 'unknown') as PlanPullRequest['state'],
    merged: Boolean(Number(row.merged ?? 0)),
    mergedAt: optionalString(row.merged_at),
    lastCheckedAt: optionalString(row.last_checked_at),
    source: (row.source ?? 'explicit') as PlanPullRequest['source'],
    lastRefreshError: optionalString(row.last_refresh_error)
  };
  return { ...pr, status: pullRequestStatus(pr) };
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

export function normalizeLinearIssueKey(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const match = /(?<![A-Z0-9])NOD-\d+\b/i.exec(value ?? '');
    if (match) return match[0].toUpperCase();
  }
  return undefined;
}

export function linearIssueUrl(issueKey: string): string {
  return `https://linear.app/nodaste/issue/${issueKey}`;
}

function searchablePlanTextForLinear(html: string): string {
  return stripHtml(html.replace(/<(code|pre)\b[\s\S]*?<\/\1>/gi, ' '));
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
        review_mode TEXT NOT NULL DEFAULT 'planning',
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        deferred_at TEXT,
        deferred_note_id TEXT,
        last_sync_at TEXT,
        last_sync_status TEXT,
        last_sync_error_json TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_id, plan_path, slug)
      );
      CREATE TABLE IF NOT EXISTS board_columns (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        position INTEGER NOT NULL,
        is_done INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        hidden_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_configuration (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS plan_pull_requests (
        plan_id TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        pr_url TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        head_ref TEXT NOT NULL,
        head_repo TEXT,
        base_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        merged INTEGER NOT NULL DEFAULT 0,
        merged_at TEXT,
        last_checked_at TEXT,
        source TEXT NOT NULL,
        last_refresh_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
        deleted_at TEXT,
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
      CREATE TABLE IF NOT EXISTS comment_thread_entries (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by_json TEXT NOT NULL,
        claim_id TEXT,
        delivery_adapter TEXT,
        action_json TEXT,
        client_mutation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(comment_id, sequence),
        UNIQUE(comment_id, client_mutation_id)
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
      CREATE TABLE IF NOT EXISTS plan_notes (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        body TEXT NOT NULL,
        created_by_json TEXT NOT NULL,
        client_mutation_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(plan_id, client_mutation_id)
      );
      CREATE TABLE IF NOT EXISTS delivery_targets (
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        adapter TEXT NOT NULL DEFAULT 'codex',
        enabled INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'sdk',
        target_thread_id TEXT,
        target_cwd TEXT,
        sandbox TEXT,
        model TEXT,
        effort TEXT,
        auto_resolve INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plan_id, adapter)
      );
      CREATE TABLE IF NOT EXISTS delivery_outbox (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        adapter TEXT NOT NULL DEFAULT 'codex',
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        claim_id TEXT,
        target_thread_id TEXT,
        adapter_turn_id TEXT,
        last_error_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(comment_id, adapter)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_claim
        ON claims(comment_id)
        WHERE released_at IS NULL AND acknowledged_at IS NULL;
    `);
    this.ensureColumn('plans', 'source_path', 'TEXT');
    this.ensureColumn('plans', 'watch_mode', "TEXT NOT NULL DEFAULT 'snapshot'");
    this.ensureColumn('plans', 'review_mode', "TEXT NOT NULL DEFAULT 'planning'");
    this.ensureColumn('plans', 'lifecycle_state', "TEXT NOT NULL DEFAULT 'active'");
    this.ensureColumn('plans', 'deferred_at', 'TEXT');
    this.ensureColumn('plans', 'deferred_note_id', 'TEXT');
    this.ensureColumn('plans', 'last_sync_at', 'TEXT');
    this.ensureColumn('plans', 'last_sync_status', 'TEXT');
    this.ensureColumn('plans', 'last_sync_error_json', 'TEXT');
    this.ensureColumn('plans', 'archived_at', 'TEXT');
    this.ensureColumn('plans', 'publication_metadata_json', 'TEXT');
    this.ensureColumn('plans', 'board_column_key', 'TEXT');
    this.ensureColumn('plans', 'pinned_at', 'TEXT');
    this.ensureColumn('plans', 'project_key', 'TEXT');
    this.ensureColumn('plans', 'project_name', 'TEXT');
    this.ensureColumn('plans', 'project_overridden_at', 'TEXT');
    this.ensureColumn('comments', 'deleted_at', 'TEXT');
    this.ensureColumn('plan_versions', 'source_mtime_ms', 'REAL');
    this.ensureColumn('plan_versions', 'source_size', 'INTEGER');
    this.ensureColumn('plan_versions', 'sync_origin', "TEXT NOT NULL DEFAULT 'manual_register'");
    this.ensureColumn('plan_versions', 'display_title', 'TEXT');
    this.ensureColumn('plan_versions', 'progress_json', 'TEXT');
    this.ensureColumn('plan_versions', 'progress_total', 'INTEGER');
    this.ensureColumn('plan_versions', 'progress_completed', 'INTEGER');
    this.ensureDefaultBoardColumns();
    this.backfillThreadEntries();
    this.backfillPlanVersionMetadata();
    this.backfillOrganizationMetadata();
  }

  private ensureDefaultBoardColumns(): void {
    const existing = Number((this.db.prepare('SELECT COUNT(*) AS count FROM board_columns').get() as { count?: number } | undefined)?.count ?? 0);
    if (existing > 0) return;
    const now = nowIso();
    const defaults: Array<{ key: string; label: string; position: number; isDone: boolean }> = [
      { key: 'backlog', label: 'Backlog', position: 0, isDone: false },
      { key: 'ready_to_pull', label: 'Ready to Pull', position: 1, isDone: false },
      { key: 'in_progress', label: 'In Progress', position: 2, isDone: false },
      { key: 'done', label: 'Done', position: 3, isDone: true }
    ];
    const insert = this.db.prepare(`INSERT INTO board_columns (key, label, position, is_done, is_default, hidden_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, NULL, ?, ?)`);
    const tx = this.db.transaction(() => {
      for (const column of defaults) insert.run(column.key, column.label, column.position, column.isDone ? 1 : 0, now, now);
    });
    tx();
  }

  private backfillThreadEntries(): void {
    const rows = this.db.prepare(`
      SELECT c.id, c.plan_id AS planId, c.body, c.created_by_json AS createdByJson, c.created_at AS createdAt, c.updated_at AS updatedAt
      FROM comments c
      LEFT JOIN comment_thread_entries e ON e.comment_id = c.id
      WHERE e.id IS NULL
    `).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    const insert = this.db.prepare(`INSERT INTO comment_thread_entries
      (id, plan_id, comment_id, sequence, role, body, created_by_json, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'human', ?, ?, ?, ?)`);
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        insert.run(id('cte'), row.planId, row.id, row.body, row.createdByJson, row.createdAt, row.updatedAt ?? row.createdAt);
      }
    });
    tx();
  }

  private backfillPlanVersionMetadata(): void {
    const rows = this.db.prepare(`
      SELECT v.id, v.html_blob_path AS htmlBlobPath, p.id AS planId, p.slug, r.repo_name AS repoName
      FROM plan_versions v
      JOIN plans p ON p.id = v.plan_id
      JOIN repos r ON r.id = p.repo_id
      WHERE v.display_title IS NULL
        OR v.progress_json IS NULL
        OR v.progress_total IS NULL
        OR v.progress_completed IS NULL
    `).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    const update = this.db.prepare(`
      UPDATE plan_versions
      SET display_title = ?, progress_json = ?, progress_total = ?, progress_completed = ?
      WHERE id = ?
    `);
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const htmlBlobPath = optionalString(row.htmlBlobPath);
        const html = htmlBlobPath && fs.existsSync(htmlBlobPath) ? fs.readFileSync(htmlBlobPath, 'utf8') : '';
        const progress = html ? extractPlanProgress(html) : { totalPhases: 0, completedPhases: 0, phases: [] };
        const displayTitle = html ? renderedHtmlTitle(html) : undefined;
        update.run(
          displayTitle ?? planTitleFallback({ id: row.planId, repoName: row.repoName, slug: row.slug }),
          JSON.stringify(progress),
          progress.totalPhases,
          progress.completedPhases,
          row.id
        );
      }
    });
    tx();
  }

  private backfillOrganizationMetadata(): void {
    const rows = this.db.prepare(`
      SELECT p.id, p.review_mode AS reviewMode, p.board_column_key AS boardColumnKey,
        p.project_key AS projectKey, p.project_name AS projectName, p.project_overridden_at AS projectOverriddenAt,
        p.plan_path AS planPath, p.source_path AS sourcePath, r.repo_name AS repoName, r.root_path AS rootPath,
        v.progress_json AS progressJson
      FROM plans p
      JOIN repos r ON r.id = p.repo_id
      LEFT JOIN plan_versions v ON v.id = (
        SELECT id FROM plan_versions WHERE plan_id = p.id ORDER BY created_at DESC LIMIT 1
      )
      WHERE p.project_overridden_at IS NULL OR p.project_key IS NULL OR p.project_name IS NULL OR (p.review_mode = 'planning' AND p.board_column_key IS NULL) OR (p.review_mode = 'collaboration' AND p.board_column_key IS NOT NULL)
    `).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    const gitParentCache = new Map<string, string | undefined>();
    const update = this.db.prepare('UPDATE plans SET project_key = ?, project_name = ?, board_column_key = ?, updated_at = updated_at WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const inferredProjectName = inferProjectName({ rootPath: optionalString(row.rootPath), repoName: optionalString(row.repoName), sourcePath: optionalString(row.sourcePath), planPath: optionalString(row.planPath) }, gitParentCache);
        const projectName = optionalString(row.projectOverriddenAt) ? (optionalString(row.projectName) ?? inferredProjectName) : inferredProjectName;
        const projectKey = optionalString(row.projectOverriddenAt) ? (optionalString(row.projectKey) ?? normalizeProjectKey(projectName)) : normalizeProjectKey(projectName);
        const progress = parseJson<PlanProgress | null>(row.progressJson as string | null, null) ?? { totalPhases: 0, completedPhases: 0, phases: [] };
        const boardColumnKey = row.reviewMode === 'planning' ? (optionalString(row.boardColumnKey) ?? this.defaultVisibleBoardColumnKey(defaultBoardColumnForProgress(progress))) : null;
        update.run(projectKey, projectName, boardColumnKey, row.id);
      }
    });
    tx();
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

  private nextThreadEntrySequence(commentId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM comment_thread_entries WHERE comment_id = ?')
      .get(commentId) as { next: number };
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

  getConfiguration(): AppConfiguration {
    const rows = this.db.prepare('SELECT key, value_json AS valueJson FROM app_configuration').all() as Array<{ key: string; valueJson: string }>;
    const candidate: Record<string, unknown> = { ...defaultAppConfiguration };
    for (const row of rows) {
      if (!Object.prototype.hasOwnProperty.call(defaultAppConfiguration, row.key)) continue;
      candidate[row.key] = parseJson(row.valueJson, candidate[row.key]);
    }
    const parsed = appConfigurationSchema.safeParse(candidate);
    return parsed.success ? parsed.data : defaultAppConfiguration;
  }

  saveConfiguration(input: AppConfiguration): AppConfiguration {
    const configuration = appConfigurationSchema.parse(input);
    const now = nowIso();
    const upsert = this.db.prepare(`INSERT INTO app_configuration (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`);
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(configuration)) {
        upsert.run(key, JSON.stringify(value), now);
      }
    });
    tx();
    return this.getConfiguration();
  }

  listBoardColumns(options: { includeHidden?: boolean } = {}): BoardColumnRecord[] {
    const rows = this.db.prepare(`SELECT key, label, position, is_done AS isDone, is_default AS isDefault, hidden_at AS hiddenAt
      FROM board_columns
      ${options.includeHidden ? '' : 'WHERE hidden_at IS NULL'}
      ORDER BY position ASC, key ASC`).all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      key: String(row.key),
      label: String(row.label),
      position: Number(row.position ?? 0),
      isDone: Number(row.isDone ?? 0) === 1,
      isDefault: Number(row.isDefault ?? 0) === 1,
      hiddenAt: optionalString(row.hiddenAt)
    }));
  }

  private requireBoardColumn(key: string): BoardColumnRecord {
    const column = this.listBoardColumns({ includeHidden: true }).find(item => item.key === key);
    if (!column) {
      throw new PlanReviewError('validation_failed', `Board column '${key}' was not found`, 400, { boardColumnKey: key }, 'Run plan-review columns list, then retry with an existing column key.');
    }
    return column;
  }

  private defaultVisibleBoardColumnKey(preferredKey = 'backlog'): string {
    const columns = this.listBoardColumns();
    return columns.find(column => column.key === preferredKey)?.key ?? columns[0]?.key ?? 'backlog';
  }

  private visibleBoardColumnKey(currentKey?: string): string | null {
    if (!currentKey) return null;
    return this.listBoardColumns({ includeHidden: true }).some(column => column.key === currentKey) ? currentKey : this.defaultVisibleBoardColumnKey(currentKey);
  }

  saveBoardColumns(input: SaveBoardColumnsInput): { columns: BoardColumnRecord[]; events: StoredEvent[] } {
    const now = nowIso();
    const seen = new Set<string>();
    const seenOriginals = new Set<string>();
    const tx = this.db.transaction(() => {
      const currentColumns = this.listBoardColumns({ includeHidden: true });
      const currentKeys = new Set(currentColumns.map(column => column.key));
      const renames = new Map(input.columns.map(column => [column.originalKey ?? column.key, column.key]));
      const nextVisibility = new Map(currentColumns.map(column => [renames.get(column.key) ?? column.key, !column.hiddenAt]));
      const renameSources = new Set<string>();
      for (const column of input.columns) {
        const originalKey = column.originalKey ?? column.key;
        if (seen.has(column.key)) throw new PlanReviewError('validation_failed', `Duplicate board column key '${column.key}'`, 400, { key: column.key });
        if (seenOriginals.has(originalKey)) throw new PlanReviewError('validation_failed', `Duplicate original board column key '${originalKey}'`, 400, { key: originalKey });
        seen.add(column.key);
        seenOriginals.add(originalKey);
        if (currentKeys.has(originalKey) && originalKey !== column.key) renameSources.add(originalKey);
        nextVisibility.set(column.key, !column.hidden);
      }
      if (![...nextVisibility.values()].some(Boolean)) {
        throw new PlanReviewError('validation_failed', 'At least one board column must remain visible', 400, {}, 'Keep one visible column so new planning documents have a valid default destination.');
      }
      for (const column of input.columns) {
        const originalKey = column.originalKey ?? column.key;
        const targetOccupiedByStableColumn = currentKeys.has(column.key) && column.key !== originalKey && !renameSources.has(column.key);
        if (targetOccupiedByStableColumn) {
          throw new PlanReviewError('validation_failed', `Board column key '${column.key}' already exists`, 400, { key: column.key }, 'Choose a unique column key before saving.');
        }
      }
      const tempRenameKeys = new Map<string, string>();
      for (const originalKey of renameSources) {
        const tempKey = `__renaming_${originalKey}_${shortHash(`${now}:${originalKey}`)}`;
        tempRenameKeys.set(originalKey, tempKey);
        this.db.prepare('UPDATE board_columns SET key = ?, updated_at = ? WHERE key = ?').run(tempKey, now, originalKey);
        this.db.prepare('UPDATE plans SET board_column_key = ?, updated_at = ? WHERE board_column_key = ?').run(tempKey, now, originalKey);
      }
      for (const [index, column] of input.columns.entries()) {
        const originalKey = column.originalKey ?? column.key;
        const tempKey = tempRenameKeys.get(originalKey);
        if (tempKey) {
          this.db.prepare('UPDATE board_columns SET key = ?, updated_at = ? WHERE key = ?').run(column.key, now, tempKey);
          this.db.prepare('UPDATE plans SET board_column_key = ?, updated_at = ? WHERE board_column_key = ?').run(column.key, now, tempKey);
        }
        this.db.prepare(`INSERT INTO board_columns (key, label, position, is_done, is_default, hidden_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET label = excluded.label, position = excluded.position, is_done = excluded.is_done,
            hidden_at = excluded.hidden_at, updated_at = excluded.updated_at`)
          .run(column.key, column.label, column.position ?? index, column.isDone ? 1 : 0, column.hidden ? now : null, now, now);
      }
      return this.listBoardColumns({ includeHidden: true });
    });
    const columns = tx();
    const planRows = this.db.prepare('SELECT id FROM plans').all() as Array<{ id: string }>;
    const events = planRows.map(row => this.addEvent(row.id, 'plan.columns.changed', { eventType: 'plan.columns.changed', planId: row.id, columns }));
    return { columns, events };
  }

  getPullRequest(planId: string): PlanPullRequest | null {
    const row = this.db.prepare('SELECT * FROM plan_pull_requests WHERE plan_id = ?').get(planId) as Record<string, unknown> | undefined;
    return pullRequestFromRow(row);
  }

  upsertPullRequest(planId: string, pullRequest: PlanPullRequest): PlanPullRequest {
    this.getPlan(planId);
    const now = nowIso();
    this.db.prepare(`INSERT INTO plan_pull_requests
      (plan_id, provider, pr_url, owner, repo, number, head_ref, head_repo, base_ref, state, merged, merged_at, last_checked_at, source, last_refresh_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET provider = excluded.provider, pr_url = excluded.pr_url, owner = excluded.owner,
        repo = excluded.repo, number = excluded.number, head_ref = excluded.head_ref, head_repo = excluded.head_repo,
        base_ref = excluded.base_ref, state = excluded.state, merged = excluded.merged, merged_at = excluded.merged_at,
        last_checked_at = excluded.last_checked_at, source = excluded.source, last_refresh_error = excluded.last_refresh_error,
        updated_at = excluded.updated_at`)
      .run(planId, pullRequest.provider, pullRequest.url, pullRequest.owner, pullRequest.repo, pullRequest.number,
        pullRequest.headRef, pullRequest.headRepo ?? null, pullRequest.baseRef, pullRequest.state, pullRequest.merged ? 1 : 0,
        pullRequest.mergedAt ?? null, pullRequest.lastCheckedAt ?? null, pullRequest.source, pullRequest.lastRefreshError ?? null, now, now);
    this.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now, planId);
    return this.getPullRequest(planId)!;
  }

  clearPullRequest(planId: string): void {
    this.getPlan(planId);
    const now = nowIso();
    this.db.prepare('DELETE FROM plan_pull_requests WHERE plan_id = ?').run(planId);
    this.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now, planId);
  }

  private threadEntryFromRow(row: Record<string, unknown>): StoredCommentThreadEntry {
    return {
      id: String(row.id),
      planId: String(row.plan_id ?? row.planId),
      commentId: String(row.comment_id ?? row.commentId),
      sequence: Number(row.sequence),
      role: String(row.role) as ThreadEntryRole,
      body: String(row.body),
      createdBy: parseJson(String(row.created_by_json ?? row.createdByJson), {}),
      claimId: optionalString(row.claim_id ?? row.claimId),
      deliveryAdapter: optionalString(row.delivery_adapter ?? row.deliveryAdapter) as DeliveryAdapter | undefined,
      action: parseJson<Record<string, unknown> | undefined>(row.action_json as string | null, undefined),
      createdAt: String(row.created_at ?? row.createdAt)
    };
  }

  listThreadEntries(commentId: string): StoredCommentThreadEntry[] {
    const rows = this.db.prepare('SELECT * FROM comment_thread_entries WHERE comment_id = ? ORDER BY sequence ASC').all(commentId) as Array<Record<string, unknown>>;
    return rows.map(row => this.threadEntryFromRow(row));
  }

  private deliveryTargetFromRow(row: Record<string, unknown>): DeliveryTargetRecord {
    return {
      planId: String(row.plan_id ?? row.planId),
      adapter: String(row.adapter) as DeliveryAdapter,
      enabled: Boolean(Number(row.enabled ?? 0)),
      mode: String(row.mode ?? 'sdk') as DeliveryTargetRecord['mode'],
      threadId: optionalString(row.target_thread_id ?? row.threadId),
      cwd: optionalString(row.target_cwd ?? row.cwd),
      sandbox: optionalString(row.sandbox),
      model: optionalString(row.model),
      effort: optionalString(row.effort),
      autoResolve: Boolean(Number(row.auto_resolve ?? 0)),
      createdAt: String(row.created_at ?? row.createdAt),
      updatedAt: String(row.updated_at ?? row.updatedAt)
    };
  }

  private deliveryOutboxFromRow(row: Record<string, unknown>): DeliveryOutboxRow {
    return {
      id: String(row.id),
      planId: String(row.plan_id ?? row.planId),
      commentId: String(row.comment_id ?? row.commentId),
      adapter: String(row.adapter) as DeliveryAdapter,
      status: String(row.status) as DeliveryStatus,
      attemptCount: Number(row.attempt_count ?? row.attemptCount ?? 0),
      nextAttemptAt: String(row.next_attempt_at ?? row.nextAttemptAt),
      claimId: optionalString(row.claim_id ?? row.claimId),
      targetThreadId: optionalString(row.target_thread_id ?? row.targetThreadId),
      adapterTurnId: optionalString(row.adapter_turn_id ?? row.adapterTurnId),
      lastError: parseJson<DeliveryErrorShape | undefined>(row.last_error_json as string | null, undefined),
      result: parseJson<Record<string, unknown> | undefined>(row.result_json as string | null, undefined),
      createdAt: String(row.created_at ?? row.createdAt),
      updatedAt: String(row.updated_at ?? row.updatedAt)
    };
  }

  getDeliveryTarget(planId: string, adapter: DeliveryAdapter = 'codex'): DeliveryTargetRecord | null {
    this.getPlan(planId);
    const row = this.db.prepare('SELECT * FROM delivery_targets WHERE plan_id = ? AND adapter = ?').get(planId, adapter) as Record<string, unknown> | undefined;
    return row ? this.deliveryTargetFromRow(row) : null;
  }

  upsertDeliveryTarget(planId: string, input: DeliveryTargetInput): { target: DeliveryTargetRecord; backfilled: number } {
    const tx = this.db.transaction(() => {
      this.getPlan(planId);
      const adapter = input.adapter ?? 'codex';
      const previous = this.getDeliveryTarget(planId, adapter);
      const now = nowIso();
      const createdAt = previous?.createdAt ?? now;
      this.db.prepare(`INSERT INTO delivery_targets
        (plan_id, adapter, enabled, mode, target_thread_id, target_cwd, sandbox, model, effort, auto_resolve, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_id, adapter) DO UPDATE SET
          enabled = excluded.enabled,
          mode = excluded.mode,
          target_thread_id = excluded.target_thread_id,
          target_cwd = excluded.target_cwd,
          sandbox = excluded.sandbox,
          model = excluded.model,
          effort = excluded.effort,
          auto_resolve = excluded.auto_resolve,
          updated_at = excluded.updated_at`)
        .run(
          planId,
          adapter,
          input.enabled ? 1 : 0,
          input.mode ?? 'sdk',
          input.threadId ?? null,
          input.cwd ?? null,
          input.sandbox ?? null,
          input.model ?? null,
          input.effort ?? null,
          input.autoResolve ? 1 : 0,
          createdAt,
          now
        );
      this.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now, planId);
      const target = this.getDeliveryTarget(planId, adapter)!;
      const shouldBackfill = target.enabled && (!previous?.enabled || previous.threadId !== target.threadId);
      const backfilled = shouldBackfill ? this.backfillDelivery(planId, adapter) : 0;
      if (!target.enabled) {
        this.db.prepare("UPDATE delivery_outbox SET status = 'paused', updated_at = ? WHERE plan_id = ? AND adapter = ? AND status IN ('pending','retry_wait')")
          .run(nowIso(), planId, adapter);
      } else {
        this.db.prepare("UPDATE delivery_outbox SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE plan_id = ? AND adapter = ? AND status = 'paused'")
          .run(nowIso(), nowIso(), planId, adapter);
      }
      return { target: this.getDeliveryTarget(planId, adapter)!, backfilled };
    });
    return tx();
  }

  enqueueDelivery(planId: string, commentId: string, adapter: DeliveryAdapter = 'codex'): DeliveryOutboxRow | null {
    const target = this.getDeliveryTarget(planId, adapter);
    if (!target?.enabled || !target.threadId) return null;
    const now = nowIso();
    const rowId = id('del');
    this.db.prepare(`INSERT INTO delivery_outbox
      (id, plan_id, comment_id, adapter, status, attempt_count, next_attempt_at, target_thread_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
      ON CONFLICT(comment_id, adapter) DO NOTHING`)
      .run(rowId, planId, commentId, adapter, now, target.threadId, now, now);
    return this.getDeliveryRowByComment(commentId, adapter);
  }

  backfillDelivery(planId: string, adapter: DeliveryAdapter = 'codex'): number {
    const target = this.getDeliveryTarget(planId, adapter);
    if (!target?.enabled || !target.threadId) return 0;
    const rows = this.db.prepare(`
      SELECT id FROM comments
      WHERE plan_id = ?
        AND status = 'pending'
        AND deleted_at IS NULL
        AND claim_id IS NULL
      ORDER BY sequence ASC
    `).all(planId) as Array<{ id: string }>;
    let created = 0;
    for (const row of rows) {
      const before = this.getDeliveryRowByComment(row.id, adapter);
      this.enqueueDelivery(planId, row.id, adapter);
      if (!before && this.getDeliveryRowByComment(row.id, adapter)) created += 1;
    }
    return created;
  }

  getDeliveryRow(id: string): DeliveryOutboxRow | null {
    const row = this.db.prepare('SELECT * FROM delivery_outbox WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.deliveryOutboxFromRow(row) : null;
  }

  getDeliveryRowByComment(commentId: string, adapter: DeliveryAdapter = 'codex'): DeliveryOutboxRow | null {
    const row = this.db.prepare('SELECT * FROM delivery_outbox WHERE comment_id = ? AND adapter = ?').get(commentId, adapter) as Record<string, unknown> | undefined;
    return row ? this.deliveryOutboxFromRow(row) : null;
  }

  listDeliveryRows(planId: string, adapter?: DeliveryAdapter): DeliveryOutboxRow[] {
    this.getPlan(planId);
    const rows = this.db.prepare(`SELECT * FROM delivery_outbox WHERE plan_id = ? ${adapter ? 'AND adapter = ?' : ''} ORDER BY created_at ASC, id ASC`)
      .all(...(adapter ? [planId, adapter] : [planId])) as Array<Record<string, unknown>>;
    return rows.map(row => this.deliveryOutboxFromRow(row));
  }

  listStaleDeliveryRows(statuses: DeliveryStatus[], olderThanIso: string): DeliveryOutboxRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM delivery_outbox WHERE status IN (${placeholders}) AND updated_at <= ? ORDER BY updated_at ASC, id ASC`)
      .all(...statuses, olderThanIso) as Array<Record<string, unknown>>;
    return rows.map(row => this.deliveryOutboxFromRow(row));
  }

  acquireNextDeliveryRow(now = nowIso()): DeliveryOutboxRow | null {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT o.*
        FROM delivery_outbox o
        JOIN delivery_targets t ON t.plan_id = o.plan_id AND t.adapter = o.adapter
        WHERE o.status IN ('pending','retry_wait')
          AND o.next_attempt_at <= ?
          AND t.enabled = 1
        ORDER BY o.next_attempt_at ASC, o.created_at ASC, o.id ASC
        LIMIT 1
      `).get(now) as Record<string, unknown> | undefined;
      if (!row) return null;
      const updated = nowIso();
      const result = this.db.prepare("UPDATE delivery_outbox SET status = 'claiming', updated_at = ? WHERE id = ? AND status IN ('pending','retry_wait')")
        .run(updated, row.id);
      if (result.changes !== 1) return null;
      return this.getDeliveryRow(String(row.id));
    });
    return tx();
  }

  acquireAckPendingDeliveryRow(now = nowIso()): DeliveryOutboxRow | null {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM delivery_outbox
        WHERE status = 'ack_pending'
          AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, updated_at ASC, id ASC
        LIMIT 1
      `).get(now) as Record<string, unknown> | undefined;
      if (!row) return null;
      this.db.prepare('UPDATE delivery_outbox SET updated_at = ? WHERE id = ?').run(nowIso(), row.id);
      return this.getDeliveryRow(String(row.id));
    });
    return tx();
  }

  markDeliveryStatus(
    rowId: string,
    status: DeliveryStatus,
    options: {
      claimId?: string | null;
      targetThreadId?: string | null;
      adapterTurnId?: string | null;
      result?: Record<string, unknown> | null;
      error?: DeliveryErrorShape | null;
      nextAttemptAt?: string;
      incrementAttempt?: boolean;
    } = {}
  ): DeliveryOutboxRow {
    const current = this.getDeliveryRow(rowId);
    if (!current) throw new PlanReviewError('not_found', `Delivery row '${rowId}' was not found`, 404);
    const now = nowIso();
    this.db.prepare(`UPDATE delivery_outbox SET
      status = ?,
      attempt_count = attempt_count + ?,
      next_attempt_at = COALESCE(?, next_attempt_at),
      claim_id = CASE WHEN ? THEN ? ELSE claim_id END,
      target_thread_id = COALESCE(?, target_thread_id),
      adapter_turn_id = COALESCE(?, adapter_turn_id),
      result_json = CASE WHEN ? THEN ? ELSE result_json END,
      last_error_json = CASE WHEN ? THEN ? ELSE last_error_json END,
      updated_at = ?
      WHERE id = ?`)
      .run(
        status,
        options.incrementAttempt ? 1 : 0,
        options.nextAttemptAt ?? null,
        Object.prototype.hasOwnProperty.call(options, 'claimId') ? 1 : 0,
        options.claimId ?? null,
        options.targetThreadId ?? null,
        options.adapterTurnId ?? null,
        Object.prototype.hasOwnProperty.call(options, 'result') ? 1 : 0,
        options.result === null || options.result === undefined ? null : JSON.stringify(options.result),
        Object.prototype.hasOwnProperty.call(options, 'error') ? 1 : 0,
        options.error === null || options.error === undefined ? null : JSON.stringify(options.error),
        now,
        rowId
      );
    return this.getDeliveryRow(rowId)!;
  }

  retryDeliveryRows(planId: string, adapter: DeliveryAdapter = 'codex', commentId?: string): { retried: number; rows: DeliveryOutboxRow[] } {
    this.getPlan(planId);
    const now = nowIso();
    const result = this.db.prepare(`
      UPDATE delivery_outbox
      SET status = CASE
          WHEN status = 'ack_failed' AND result_json IS NOT NULL THEN 'ack_pending'
          ELSE 'pending'
        END,
        next_attempt_at = ?,
        last_error_json = NULL,
        updated_at = ?
      WHERE plan_id = ?
        AND adapter = ?
        AND status IN ('failed','retry_wait','ack_failed')
        ${commentId ? 'AND comment_id = ?' : ''}
    `).run(...(commentId ? [now, now, planId, adapter, commentId] : [now, now, planId, adapter]));
    return { retried: result.changes, rows: this.listDeliveryRows(planId, adapter).filter(row => !commentId || row.commentId === commentId) };
  }

  activeClaim(claimId: string, commentId: string): { id: string; leaseExpiresAt: string } | null {
    const row = this.db.prepare(`
      SELECT id, lease_expires_at AS leaseExpiresAt
      FROM claims
      WHERE id = ? AND comment_id = ? AND released_at IS NULL AND acknowledged_at IS NULL AND lease_expires_at > ?
    `).get(claimId, commentId, nowIso()) as { id: string; leaseExpiresAt: string } | undefined;
    return row ?? null;
  }

  registerPlan(input: RegisterPlanInput, renderedHtml: string, renderWarnings: unknown[], syncOrigin: 'manual_register' | 'filesystem_watch' = 'manual_register', validateBeforeCommit?: () => void) {
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
      const reviewMode = inferReviewMode(input);
      const lastSyncStatus = watchMode === 'filesystem' ? 'synced' : 'snapshot';
      const inferredProjectName = inferProjectName({ rootPath: input.rootPath, repoName: input.repoName, sourcePath: input.sourcePath, planPath: input.planPath });
      const inferredProjectKey = normalizeProjectKey(inferredProjectName);
      const defaultBoardColumn = reviewMode === 'planning' ? this.defaultVisibleBoardColumnKey('backlog') : null;
      this.db
        .prepare(`INSERT INTO plans (id, repo_id, slug, plan_path, source_path, watch_mode, review_mode, lifecycle_state, deferred_at, deferred_note_id, last_sync_at, last_sync_status, last_sync_error_json, archived_at, publication_metadata_json, board_column_key, pinned_at, project_key, project_name, project_overridden_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?)
          ON CONFLICT(repo_id, plan_path, slug) DO UPDATE SET updated_at = excluded.updated_at,
            source_path = excluded.source_path, watch_mode = excluded.watch_mode, review_mode = excluded.review_mode,
            last_sync_at = excluded.last_sync_at, last_sync_status = excluded.last_sync_status,
            last_sync_error_json = excluded.last_sync_error_json,
            publication_metadata_json = excluded.publication_metadata_json,
            board_column_key = CASE WHEN excluded.review_mode = 'planning' THEN COALESCE(plans.board_column_key, excluded.board_column_key) ELSE NULL END,
            project_key = CASE WHEN plans.project_overridden_at IS NULL THEN excluded.project_key ELSE plans.project_key END,
            project_name = CASE WHEN plans.project_overridden_at IS NULL THEN excluded.project_name ELSE plans.project_name END,
            project_overridden_at = plans.project_overridden_at,
            pinned_at = plans.pinned_at,
            archived_at = plans.archived_at,
            lifecycle_state = plans.lifecycle_state,
            deferred_at = plans.deferred_at,
            deferred_note_id = plans.deferred_note_id`)
        .run(planId, repoId, slug, input.planPath, input.sourcePath ?? null, watchMode, reviewMode, now, lastSyncStatus, null, input.publicationMetadata ? JSON.stringify(input.publicationMetadata) : null, defaultBoardColumn, inferredProjectKey, inferredProjectName, now, now);

      const htmlName = `${input.fileHash}.html`;
      const renderedName = `${sha256(renderedHtml)}.rendered.html`;
      const htmlBlobPath = this.writeBlob('html', htmlName, input.html);
      const renderedBlobPath = this.writeBlob('rendered', renderedName, renderedHtml);
      const commitSha = input.commitSha ?? '';
      const progress = extractPlanProgress(input.html);
      const displayTitle = renderedHtmlTitle(input.html) ?? planTitleFallback({ id: planId, repoName: input.repoName, slug });
      const existingVersion = this.db
        .prepare('SELECT id FROM plan_versions WHERE plan_id = ? AND file_hash = ? AND branch = ? AND commit_sha = ?')
        .get(planId, input.fileHash, input.branch, commitSha) as { id: string } | undefined;
      const versionId = existingVersion?.id || id('ver');
      this.db
        .prepare(`INSERT INTO plan_versions
          (id, plan_id, file_hash, branch, commit_sha, html_blob_path, rendered_blob_path, render_warnings_json, source_mtime_ms, source_size, sync_origin, display_title, progress_json, progress_total, progress_completed, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(plan_id, file_hash, branch, commit_sha) DO UPDATE SET
            html_blob_path = excluded.html_blob_path, rendered_blob_path = excluded.rendered_blob_path,
            source_mtime_ms = excluded.source_mtime_ms, source_size = excluded.source_size,
            sync_origin = excluded.sync_origin, display_title = excluded.display_title,
            progress_json = excluded.progress_json, progress_total = excluded.progress_total,
            progress_completed = excluded.progress_completed, created_at = excluded.created_at,
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
          displayTitle,
          JSON.stringify(progress),
          progress.totalPhases,
          progress.completedPhases,
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
        reviewMode,
        lastSyncStatus
      });
      validateBeforeCommit?.();

      return {
        planId,
        versionId,
        repoId,
        repoKey,
        slug,
        sourceSync: { watchMode, sourcePath: input.sourcePath, status: lastSyncStatus, active: watchMode === 'filesystem' && this.getPlan(planId).plan.lifecycleState === 'active' },
        event,
        reviewUrl: `/p/${planId}`,
        indexUrl: '/',
        watchCommand: `plan-review watch ${planId} --mode queue`
      };
    });
    const result = tx();
    if (input.codexDelivery) {
      const codexDelivery = this.upsertDeliveryTarget(result.planId, { adapter: 'codex', ...input.codexDelivery });
      return { ...result, codexDelivery };
    }
    return result;
  }

  private planListWhere(options: ListPlansOptions = {}): { where: string; args: unknown[] } {
    const filters: string[] = [];
    const args: unknown[] = [];
    if (options.lifecycleState) {
      if (options.lifecycleState === 'archived') filters.push('p.archived_at IS NOT NULL');
      else if (options.lifecycleState === 'deferred') filters.push("p.archived_at IS NULL AND p.lifecycle_state = 'deferred'");
      else filters.push("p.archived_at IS NULL AND COALESCE(p.lifecycle_state, 'active') != 'deferred'");
    } else {
      if (!options.includeArchived) filters.push('p.archived_at IS NULL');
      if (!options.includeDeferred) filters.push("COALESCE(p.lifecycle_state, 'active') != 'deferred'");
    }
    if (options.projectKey) {
      filters.push('p.project_key = ?');
      args.push(options.projectKey);
    }
    if (options.reviewMode) {
      filters.push('p.review_mode = ?');
      args.push(options.reviewMode);
    }
    if (options.boardColumnKey) {
      filters.push('p.board_column_key = ?');
      args.push(options.boardColumnKey);
    }
    return { where: filters.length ? `WHERE ${filters.join(' AND ')}` : '', args };
  }

  countPlansByLifecycle(): { active: number; deferred: number; archived: number } {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN p.archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN p.archived_at IS NULL AND p.lifecycle_state = 'deferred' THEN 1 ELSE 0 END) AS deferred,
      SUM(CASE WHEN p.archived_at IS NULL AND COALESCE(p.lifecycle_state, 'active') != 'deferred' THEN 1 ELSE 0 END) AS active
      FROM plans p`).get() as Record<string, unknown> | undefined;
    return { active: Number(row?.active ?? 0), deferred: Number(row?.deferred ?? 0), archived: Number(row?.archived ?? 0) };
  }

  listPlanProjects(): PlanProjectRecord[] {
    const rows = this.db.prepare(`SELECT p.project_key AS projectKey, p.project_name AS projectName
      FROM plans p
      GROUP BY p.project_key, p.project_name
      ORDER BY LOWER(p.project_name) ASC, LOWER(p.project_key) ASC`).all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      projectKey: optionalString(row.projectKey) ?? normalizeProjectKey(String(row.projectName ?? 'Uncategorized')),
      projectName: optionalString(row.projectName) ?? String(row.projectKey ?? 'Uncategorized')
    }));
  }

  countActivePlanningPlansByColumn(): Map<string, number> {
    const rows = this.db.prepare(`SELECT COALESCE(p.board_column_key, '') AS boardColumnKey, COUNT(*) AS count
      FROM plans p
      WHERE p.review_mode = 'planning' AND p.archived_at IS NULL AND COALESCE(p.lifecycle_state, 'active') != 'deferred'
      GROUP BY COALESCE(p.board_column_key, '')`).all() as Array<Record<string, unknown>>;
    return new Map(rows.map(row => [String(row.boardColumnKey ?? ''), Number(row.count ?? 0)]));
  }

  listPlans(options: ListPlansOptions = {}) {
    const { where: baseWhere, args: baseArgs } = this.planListWhere(options);
    const boundedLimit = options.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;
    const orderBy = `ORDER BY
      CASE WHEN p.pinned_at IS NULL THEN 1 ELSE 0 END ASC,
      p.pinned_at DESC,
      CASE
        WHEN p.watch_mode = 'filesystem' AND p.last_sync_status = 'failed' THEN 3
        WHEN COALESCE(v.progress_total, 0) > 0 AND COALESCE(v.progress_completed, 0) = COALESCE(v.progress_total, 0) THEN 0
        WHEN COALESCE(json_extract(p.publication_metadata_json, '$.executionReady'), 0) = 1 THEN 1
        ELSE 2
      END ASC,
      CASE WHEN COALESCE(v.progress_total, 0) > 0 THEN CAST(COALESCE(v.progress_completed, 0) AS REAL) / v.progress_total ELSE 0 END DESC,
      activityAt DESC,
      r.repo_name ASC,
      p.slug ASC,
      p.id ASC`;
    const selectRows = (where: string, limit?: number, args: unknown[] = []) => this.db.prepare(`
      SELECT p.id, p.slug, p.plan_path AS planPath, p.source_path AS sourcePath, p.watch_mode AS watchMode,
        p.review_mode AS reviewMode, p.lifecycle_state AS lifecycleState, p.deferred_at AS deferredAt, p.deferred_note_id AS deferredNoteId,
        p.last_sync_at AS lastSyncAt, p.last_sync_status AS lastSyncStatus, p.last_sync_error_json AS lastSyncErrorJson,
        p.archived_at AS archivedAt, p.publication_metadata_json AS publicationMetadataJson,
        p.board_column_key AS boardColumnKey, p.pinned_at AS pinnedAt, p.project_key AS projectKey, p.project_name AS projectName, p.project_overridden_at AS projectOverriddenAt,
        r.repo_name AS repoName, r.repo_key AS repoKey, r.remote_url AS remoteUrl, r.root_path AS rootPath,
        v.id AS versionId, v.branch, v.commit_sha AS commitSha, v.file_hash AS fileHash,
        v.html_blob_path AS htmlBlobPath, v.display_title AS displayTitle, v.progress_json AS progressJson,
        v.source_mtime_ms AS sourceMtimeMs, v.source_size AS sourceSize, v.sync_origin AS syncOrigin,
        v.created_at AS versionCreatedAt, p.updated_at AS planUpdatedAt,
        SUM(CASE WHEN c.deleted_at IS NULL AND c.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN c.deleted_at IS NULL AND c.status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN c.deleted_at IS NULL AND c.status = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
        SUM(CASE WHEN c.deleted_at IS NULL AND c.status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
        MAX(COALESCE(c.updated_at, c.created_at)) AS commentActivityAt,
        CASE WHEN MAX(COALESCE(c.updated_at, c.created_at)) > p.updated_at THEN MAX(COALESCE(c.updated_at, c.created_at)) ELSE p.updated_at END AS activityAt
      FROM plans p
      JOIN repos r ON r.id = p.repo_id
      LEFT JOIN plan_versions v ON v.id = (
        SELECT id FROM plan_versions WHERE plan_id = p.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN comments c ON c.plan_id = p.id
      ${where}
      GROUP BY p.id
      ${orderBy}
      ${limit ? `LIMIT ${limit}` : ''}
    `).all(...args) as Array<Record<string, unknown>>;
    let rows = selectRows(baseWhere, boundedLimit, baseArgs);
    if (boundedLimit && options.currentPlanId && !rows.some(row => String(row.id) === options.currentPlanId)) {
      rows = [...rows, ...selectRows('WHERE p.id = ?', undefined, [options.currentPlanId])];
    }
    const plans = rows.map(row => {
      const planUpdatedAt = String(row.planUpdatedAt ?? '');
      const commentActivityAt = row.commentActivityAt ? String(row.commentActivityAt) : '';
      const activityAt = commentActivityAt > planUpdatedAt ? commentActivityAt : planUpdatedAt;
      const htmlBlobPath = optionalString(row.htmlBlobPath);
      const sourceMtimeMs = optionalNumber(row.sourceMtimeMs);
      const modifiedAt = isoFromEpochMs(sourceMtimeMs) ?? String(row.versionCreatedAt ?? planUpdatedAt);
      const storedProgress = parseJson<PlanProgress | null>(row.progressJson as string | null, null);
      const html = htmlBlobPath ? fs.readFileSync(htmlBlobPath, 'utf8') : '';
      const progress = storedProgress ?? (html ? extractPlanProgress(html) : { totalPhases: 0, completedPhases: 0, phases: [] });
      const displayTitle = optionalString(row.displayTitle) ?? (html ? renderedHtmlTitle(html) : undefined) ?? planTitleFallback({ id: row.id, repoName: row.repoName, slug: row.slug });
      const latestNote = this.latestPlanNote(String(row.id));
      const reviewMode = (row.reviewMode ?? 'planning') as ReviewMode;
      const publicationMetadata = metadataFromRow(row, reviewMode);
      const linearIssueKey = normalizeLinearIssueKey(publicationMetadata?.linearIssue, searchablePlanTextForLinear(html));
      const planId = String(row.id);
      return {
      plan: {
        id: row.id,
        slug: row.slug,
        planPath: row.planPath,
        repoName: row.repoName,
        repoKey: row.repoKey,
        remoteUrl: optionalString(row.remoteUrl),
        rootPath: optionalString(row.rootPath),
        sourcePath: optionalString(row.sourcePath),
        watchMode: (row.watchMode ?? 'snapshot') as 'filesystem' | 'snapshot',
        reviewMode,
        lifecycleState: lifecycleStateFromRow(row),
        deferredAt: optionalString(row.deferredAt),
        deferredNoteId: optionalString(row.deferredNoteId),
        lastSyncAt: optionalString(row.lastSyncAt),
        lastSyncStatus: optionalString(row.lastSyncStatus),
        lastSyncError: parseJson(row.lastSyncErrorJson as string | null, null),
        archivedAt: optionalString(row.archivedAt),
        publicationMetadata,
        linearIssueKey,
        linearIssueUrl: linearIssueKey ? linearIssueUrl(linearIssueKey) : undefined,
        pullRequest: this.getPullRequest(planId),
        boardColumnKey: optionalString(row.boardColumnKey),
        pinnedAt: optionalString(row.pinnedAt),
        projectKey: optionalString(row.projectKey) ?? normalizeProjectKey(String(row.repoName ?? 'Uncategorized')),
        projectName: optionalString(row.projectName) ?? String(row.repoName ?? 'Uncategorized'),
        projectOverriddenAt: optionalString(row.projectOverriddenAt)
      },
      latestVersion: {
        id: row.versionId,
        branch: row.branch,
        commitSha: row.commitSha,
        fileHash: row.fileHash,
        sourceMtimeMs,
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
      noteCount: this.countPlanNotes(String(row.id)),
      latestNote,
      activityAt,
      modifiedAt,
      displayTitle,
      reviewUrl: `/p/${row.id}`
      };
    });
    return boundedLimit ? plans : plans.sort((a, b) => {
      if (Boolean(a.plan.pinnedAt) !== Boolean(b.plan.pinnedAt)) return a.plan.pinnedAt ? -1 : 1;
      if (a.plan.pinnedAt && b.plan.pinnedAt && a.plan.pinnedAt !== b.plan.pinnedAt) return String(b.plan.pinnedAt).localeCompare(String(a.plan.pinnedAt));
      const aStarted = a.progress.totalPhases > 0 && a.progress.completedPhases > 0;
      const bStarted = b.progress.totalPhases > 0 && b.progress.completedPhases > 0;
      if (aStarted !== bStarted) return bStarted ? 1 : -1;
      if (aStarted && bStarted) {
        const aRatio = a.progress.completedPhases / a.progress.totalPhases;
        const bRatio = b.progress.completedPhases / b.progress.totalPhases;
        if (aRatio !== bRatio) return bRatio - aRatio;
      }
      return String(b.activityAt).localeCompare(String(a.activityAt))
        || String(a.plan.repoName).localeCompare(String(b.plan.repoName))
        || String(a.plan.slug).localeCompare(String(b.plan.slug))
        || String(a.plan.id).localeCompare(String(b.plan.id));
    });
  }

  private noteFromRow(row: Record<string, unknown>): PlanNoteRecord {
    return {
      id: String(row.id),
      planId: String(row.plan_id ?? row.planId),
      body: String(row.body),
      createdBy: parseJson(String(row.created_by_json ?? row.createdByJson), {}),
      createdAt: String(row.created_at ?? row.createdAt)
    };
  }

  createPlanNote(planId: string, input: CreatePlanNoteInput): { note: PlanNoteRecord; event?: StoredEvent; created: boolean } {
    const tx = this.db.transaction(() => {
      this.getPlan(planId);
      const duplicate = input.clientMutationId
        ? this.db.prepare('SELECT * FROM plan_notes WHERE plan_id = ? AND client_mutation_id = ?').get(planId, input.clientMutationId) as Record<string, unknown> | undefined
        : undefined;
      if (duplicate) {
        return { note: this.noteFromRow(duplicate), created: false };
      }
      const now = nowIso();
      const noteId = id('note');
      this.db.prepare(`INSERT INTO plan_notes (id, plan_id, body, created_by_json, client_mutation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(noteId, planId, input.body, JSON.stringify(noteAuthor(input.createdBy)), input.clientMutationId ?? null, now);
      this.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now, planId);
      const note = this.getPlanNote(noteId);
      const event = this.addEvent(planId, 'plan.note.created', { eventType: 'plan.note.created', planId, note });
      return { note, event, created: true };
    });
    return tx();
  }

  private getPlanNote(noteId: string): PlanNoteRecord {
    const row = this.db.prepare('SELECT * FROM plan_notes WHERE id = ?').get(noteId) as Record<string, unknown> | undefined;
    if (!row) throw new PlanReviewError('not_found', `Plan note '${noteId}' was not found`, 404);
    return this.noteFromRow(row);
  }

  listPlanNotes(planId: string, options: { limit?: number } = {}): PlanNoteRecord[] {
    this.getPlan(planId);
    const rows = this.db.prepare('SELECT * FROM plan_notes WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(planId, options.limit ?? 50) as Array<Record<string, unknown>>;
    return rows.map(row => this.noteFromRow(row));
  }

  private latestPlanNote(planId: string): PlanNoteRecord | undefined {
    return this.listPlanNotes(planId, { limit: 1 })[0];
  }

  private countPlanNotes(planId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM plan_notes WHERE plan_id = ?').get(planId) as { count: number };
    return Number(row.count ?? 0);
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

  latestEventSequence(planId: string, mode: 'all' | 'queue' = 'all'): number {
    const eventFilter = mode === 'queue'
      ? "AND event_type IN ('comment.created','comment.claimed','comment.acknowledged','comment.resolved','comment.released','comment.deleted','comment.thread_entry.created')"
      : '';
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(sequence), 0) AS latest FROM comment_events WHERE plan_id = ? ${eventFilter}`)
      .get(planId) as { latest: number };
    return Number(row.latest ?? 0);
  }

  getPlanCounts(planId: string): { pending: number; claimed: number; acknowledged: number; resolved: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN deleted_at IS NULL AND status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN deleted_at IS NULL AND status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN deleted_at IS NULL AND status = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
        SUM(CASE WHEN deleted_at IS NULL AND status = 'resolved' THEN 1 ELSE 0 END) AS resolved
      FROM comments
      WHERE plan_id = ?
    `).get(planId) as Record<string, unknown> | undefined;
    return {
      pending: Number(row?.pending ?? 0),
      claimed: Number(row?.claimed ?? 0),
      acknowledged: Number(row?.acknowledged ?? 0),
      resolved: Number(row?.resolved ?? 0)
    };
  }

  getPlanProgress(planId: string): PlanProgress {
    const { version } = this.getPlan(planId);
    if (!version.htmlBlobPath) return { totalPhases: 0, completedPhases: 0, phases: [] };
    return extractPlanProgress(fs.readFileSync(version.htmlBlobPath, 'utf8'));
  }

  getPlan(identifier: string): { plan: PlanRecord; version: VersionRecord } {
    const row = this.db.prepare(`
      SELECT p.id, p.repo_id AS repoId, p.slug, p.plan_path AS planPath, p.source_path AS sourcePath,
        p.watch_mode AS watchMode, p.review_mode AS reviewMode, p.lifecycle_state AS lifecycleState, p.deferred_at AS deferredAt, p.deferred_note_id AS deferredNoteId,
        p.last_sync_at AS lastSyncAt, p.last_sync_status AS lastSyncStatus,
        p.last_sync_error_json AS lastSyncErrorJson, p.archived_at AS archivedAt, p.publication_metadata_json AS publicationMetadataJson,
        p.board_column_key AS boardColumnKey, p.pinned_at AS pinnedAt, p.project_key AS projectKey, p.project_name AS projectName, p.project_overridden_at AS projectOverriddenAt,
        r.repo_name AS repoName, r.repo_key AS repoKey, r.remote_url AS remoteUrl, r.root_path AS rootPath,
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
        p.watch_mode AS watchMode, p.review_mode AS reviewMode, p.lifecycle_state AS lifecycleState, p.deferred_at AS deferredAt, p.deferred_note_id AS deferredNoteId,
        p.last_sync_at AS lastSyncAt, p.last_sync_status AS lastSyncStatus,
        p.last_sync_error_json AS lastSyncErrorJson, p.archived_at AS archivedAt, p.publication_metadata_json AS publicationMetadataJson,
        p.board_column_key AS boardColumnKey, p.pinned_at AS pinnedAt, p.project_key AS projectKey, p.project_name AS projectName, p.project_overridden_at AS projectOverriddenAt,
        r.repo_name AS repoName, r.repo_key AS repoKey, r.remote_url AS remoteUrl, r.root_path AS rootPath,
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
    const reviewMode = (selectedRow.reviewMode ?? 'planning') as ReviewMode;
    const publicationMetadata = metadataFromRow(selectedRow, reviewMode);
    const html = fs.readFileSync(selectedRow.htmlBlobPath, 'utf8');
    const linearIssueKey = normalizeLinearIssueKey(publicationMetadata?.linearIssue, searchablePlanTextForLinear(html));
    return {
      plan: {
        id: selectedRow.id,
        repoId: selectedRow.repoId,
        slug: selectedRow.slug,
        planPath: selectedRow.planPath,
        repoName: selectedRow.repoName,
        repoKey: selectedRow.repoKey,
        remoteUrl: optionalString(selectedRow.remoteUrl),
        rootPath: optionalString(selectedRow.rootPath),
        branch: selectedRow.branch,
        commitSha: selectedRow.commitSha ?? undefined,
        sourcePath: optionalString(selectedRow.sourcePath),
        watchMode: (selectedRow.watchMode ?? 'snapshot') as 'filesystem' | 'snapshot',
        reviewMode,
        lifecycleState: lifecycleStateFromRow(selectedRow),
        deferredAt: optionalString(selectedRow.deferredAt),
        deferredNoteId: optionalString(selectedRow.deferredNoteId),
        lastSyncAt: optionalString(selectedRow.lastSyncAt),
        lastSyncStatus: optionalString(selectedRow.lastSyncStatus),
        lastSyncError: parseJson(selectedRow.lastSyncErrorJson, null),
        archivedAt: optionalString(selectedRow.archivedAt),
        publicationMetadata,
        linearIssueKey,
        linearIssueUrl: linearIssueKey ? linearIssueUrl(linearIssueKey) : undefined,
        pullRequest: this.getPullRequest(selectedRow.id),
        boardColumnKey: optionalString(selectedRow.boardColumnKey),
        pinnedAt: optionalString(selectedRow.pinnedAt),
        projectKey: optionalString(selectedRow.projectKey) ?? normalizeProjectKey(String(selectedRow.repoName ?? 'Uncategorized')),
        projectName: optionalString(selectedRow.projectName) ?? String(selectedRow.repoName ?? 'Uncategorized'),
        projectOverriddenAt: optionalString(selectedRow.projectOverriddenAt)
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

  getPlanSourceExport(identifier: string, versionId?: string) {
    const { plan, version } = this.getPlan(identifier);
    const selectedVersionId = versionId ?? version.id;
    const row = this.db.prepare(`
      SELECT id, file_hash AS fileHash, branch, commit_sha AS commitSha, html_blob_path AS htmlBlobPath,
        rendered_blob_path AS renderedBlobPath, render_warnings_json AS renderWarningsJson,
        source_mtime_ms AS sourceMtimeMs, source_size AS sourceSize, sync_origin AS syncOrigin
      FROM plan_versions
      WHERE id = ? AND plan_id = ?
    `).get(selectedVersionId, plan.id) as Record<string, unknown> | undefined;
    if (!row) throw new PlanReviewError('not_found', `Version '${selectedVersionId}' was not found for plan '${plan.id}'`, 404);
    const assetRows = this.db.prepare(`
      SELECT id, source_url AS sourceUrl, asset_hash AS assetHash, content_type AS contentType,
        width, height, status, warning_json AS warningJson, blob_path AS blobPath
      FROM plan_assets
      WHERE version_id = ?
      ORDER BY source_url
    `).all(selectedVersionId) as Array<Record<string, unknown>>;
    const htmlBlobPath = String(row.htmlBlobPath);
    return {
      plan,
      version: {
        id: String(row.id),
        planId: plan.id,
        fileHash: String(row.fileHash),
        branch: String(row.branch),
        commitSha: optionalString(row.commitSha),
        htmlBlobPath,
        renderedBlobPath: String(row.renderedBlobPath),
        renderWarnings: parseJson(row.renderWarningsJson as string | null, []),
        sourceMtimeMs: optionalNumber(row.sourceMtimeMs),
        sourceSize: optionalNumber(row.sourceSize),
        syncOrigin: (row.syncOrigin ?? 'manual_register') as 'manual_register' | 'filesystem_watch'
      },
      html: fs.readFileSync(htmlBlobPath, 'utf8'),
      assets: assetRows.map(asset => ({
        id: String(asset.id),
        sourceUrl: String(asset.sourceUrl),
        assetHash: optionalString(asset.assetHash),
        contentType: optionalString(asset.contentType),
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        status: String(asset.status),
        warning: parseJson(asset.warningJson as string | null, null),
        blobPath: optionalString(asset.blobPath)
      }))
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

  changePlanMode(identifier: string, reviewMode: ReviewMode): { plan: PlanRecord; event: StoredEvent; changed: boolean } {
    const tx = this.db.transaction(() => {
      const { plan } = this.getPlan(identifier);
      if (plan.reviewMode === reviewMode) {
        const event = this.addEvent(plan.id, 'plan.mode.changed', { eventType: 'plan.mode.changed', planId: plan.id, reviewMode, changed: false });
        return { plan, event, changed: false };
      }
      const now = nowIso();
      const boardColumn = reviewMode === 'planning' ? (plan.boardColumnKey ?? this.defaultVisibleBoardColumnKey('backlog')) : null;
      const pinnedAt = reviewMode === 'planning' ? plan.pinnedAt ?? null : null;
      this.db.prepare('UPDATE plans SET review_mode = ?, board_column_key = ?, pinned_at = ?, updated_at = ? WHERE id = ?').run(reviewMode, boardColumn, pinnedAt, now, plan.id);
      const updated = this.getPlan(plan.id).plan;
      const event = this.addEvent(plan.id, 'plan.mode.changed', { eventType: 'plan.mode.changed', planId: plan.id, reviewMode, changed: true });
      return { plan: updated, event, changed: true };
    });
    return tx();
  }

  setPlanLifecycleState(identifier: string, lifecycleState: PlanLifecycleState): { plan: PlanRecord; event: StoredEvent; changed: boolean } {
    const tx = this.db.transaction(() => {
      const { plan } = this.getPlan(identifier);
      const changed = plan.lifecycleState !== lifecycleState;
      const now = nowIso();
      if (changed) {
        if (lifecycleState === 'archived') {
          this.db.prepare("UPDATE plans SET lifecycle_state = 'archived', archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?").run(now, now, plan.id);
        } else if (lifecycleState === 'deferred') {
          this.db.prepare("UPDATE plans SET lifecycle_state = 'deferred', archived_at = NULL, deferred_at = COALESCE(deferred_at, ?), updated_at = ? WHERE id = ?").run(now, now, plan.id);
        } else {
          this.db.prepare("UPDATE plans SET lifecycle_state = 'active', archived_at = NULL, deferred_at = NULL, deferred_note_id = NULL, board_column_key = COALESCE(?, board_column_key), updated_at = ? WHERE id = ?").run(this.visibleBoardColumnKey(plan.boardColumnKey), now, plan.id);
        }
      }
      const updated = this.getPlan(plan.id).plan;
      const event = this.addEvent(plan.id, 'plan.lifecycle.changed', { eventType: 'plan.lifecycle.changed', planId: plan.id, lifecycleState, changed });
      return { plan: updated, event, changed };
    });
    return tx();
  }

  setPlanBoardColumn(identifier: string, boardColumnKey: string): { plan: PlanRecord; column: BoardColumnRecord; event: StoredEvent; changed: boolean } {
    const tx = this.db.transaction(() => {
      const { plan } = this.getPlan(identifier);
      if (plan.reviewMode !== 'planning') {
        throw new PlanReviewError('not_applicable', 'Collaboration documents cannot be moved to board columns', 400, { planId: plan.id, reviewMode: plan.reviewMode }, 'Use All documents with Filter by type set to Collaborative; board columns apply only to planning documents.');
      }
      const column = this.requireBoardColumn(boardColumnKey);
      const changed = plan.boardColumnKey !== column.key;
      if (changed) this.db.prepare('UPDATE plans SET board_column_key = ?, updated_at = ? WHERE id = ?').run(column.key, nowIso(), plan.id);
      const updated = this.getPlan(plan.id).plan;
      const event = this.addEvent(plan.id, 'plan.column.changed', { eventType: 'plan.column.changed', planId: plan.id, boardColumnKey: column.key, changed });
      return { plan: updated, column, event, changed };
    });
    return tx();
  }

  setPlanPinned(identifier: string, pinned: boolean): { plan: PlanRecord; event: StoredEvent; changed: boolean } {
    const tx = this.db.transaction(() => {
      const { plan } = this.getPlan(identifier);
      if (plan.reviewMode !== 'planning') {
        throw new PlanReviewError('not_applicable', 'Collaboration documents cannot be pinned as plans', 400, { planId: plan.id, reviewMode: plan.reviewMode }, 'Use All documents with Filter by type set to Collaborative; pinning applies only to planning documents.');
      }
      const changed = Boolean(plan.pinnedAt) !== pinned;
      const pinnedAt = pinned ? (plan.pinnedAt ?? nowIso()) : null;
      if (changed) this.db.prepare('UPDATE plans SET pinned_at = ?, updated_at = ? WHERE id = ?').run(pinnedAt, nowIso(), plan.id);
      const updated = this.getPlan(plan.id).plan;
      const event = this.addEvent(plan.id, 'plan.pin.changed', { eventType: 'plan.pin.changed', planId: plan.id, pinned, pinnedAt: updated.pinnedAt, changed });
      return { plan: updated, event, changed };
    });
    return tx();
  }

  setPlanProject(identifier: string, input: { projectName: string; projectKey?: string }): { plan: PlanRecord; event: StoredEvent; changed: boolean } {
    const tx = this.db.transaction(() => {
      const { plan } = this.getPlan(identifier);
      if (plan.reviewMode !== 'planning') {
        throw new PlanReviewError('not_applicable', 'Collaboration documents cannot use planning project overrides', 400, { planId: plan.id, reviewMode: plan.reviewMode }, 'Use All documents with Filter by type set to Collaborative; project overrides apply only to planning documents.');
      }
      const projectName = input.projectName.trim();
      const projectKey = input.projectKey?.trim() || normalizeProjectKey(projectName);
      const changed = plan.projectName !== projectName || plan.projectKey !== projectKey || !plan.projectOverriddenAt;
      const now = nowIso();
      if (changed) this.db.prepare('UPDATE plans SET project_key = ?, project_name = ?, project_overridden_at = COALESCE(project_overridden_at, ?), updated_at = ? WHERE id = ?').run(projectKey, projectName, now, now, plan.id);
      const updated = this.getPlan(plan.id).plan;
      const event = this.addEvent(plan.id, 'plan.project.changed', { eventType: 'plan.project.changed', planId: plan.id, projectKey, projectName, changed });
      return { plan: updated, event, changed };
    });
    return tx();
  }

  deferPlan(identifier: string, input: DeferPlanInput): { plan: PlanRecord; note: PlanNoteRecord; events: StoredEvent[] } {
    const tx = this.db.transaction(() => {
      const { plan } = this.getPlan(identifier);
      if (plan.lifecycleState === 'archived') {
        throw new PlanReviewError('invalid_state', 'Archived plans cannot be deferred', 409, { planId: plan.id, lifecycleState: plan.lifecycleState }, 'Restore the archived plan before deferring it.');
      }
      if (plan.lifecycleState === 'deferred') {
        throw new PlanReviewError('invalid_state', 'Plan is already deferred', 409, { planId: plan.id, lifecycleState: plan.lifecycleState }, 'Resume the plan before deferring it again, or add a plan note to update deferred status.');
      }
      const now = nowIso();
      const noteId = id('note');
      this.db.prepare(`INSERT INTO plan_notes (id, plan_id, body, created_by_json, client_mutation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_id, client_mutation_id) DO NOTHING`)
        .run(noteId, plan.id, input.note, JSON.stringify(noteAuthor(input.createdBy)), input.clientMutationId ?? null, now);
      const note = input.clientMutationId
        ? (this.db.prepare('SELECT * FROM plan_notes WHERE plan_id = ? AND client_mutation_id = ?').get(plan.id, input.clientMutationId) as Record<string, unknown> | undefined)
        : undefined;
      const storedNote = note ? this.noteFromRow(note) : this.getPlanNote(noteId);
      this.db.prepare("UPDATE plans SET lifecycle_state = 'deferred', deferred_at = COALESCE(deferred_at, ?), deferred_note_id = ?, archived_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, storedNote.id, now, plan.id);
      const updated = this.getPlan(plan.id).plan;
      const noteEvent = this.addEvent(plan.id, 'plan.note.created', { eventType: 'plan.note.created', planId: plan.id, note: storedNote });
      const deferredEvent = this.addEvent(plan.id, 'plan.deferred', { eventType: 'plan.deferred', planId: plan.id, deferredAt: updated.deferredAt, deferredNoteId: storedNote.id });
      return { plan: updated, note: storedNote, events: [noteEvent, deferredEvent] };
    });
    return tx();
  }

  resumePlan(identifier: string, input: ResumePlanInput = {}): { plan: PlanRecord; note?: PlanNoteRecord; events: StoredEvent[] } {
    const tx = this.db.transaction(() => {
      const { plan } = this.getPlan(identifier);
      if (plan.lifecycleState === 'archived') {
        throw new PlanReviewError('invalid_state', 'Archived plans cannot be resumed from deferred state', 409, { planId: plan.id, lifecycleState: plan.lifecycleState }, 'Restore the archived plan first.');
      }
      if (plan.lifecycleState !== 'deferred') {
        throw new PlanReviewError('invalid_state', 'Only deferred plans can be resumed', 409, { planId: plan.id, lifecycleState: plan.lifecycleState }, 'Defer the plan first, or continue working from the active plan page.');
      }
      const now = nowIso();
      let note: PlanNoteRecord | undefined;
      const events: StoredEvent[] = [];
      if (input.note) {
        const noteId = id('note');
        this.db.prepare(`INSERT INTO plan_notes (id, plan_id, body, created_by_json, client_mutation_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(noteId, plan.id, input.note, JSON.stringify(noteAuthor(input.createdBy)), input.clientMutationId ?? null, now);
        note = this.getPlanNote(noteId);
        events.push(this.addEvent(plan.id, 'plan.note.created', { eventType: 'plan.note.created', planId: plan.id, note }));
      }
      this.db.prepare("UPDATE plans SET lifecycle_state = 'active', deferred_at = NULL, deferred_note_id = NULL, board_column_key = COALESCE(?, board_column_key), updated_at = ? WHERE id = ?")
        .run(this.visibleBoardColumnKey(plan.boardColumnKey), now, plan.id);
      const updated = this.getPlan(plan.id).plan;
      events.push(this.addEvent(plan.id, 'plan.resumed', { eventType: 'plan.resumed', planId: plan.id, resumedAt: now, noteId: note?.id }));
      return { plan: updated, note, events };
    });
    return tx();
  }

  archivePlan(identifier: string): { plan: PlanRecord; event: StoredEvent } {
    const { plan } = this.getPlan(identifier);
    const archivedAt = plan.archivedAt ?? nowIso();
    if (!plan.archivedAt) {
      this.db.prepare("UPDATE plans SET archived_at = ?, lifecycle_state = 'archived', updated_at = ? WHERE id = ?").run(archivedAt, archivedAt, plan.id);
    }
    const updated = this.getPlan(plan.id).plan;
    const event = this.addEvent(plan.id, 'plan.archived', { eventType: 'plan.archived', planId: plan.id, archivedAt });
    return { plan: updated, event };
  }

  unarchivePlan(identifier: string): { plan: PlanRecord; event: StoredEvent } {
    const { plan } = this.getPlan(identifier);
    const unarchivedAt = nowIso();
    if (plan.archivedAt) {
      this.db.prepare("UPDATE plans SET archived_at = NULL, lifecycle_state = 'active', deferred_at = NULL, deferred_note_id = NULL, board_column_key = COALESCE(?, board_column_key), updated_at = ? WHERE id = ?").run(this.visibleBoardColumnKey(plan.boardColumnKey), unarchivedAt, plan.id);
    }
    const updated = this.getPlan(plan.id).plan;
    const event = this.addEvent(plan.id, 'plan.unarchived', { eventType: 'plan.unarchived', planId: plan.id, unarchivedAt });
    return { plan: updated, event };
  }

  listFilesystemPlans(): Array<{ planId: string }> {
    const rows = this.db.prepare("SELECT id AS planId FROM plans WHERE watch_mode = 'filesystem' AND source_path IS NOT NULL AND archived_at IS NULL AND COALESCE(lifecycle_state, 'active') != 'deferred' ORDER BY updated_at DESC").all() as Array<{ planId: string }>;
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

  getCommentByClientMutationId(planId: string, clientMutationId: string): { comment: StoredComment; event: StoredEvent } | undefined {
    const duplicate = this.db.prepare('SELECT id FROM comments WHERE plan_id = ? AND client_mutation_id = ?').get(planId, clientMutationId) as { id: string } | undefined;
    if (!duplicate) return undefined;
    return { comment: this.getComment(duplicate.id), event: this.getCommentCreatedEvent(duplicate.id) };
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
        const existing = this.getComment(duplicate.id);
        if (existing.deletedAt) {
          throw new PlanReviewError(
            'duplicate_comment_deleted',
            'This comment draft was already submitted and then deleted.',
            409,
            { commentId: existing.id, clientMutationId: input.clientMutationId },
            'Refresh the comments list and start a new comment if you still need to submit feedback.'
          );
        }
        const sameFingerprint =
          existing.versionId === input.versionId &&
          existing.body === input.body &&
          existing.anchorType === input.anchorType &&
          stableJson(existing.anchor) === stableJson(input.anchor);
        if (!sameFingerprint) {
          throw new PlanReviewError(
            'duplicate_comment_conflict',
            'This comment draft identifier was already used for different comment content.',
            409,
            { commentId: existing.id, clientMutationId: input.clientMutationId },
            'Refresh the comments list before retrying, or start a new comment from the current selection.'
          );
        }
        return { comment: existing, event: this.getCommentCreatedEvent(duplicate.id), created: false };
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

      const createdBy = commentAuthor(input.createdBy);
      const firstThreadRole: ThreadEntryRole = createdBy.type === 'agent' ? 'agent' : 'human';
      const conversationPayload = this.buildConversationPayload(planId, commentId, sequence, input, screenshotAssetId, createdBy);
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
          JSON.stringify(createdBy),
          input.clientMutationId ?? null,
          now,
          now
        );
      this.db.prepare(`INSERT INTO comment_thread_entries
        (id, plan_id, comment_id, sequence, role, body, created_by_json, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(id('cte'), planId, commentId, firstThreadRole, input.body, JSON.stringify(createdBy), now, now);
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
      this.enqueueDelivery(planId, commentId, 'codex');
      this.enqueueDelivery(planId, commentId, 'hermes');
      return { comment, event, created: true };
    });
    return tx();
  }

  private buildConversationPayload(
    planId: string,
    commentId: string,
    markerNumber: number,
    input: CreateCommentInput,
    screenshotAssetId?: string,
    createdBy?: Record<string, unknown>
  ) {
    const textPreview =
      String(input.anchor.textPreview ?? input.anchor.selectedText ?? input.anchor.cssSelector ?? input.anchorType);
    const diagram = input.anchor.diagram && typeof input.anchor.diagram === 'object'
      ? input.anchor.diagram as Record<string, unknown>
      : undefined;
    const diagramEvidence = diagram?.kind === 'mermaid'
      ? {
          kind: 'mermaid',
          sourcePlanNodeId: diagram.sourcePlanNodeId,
          sourceHash: diagram.sourceHash,
          elementKey: diagram.elementKey,
          elementLabel: diagram.elementLabel
        }
      : undefined;
    return {
      type: 'browser.comment.v1',
      commentId,
      conversationHint: {
        mode: 'append-to-active-thread',
        title: `Comment ${markerNumber} on ${textPreview.slice(0, 80)}`,
        summary: input.body.slice(0, 240)
      },
      createdBy,
      evidence: {
        reviewUrl: `/p/${planId}`,
        selector: input.anchor.cssSelector,
        planNodeId: input.anchor.planNodeId,
        markerNumber,
        textPreview,
        headingPath: input.anchor.headingPath,
        screenshotAssetId,
        diagram: diagramEvidence
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
      threadEntries: this.listThreadEntries(String(row.id)),
      createdBy: parseJson(String(row.created_by_json), {}),
      createdAt: String(row.created_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
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

    const diagram = anchor.diagram && typeof anchor.diagram === 'object' ? anchor.diagram as Record<string, unknown> : undefined;
    if (diagram?.kind === 'mermaid') {
      const sourcePlanNodeId = typeof diagram.sourcePlanNodeId === 'string' ? diagram.sourcePlanNodeId : undefined;
      const sourceHash = typeof diagram.sourceHash === 'string' ? diagram.sourceHash : undefined;
      const sourceNodeMatches = Boolean(sourcePlanNodeId && renderedHtml.includes(`data-plan-node-id="${sourcePlanNodeId}"`));
      const sourceElementMatches = Boolean(sourcePlanNodeId && sourceHash && new RegExp(
        `<[^>]+\\bdata-plan-node-id="${escapeRegExp(sourcePlanNodeId)}"[^>]*\\bdata-plan-mermaid-source-hash="${escapeRegExp(sourceHash)}"|<[^>]+\\bdata-plan-mermaid-source-hash="${escapeRegExp(sourceHash)}"[^>]*\\bdata-plan-node-id="${escapeRegExp(sourcePlanNodeId)}"`
      ).test(renderedHtml));
      if (sourceElementMatches) return { ...comment, anchorState: 'mapped' };
      if (sourceNodeMatches) return { ...comment, anchorState: 'stale' };
      return { ...comment, anchorState: 'unmapped' };
    }

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
    const clauses = ['c.plan_id = ?', 'c.deleted_at IS NULL'];
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
        AND c.deleted_at IS NULL
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
      const { plan } = this.getPlan(planId);
      if (plan.lifecycleState === 'deferred') {
        throw new PlanReviewError('invalid_state', 'Deferred plans cannot claim comments', 409, { planId: plan.id, lifecycleState: plan.lifecycleState }, 'Resume the plan before claiming comments, or leave it deferred for later pickup.');
      }
      if (plan.lifecycleState === 'archived') {
        throw new PlanReviewError('invalid_state', 'Archived plans cannot claim comments', 409, { planId: plan.id, lifecycleState: plan.lifecycleState }, 'Restore the archived plan before claiming comments.');
      }
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
        if (comment.deletedAt) {
          if (input.mode === 'selected') {
            throw new PlanReviewError(
              'invalid_state',
              'Deleted comments cannot be claimed',
              409,
              { commentId: comment.id, status: comment.status, deletedAt: comment.deletedAt },
              'Refresh the comments list; deleted comments are no longer available to agents.'
            );
          }
          skipped.push({ commentId: comment.id, reason: 'deleted' });
          continue;
        }
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

  private assertCommentNotDeleted(comment: StoredComment, action: string) {
    if (!comment.deletedAt) return;
    throw new PlanReviewError(
      'invalid_state',
      `Deleted comments cannot be ${action}`,
      409,
      { commentId: comment.id, status: comment.status, deletedAt: comment.deletedAt },
      'Refresh the comments list; deleted comments are no longer available.'
    );
  }

  ackComment(commentId: string, input: AckCommentInput) {
    const tx = this.db.transaction(() => {
      let comment = this.getComment(commentId);
      const expiredEvents = this.releaseExpiredClaims(comment.planId);
      comment = this.getComment(commentId);
      this.assertCommentNotDeleted(comment, 'acknowledged');
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
      this.assertCommentNotDeleted(comment, 'resolved');
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

  appendThreadEntry(commentId: string, input: AppendThreadEntryInput): { comment: StoredComment; entry: StoredCommentThreadEntry; event: StoredEvent; created: boolean } {
    const tx = this.db.transaction(() => {
      const comment = this.getComment(commentId);
      this.assertCommentNotDeleted(comment, 'updated');
      const duplicate = input.clientMutationId
        ? this.db.prepare('SELECT * FROM comment_thread_entries WHERE comment_id = ? AND client_mutation_id = ?').get(commentId, input.clientMutationId) as Record<string, unknown> | undefined
        : undefined;
      if (duplicate) {
        return { comment, entry: this.threadEntryFromRow(duplicate), event: this.getCommentCreatedEvent(commentId), created: false };
      }
      const now = nowIso();
      const entryId = id('cte');
      const sequence = this.nextThreadEntrySequence(commentId);
      const createdBy = { type: input.role, displayName: input.createdBy?.displayName?.trim() || (input.role === 'agent' ? 'Agent' : input.role === 'system' ? 'System' : 'Reviewer') };
      this.db.prepare(`INSERT INTO comment_thread_entries
        (id, plan_id, comment_id, sequence, role, body, created_by_json, claim_id, delivery_adapter, action_json, client_mutation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entryId, comment.planId, commentId, sequence, input.role, input.body, JSON.stringify(createdBy), input.claimId ?? null, input.deliveryAdapter ?? null, input.action ? JSON.stringify(input.action) : null, input.clientMutationId ?? null, now, now);
      this.db.prepare('UPDATE comments SET updated_at = ? WHERE id = ?').run(now, commentId);
      this.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now, comment.planId);
      const entry = this.listThreadEntries(commentId).find(item => item.id === entryId)!;
      const updated = this.getComment(commentId);
      const event = this.addEvent(comment.planId, 'comment.thread_entry.created', { eventType: 'comment.thread_entry.created', planId: comment.planId, commentId, entry, comment: updated }, commentId);
      return { comment: updated, entry, event, created: true };
    });
    return tx();
  }

  releaseComment(commentId: string, claimId: string, reason = 'released') {
    const tx = this.db.transaction(() => {
      const comment = this.getComment(commentId);
      this.assertCommentNotDeleted(comment, 'released');
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

  deleteComment(commentId: string) {
    const tx = this.db.transaction(() => {
      let comment = this.getComment(commentId);
      const expiredEvents = this.releaseExpiredClaims(comment.planId);
      comment = this.getComment(commentId);
      if (comment.deletedAt) {
        throw new PlanReviewError(
          'invalid_state',
          'Deleted comments cannot be deleted again',
          409,
          { commentId, status: comment.status, deletedAt: comment.deletedAt },
          'Refresh the comments list; this comment has already been deleted.'
        );
      }
      if (comment.status !== 'pending' || comment.claim) {
        throw new PlanReviewError(
          'invalid_state',
          'Only pending unclaimed comments can be deleted',
          409,
          { commentId, status: comment.status, claim: comment.claim },
          comment.status === 'claimed'
            ? 'Release the claim, acknowledge it, resolve it, or wait for the claim lease to expire before deleting.'
            : 'Only pending unclaimed comments can be deleted.'
        );
      }
      const now = nowIso();
      this.db.prepare('UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, commentId);
      const updated = this.getComment(commentId);
      const event = this.addEvent(updated.planId, 'comment.deleted', {
        eventType: 'comment.deleted',
        planId: updated.planId,
        commentId,
        comment: updated
      }, commentId);
      return { comment: updated, event, expiredEvents };
    });
    return tx();
  }

  eventsAfter(planId: string, afterSequence = 0, mode: 'all' | 'queue' = 'all', limit = 200): StoredEvent[] {
    const eventFilter = mode === 'queue'
      ? "AND event_type IN ('comment.created','comment.claimed','comment.acknowledged','comment.resolved','comment.released','comment.deleted','comment.thread_entry.created')"
      : '';
    const rows = this.db
      .prepare(`SELECT * FROM comment_events WHERE plan_id = ? AND sequence > ? ${eventFilter} ORDER BY sequence ASC LIMIT ?`)
      .all(planId, afterSequence, limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.eventFromRow(row));
  }

  claimNextAcrossQueue(input: ClaimQueueInput, agentId = 'plan-review-cli') {
    const tx = this.db.transaction(() => {
      const expiredEvents = this.releaseExpiredClaims();
      const clauses = ["c.status = 'pending'", 'c.deleted_at IS NULL', 'c.claim_id IS NULL', 'p.archived_at IS NULL', "COALESCE(p.lifecycle_state, 'active') != 'deferred'"];
      const params: unknown[] = [];
      if (input.reviewMode) {
        clauses.push('p.review_mode = ?');
        params.push(input.reviewMode);
      }
      if (input.repoKey) {
        clauses.push('r.repo_key = ?');
        params.push(input.repoKey);
      }
      if (input.adapter) {
        const modeClause = input.adapter === 'hermes'
          ? "AND t.mode IN ('fake','webhook')"
          : "AND t.mode IN ('sdk','app-server','fake')";
        clauses.push(`EXISTS (
          SELECT 1 FROM delivery_targets t
          WHERE t.plan_id = p.id
            AND t.adapter = ?
            AND t.enabled = 1
            AND t.target_thread_id IS NOT NULL
            ${modeClause}
        )`);
        params.push(input.adapter);
      }
      const row = this.db.prepare(`
        SELECT c.id AS commentId, c.plan_id AS planId
        FROM comments c
        JOIN plans p ON p.id = c.plan_id
        JOIN repos r ON r.id = p.repo_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY c.created_at ASC, c.sequence ASC, c.id ASC
        LIMIT 1
      `).get(...params) as { commentId: string; planId: string } | undefined;
      if (!row) return { claimed: [], events: expiredEvents, skipped: [] };
      const leaseExpiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
      const claimId = id('claim');
      this.db.prepare(`INSERT INTO claims (id, comment_id, agent_id, lease_expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(claimId, row.commentId, agentId, leaseExpiresAt, nowIso());
      this.db.prepare("UPDATE comments SET status = 'claimed', claim_id = ?, updated_at = ? WHERE id = ?")
        .run(claimId, nowIso(), row.commentId);
      const updated = this.getComment(row.commentId);
      const event = this.addEvent(row.planId, 'comment.claimed', {
        eventType: 'comment.claimed',
        planId: row.planId,
        commentId: row.commentId,
        comment: updated
      }, row.commentId);
      return { claimed: [updated], events: [...expiredEvents, event], leaseExpiresAt, skipped: [] };
    });
    return tx();
  }

  queueSnapshot(filters: { repoKey?: string; planId?: string; limit?: number }) {
    this.releaseExpiredClaims(filters.planId);
    const clauses = ["c.status = 'pending'", 'c.deleted_at IS NULL', 'p.archived_at IS NULL', "COALESCE(p.lifecycle_state, 'active') != 'deferred'"];
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
