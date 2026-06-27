import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { parse, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { ZodError } from 'zod';
import {
  ackCommentSchema,
  actionCommentPlanPathSchema,
  appConfigurationSchema,
  type AppConfiguration,
  appendThreadEntrySchema,
  changePlanModeSchema,
  claimCommentsSchema,
  claimQueueSchema,
  createCommentSchema,
  createDomCommentSchema,
  createPlanNoteSchema,
  deferPlanSchema,
  deliveryAdapterSchema,
  deliveryTargetUpdateSchema,
  defaultAppConfiguration,
  planPullRequestSchema,
  registerPlanSchema,
  releaseCommentSchema,
  resolveCommentSchema,
  resumePlanSchema,
  saveBoardColumnsSchema,
  setPlanBoardColumnSchema,
  setPlanLifecycleSchema,
  setPlanPinnedSchema,
  setPlanProjectSchema
} from '../schemas.js';
import { renderPlan } from '../render/render.js';
import { buildRegistrationAgentInstructions } from '../registrationInstructions.js';
import { PlanReviewStore, type BoardColumnRecord, type PlanProjectRecord, type PlanRecord, type StoredEvent } from '../storage/database.js';
import { SourceSyncService } from './sourceSync.js';
import { fail, ok, PlanReviewError } from '../util.js';
import { planTitleFallback, renderedHtmlTitle, reviewShellTitle } from '../planTitles.js';
import { resolveDeliveryWorkerConfig, resolveUpdateCheckConfig, setUpdateChecksEnabled, type DeliveryWorkerConfig, type UpdateCheckConfig } from '../config.js';
import { checkForUpdates, readBuildIdentity, type UpdateStatus } from '../updateStatus.js';
import { DeliveryWorker, type DeliveryWorkerOptions } from '../delivery/worker.js';
import { buildAgentNextClaimed, buildAgentNextEmpty } from '../agentNext.js';
import { buildPlanExport, contentDispositionAttachment } from '../exportPlan.js';

export interface AppOptions {
  dbPath: string;
  delivery?: Partial<DeliveryWorkerConfig> & Pick<DeliveryWorkerOptions, 'clientFactory'>;
  updateChecks?: {
    enabled?: boolean;
    configFile?: string;
    initialStatus?: UpdateStatus;
    checker?: () => Promise<UpdateStatus>;
    stableFormulaUrl?: string;
    headCompareUrl?: string;
    timeoutMs?: number;
    cacheMs?: number;
  };
}

interface EventBus {
  emitEvent(event: StoredEvent): void;
  onEvent(planId: string, handler: (event: StoredEvent) => void): () => void;
}

type ListedPlan = ReturnType<PlanReviewStore['listPlans']>[number];

function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);
  return {
    emitEvent(event) {
      emitter.emit(event.planId, event);
    },
    onEvent(planId, handler) {
      emitter.on(planId, handler);
      return () => emitter.off(planId, handler);
    }
  };
}

function eventForSse(event: StoredEvent): string {
  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
}

function encodeClientData(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function requestServiceUrl(request: { headers: { host?: string | string[] } }, fallback: string): string {
  const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
  return host ? `http://${host}` : fallback;
}

function progressHtml(progress: ReturnType<PlanReviewStore['listPlans']>[number]['progress']): string {
  if (!progress.totalPhases) return '<p class="progress-empty">No phase progress markers found.</p>';
  const label = `${progress.completedPhases} of ${progress.totalPhases} phases complete`;
  const segments = progress.phases.map((phase, index) => `<span class="progress-segment${phase.complete ? ' complete' : ''}" title="${escapeHtml(phase.label || `Phase ${index + 1}`)}"></span>`).join('');
  return `<div class="progress-row"><div class="progress-bar" aria-label="${escapeHtml(label)}">${segments}</div><span class="progress-count">${escapeHtml(label)}</span></div>`;
}

function commentCountsHtml(item: ListedPlan): string {
  return `<p class="comment-counts"><span class="row-label">Comments</span> pending ${item.counts.pending} · claimed ${item.counts.claimed} · acknowledged ${item.counts.acknowledged} · resolved ${item.counts.resolved}</p>`;
}

function lastUpdatedHtml(value: string): string {
  return `<p class="timestamp-row"><span class="row-label">Last updated</span> <time datetime="${escapeHtml(value)}" data-local-timestamp>${escapeHtml(value)}</time></p>`;
}

function latestNoteHtml(item: ListedPlan): string {
  if (!item.latestNote) return '<p class="note-summary muted"><span class="row-label">Notes</span> None</p>';
  return `<p class="note-summary"><span class="row-label">Latest note</span> ${escapeHtml(item.latestNote.body)} <small class="muted">· <time datetime="${escapeHtml(item.latestNote.createdAt)}" data-local-timestamp>${escapeHtml(item.latestNote.createdAt)}</time> · ${item.noteCount} total</small></p>`;
}

function localTimestampScript(): string {
  return `document.querySelectorAll('[data-local-timestamp]').forEach(time=>{const date=new Date(time.getAttribute('datetime')||''); if(Number.isNaN(date.getTime())) return; time.textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date); time.title=date.toISOString();});`;
}

function runtimeUpdateIndicatorStyles(): string {
  return `.runtime-update-indicator{position:fixed;right:16px;bottom:16px;z-index:80;display:grid;justify-items:end;gap:8px}.runtime-update-button{width:38px;height:38px;border-radius:999px;border:2px solid #86efac;background:linear-gradient(180deg,#22c55e,#15803d);color:#052e16;font-size:22px;font-weight:950;line-height:1;box-shadow:0 0 0 3px rgba(34,197,94,.18),0 12px 28px rgba(21,128,61,.38);cursor:pointer}.runtime-update-popover{max-width:min(360px,calc(100vw - 32px));border:1px solid #22c55e;border-radius:12px;background:#0f172a;color:#e5e7eb;padding:12px;box-shadow:0 18px 48px rgba(2,6,23,.62)}.runtime-update-popover[hidden]{display:none}.runtime-update-popover strong{display:block;color:#bbf7d0;margin-bottom:6px}.runtime-update-popover code{display:block;margin-top:6px;white-space:normal;overflow-wrap:anywhere}body.comments-open .runtime-update-indicator{right:calc(var(--comments-width, 0px) + 16px)}@media(max-width:760px),(pointer:coarse){.runtime-update-indicator{right:14px;bottom:calc(68px + env(safe-area-inset-bottom))}body.comments-open .runtime-update-indicator{right:14px}}`;
}

function runtimeUpdateIndicatorMarkup(status: UpdateStatus | undefined): string {
  if (status?.status !== 'update_available' || !status.updateCommand) return '';
  const restart = status.restartCommand ? `<code>${escapeHtml(status.restartCommand)}</code>` : '';
  const verify = status.verifyCommand ? `<code>${escapeHtml(status.verifyCommand)}</code>` : '';
  return `<div class="runtime-update-indicator" role="status"><button class="runtime-update-button" type="button" aria-label="plan-reviewer update available" title="plan-reviewer update available">↑</button><div class="runtime-update-popover" hidden><strong>plan-reviewer update available</strong><span>Run:</span><code>${escapeHtml(status.updateCommand)}</code>${restart ? `<span>Then restart if managed by Homebrew:</span>${restart}` : ''}${verify ? `<span>Verify:</span>${verify}` : ''}</div></div>`;
}

function runtimeUpdateIndicatorScript(): string {
  return `(function(){const root=document.getElementById('runtime-update-indicator-root');if(!root)return;function text(value){return String(value==null?'':value)}function render(status){root.textContent='';if(!status||status.status!=='update_available'||!status.updateCommand)return;const label='plan-reviewer update '+ 'available';const wrap=document.createElement('div');wrap.className='runtime-update-indicator';wrap.setAttribute('role','status');const button=document.createElement('button');button.className='runtime-update-button';button.type='button';button.setAttribute('aria-label',label);button.title=label;button.textContent='↑';const popover=document.createElement('div');popover.className='runtime-update-popover';popover.hidden=true;const title=document.createElement('strong');title.textContent=label;popover.append(title,document.createTextNode('Run:'));const command=document.createElement('code');command.textContent=text(status.updateCommand);popover.append(command);if(status.restartCommand){popover.append(document.createTextNode('Then restart if managed by Homebrew:'));const restart=document.createElement('code');restart.textContent=text(status.restartCommand);popover.append(restart);}if(status.verifyCommand){popover.append(document.createTextNode('Verify:'));const verify=document.createElement('code');verify.textContent=text(status.verifyCommand);popover.append(verify);}button.addEventListener('click',()=>{popover.hidden=!popover.hidden;});wrap.append(button,popover);root.append(wrap);}try{const initial=root.dataset.runtimeUpdateInitial;if(initial)render(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(initial),c=>c.charCodeAt(0)))));}catch{}fetch('/api/runtime/update',{cache:'no-store'}).then(response=>response.ok?response.json():null).then(payload=>render(payload&&payload.data?payload.data:payload)).catch(()=>{});})();`;
}

function runtimeUpdateIndicatorHtml(status: UpdateStatus | undefined): string {
  const encoded = status ? ` data-runtime-update-initial="${escapeHtml(encodeClientData(JSON.stringify(status)))}"` : '';
  return `<div id="runtime-update-indicator-root"${encoded}>${runtimeUpdateIndicatorMarkup(status)}</div><script>${runtimeUpdateIndicatorScript()}</script>`;
}

function fullyQualifiedPlanPath(item: ReturnType<PlanReviewStore['listPlans']>[number]): string {
  if (item.plan.sourcePath && path.isAbsolute(item.plan.sourcePath)) return item.plan.sourcePath;
  if (path.isAbsolute(String(item.plan.planPath))) return String(item.plan.planPath);
  const worktreePath = item.plan.publicationMetadata?.worktreePath ?? item.plan.rootPath;
  return worktreePath ? path.join(worktreePath, String(item.plan.planPath)) : String(item.plan.planPath);
}

function publicationMetadataHtml(item: ReturnType<PlanReviewStore['listPlans']>[number]): string {
  const metadata = item.plan.publicationMetadata;
  if (!metadata || item.plan.reviewMode === 'collaboration') {
    return `<dl class="plan-metadata"><div><dt>Mode</dt><dd><span class="ready-pill ready">Collaboration</span></dd></div><div><dt>Source</dt><dd><code>${escapeHtml(item.plan.sourcePath ?? item.plan.planPath)}</code></dd></div></dl>`;
  }
  const linear = item.plan.linearIssueKey
    ? `<a href="${escapeHtml(item.plan.linearIssueUrl)}" target="_blank" rel="noreferrer"><code>${escapeHtml(item.plan.linearIssueKey)}</code></a>`
    : metadata.linearIssue ? `<code>${escapeHtml(metadata.linearIssue)}</code>` : '<span class="muted">None</span>';
  const readyLabel = metadata.executionReady ? 'Yes' : 'No';
  return `<dl class="plan-metadata">
    <div><dt>Worktree</dt><dd><code>${escapeHtml(metadata.worktreePath)}</code></dd></div>
    <div><dt>Branch</dt><dd><code>${escapeHtml(metadata.branch)}</code></dd></div>
    <div><dt>Linear issue</dt><dd>${linear}</dd></div>
    <div><dt>Execution ready</dt><dd><span class="ready-pill ${metadata.executionReady ? 'ready' : 'not-ready'}">${readyLabel}</span> <span class="muted">based on agent review results</span></dd></div>
  </dl>`;
}

function pullRequestHtml(item: ListedPlan): string {
  const pr = item.plan.pullRequest;
  if (!pr) return '<p class="pr-status"><span class="row-label">PR</span> <span class="pr-pill unlinked">No PR</span></p>';
  const status = pr.status ?? 'unknown';
  const label = status === 'stale' ? 'PR stale' : status === 'merged' ? 'PR merged' : status === 'closed' ? 'PR closed' : status === 'open' ? 'PR open' : 'PR unknown';
  const checked = pr.lastCheckedAt ? ` · last checked <time datetime="${escapeHtml(pr.lastCheckedAt)}" data-local-timestamp>${escapeHtml(pr.lastCheckedAt)}</time>` : '';
  const error = pr.lastRefreshError ? ` · <span class="pr-error">${escapeHtml(pr.lastRefreshError)}</span>` : '';
  const refresh = status === 'stale' || status === 'unknown' ? ` <span class="muted">Refresh with <code>plan-review pr refresh ${escapeHtml(item.plan.id)}</code></span>` : '';
  return `<p class="pr-status"><span class="row-label">PR</span> <a class="pr-pill ${escapeHtml(status)}" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${escapeHtml(label)} #${escapeHtml(pr.number)}</a>${checked}${error}${refresh}</p>`;
}

function baseIndexStyles(): string {
  return `body{margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:32px}a{color:#7dd3fc}.page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.page-header h1{margin:0 0 8px}.nav-link,.restore-plan,.archive-plan{background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px 10px;cursor:pointer;text-decoration:none;font-weight:700}.nav-link.primary,.restore-plan{border-color:#38bdf8;color:#bae6fd}.restore-plan{border-color:#22c55e;color:#bbf7d0}.toolbar{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:10px;margin:18px 0}.toolbar input,.toolbar select{background:#0f172a;color:#e5e7eb;border:1px solid #2b364d;border-radius:6px;padding:10px}.plan-card{border:1px solid #2563eb;border-left:5px solid #2563eb;background:#111827;border-radius:8px;padding:16px;margin:12px 0}.plan-card.complete{border-color:#16a34a;border-left-color:#16a34a}.plan-card.needs-attention{border-color:#f59e0b;border-left-color:#f59e0b;background:linear-gradient(180deg,rgba(245,158,11,.10),#111827 42%)}.plan-card.archived{border-color:#64748b;border-left-color:#64748b}.plan-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.plan-card-header h2{margin-top:0}.plan-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end}.archive-plan:hover,.restore-plan:hover,.nav-link:hover{border-color:#93c5fd}.plan-metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin:12px 0}.plan-metadata div{min-width:0}.plan-metadata dt{color:#a7b0c0;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.03em}.plan-metadata dd{margin:3px 0 0;overflow-wrap:anywhere}.ready-pill{display:inline-block;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:800}.ready-pill.ready{background:#166534;color:#dcfce7}.ready-pill.not-ready{background:#7f1d1d;color:#fecaca}.pr-status{margin:6px 0}.pr-pill{display:inline-block;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:800;text-decoration:none;background:#334155;color:#e2e8f0}.pr-pill.open{background:#1d4ed8;color:#dbeafe}.pr-pill.merged{background:#166534;color:#dcfce7}.pr-pill.closed{background:#7f1d1d;color:#fecaca}.pr-pill.unknown,.pr-pill.stale{background:#92400e;color:#ffedd5}.pr-error{color:#fecaca}.progress-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;margin:12px 0}.progress-bar{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:5px}.progress-segment{height:14px;border:1px solid #64748b;border-radius:3px;background:transparent}.progress-segment.complete{background:#22c55e;border-color:#22c55e}.progress-count,.progress-empty,.muted,.comment-counts,.timestamp-row{color:#a7b0c0;font-size:13px}.comment-counts,.timestamp-row{margin:6px 0}.row-label{color:#e5e7eb;font-weight:800}.status-pill{display:inline-block;border-radius:999px;padding:2px 8px;background:#1d4ed8;color:#dbeafe;font-size:12px;font-weight:700}.complete .status-pill{background:#166534;color:#dcfce7}.status-pill.attention{background:#fbbf24;color:#1c1206}.archived .status-pill{background:#334155;color:#cbd5e1}.attention-summary,.sync-warning-card{border:1px solid rgba(245,158,11,.45);border-radius:8px;background:rgba(245,158,11,.10);padding:12px;margin:12px 0;color:#fde68a}.attention-summary{display:flex;align-items:center;justify-content:space-between;gap:12px}.attention-summary button{background:#92400e;color:#ffedd5;border:1px solid rgba(245,158,11,.65);border-radius:999px;padding:6px 10px;cursor:pointer;font-weight:800}.sync-warning-card.archived-source{border-color:#475569;background:#0f172a;color:#cbd5e1}.sync-warning-card p{margin:.35rem 0 0}.sync-warning-card code{display:inline-block;max-width:100%;overflow-wrap:anywhere}.repair-command code{display:block;margin-top:.25rem;padding:.35rem .5rem}.empty-state,.restore-error{border:1px solid #475569;border-radius:8px;background:#0f172a;padding:14px;margin:12px 0;color:#cbd5e1}.restore-error{border-color:#fb7185;color:#fecdd3}.archive-toast{position:fixed;top:14px;right:18px;width:min(520px,calc(100vw - 36px));z-index:50;display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #38bdf8;border-radius:14px;background:rgba(15,23,42,.97);color:#e5e7eb;padding:12px 14px;box-shadow:0 18px 50px rgba(2,6,23,.64)}.archive-toast strong{color:#f8fafc}.archive-toast p{margin:2px 0 0;color:#a7b0c0;font-size:13px}.archive-toast button{border:2px solid #86efac;border-radius:10px;background:linear-gradient(180deg,#22c55e,#15803d);color:#052e16;padding:10px 18px;font-weight:950;box-shadow:0 0 0 3px rgba(34,197,94,.18),0 10px 24px rgba(21,128,61,.38);cursor:pointer}.archive-toast.error{border-color:#fb7185}.archive-toast.error button{display:none}code{background:#0f172a;color:#dbeafe;padding:.1rem .25rem;border-radius:4px}@media(max-width:680px){.page-header,.toolbar,.progress-row,.plan-metadata{grid-template-columns:1fr;display:grid}.plan-card-header{display:block}.plan-actions{justify-content:flex-start;margin-bottom:8px}}`;
}

function planNeedsAttention(item: ListedPlan): boolean {
  return item.plan.watchMode === 'filesystem' && item.plan.lastSyncStatus === 'failed';
}

function syncErrorDetail(item: ListedPlan): string {
  const error = item.plan.lastSyncError as Record<string, unknown> | null | undefined;
  if (!error || typeof error !== 'object') return 'unknown error';
  const code = typeof error.code === 'string' && error.code ? error.code : undefined;
  const message = typeof error.message === 'string' && error.message ? error.message : 'unknown error';
  return code ? `${code}: ${message}` : message;
}

function sourcePathLabel(item: ListedPlan): string {
  return String(item.plan.sourcePath || item.plan.planPath);
}

function repairCommand(item: ListedPlan): string {
  return `plan-review register ${item.plan.planPath}`;
}

function syncWarningHtml(item: ListedPlan, options: { archived?: boolean } = {}): string {
  const title = options.archived ? 'Source unavailable' : 'Source missing';
  const className = `sync-warning-card${options.archived ? ' archived-source' : ''}`;
  return `<div class="${className}"><strong>${title}</strong><p>Source sync failed for <code>${escapeHtml(sourcePathLabel(item))}</code>: ${escapeHtml(syncErrorDetail(item))}</p><p>Plan path: <code>${escapeHtml(item.plan.planPath)}</code></p><p>Showing cached copy from the last successful render.</p>${options.archived ? '' : `<p class="repair-command">Repair with:<code>${escapeHtml(repairCommand(item))}</code></p>`}</div>`;
}

function planCardSearch(item: ListedPlan): string {
  const metadata = item.plan.publicationMetadata;
  const pr = item.plan.pullRequest;
  const prTerms = pr ? ` ${pr.url} ${pr.number} ${pr.state} ${pr.status ?? ''} ${pr.merged ? 'merged' : ''} pr ${pr.status ?? pr.state} pr ${pr.state} pull request pr` : ' no pr unlinked';
  const linearTerms = ` ${metadata?.linearIssue ?? ''} ${item.plan.linearIssueKey ?? ''} ${item.plan.linearIssueUrl ?? ''}`;
  const attentionTerms = planNeedsAttention(item) ? ' needs attention source missing source unavailable failed cached copy' : '';
  return `${item.plan.repoName} ${item.plan.repoKey} ${item.plan.slug} ${item.plan.reviewMode} ${item.plan.projectKey} ${item.plan.projectName} ${item.plan.lifecycleState} ${item.plan.boardColumnKey ?? ''} ${item.plan.pinnedAt ? 'pinned' : 'unpinned'} ${metadata?.executionReady ? 'execution ready ready' : 'execution not ready not-ready'} ${fullyQualifiedPlanPath(item)} ${metadata?.worktreePath ?? ''} ${metadata?.branch ?? ''} ${item.latestNote?.body ?? ''}${linearTerms}${prTerms}${attentionTerms}`.toLowerCase();
}

function hasStartedPlanProgress(item: ListedPlan): boolean {
  return item.progress.totalPhases > 0 && item.progress.completedPhases > 0;
}

function planComplete(item: ListedPlan): boolean {
  return item.progress.totalPhases > 0 && item.progress.completedPhases === item.progress.totalPhases;
}

function planProgressRatio(item: ListedPlan): number {
  return item.progress.totalPhases > 0 ? item.progress.completedPhases / item.progress.totalPhases : 0;
}

function displayTitle(item: ListedPlan): string {
  return String(item.displayTitle || `${item.plan.repoName} / ${item.plan.slug}`);
}

function planNavigatorRank(item: ListedPlan): number {
  if (planNeedsAttention(item)) return 3;
  if (planComplete(item)) return 0;
  if (item.plan.publicationMetadata?.executionReady) return 1;
  return 2;
}

function sortPlansForNavigator(plans: ListedPlan[]): ListedPlan[] {
  return [...plans].sort((a, b) => (Boolean(a.plan.pinnedAt) === Boolean(b.plan.pinnedAt) ? 0 : a.plan.pinnedAt ? -1 : 1)
    || planNavigatorRank(a) - planNavigatorRank(b)
    || planProgressRatio(b) - planProgressRatio(a)
    || String(b.activityAt).localeCompare(String(a.activityAt))
    || displayTitle(a).localeCompare(displayTitle(b))
    || String(a.plan.id).localeCompare(String(b.plan.id)));
}

function planNavigatorStatus(item: ListedPlan, columns: BoardColumnRecord[] = []): string {
  if (planNeedsAttention(item)) return 'Needs attention';
  if (item.plan.lifecycleState === 'archived') return `Archived · ${boardColumnLabel(columns, item.plan.boardColumnKey)}`;
  if (item.plan.lifecycleState === 'deferred') return `Deferred · ${boardColumnLabel(columns, item.plan.boardColumnKey)}`;
  if (planComplete(item)) return 'Complete';
  if (item.plan.reviewMode === 'collaboration') return 'Collaboration';
  if (item.plan.publicationMetadata?.executionReady) return 'Execution ready';
  return 'Execution not ready';
}

function planNavigatorProgress(item: ListedPlan): string {
  if (!item.progress.totalPhases) return 'No phases';
  return `${item.progress.completedPhases}/${item.progress.totalPhases}`;
}

type ReviewShellNavigatorFilters = { project: string; state: '' | 'active' | 'deferred' | 'archived'; status: string; active?: boolean };

function emptyReviewShellNavigatorFilters(): ReviewShellNavigatorFilters {
  return { project: '', state: '', status: '', active: false };
}

function reviewShellNavigatorFiltersActive(filters: ReviewShellNavigatorFilters): boolean {
  return filters.active ?? Boolean(filters.project || filters.state || filters.status);
}

function reviewShellNavigatorFilterSearch(filters: ReviewShellNavigatorFilters): string {
  const params = new URLSearchParams();
  if (filters.project) params.set('projectKey', filters.project);
  else if (reviewShellNavigatorFiltersActive(filters)) params.set('projectKey', '');
  if (filters.state) params.set('lifecycle', filters.state);
  else if (reviewShellNavigatorFiltersActive(filters)) params.set('lifecycle', '');
  if (filters.status) params.set('boardColumnKey', filters.status);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function planNavigatorItemHtml(item: ListedPlan, currentPlanId: string, filters = emptyReviewShellNavigatorFilters(), columns: BoardColumnRecord[] = []): string {
  const active = item.plan.id === currentPlanId;
  const status = planNavigatorStatus(item, columns);
  const href = `/p/${encodeURIComponent(String(item.plan.id))}${reviewShellNavigatorFilterSearch(filters)}`;
  return `<a class="plan-nav-item${active ? ' active' : ''}${planNeedsAttention(item) ? ' attention' : ''}" href="${escapeHtml(href)}" data-plan-nav-item data-plan-id="${escapeHtml(item.plan.id)}" aria-current="${active ? 'page' : 'false'}">
    <span class="plan-nav-title">${escapeHtml(displayTitle(item))}</span>
    <span class="plan-nav-meta"><span class="plan-nav-pill ${item.plan.reviewMode === 'collaboration' || item.plan.publicationMetadata?.executionReady ? 'ready' : 'not-ready'}">${escapeHtml(status)}</span><span>${escapeHtml(planNavigatorProgress(item))}</span></span>
    <span class="plan-nav-submeta">pending ${item.counts.pending} · updated <time datetime="${escapeHtml(item.modifiedAt)}" data-local-timestamp>${escapeHtml(item.modifiedAt)}</time></span>
  </a>`;
}

function planNavigatorItemsFor(store: PlanReviewStore, options: { limit: number; currentPlanId?: string }): ListedPlan[] {
  return store.listPlans({ limit: options.limit, currentPlanId: options.currentPlanId });
}

function normalizeReviewShellNavigatorFilters(query: { projectKey?: string; lifecycle?: string; boardColumnKey?: string }, currentPlan: PlanRecord, columns: BoardColumnRecord[], projects: PlanProjectRecord[]): ReviewShellNavigatorFilters {
  const projectKeys = new Set(projects.map(project => project.projectKey).filter(Boolean));
  projectKeys.add(currentPlan.projectKey);
  const columnKeys = new Set(columns.map(column => column.key));
  const lifecycleRequested = Object.prototype.hasOwnProperty.call(query, 'lifecycle');
  const defaultLifecycle = currentPlan.lifecycleState === 'archived' || currentPlan.lifecycleState === 'deferred' ? currentPlan.lifecycleState : 'active';
  return {
    project: query.projectKey === '' ? '' : query.projectKey && projectKeys.has(query.projectKey) ? query.projectKey : currentPlan.projectKey,
    state: query.lifecycle === '' ? '' : query.lifecycle === 'active' || query.lifecycle === 'deferred' || query.lifecycle === 'archived' ? query.lifecycle : lifecycleRequested ? 'active' : defaultLifecycle,
    status: currentPlan.reviewMode !== 'collaboration' && query.boardColumnKey && columnKeys.has(query.boardColumnKey) ? query.boardColumnKey : '',
    active: true
  };
}

function filteredReviewShellNavigatorItems(store: PlanReviewStore, currentPlanId: string | undefined, filters: ReviewShellNavigatorFilters, limit = 200): ListedPlan[] {
  if (!reviewShellNavigatorFiltersActive(filters)) return planNavigatorItemsFor(store, { limit, currentPlanId });
  return store.listPlans({
    includeArchived: !filters.state,
    includeDeferred: !filters.state,
    lifecycleState: filters.state || undefined,
    projectKey: filters.project || undefined,
    boardColumnKey: filters.status || undefined,
    limit,
    currentPlanId
  });
}

function planNavigatorHtml(plans: ListedPlan[], currentPlanId: string, label = 'plans', filters = emptyReviewShellNavigatorFilters(), filterControls = '', open = true, columns: BoardColumnRecord[] = []): string {
  const items = sortPlansForNavigator(plans).map(item => planNavigatorItemHtml(item, currentPlanId, filters, columns)).join('');
  const noun = label === 'documents' ? 'documents' : 'plans';
  const stateLabel = filters.state === 'archived' ? 'Archived' : filters.state === 'deferred' ? 'Deferred' : filters.state === '' && reviewShellNavigatorFiltersActive(filters) ? 'All' : 'Active';
  const title = `${stateLabel} ${noun}`;
  const empty = `No ${stateLabel.toLowerCase()} ${noun}.`;
  const hiddenAttributes = open ? '' : ' aria-hidden="true" inert';
  return `<aside id="plan-list-nav" aria-label="${escapeHtml(title)}"${hiddenAttributes}><div class="plan-list-header"><h2>${escapeHtml(title)}</h2><button id="plan-list-retry" type="button" hidden>Retry</button></div>${filterControls}<div class="plan-list-error" id="plan-list-error" hidden>Unable to load ${escapeHtml(label)}.</div><div id="plan-list-items">${items || `<p class="plan-list-empty">${escapeHtml(empty)}</p>`}</div></aside>`;
}

function planCardHtml(item: ListedPlan): string {
  const complete = planComplete(item);
  const needsAttention = planNeedsAttention(item);
  const statusLabel = needsAttention ? 'Source missing' : complete ? 'Complete' : 'Incomplete';
  const cardClass = needsAttention ? 'needs-attention' : complete ? 'complete' : 'incomplete';
  const prStatus = item.plan.pullRequest?.status ?? item.plan.pullRequest?.state ?? 'unlinked';
  return `<article class="plan-card ${cardClass}" data-plan-id="${escapeHtml(item.plan.id)}" data-repo="${escapeHtml(item.plan.repoName)}" data-type="${item.plan.reviewMode === 'collaboration' ? 'collaborative' : 'plan'}" data-pr-status="${escapeHtml(prStatus)}" data-search="${escapeHtml(planCardSearch(item))}" data-needs-attention="${needsAttention ? 'true' : 'false'}" aria-label="${escapeHtml(`${item.plan.repoName} / ${item.plan.slug}: ${statusLabel}`)}">
      <div class="plan-card-header"><h2><a href="/p/${escapeHtml(item.plan.id)}">${escapeHtml(item.plan.repoName)} / ${escapeHtml(item.plan.slug)}</a></h2><div class="plan-actions"><span class="status-pill${needsAttention ? ' attention' : ''}">${escapeHtml(statusLabel)}</span><button class="archive-plan" type="button" data-archive-plan="${escapeHtml(item.plan.id)}">Archive</button></div></div>
      <p><code>${escapeHtml(fullyQualifiedPlanPath(item))}</code></p>
      ${publicationMetadataHtml(item)}
      ${pullRequestHtml(item)}
      ${needsAttention ? syncWarningHtml(item) : ''}
      ${latestNoteHtml(item)}
      ${progressHtml(item.progress)}
      ${commentCountsHtml(item)}
      ${lastUpdatedHtml(item.modifiedAt)}
    </article>`;
}

function repoGroupsHtml(plans: ListedPlan[]): string {
  const groups: string[] = [];
  let currentRepo: string | undefined;
  let currentCards: string[] = [];
  const flush = () => {
    if (!currentRepo) return;
    groups.push(`<section class="repo-group" data-repo-group="${escapeHtml(currentRepo)}"><h2>${escapeHtml(currentRepo)}</h2>${currentCards.join('\n')}</section>`);
  };
  for (const item of plans) {
    if (item.plan.repoName !== currentRepo) {
      flush();
      currentRepo = String(item.plan.repoName);
      currentCards = [];
    }
    currentCards.push(planCardHtml(item));
  }
  flush();
  return groups.join('\n');
}

function organizationIndexStyles(): string {
  return `.doc-kind-switcher{display:inline-flex;gap:2px;padding:3px;border:1px solid #334155;border-radius:999px;background:#08111f}.doc-kind-seg{border-radius:999px;padding:5px 10px;color:#a7b0c0;font-size:12px;font-weight:850;text-decoration:none;white-space:nowrap}.doc-kind-seg.active{background:#0ea5e9;color:#e0f2fe}.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}.kanban-page,.documents-page,.configuration-page{max-width:none;width:100%;box-sizing:border-box;padding:24px clamp(14px,2vw,32px)}.documents-page .toolbar{grid-template-columns:minmax(0,1fr) minmax(160px,220px) minmax(160px,220px)}@media(max-width:760px){.documents-page .toolbar{grid-template-columns:1fr}}.kanban-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:16px;align-items:start}.kanban-column{background:#0b1220;border:1px solid #334155;border-radius:12px;padding:12px;min-height:180px}.kanban-column h2{font-size:16px;margin:0 0 8px;display:flex;justify-content:space-between}.kanban-card{border:1px solid #253248;border-radius:10px;background:#111827;padding:12px;margin:8px 0}.kanban-card:focus{outline:2px solid #7dd3fc;outline-offset:2px}.kanban-card[draggable=true]{cursor:grab}.kanban-card[aria-busy=true]{opacity:.72}.kanban-context-menu{position:fixed;z-index:60;width:250px;max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;border:1px solid #475569;border-radius:12px;background:rgba(15,23,42,.98);box-shadow:0 22px 54px rgba(2,6,23,.62);padding:6px}.kanban-context-menu[hidden]{display:none}.kanban-context-menu strong{display:block;padding:8px 10px 6px;color:#f8fafc;font-size:12px;letter-spacing:.03em;text-transform:uppercase}.kanban-context-menu button{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:#e5e7eb;font:inherit;font-weight:800;text-align:left;cursor:pointer}.kanban-context-menu button:hover,.kanban-context-menu button:focus{background:rgba(56,189,248,.14);color:#e0f2fe;outline:none}.kanban-context-menu button.current{color:#bbf7d0}.kanban-context-menu button.danger{color:#fecdd3}.kanban-context-menu button:disabled{cursor:wait;opacity:.62}.kanban-menu-separator{height:1px;background:#334155;margin:5px 4px}.badge{display:inline-block;border:1px solid #475569;border-radius:999px;padding:1px 7px;background:#0b1220;color:#cbd5e1;font-size:12px;margin:2px}.badge.ready{border-color:#22c55e;color:#bbf7d0}.badge.not-ready{border-color:#f59e0b;color:#fde68a}.drop-target{outline:2px dashed #7dd3fc;outline-offset:-4px}.card-summary{color:#cbd5e1;font-size:13px}.collab-card{border-left-color:#a78bfa}.organizer-error{border:1px solid #fb7185;border-radius:8px;background:rgba(251,113,133,.12);color:#fecdd3;padding:10px;margin:12px 0}.columns-table{width:100%;border-collapse:collapse;margin:16px 0}.columns-table th,.columns-table td{border-bottom:1px solid #334155;padding:10px;text-align:left}.columns-table input[type=checkbox]{width:18px;height:18px}.columns-save{display:flex;gap:10px;align-items:center}.columns-message{color:#a7b0c0}.topbar-icon-action{display:inline-flex;align-items:center;justify-content:center;min-width:38px;min-height:34px;padding:8px 10px;box-sizing:border-box;font-size:16px;line-height:1}.configuration-layout{display:grid;grid-template-columns:minmax(190px,250px) minmax(0,1fr);gap:18px;align-items:start}.configuration-nav{border:1px solid #334155;border-radius:12px;background:#0f172a;padding:12px;position:sticky;top:16px}.configuration-nav a{display:block;padding:8px 10px;border-radius:8px;color:#cbd5e1;text-decoration:none;font-weight:800}.configuration-nav a:hover{background:rgba(56,189,248,.14);color:#e0f2fe}.configuration-section{border:1px solid #334155;border-radius:14px;background:#0f172a;padding:16px;margin:0 0 14px}.configuration-section h2{margin-top:0}.configuration-grid{display:grid;grid-template-columns:minmax(190px,280px) minmax(0,1fr);gap:10px 14px;align-items:center}.configuration-input{width:100%;box-sizing:border-box;background:#020617;color:#e5e7eb;border:1px solid #475569;border-radius:8px;padding:8px 10px}.configuration-preview{background:#020617;border:1px solid #1e293b;border-radius:8px;color:#cbd5e1;padding:10px;white-space:pre-wrap}.configuration-save{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:14px}.configuration-message{color:#a7b0c0}@media(max-width:860px){.configuration-layout{grid-template-columns:1fr}.configuration-nav{position:static}.configuration-grid{grid-template-columns:1fr}}`;
}

function documentViewSwitcher(active?: 'kanban' | 'all', kanbanEnabled = true): string {
  const link = (view: 'kanban' | 'all', label: string, href: string) => `<a class="doc-kind-seg${active === view ? ' active' : ''}" href="${href}">${label}</a>`;
  const allHref = kanbanEnabled ? '/?view=all' : '/';
  return `<nav class="doc-kind-switcher" aria-label="Document view selector">${kanbanEnabled ? link('kanban', 'Kanban', '/') : ''}${link('all', 'All documents', allHref)}</nav>`;
}

function topbarIconAction(href: string, label: string, icon: string): string {
  return `<a class="nav-link primary topbar-icon-action" href="${escapeHtml(href)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${escapeHtml(icon)}</a>`;
}

function configurationGearAction(): string {
  return topbarIconAction('/configuration', 'Configuration', '⚙');
}

function configurationToolAction(): string {
  return '<a id="configuration-link" class="tool-button" href="/configuration" aria-label="Configuration" title="Configuration">⚙</a>';
}

function boardColumnLabel(columns: BoardColumnRecord[], key: string | undefined): string {
  return columns.find(column => column.key === key)?.label ?? key ?? 'Unassigned';
}

function summaryForItem(item: ListedPlan): string {
  return item.latestNote?.body ?? `${displayTitle(item)} · ${fullyQualifiedPlanPath(item)}`;
}

function issueBadgeHtml(item: ListedPlan): string {
  if (item.plan.linearIssueKey) return `<span class="badge">Linear: <a href="${escapeHtml(item.plan.linearIssueUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.plan.linearIssueKey)}</a></span>`;
  return '<span class="badge">Linear: none</span>';
}

function planBadgesHtml(item: ListedPlan, columns: BoardColumnRecord[]): string {
  const ready = item.plan.publicationMetadata?.executionReady;
  const progress = item.progress.totalPhases ? `${item.progress.completedPhases} of ${item.progress.totalPhases} phases complete` : 'No phases';
  const attentionBadge = planNeedsAttention(item) ? '<span class="badge not-ready">Needs attention</span><span class="badge not-ready">Source missing</span>' : '';
  return `<div class="card-meta"><span class="badge">${item.plan.reviewMode === 'collaboration' ? 'Collaborative' : 'Plan'}</span><span class="badge">Project: ${escapeHtml(item.plan.projectName)}</span>${issueBadgeHtml(item)}<span class="badge">State: ${escapeHtml(item.plan.lifecycleState)}</span>${item.plan.reviewMode === 'planning' ? `<span class="badge">Status: ${escapeHtml(boardColumnLabel(columns, item.plan.boardColumnKey))}</span><span class="badge ${ready ? 'ready' : 'not-ready'}">${ready ? 'Execution ready' : 'Execution not ready'}</span><span class="badge">Progress: ${escapeHtml(progress)}</span>` : ''}<span class="badge">Pending: ${item.counts.pending}</span>${attentionBadge}</div>`;
}

function kanbanCardHtml(item: ListedPlan, columns: BoardColumnRecord[]): string {
  const title = displayTitle(item);
  return `<article class="kanban-card" draggable="true" tabindex="0" aria-label="Open plan ${escapeHtml(title)}" data-plan-id="${escapeHtml(item.plan.id)}" data-plan-title="${escapeHtml(title)}" data-plan-url="/p/${escapeHtml(item.plan.id)}" data-column="${escapeHtml(item.plan.boardColumnKey ?? '')}"><div class="plan-card-header"><strong><a href="/p/${escapeHtml(item.plan.id)}">${escapeHtml(title)}</a></strong></div><p class="card-summary">${escapeHtml(summaryForItem(item))}</p>${planBadgesHtml(item, columns)}</article>`;
}

function kanbanIndexHtml(plans: ReturnType<PlanReviewStore['listPlans']>, archivedCount: number, deferredCount: number, columns: BoardColumnRecord[], projectName?: string, updateStatus?: UpdateStatus): string {
  const planning = plans.filter(item => item.plan.reviewMode === 'planning');
  const doneColumn = columns.find(column => column.isDone);
  const cardsFor = (column: BoardColumnRecord) => planning.filter(item => item.plan.boardColumnKey === column.key).sort((a, b) => String(b.activityAt).localeCompare(String(a.activityAt)) || displayTitle(a).localeCompare(displayTitle(b))).map(item => kanbanCardHtml(item, columns)).join('\n');
  const board = columns.map(column => `<section class="kanban-column" data-column-key="${escapeHtml(column.key)}" data-column-label="${escapeHtml(column.label)}" data-column-is-done="${column.isDone ? 'true' : 'false'}"><h2>${escapeHtml(column.label)} <span data-column-count>${planning.filter(item => item.plan.boardColumnKey === column.key).length}</span></h2>${cardsFor(column) || '<p class="muted">No plans.</p>'}</section>`).join('\n');
  const projectSummary = projectName ? `<p class="muted">Project: ${escapeHtml(projectName)} · <a href="/">Show all projects</a></p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plans · Kanban</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${baseIndexStyles()}${organizationIndexStyles()}${runtimeUpdateIndicatorStyles()}</style></head><body><main class="kanban-page"><div class="topbar">${documentViewSwitcher('kanban')}<div class="plan-actions">${configurationGearAction()}</div></div><div class="page-header"><div><h1>Plans · Kanban</h1><p class="muted">Columns are workflow status for planning documents. Execution readiness is a separate badge.</p>${projectSummary}</div></div><div id="organizer-error" class="organizer-error" hidden></div><section class="kanban-board" aria-label="Plan board columns" data-done-column-key="${escapeHtml(doneColumn?.key ?? '')}" data-done-column-label="${escapeHtml(doneColumn?.label ?? 'Done')}">${board}</section><script>${localTimestampScript()}\n${organizationScript()}</script>${runtimeUpdateIndicatorHtml(updateStatus)}</main></body></html>`;
}

function organizationScript(): string {
  return `let draggedPlanId=null,kanbanMenu=null,kanbanMenuCard=null,kanbanMenuOpenedAt=0,cardOpenSuppressedUntil=0,archiveToast=null,archiveToastTimer=null,archiveToastDismissHandlers=[];const pendingPlanIds=new Set();const kanbanBoard=document.querySelector('.kanban-board');const organizerError=document.getElementById('organizer-error');function setOrganizerError(message){if(!organizerError)return;organizerError.hidden=false;organizerError.textContent=message;}function clearOrganizerError(){if(!organizerError)return;organizerError.hidden=true;organizerError.textContent='';}const organizerReloadMessageKey='plan-review-kanban-reload-message';function restoreOrganizerReloadMessage(){let message=null;try{message=sessionStorage.getItem(organizerReloadMessageKey);sessionStorage.removeItem(organizerReloadMessageKey);}catch{}if(message)setOrganizerError(message);}function reloadWithOrganizerMessage(message){try{sessionStorage.setItem(organizerReloadMessageKey,message);}catch{}setOrganizerError(message);window.location.reload();}function columns(){return [...document.querySelectorAll('.kanban-column')];}function doneColumnConfig(){const key=kanbanBoard?.dataset.doneColumnKey||'';return key?{key,label:kanbanBoard?.dataset.doneColumnLabel||key}:null;}function columnForKey(key){return document.querySelector('[data-column-key="'+CSS.escape(key||'')+'"]');}function emptyState(column){let empty=column.querySelector(':scope > .muted');if(!empty){empty=document.createElement('p');empty.className='muted';empty.textContent='No plans.';column.appendChild(empty);}return empty;}function updateCounts(){for(const column of columns()){const count=column.querySelector('[data-column-count]');if(count)count.textContent=String(column.querySelectorAll(':scope > .kanban-card').length);const empty=column.querySelector(':scope > .muted');if(column.querySelector(':scope > .kanban-card'))empty?.remove();else emptyState(column);}}function statusBadge(card){return [...card.querySelectorAll('.badge')].find(badge=>badge.textContent?.trim().startsWith('Status:'));}function setCardPending(card,pending){if(!card)return;card.setAttribute('aria-busy',pending?'true':'false');for(const item of document.querySelectorAll('.kanban-context-menu button'))item.disabled=pending;}function closeKanbanMenu(){if(kanbanMenu){kanbanMenu.remove();kanbanMenu=null;}kanbanMenuCard=null;}function placeKanbanMenu(menu,x,y){menu.hidden=false;const rect=menu.getBoundingClientRect();const margin=8;const left=Math.max(margin,Math.min(x,window.innerWidth-rect.width-margin));const top=Math.max(margin,Math.min(y,window.innerHeight-rect.height-margin));menu.style.left=left+'px';menu.style.top=top+'px';}function menuButton(label,action,options={}){const button=document.createElement('button');button.type='button';button.setAttribute('role',options.radio?'menuitemradio':'menuitem');button.dataset.action=action;if(options.columnKey)button.dataset.columnKey=options.columnKey;button.textContent=label;if(options.current){button.className='current';button.setAttribute('aria-checked','true');button.append(document.createTextNode(' ✓'));}else if(options.radio)button.setAttribute('aria-checked','false');if(options.danger)button.classList.add('danger');return button;}function openKanbanMenu(card,x,y){if(!card||pendingPlanIds.has(card.dataset.planId))return;closeKanbanMenu();const menu=document.createElement('div');menu.className='kanban-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Card actions for '+(card.dataset.planTitle||'plan'));menu.hidden=true;const heading=document.createElement('strong');heading.textContent='Move to status';menu.append(heading);for(const column of columns()){const key=column.dataset.columnKey||'';const label=column.dataset.columnLabel||key;menu.append(menuButton(label,'move',{radio:true,columnKey:key,current:key===card.dataset.column}));}const sep=document.createElement('div');sep.className='kanban-menu-separator';menu.append(sep);const done=doneColumnConfig();if(done&&done.key!==card.dataset.column)menu.append(menuButton('Mark plan done ✓','mark-done',{columnKey:done.key}));menu.append(menuButton('Defer plan ⏸','defer'),menuButton('Archive plan 🗄','archive',{danger:true}));document.body.append(menu);kanbanMenu=menu;kanbanMenuCard=card;kanbanMenuOpenedAt=Date.now();placeKanbanMenu(menu,x,y);menu.querySelector('button')?.focus({preventScroll:true});}async function moveCard(card,targetKey){if(!card||!targetKey)return;if(card.dataset.column===targetKey){closeKanbanMenu();return;}const planId=card.dataset.planId;if(!planId||pendingPlanIds.has(planId))return;const previousColumn=card.parentElement;const previousNext=card.nextSibling;const targetColumn=columnForKey(targetKey);if(!targetColumn)return;pendingPlanIds.add(planId);setCardPending(card,true);clearOrganizerError();closeKanbanMenu();targetColumn.appendChild(card);updateCounts();const res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/column',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({boardColumnKey:targetKey})}).catch(()=>null);const result=res?.ok?await res.json().catch(()=>null):null;pendingPlanIds.delete(planId);setCardPending(card,false);if(!res?.ok){if(previousNext&&previousNext.parentNode===previousColumn)previousColumn?.insertBefore(card,previousNext);else previousColumn?.appendChild(card);updateCounts();if(res?.status===404||res?.status===409){reloadWithOrganizerMessage('The plan changed elsewhere; the board refreshed from server truth.');return;}setOrganizerError('Column update failed; the card was restored. Check the service and try again.');return;}if(result?.data?.plan?.lifecycleState!=='active'||result?.data?.plan?.archivedAt||result?.data?.plan?.boardColumnKey!==targetKey||result?.data?.column?.hiddenAt){if(previousNext&&previousNext.parentNode===previousColumn)previousColumn?.insertBefore(card,previousNext);else previousColumn?.appendChild(card);updateCounts();reloadWithOrganizerMessage('The plan changed elsewhere; the board refreshed from server truth.');return;}card.dataset.column=targetKey;const label=result?.data?.column?.label||targetColumn.dataset.columnLabel||targetKey;const badge=statusBadge(card);if(badge)badge.textContent='Status: '+label;updateCounts();}async function removeCardForLifecycle(card,path,successMessage,errorMessage){if(!card)return;const planId=card.dataset.planId;if(!planId||pendingPlanIds.has(planId))return;pendingPlanIds.add(planId);setCardPending(card,true);clearOrganizerError();closeKanbanMenu();const res=await fetch('/api/plans/'+encodeURIComponent(planId)+path,{method:'POST'}).catch(()=>null);pendingPlanIds.delete(planId);setCardPending(card,false);if(!res?.ok){if(res?.status===404||res?.status===409){reloadWithOrganizerMessage('The plan changed elsewhere; the board refreshed from server truth.');return;}setOrganizerError(errorMessage);return;}card.remove();updateCounts();if(successMessage)showArchiveToast(successMessage,planId);}async function deferCard(card){const note=window.prompt('Enter a note for deferring this plan:');if(!note||!note.trim())return;const planId=card?.dataset.planId;if(!card||!planId||pendingPlanIds.has(planId))return;pendingPlanIds.add(planId);setCardPending(card,true);clearOrganizerError();closeKanbanMenu();const res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/defer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:note.trim()})}).catch(()=>null);pendingPlanIds.delete(planId);setCardPending(card,false);if(!res?.ok){if(res?.status===404||res?.status===409){reloadWithOrganizerMessage('The plan changed elsewhere; the board refreshed from server truth.');return;}setOrganizerError('Defer failed; the card remains on the board. Check the service and try again.');return;}card.remove();updateCounts();}function stopArchiveToastDismissal(){if(archiveToastTimer)clearTimeout(archiveToastTimer);archiveToastTimer=null;archiveToastDismissHandlers.forEach(([target,type,handler,options])=>target.removeEventListener(type,handler,options));archiveToastDismissHandlers=[];}function dismissArchiveToast(){stopArchiveToastDismissal();archiveToast?.remove();archiveToast=null;}function addArchiveToastDismissListeners(){const dismiss=event=>{if(archiveToast?.contains(event.target))return;dismissArchiveToast();};const dismissOnEscape=event=>{if(event.key==='Escape')dismissArchiveToast();};[['click',document],['scroll',window],['touchstart',document],['pointerdown',document]].forEach(([type,target])=>{const options=type==='scroll'||type==='touchstart'?{passive:true}:true;target.addEventListener(type,dismiss,options);archiveToastDismissHandlers.push([target,type,dismiss,options]);});document.addEventListener('keydown',dismissOnEscape,true);archiveToastDismissHandlers.push([document,'keydown',dismissOnEscape,true]);}function restartArchiveToastDismissal(){archiveToastTimer=setTimeout(dismissArchiveToast,10000);setTimeout(addArchiveToastDismissListeners,0);}function showArchiveToast(message,planId,options={}){dismissArchiveToast();archiveToast=document.createElement('div');archiveToast.className='archive-toast'+(options.error?' error':'');archiveToast.setAttribute('role','status');archiveToast.setAttribute('aria-label',options.error?'Archive error':'Archived plan undo toast');const text=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p'),undo=document.createElement('button');title.textContent=message;detail.textContent=options.error?'Check the service and try Archive again.':'Undo is available for 10 seconds. It clears when you keep working.';undo.type='button';undo.textContent='Undo';text.append(title,detail);archiveToast.append(text,undo);undo.addEventListener('click',async event=>{event.stopPropagation();stopArchiveToastDismissal();undo.disabled=true;const res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive',{method:'POST'}).catch(()=>null);if(!res?.ok){undo.disabled=false;detail.textContent='Undo failed. The plan remains archived; use Archived plans to restore it.';restartArchiveToastDismissal();return;}window.location.reload();});document.body.appendChild(archiveToast);if(!options.error)undo.focus({preventScroll:true});restartArchiveToastDismissal();}restoreOrganizerReloadMessage();document.addEventListener('contextmenu',event=>{const card=event.target instanceof Element?event.target.closest('.kanban-card[data-plan-id]'):null;if(!card)return;event.preventDefault();openKanbanMenu(card,event.clientX,event.clientY);});document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeKanbanMenu();return;}if(kanbanMenu&&['ArrowDown','ArrowUp'].includes(event.key)){const items=[...kanbanMenu.querySelectorAll('button')];const index=items.indexOf(document.activeElement);const next=event.key==='ArrowDown'?(index+1)%items.length:(index-1+items.length)%items.length;event.preventDefault();items[next]?.focus();return;}const card=event.target instanceof Element?event.target.closest('.kanban-card[data-plan-id]'):null;if(card&&(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))){event.preventDefault();const rect=card.getBoundingClientRect();openKanbanMenu(card,rect.left+24,rect.top+24);return;}if(event.target===card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();const url=card.dataset.planUrl;if(url)window.location.href=url;}});document.addEventListener('click',event=>{const target=event.target;if(kanbanMenu&&target instanceof Element&&kanbanMenu.contains(target)){const button=target.closest('button[data-action]');if(!button||!kanbanMenuCard)return;const action=button.dataset.action;if(action==='move'||action==='mark-done')void moveCard(kanbanMenuCard,button.dataset.columnKey);else if(action==='defer')void deferCard(kanbanMenuCard);else if(action==='archive')void removeCardForLifecycle(kanbanMenuCard,'/archive','Archived '+(kanbanMenuCard.dataset.planTitle||'plan')+'.','Archive failed; the card remains on the board. Check the service and try again.');return;}if(kanbanMenu)closeKanbanMenu();const card=target instanceof Element?target.closest('.kanban-card[data-plan-id]'):null;if(!card||Date.now()<cardOpenSuppressedUntil)return;if(target instanceof Element&&target.closest('a,button,input,select,textarea,label,[role="button"],[role="menuitem"],[role="menuitemradio"]'))return;const url=card.dataset.planUrl;if(url)window.location.href=url;});document.addEventListener('dragstart',event=>{const card=event.target instanceof Element?event.target.closest('[data-plan-id]'):null;if(!card)return;if(pendingPlanIds.has(card.dataset.planId)){event.preventDefault();return;}closeKanbanMenu();cardOpenSuppressedUntil=Date.now()+800;draggedPlanId=card.dataset.planId;event.dataTransfer?.setData('text/plain',draggedPlanId||'');});document.addEventListener('dragover',event=>{const col=event.target instanceof Element?event.target.closest('[data-column-key]'):null;if(!col)return;event.preventDefault();col.classList.add('drop-target');});document.addEventListener('dragleave',event=>{const col=event.target instanceof Element?event.target.closest('[data-column-key]'):null;col?.classList.remove('drop-target');});document.addEventListener('drop',async event=>{const col=event.target instanceof Element?event.target.closest('[data-column-key]'):null;if(!col||!draggedPlanId)return;event.preventDefault();col.classList.remove('drop-target');const card=document.querySelector('[data-plan-id="'+CSS.escape(draggedPlanId)+'"]');const targetKey=col.dataset.columnKey;draggedPlanId=null;if(card&&targetKey)await moveCard(card,targetKey);});document.addEventListener('scroll',event=>{if(kanbanMenu&&(Date.now()-kanbanMenuOpenedAt<150||event.composedPath?.().includes(kanbanMenu)||(event.target instanceof Node&&kanbanMenu.contains(event.target))))return;closeKanbanMenu();},true);window.addEventListener('resize',closeKanbanMenu);`;
}

function indexHtml(plans: ReturnType<PlanReviewStore['listPlans']>, archivedCount: number, deferredCount: number, columns: BoardColumnRecord[] = [], view: 'kanban' | 'all' = 'kanban', projectName?: string, typeFilter?: 'plan' | 'collaborative', kanbanEnabled = true, updateStatus?: UpdateStatus): string {
  if (view === 'kanban' && kanbanEnabled) return kanbanIndexHtml(plans, archivedCount, deferredCount, columns, projectName, updateStatus);
  const repos = [...new Set(plans.map(item => item.plan.repoName))].sort();
  const attentionCount = plans.filter(planNeedsAttention).length;
  const attentionSummary = attentionCount
    ? `<div class="attention-summary" role="status"><strong>${attentionCount} ${attentionCount === 1 ? 'plan · source file missing' : 'plans · source files missing'}</strong><span>Cached copies still open.</span><button type="button" data-attention-filter aria-pressed="false">Needs attention</button></div>`
    : '';
  const startedPlans = plans.filter(hasStartedPlanProgress);
  const notStartedPlans = plans.filter(item => !hasStartedPlanProgress(item));
  const rows = [repoGroupsHtml(startedPlans), repoGroupsHtml(notStartedPlans)].filter(Boolean).join('\n');
  const viewActions = view === 'all' ? `${topbarIconAction('/deferred', `Deferred (${deferredCount})`, '⏸')}${topbarIconAction('/archive', `Archived (${archivedCount})`, '🗄')}${configurationGearAction()}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plan Review Index</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <style>${baseIndexStyles()}${organizationIndexStyles()}${runtimeUpdateIndicatorStyles()}</style>
  </head><body><main class="documents-page"><div class="topbar">${documentViewSwitcher('all', kanbanEnabled)}<div class="plan-actions">${viewActions}</div></div><div class="page-header"><div><h1>Plan Review Index · All documents</h1><p class="muted">Planning and collaboration documents are shown together. Use Type to narrow the list.</p></div></div>${attentionSummary}<div class="toolbar"><input id="q" placeholder="Filter documents" aria-label="Filter documents"><select id="repo" aria-label="Filter by repo"><option value="">All repos</option>${repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('')}</select><select id="type" aria-label="Filter by type"><option value="">All types</option><option value="plan"${typeFilter === 'plan' ? ' selected' : ''}>Plan</option><option value="collaborative"${typeFilter === 'collaborative' ? ' selected' : ''}>Collaborative</option></select></div><div id="plans">${rows || '<p>No active documents registered.</p>'}</div><script>
  const q=document.getElementById('q'), repo=document.getElementById('repo'), type=document.getElementById('type'), attentionFilter=document.querySelector('[data-attention-filter]'), cards=[...document.querySelectorAll('.plan-card')];
  let attentionOnly=false;
  function matchesSearch(card,text){if(!text)return true; const status=card.dataset.prStatus; if(text==='merged')return status==='merged'; if(text==='unmerged')return !!status&&status!=='merged'&&status!=='unlinked'; return card.dataset.search.includes(text);}  function apply(){const text=q.value.toLowerCase().trim(), r=repo.value, t=type.value; cards.forEach(card=>{card.hidden=!!((r&&card.dataset.repo!==r)||(t&&card.dataset.type!==t)||(text&&!matchesSearch(card,text))||(attentionOnly&&card.dataset.needsAttention!=='true'));}); document.querySelectorAll('.repo-group').forEach(group=>{group.hidden=!group.querySelector('.plan-card:not([hidden])');});}
  ${localTimestampScript()}
  let archiveToast=null, archiveToastTimer=null, archiveToastDismissHandlers=[];
  function stopArchiveToastDismissal(){ if(archiveToastTimer) clearTimeout(archiveToastTimer); archiveToastTimer=null; archiveToastDismissHandlers.forEach(([target,type,handler,options])=>target.removeEventListener(type,handler,options)); archiveToastDismissHandlers=[]; }
  function dismissArchiveToast(){ stopArchiveToastDismissal(); archiveToast?.remove(); archiveToast=null; }
  function addArchiveToastDismissListeners(){ const dismiss=event=>{ if(archiveToast?.contains(event.target)) return; dismissArchiveToast(); }; const dismissOnEscape=event=>{ if(event.key==='Escape') dismissArchiveToast(); }; [['click',document],['scroll',window],['touchstart',document],['pointerdown',document],['input',q],['change',repo],['change',type]].forEach(([type,target])=>{ if(!target) return; const options=type==='scroll'||type==='touchstart'?{passive:true}:true; target.addEventListener(type,dismiss,options); archiveToastDismissHandlers.push([target,type,dismiss,options]); }); document.addEventListener('keydown',dismissOnEscape,true); archiveToastDismissHandlers.push([document,'keydown',dismissOnEscape,true]); }
  function restartArchiveToastDismissal(){ archiveToastTimer=setTimeout(dismissArchiveToast,10000); setTimeout(addArchiveToastDismissListeners,0); }
  function showArchiveToast(message, planId, options={}){ dismissArchiveToast(); archiveToast=document.createElement('div'); archiveToast.className='archive-toast'+(options.error?' error':''); archiveToast.setAttribute('role','status'); archiveToast.setAttribute('aria-label', options.error ? 'Archive error' : 'Archived plan undo toast'); const text=document.createElement('div'), title=document.createElement('strong'), detail=document.createElement('p'), undo=document.createElement('button'); title.textContent=message; detail.textContent=options.error?'Check the service and try Archive again.':'Undo is available for 10 seconds. It clears when you keep working.'; undo.type='button'; undo.textContent='Undo'; text.append(title,detail); archiveToast.append(text,undo); undo.addEventListener('click',async event=>{ event.stopPropagation(); stopArchiveToastDismissal(); undo.disabled=true; const res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive',{method:'POST'}).catch(()=>null); if(!res?.ok){ undo.disabled=false; detail.textContent='Undo failed. The plan remains archived; use Archived plans to restore it.'; restartArchiveToastDismissal(); return; } window.location.reload(); }); document.body.appendChild(archiveToast); if(!options.error) undo.focus({preventScroll:true}); restartArchiveToastDismissal(); }
  q.addEventListener('input',apply); repo.addEventListener('change',apply); type.addEventListener('change',apply); attentionFilter?.addEventListener('click',()=>{attentionOnly=!attentionOnly; attentionFilter.setAttribute('aria-pressed', String(attentionOnly)); apply();}); apply();
  document.addEventListener('click',async event=>{const target=event.target; const button=target instanceof Element ? target.closest('[data-archive-plan]') : null; if(!button) return; button.disabled=true; const planId=button.dataset.archivePlan; const card=button.closest('.plan-card'); const title=card?.querySelector('h2')?.textContent?.trim()||'plan'; const res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/archive',{method:'POST'}).catch(()=>null); if(!res?.ok){button.disabled=false; showArchiveToast('Unable to archive '+title+'.', planId, {error:true}); return;} card?.remove(); const index=cards.findIndex(card=>card.dataset.planId===planId); if(index>=0) cards.splice(index,1); apply(); showArchiveToast('Archived '+title+'.', planId);});
  </script>${runtimeUpdateIndicatorHtml(updateStatus)}</main></body></html>`;
}

function archiveHtml(plans: ReturnType<PlanReviewStore['listPlans']>, deferredCount = 0, kanbanEnabled = true): string {
  const archivedPlans = plans
    .filter(item => item.plan.archivedAt)
    .sort((a, b) => String(b.plan.archivedAt).localeCompare(String(a.plan.archivedAt)) || String(b.activityAt).localeCompare(String(a.activityAt)) || String(a.plan.repoName).localeCompare(String(b.plan.repoName)) || String(a.plan.slug).localeCompare(String(b.plan.slug)) || String(a.plan.id).localeCompare(String(b.plan.id)));
  const repos = [...new Set(archivedPlans.map(item => item.plan.repoName))].sort();
  const rows = archivedPlans.map(item => {
    const complete = item.progress.totalPhases > 0 && item.progress.completedPhases === item.progress.totalPhases;
    const statusLabel = complete ? 'Complete' : 'Incomplete';
    const sourceWarning = planNeedsAttention(item) ? syncWarningHtml(item, { archived: true }) : '';
    const prStatus = item.plan.pullRequest?.status ?? item.plan.pullRequest?.state ?? 'unlinked';
    return `<article class="plan-card archived ${complete ? 'complete' : 'incomplete'}" data-plan-id="${escapeHtml(item.plan.id)}" data-repo="${escapeHtml(item.plan.repoName)}" data-pr-status="${escapeHtml(prStatus)}" data-search="${escapeHtml(planCardSearch(item))}">
      <div class="plan-card-header"><h2>${escapeHtml(item.plan.repoName)} / ${escapeHtml(item.plan.slug)}</h2><div class="plan-actions"><span class="status-pill">${escapeHtml(statusLabel)}</span><span class="status-pill">Archived</span><a class="nav-link primary" href="/p/${escapeHtml(item.plan.id)}">Open</a><button class="restore-plan" type="button" data-restore-plan="${escapeHtml(item.plan.id)}">Restore</button></div></div>
      <p><code>${escapeHtml(fullyQualifiedPlanPath(item))}</code></p>
      ${publicationMetadataHtml(item)}
      ${pullRequestHtml(item)}
      ${sourceWarning}
      ${latestNoteHtml(item)}
      ${progressHtml(item.progress)}
      ${commentCountsHtml(item)}
      ${lastUpdatedHtml(item.modifiedAt)}
      <p class="restore-error" hidden>Restore failed. The plan is still archived; check the service and try Restore again.</p>
    </article>`;
  }).join('\n');
  const empty = '<p class="empty-state" id="archive-empty">No archived plans yet.</p>';
  const filteredEmpty = '<p class="empty-state" id="archive-filter-empty" hidden>No archived plans match the current filters. <button type="button" id="clear-filters">Clear filters</button></p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Archived Plans</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <style>${baseIndexStyles()}${organizationIndexStyles()}</style>
  </head><body><main><div class="topbar">${documentViewSwitcher('all', kanbanEnabled)}<div class="plan-actions">${topbarIconAction('/deferred', `Deferred (${deferredCount})`, '⏸')}${configurationGearAction()}</div></div><div class="page-header"><div><h1>Archived Plans</h1><p class="muted">Archived plans stay out of the active index but remain inspectable and restorable.</p></div></div><div class="toolbar"><input id="q" placeholder="Filter archived plans" aria-label="Filter archived plans"><select id="repo" aria-label="Filter by repo"><option value="">All repos</option>${repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('')}</select></div><p class="muted" id="archive-count">${archivedPlans.length} archived</p><div id="plans">${rows || empty}</div>${rows ? filteredEmpty : ''}<script>
  const q=document.getElementById('q'), repo=document.getElementById('repo'), cards=[...document.querySelectorAll('.plan-card')], filteredEmpty=document.getElementById('archive-filter-empty'), count=document.getElementById('archive-count');
  function matchesSearch(card,text){if(!text)return true; const status=card.dataset.prStatus; if(text==='merged')return status==='merged'; if(text==='unmerged')return !!status&&status!=='merged'&&status!=='unlinked'; return card.dataset.search.includes(text);}  function apply(){const text=q.value.toLowerCase().trim(), r=repo.value; let visible=0; cards.forEach(card=>{card.hidden=!!((r&&card.dataset.repo!==r)||(text&&!matchesSearch(card,text))); if(!card.hidden) visible++;}); if(filteredEmpty) filteredEmpty.hidden=visible>0||cards.length===0; if(count) count.textContent=visible+' archived';}
  ${localTimestampScript()}
  q?.addEventListener('input',apply); repo?.addEventListener('change',apply); document.getElementById('clear-filters')?.addEventListener('click',()=>{q.value=''; repo.value=''; apply();});
  document.addEventListener('click',async event=>{const target=event.target; const button=target instanceof Element ? target.closest('[data-restore-plan]') : null; if(!button) return; button.disabled=true; const card=button.closest('.plan-card'); const error=card?.querySelector('.restore-error'); if(error) error.hidden=true; const planId=button.dataset.restorePlan; let res; try{res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive',{method:'POST'});}catch{button.disabled=false; if(error) error.hidden=false; return;} if(!res.ok){button.disabled=false; if(error) error.hidden=false; return;} card?.remove(); const index=cards.findIndex(item=>item.dataset.planId===planId); if(index>=0) cards.splice(index,1); apply();});
  </script></main></body></html>`;
}

function deferredHtml(plans: ReturnType<PlanReviewStore['listPlans']>, archivedCount = 0, kanbanEnabled = true): string {
  const deferredPlans = plans
    .filter(item => item.plan.lifecycleState === 'deferred')
    .sort((a, b) => String(b.plan.deferredAt ?? b.activityAt).localeCompare(String(a.plan.deferredAt ?? a.activityAt)) || String(a.plan.repoName).localeCompare(String(b.plan.repoName)) || String(a.plan.slug).localeCompare(String(b.plan.slug)));
  const repos = [...new Set(deferredPlans.map(item => item.plan.repoName))].sort();
  const rows = deferredPlans.map(item => {
    const sourceWarning = planNeedsAttention(item) ? syncWarningHtml(item, { archived: true }) : '';
    const deferredAt = item.plan.deferredAt ? `<p class="timestamp-row"><span class="row-label">Deferred</span> <time datetime="${escapeHtml(item.plan.deferredAt)}" data-local-timestamp>${escapeHtml(item.plan.deferredAt)}</time></p>` : '';
    return `<article class="plan-card needs-attention" data-plan-id="${escapeHtml(item.plan.id)}" data-repo="${escapeHtml(item.plan.repoName)}" data-search="${escapeHtml(planCardSearch(item))}">
      <div class="plan-card-header"><h2><a href="/p/${escapeHtml(item.plan.id)}">${escapeHtml(item.plan.repoName)} / ${escapeHtml(item.plan.slug)}</a></h2><div class="plan-actions"><span class="status-pill attention">Deferred</span><button class="restore-plan" type="button" data-resume-plan="${escapeHtml(item.plan.id)}">Resume</button><button class="archive-plan" type="button" data-archive-plan="${escapeHtml(item.plan.id)}">Archive</button></div></div>
      <p><code>${escapeHtml(fullyQualifiedPlanPath(item))}</code></p>
      ${publicationMetadataHtml(item)}
      ${sourceWarning}
      ${latestNoteHtml(item)}
      ${deferredAt}
      ${progressHtml(item.progress)}
      ${commentCountsHtml(item)}
      ${lastUpdatedHtml(item.modifiedAt)}
      <p class="restore-error" hidden>Action failed. Check the service and try again.</p>
    </article>`;
  }).join('\n');
  const empty = '<p class="empty-state" id="deferred-empty">No deferred plans yet.</p>';
  const filteredEmpty = '<p class="empty-state" id="deferred-filter-empty" hidden>No deferred plans match the current filters. <button type="button" id="clear-filters">Clear filters</button></p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Deferred Plans</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <style>${baseIndexStyles()}${organizationIndexStyles()}</style>
  </head><body><main><div class="topbar">${documentViewSwitcher('all', kanbanEnabled)}<div class="plan-actions">${topbarIconAction('/archive', `Archived (${archivedCount})`, '🗄')}${configurationGearAction()}</div></div><div class="page-header"><div><h1>Deferred Plans</h1><p class="muted">Deferred plans are paused for later pickup and keep their notes with the plan.</p></div></div><div class="toolbar"><input id="q" placeholder="Filter deferred plans" aria-label="Filter deferred plans"><select id="repo" aria-label="Filter by repo"><option value="">All repos</option>${repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('')}</select></div><p class="muted" id="deferred-count">${deferredPlans.length} deferred</p><div id="plans">${rows || empty}</div>${rows ? filteredEmpty : ''}<script>
  const q=document.getElementById('q'), repo=document.getElementById('repo'), cards=[...document.querySelectorAll('.plan-card')], filteredEmpty=document.getElementById('deferred-filter-empty'), count=document.getElementById('deferred-count');
  function apply(){const text=q.value.toLowerCase(), r=repo.value; let visible=0; cards.forEach(card=>{card.hidden=!!((r&&card.dataset.repo!==r)||(text&&!card.dataset.search.includes(text))); if(!card.hidden) visible++;}); if(filteredEmpty) filteredEmpty.hidden=visible>0||cards.length===0; if(count) count.textContent=visible+' deferred';}
  ${localTimestampScript()}
  let archiveToast=null, archiveToastTimer=null, archiveToastDismissHandlers=[];
  function stopArchiveToastDismissal(){ if(archiveToastTimer) clearTimeout(archiveToastTimer); archiveToastTimer=null; archiveToastDismissHandlers.forEach(([target,type,handler,options])=>target.removeEventListener(type,handler,options)); archiveToastDismissHandlers=[]; }
  function dismissArchiveToast(){ stopArchiveToastDismissal(); archiveToast?.remove(); archiveToast=null; }
  function addArchiveToastDismissListeners(){ const dismiss=event=>{ if(archiveToast?.contains(event.target)) return; dismissArchiveToast(); }; const dismissOnEscape=event=>{ if(event.key==='Escape') dismissArchiveToast(); }; [['click',document],['scroll',window],['touchstart',document],['pointerdown',document],['input',q],['change',repo]].forEach(([type,target])=>{ if(!target) return; const options=type==='scroll'||type==='touchstart'?{passive:true}:true; target.addEventListener(type,dismiss,options); archiveToastDismissHandlers.push([target,type,dismiss,options]); }); document.addEventListener('keydown',dismissOnEscape,true); archiveToastDismissHandlers.push([document,'keydown',dismissOnEscape,true]); }
  function restartArchiveToastDismissal(){ archiveToastTimer=setTimeout(dismissArchiveToast,10000); setTimeout(addArchiveToastDismissListeners,0); }
  function showArchiveToast(message, planId, options={}){ dismissArchiveToast(); archiveToast=document.createElement('div'); archiveToast.className='archive-toast'+(options.error?' error':''); archiveToast.setAttribute('role','status'); archiveToast.setAttribute('aria-label', options.error ? 'Archive error' : 'Archived plan undo toast'); const text=document.createElement('div'), title=document.createElement('strong'), detail=document.createElement('p'), undo=document.createElement('button'); title.textContent=message; detail.textContent=options.error?'Check the service and try Archive again.':'Undo is available for 10 seconds. It clears when you keep working.'; undo.type='button'; undo.textContent='Undo'; text.append(title,detail); archiveToast.append(text,undo); undo.addEventListener('click',async event=>{ event.stopPropagation(); stopArchiveToastDismissal(); undo.disabled=true; const res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive',{method:'POST'}).catch(()=>null); if(!res?.ok){ undo.disabled=false; detail.textContent='Undo failed. The plan remains archived; use Archived plans to restore it.'; restartArchiveToastDismissal(); return; } window.location.href='/'; }); document.body.appendChild(archiveToast); if(!options.error) undo.focus({preventScroll:true}); restartArchiveToastDismissal(); }
  q?.addEventListener('input',apply); repo?.addEventListener('change',apply); document.getElementById('clear-filters')?.addEventListener('click',()=>{q.value=''; repo.value=''; apply();});
  document.addEventListener('click',async event=>{const target=event.target; const resume=target instanceof Element ? target.closest('[data-resume-plan]') : null; const archive=target instanceof Element ? target.closest('[data-archive-plan]') : null; const button=resume||archive; if(!button) return; button.disabled=true; const card=button.closest('.plan-card'); const error=card?.querySelector('.restore-error'); if(error) error.hidden=true; const planId=resume ? button.dataset.resumePlan : button.dataset.archivePlan; const title=card?.querySelector('h2')?.textContent?.trim()||'plan'; const path=resume ? '/resume' : '/archive'; let res; try{res=await fetch('/api/plans/'+encodeURIComponent(planId)+path, resume ? {method:'POST',headers:{'content-type':'application/json'},body:'{}'} : {method:'POST'});}catch{button.disabled=false; if(error) error.hidden=false; if(archive) showArchiveToast('Unable to archive '+title+'.', planId, {error:true}); return;} if(!res.ok){button.disabled=false; if(error) error.hidden=false; if(archive) showArchiveToast('Unable to archive '+title+'.', planId, {error:true}); return;} card?.remove(); const index=cards.findIndex(item=>item.dataset.planId===planId); if(index>=0) cards.splice(index,1); apply(); if(archive) showArchiveToast('Archived '+title+'.', planId);});
  </script></main></body></html>`;
}

function filterPlans(plans: ReturnType<PlanReviewStore['listPlans']>, query: { q?: string; repoKey?: string; projectKey?: string; status?: string; reviewMode?: 'planning' | 'collaboration'; boardColumnKey?: string; limit?: string; cursor?: string; currentPlanId?: string }) {
  const parseInteger = (value: string | undefined, name: string, min: number, max?: number): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) {
      throw new PlanReviewError('validation_failed', `${name} must be a non-negative integer`, 400, { [name]: value });
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
      throw new PlanReviewError('validation_failed', `${name} must be between ${min} and ${max ?? Number.MAX_SAFE_INTEGER}`, 400, { [name]: value });
    }
    return parsed;
  };
  const text = query.q?.toLowerCase();
  const filtered = plans.filter(item => {
    const matchesRepo = !query.repoKey || item.plan.repoKey === query.repoKey;
    const matchesProject = !query.projectKey || item.plan.projectKey === query.projectKey;
    const matchesMode = !query.reviewMode || item.plan.reviewMode === query.reviewMode;
    const matchesColumn = !query.boardColumnKey || item.plan.boardColumnKey === query.boardColumnKey;
    const matchesStatus = !query.status || Number(item.counts[query.status as keyof typeof item.counts] ?? 0) > 0;
    const haystack = planCardSearch(item);
    const trimmedText = text?.trim();
    const prStatus = item.plan.pullRequest?.status ?? item.plan.pullRequest?.state;
    const matchesText = !trimmedText
      || (trimmedText === 'merged' ? prStatus === 'merged' : trimmedText === 'unmerged' ? Boolean(item.plan.pullRequest && prStatus !== 'merged') : haystack.includes(trimmedText));
    return matchesRepo && matchesProject && matchesMode && matchesColumn && matchesStatus && matchesText;
  });
  const offset = parseInteger(query.cursor, 'cursor', 0) ?? 0;
  const limit = parseInteger(query.limit, 'limit', 1, 200);
  const page = limit ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
  const currentPlan = query.currentPlanId ? filtered.find(item => item.plan.id === query.currentPlanId) : undefined;
  const pagePlans = currentPlan && !page.some(item => item.plan.id === currentPlan.plan.id) ? [...page, currentPlan] : page;
  return {
    plans: pagePlans,
    nextCursor: limit && offset + limit < filtered.length ? String(offset + limit) : undefined
  };
}

const clientAssetVersion = 'plan-nav-first-paint-state-v1';
const planNavStateCookieName = 'plan_review_plan_nav';

function cookieValue(cookieHeader: string | string[] | undefined, name: string): string | undefined {
  const rawCookie = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!rawCookie) return undefined;
  for (const part of rawCookie.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    const key = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
    if (key !== name) continue;
    const value = separator >= 0 ? trimmed.slice(separator + 1) : '';
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function planNavigatorOpenFromCookie(cookieHeader: string | string[] | undefined, fallback: boolean): boolean {
  const value = cookieValue(cookieHeader, planNavStateCookieName);
  if (value === 'open') return true;
  if (value === 'closed') return false;
  return fallback;
}

function safeActionPlanPath(planPath: string): string {
  const parsed = actionCommentPlanPathSchema.safeParse(planPath);
  if (!parsed.success) {
    throw new PlanReviewError(
      'validation_failed',
      'Plan path is unsafe for action comments',
      400,
      { issues: parsed.error.issues, planPath },
      'Re-register the plan with a single-line path that contains no newline or control characters before requesting an agent action.'
    );
  }
  return parsed.data;
}

function executionReviewRequestBody(planPath: string, skillName = defaultAppConfiguration.executionReadySkillName): string {
  return `Use the ${skillName} skill for this plan.\nPlan path: ${safeActionPlanPath(planPath)}`;
}

function buildPlanRequestBody(planPath: string, skillName = defaultAppConfiguration.buildPlanSkillName): string {
  return `Use the ${skillName} skill for this plan.\nPlan path: ${safeActionPlanPath(planPath)}`;
}

function checked(value: boolean): string {
  return value ? ' checked' : '';
}

function boardColumnRowsHtml(columns: BoardColumnRecord[], planCounts: Map<string, number>): string {
  return columns.map(column => {
    const count = planCounts.get(column.key) ?? 0;
    const title = 'Hide this column from the Kanban board. Plans stay assigned to this column and can be shown again later.';
    return `<tr data-column-row data-original-key="${escapeHtml(column.key)}" data-position="${column.position}" data-is-done="${column.isDone ? 'true' : 'false'}"><td><code data-column-key-preview>${escapeHtml(column.key)}</code></td><td><input class="configuration-input" data-column-label aria-label="Label for ${escapeHtml(column.key)}" value="${escapeHtml(column.label)}"></td><td>${column.position}</td><td>${column.isDone ? 'Done' : 'Workflow'}</td><td>${count}</td><td><label title="${escapeHtml(title)}"><input type="checkbox" data-column-hidden ${column.hiddenAt ? 'checked' : ''}> Hide</label>${count > 0 ? ` <span class="muted">${count} assigned plan${count === 1 ? '' : 's'} will be hidden from the board</span>` : ''}</td></tr>`;
  }).join('');
}

function boardColumnsConfigurationSectionHtml(columns: BoardColumnRecord[], planCounts: Map<string, number>): string {
  return `<section id="kanban-columns" class="configuration-section"><h2>Board columns</h2><p class="muted">Column labels, keys, order, done behavior, and visibility are persisted in the local database. Renaming a column updates its stable key and migrates assigned plans. Hidden columns and their plans are omitted from the Kanban board until shown again.</p><table class="columns-table"><thead><tr><th>Stable key</th><th>Label</th><th>Position</th><th>Behavior</th><th>Plans</th><th>Visibility</th></tr></thead><tbody>${boardColumnRowsHtml(columns, planCounts)}</tbody></table><div class="columns-save"><button id="save-columns" class="nav-link primary" type="button">Save columns</button><span id="columns-message" class="columns-message"></span></div></section>`;
}

function configurationHtml(configuration: AppConfiguration, columns: BoardColumnRecord[], planCounts: Map<string, number>, updateConfig: UpdateCheckConfig, cachedStatus: UpdateStatus | undefined): string {
  const executionPreview = executionReviewRequestBody('thoughts/plans/example.html', configuration.executionReadySkillName);
  const buildPreview = buildPlanRequestBody('thoughts/plans/example.html', configuration.buildPlanSkillName);
  const updateChecked = updateConfig.enabled ? ' checked' : '';
  const updateStatusText = cachedStatus ? `${cachedStatus.status} · checked ${cachedStatus.checkedAt}` : 'No cached update status yet.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Configuration</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${baseIndexStyles()}${organizationIndexStyles()}</style></head><body><main class="configuration-page"><div class="topbar">${documentViewSwitcher(undefined, configuration.kanbanEnabled)}<div class="plan-actions">${configurationGearAction()}</div></div><div class="page-header"><div><h1>Configuration</h1><p class="muted">Service-local settings for the review shell, action buttons, and Kanban board.</p></div></div><div id="organizer-error" class="organizer-error" hidden></div><div class="configuration-layout"><nav class="configuration-nav" aria-label="Configuration sections"><a href="#review-shell-defaults">Review shell defaults</a><a href="#action-button-skills">Action button skills</a><a href="#kanban-availability">Kanban availability</a><a href="#update-checks-settings">Update checks</a><a href="#kanban-columns">Board columns</a></nav><div><section id="review-shell-defaults" class="configuration-section"><h2>Review shell defaults</h2><p class="muted">Choose which side panels are open by default when entering a plan.</p><div class="configuration-grid"><label for="show-plan-navigator-default">Show plan navigator by default</label><input id="show-plan-navigator-default" type="checkbox"${checked(configuration.showPlanNavigatorByDefault)}><label for="show-comments-default">Show comments by default</label><input id="show-comments-default" type="checkbox"${checked(configuration.showCommentsByDefault)}></div></section><section id="action-button-skills" class="configuration-section"><h2>Action button skills</h2><p class="muted">These skill names are inserted into fixed, single-line-safe action comments. Prompt body shape is not configurable.</p><div class="configuration-grid"><label for="execution-ready-skill-name">Review execution ready skill</label><input id="execution-ready-skill-name" class="configuration-input" value="${escapeHtml(configuration.executionReadySkillName)}" aria-describedby="execution-ready-preview"><label for="build-plan-skill-name">Build Plan skill</label><input id="build-plan-skill-name" class="configuration-input" value="${escapeHtml(configuration.buildPlanSkillName)}" aria-describedby="build-plan-preview"></div><h3>Preview</h3><pre id="execution-ready-preview" class="configuration-preview"><code>${escapeHtml(executionPreview)}</code></pre><pre id="build-plan-preview" class="configuration-preview"><code>${escapeHtml(buildPreview)}</code></pre></section><section id="kanban-availability" class="configuration-section"><h2>Kanban availability</h2><p class="muted">Disabling Kanban hides board navigation and movement controls without deleting columns or plan assignments.</p><div class="configuration-grid"><label for="kanban-enabled">Enable Kanban board</label><input id="kanban-enabled" type="checkbox"${checked(configuration.kanbanEnabled)}></div></section><section id="update-checks-settings" class="configuration-section"><h2>Update checks</h2><p class="muted">Automatic checks fetch only public Homebrew/GitHub metadata. They never send plan data and never apply updates.</p><div class="configuration-grid"><label for="update-checks-enabled">Enable automatic update checks</label><input id="update-checks-enabled" type="checkbox"${updateChecked}><span class="row-label">Cached status</span><span id="update-checks-status">${escapeHtml(updateStatusText)}</span><span class="row-label">Manual check</span><code>plan-review update check --json</code></div><div class="columns-save"><button id="save-update-checks" class="nav-link primary" type="button">Save update checks</button><span id="update-checks-message" class="columns-message"></span></div></section><div class="configuration-save"><button id="save-configuration" class="nav-link primary" type="button">Save configuration</button><span id="configuration-message" class="configuration-message"></span></div>${boardColumnsConfigurationSectionHtml(columns, planCounts)}</div></div><script>
      const message=document.getElementById('columns-message'), configMessage=document.getElementById('configuration-message'), updateMessage=document.getElementById('update-checks-message'), error=document.getElementById('organizer-error');
      const keyFromLabel=value=>(value||'').trim().toLowerCase().replace(/['"]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'column';
      const skillPattern=/^[a-z0-9][a-z0-9_-]*$/;
      function setError(text){ if(error){error.hidden=!text; error.textContent=text||'';} }
      for(const input of document.querySelectorAll('[data-column-label]')) input.addEventListener('input',()=>{const row=input.closest('[data-column-row]'), preview=row?.querySelector('[data-column-key-preview]'); if(preview) preview.textContent=keyFromLabel(input.value);});
      document.getElementById('save-update-checks')?.addEventListener('click', async event => {
        const button=event.currentTarget;
        button.disabled=true; setError(''); if(updateMessage) updateMessage.textContent='Saving…';
        const res=await fetch('/api/configuration/update-checks',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:Boolean(document.getElementById('update-checks-enabled')?.checked)})}).catch(()=>null);
        button.disabled=false;
        if(!res?.ok){const json=await res?.json().catch(()=>null); setError(json?.error?.nextAction||json?.error?.message||'Update check setting could not be saved.'); if(updateMessage) updateMessage.textContent=''; return;}
        if(updateMessage) updateMessage.textContent='Update checks saved.';
      });
      document.getElementById('save-configuration')?.addEventListener('click', async event => {
        const button=event.currentTarget;
        const executionReadySkillName=document.getElementById('execution-ready-skill-name')?.value?.trim()||'';
        const buildPlanSkillName=document.getElementById('build-plan-skill-name')?.value?.trim()||'';
        if(!skillPattern.test(executionReadySkillName)||!skillPattern.test(buildPlanSkillName)){setError('Skill names must use lowercase letters, numbers, underscores, or dashes.'); return;}
        button.disabled=true; setError(''); if(configMessage) configMessage.textContent='Saving…';
        const payload={showPlanNavigatorByDefault:Boolean(document.getElementById('show-plan-navigator-default')?.checked),showCommentsByDefault:Boolean(document.getElementById('show-comments-default')?.checked),executionReadySkillName,buildPlanSkillName,kanbanEnabled:Boolean(document.getElementById('kanban-enabled')?.checked)};
        const res=await fetch('/api/configuration',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}).catch(()=>null);
        button.disabled=false;
        if(!res?.ok){const json=await res?.json().catch(()=>null); setError(json?.error?.nextAction||json?.error?.message||'Configuration could not be saved.'); if(configMessage) configMessage.textContent=''; return;}
        if(configMessage) configMessage.textContent='Configuration saved.';
      });
      document.getElementById('save-columns')?.addEventListener('click', async event => {
        const button=event.currentTarget;
        button.disabled=true;
        setError('');
        if(message) message.textContent='Saving…';
        const columns=[...document.querySelectorAll('[data-column-row]')].map(row=>{const label=row.querySelector('[data-column-label]')?.value||row.dataset.originalKey; return {originalKey:row.dataset.originalKey,key:keyFromLabel(label),label,position:Number(row.dataset.position),isDone:row.dataset.isDone==='true',hidden:Boolean(row.querySelector('[data-column-hidden]')?.checked)};});
        const res=await fetch('/api/board-columns',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({columns})}).catch(()=>null);
        if(!res?.ok){
          button.disabled=false;
          const json=await res?.json().catch(()=>null);
          setError(json?.error?.nextAction||json?.error?.message||'Columns could not be saved.');
          if(message) message.textContent='';
          return;
        }
        if(message) message.textContent='Columns saved. Reloading…';
        window.location.reload();
      });
    </script></main></body></html>`;
}

function selectedOption(actual: string | undefined, expected: string): string {
  return actual === expected ? ' selected' : '';
}

function navigatorFilterControls(plan: ReturnType<PlanReviewStore['getPlan']>['plan'], columns: BoardColumnRecord[], projects: PlanProjectRecord[], navigatorFilters: ReviewShellNavigatorFilters, kanbanEnabled: boolean): string {
  const projectOptions = [...new Map(projects.map(project => [project.projectKey, project.projectName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (!projectOptions.some(([key]) => key === plan.projectKey)) projectOptions.push([plan.projectKey, plan.projectName]);
  const projectFilterControl = `<label class="filter-control">Filter: Project <select id="project-filter-control" aria-label="Filter navigator by project"><option value=""${selectedOption(navigatorFilters.project, '')}>All projects</option>${projectOptions.map(([key, name]) => `<option value="${escapeHtml(key)}"${selectedOption(navigatorFilters.project, key)}>${escapeHtml(name)}</option>`).join('')}</select></label>`;
  const stateFilterControl = `<label class="filter-control">Filter: State <select id="state-filter-control" aria-label="Filter navigator by state"><option value=""${selectedOption(navigatorFilters.state, '')}>All states</option><option value="active"${selectedOption(navigatorFilters.state, 'active')}>Active</option><option value="deferred"${selectedOption(navigatorFilters.state, 'deferred')}>Deferred</option><option value="archived"${selectedOption(navigatorFilters.state, 'archived')}>Archived</option></select></label>`;
  const statusFilterControl = plan.reviewMode === 'collaboration' || !kanbanEnabled ? '' : `<label class="filter-control">Filter: Status <select id="status-filter-control" aria-label="Filter navigator by status"><option value=""${selectedOption(navigatorFilters.status, '')}>All statuses</option>${columns.map(column => `<option value="${escapeHtml(column.key)}"${selectedOption(navigatorFilters.status, column.key)}>${escapeHtml(column.label)}</option>`).join('')}</select></label>`;
  return `<section class="plan-nav-filters" aria-label="Filter navigator plans">${projectFilterControl}${stateFilterControl}${statusFilterControl}</section>`;
}

function currentPlanStatusControl(plan: ReturnType<PlanReviewStore['getPlan']>['plan'], allColumns: BoardColumnRecord[]): string {
  if (plan.reviewMode === 'collaboration' || plan.lifecycleState !== 'active') return '';
  const currentKey = plan.boardColumnKey ?? '';
  const statusOptions = allColumns.map(column => `<option value="${escapeHtml(column.key)}"${selectedOption(currentKey, column.key)}>${escapeHtml(column.label)}</option>`).join('');
  return `<label class="current-plan-status-control">Current plan status <select id="current-plan-status-control" aria-label="Current plan status" data-current-value="${escapeHtml(currentKey)}">${statusOptions}</select><span id="current-plan-status-error" class="current-plan-status-error" role="status" hidden></span></label>`;
}

function currentPlanStatusGuidance(plan: ReturnType<PlanReviewStore['getPlan']>['plan']): string {
  if (plan.reviewMode === 'collaboration') return '';
  if (plan.archivedAt) return '<span id="current-plan-status-guidance" class="current-plan-status-guidance">Restore this plan before changing its board status.</span>';
  if (plan.lifecycleState === 'deferred') return '<span id="current-plan-status-guidance" class="current-plan-status-guidance">Resume this plan before changing its board status.</span>';
  return '<span id="current-plan-status-guidance" class="current-plan-status-guidance" hidden></span>';
}

function reviewShell(plan: ReturnType<PlanReviewStore['getPlan']>['plan'], currentTitle: string, shellTitle: string, plans: ListedPlan[], columns: BoardColumnRecord[], projects: PlanProjectRecord[], configuration: AppConfiguration, navigatorFilters = emptyReviewShellNavigatorFilters(), allColumns = columns, planNavigatorOpen = configuration.showPlanNavigatorByDefault, updateStatus?: UpdateStatus): string {
  const escapedPlanId = escapeHtml(plan.id);
  const escapedShellTitle = escapeHtml(shellTitle);
  const escapedCurrentTitle = escapeHtml(currentTitle);
  const isCollaboration = plan.reviewMode === 'collaboration';
  const documentKind = isCollaboration ? 'document' : 'plan';
  const readyLabel = isCollaboration ? 'Collaboration mode' : plan.publicationMetadata?.executionReady ? 'Execution ready' : 'Execution not ready';
  const encodedTitleFallback = escapeHtml(encodeClientData(reviewShellTitle(planTitleFallback(plan))));
  const encodedBoardColumnLabels = escapeHtml(encodeClientData(JSON.stringify(Object.fromEntries(allColumns.map(column => [column.key, column.label])))));
  const reviewButton = isCollaboration ? '' : '<button id="request-execution-review" class="tool-button" type="button" aria-label="Request execution-ready review" title="Request execution-ready review">✓</button>';
  const buildButton = isCollaboration ? '' : '<button id="build-plan" class="tool-button" type="button" aria-label="Build Plan" title="Build Plan">⚒</button>';
  const planNavToggle = `<button id="desktop-plan-nav-toggle" class="tool-button" type="button" aria-controls="plan-list-nav" aria-expanded="${planNavigatorOpen ? 'true' : 'false'}" aria-label="Plan Navigator" title="Plan Navigator">☰</button>`;
  const downloadAction = `<a id="download-raw-plan" class="tool-button download-tool" href="/download/${escapedPlanId}" aria-label="Download raw plan" title="Download raw plan HTML; ZIP includes required assets." download>⬇</a>`;
  const commentsButton = `<button id="desktop-comments-toggle" class="tool-button comments-toggle" type="button" aria-controls="sidebar" aria-expanded="${configuration.showCommentsByDefault ? 'true' : 'false'}" aria-label="${configuration.showCommentsByDefault ? 'Close comments' : 'Open comments'}" title="Comments">💬 <span id="desktop-comments-count" class="comments-count" hidden></span></button>`;
  const indexLink = documentViewSwitcher(undefined, configuration.kanbanEnabled);
  const pinControl = isCollaboration ? '' : `<button id="pin-plan" class="pin-button" type="button" data-pin-plan="${escapedPlanId}" aria-pressed="${plan.pinnedAt ? 'true' : 'false'}" aria-label="${plan.pinnedAt ? 'Unpin plan' : 'Pin plan'}" title="${plan.pinnedAt ? 'Unpin plan' : 'Pin plan'}">${plan.pinnedAt ? '★' : '☆'}</button>`;
  const organizationControls = pinControl;
  const navFilterControls = navigatorFilterControls(plan, columns, projects, navigatorFilters, configuration.kanbanEnabled);
  const currentStatusControl = configuration.kanbanEnabled ? currentPlanStatusControl(plan, allColumns) : '';
  const currentStatusGuidance = configuration.kanbanEnabled ? currentPlanStatusGuidance(plan) : '';
  const archiveLabel = isCollaboration ? 'Archive document' : 'Archive plan';
  const restoreLabel = isCollaboration ? 'Restore document' : 'Restore plan';
  const resumeLabel = isCollaboration ? 'Resume document' : 'Resume plan';
  const deferAction = isCollaboration ? '' : '<button id="defer-plan" class="tool-button" type="button" aria-label="Defer plan" title="Defer plan">⏸</button>';
  const bodyClasses = [planNavigatorOpen ? '' : 'plan-nav-collapsed', configuration.showCommentsByDefault ? 'comments-open' : ''].filter(Boolean).join(' ');
  const bodyClassAttribute = bodyClasses ? ` class="${escapeHtml(bodyClasses)}"` : '';
  const navActions = plan.archivedAt
    ? `${planNavToggle}${indexLink}${organizationControls}${downloadAction}${reviewButton}${buildButton}<span id="archive-status" class="lifecycle-status archived" role="status" aria-label="Status: Archived" title="Archived">Status: Archived</span><button id="restore-plan" class="tool-button" type="button" aria-label="${restoreLabel}" title="${restoreLabel}">↩</button>${configurationToolAction()}${commentsButton}`
    : plan.lifecycleState === 'deferred'
      ? `${planNavToggle}${indexLink}${organizationControls}${downloadAction}${reviewButton}${buildButton}<span id="archive-status" class="lifecycle-status deferred" role="status" aria-label="Status: Deferred" title="Deferred">Deferred</span><button id="resume-plan" class="tool-button" type="button" aria-label="${resumeLabel}" title="${resumeLabel}">▶</button><button id="archive-plan" class="tool-button" type="button" aria-label="${archiveLabel}" title="${archiveLabel}">🗄</button><button id="restore-plan" class="tool-button" type="button" aria-label="${restoreLabel}" title="${restoreLabel}" hidden>↩</button>${configurationToolAction()}${commentsButton}`
      : `${planNavToggle}${indexLink}${organizationControls}${downloadAction}${reviewButton}${buildButton}<span id="archive-status" class="lifecycle-status archived" hidden></span>${deferAction}<button id="archive-plan" class="tool-button" type="button" aria-label="${archiveLabel}" title="${archiveLabel}">🗄</button><button id="restore-plan" class="tool-button" type="button" aria-label="${restoreLabel}" title="${restoreLabel}" hidden>↩</button>${configurationToolAction()}${commentsButton}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapedShellTitle}</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="stylesheet" href="/client.css?v=${clientAssetVersion}">
  </head><body${bodyClassAttribute} data-plan-id="${escapedPlanId}" data-review-mode="${escapeHtml(plan.reviewMode)}" data-plan-title-fallback="${encodedTitleFallback}" data-board-column-labels="${encodedBoardColumnLabels}">
    <nav id="plan-navbar" aria-label="Plan actions"><div id="plan-navbar-actions">${navActions}</div><div id="current-plan-bar"><strong id="current-plan-title">${escapedCurrentTitle}</strong><span class="ready-pill ${isCollaboration || plan.publicationMetadata?.executionReady ? 'ready' : 'not-ready'}">${escapeHtml(readyLabel)}</span>${currentStatusControl}${currentStatusGuidance}<span id="comment-status-banner" class="comment-status-banner" hidden></span></div></nav>
    <div id="app">
      ${planNavigatorHtml(plans, plan.id, isCollaboration ? 'documents' : 'plans', navigatorFilters, navFilterControls, planNavigatorOpen, allColumns)}
      <main id="review"><iframe id="plan-frame" sandbox="allow-same-origin allow-popups" src="/render/${escapedPlanId}"></iframe><div id="plan-touch-layer" aria-hidden="true"></div><button id="mobile-comments-toggle" class="comments-toggle" type="button" aria-controls="sidebar" aria-expanded="false">Comments</button><div id="hover-selection-box" class="selection-box hover" hidden></div><div id="active-selection-box" class="selection-box active" hidden></div></main>
      <aside id="sidebar"><div id="comments-tray-handle" aria-hidden="true"></div><h1>Comments</h1><div id="comments-status-filters" aria-label="Comment status summary"></div><div id="sync-warning" hidden></div><section id="plan-notes-panel"><h2>${isCollaboration ? 'Document notes' : 'Plan notes'}</h2><div id="plan-notes"></div><textarea id="plan-note-body" placeholder="${isCollaboration ? 'Add context for agents' : 'Add a plan note for agents'}"></textarea><button id="add-plan-note" type="button">Add note</button></section><div id="deferred-refresh-notice" hidden>Document updated in the background. Finish or cancel this comment to refresh.</div><div id="comments"></div></aside>
    </div>
    <div id="archive-toast" role="status" aria-label="Archived plan undo toast" hidden><div><strong id="archive-toast-title"></strong><p id="archive-toast-message"></p></div><button id="archive-toast-undo" type="button">Undo</button></div>
    ${runtimeUpdateIndicatorHtml(updateStatus)}
    <div id="quick-open-backdrop" hidden>
      <section id="quick-open-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-open-title" aria-describedby="quick-open-status">
        <div class="quick-open-header"><div><h2 id="quick-open-title">Quick open ${escapeHtml(documentKind)}</h2><p id="quick-open-status">Search all registered documents across lifecycle, columns, readiness, pins, and collaboration docs.</p></div><span class="quick-open-shortcut">⌘O</span></div>
        <input id="quick-open-input" type="search" role="combobox" aria-controls="quick-open-results" aria-expanded="true" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search all documents">
        <div id="quick-open-error" hidden>Plans could not be loaded. <button id="quick-open-retry" type="button">Retry</button></div>
        <div id="quick-open-empty" hidden>No matching documents.</div>
        <div id="quick-open-results" role="listbox" aria-label="Quick open results"><div id="quick-open-result-list"></div></div>
      </section>
    </div>
    <div id="lightbox" class="lightbox" hidden><header><button id="zoom-out">-</button><button id="zoom-reset">Reset</button><button id="zoom-in">+</button><button id="pan-toggle">Pan</button><button id="close-lightbox">Close</button></header><div id="lightbox-stage" class="lightbox-stage"><img id="lightbox-image" alt=""><div id="image-selection-box" hidden></div></div></div>
    <div id="composer" hidden><div id="composer-context" hidden></div><textarea id="comment-body" placeholder="Comment on selection" inputmode="text" enterkeyhint="done" autocapitalize="sentences"></textarea><div id="comment-discard-warning" hidden>Your comment would be lost. Use Cancel to discard it.</div><button id="submit-comment">Submit</button><button id="cancel-comment">Cancel</button></div>
    <script src="/vendor/html2canvas.js"></script>
    <script type="module" src="/client.js?v=${clientAssetVersion}"></script>
  </body></html>`;
}

function resolvedModuleFile(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Plan review comments">
  <defs>
    <linearGradient id="bg" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
      <stop stop-color="#111827"/>
      <stop offset="1" stop-color="#312e81"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#bg)"/>
  <path d="M14 16h34a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H31L19 56v-10h-5a6 6 0 0 1-6-6V22a6 6 0 0 1 6-6z" fill="#7dd3fc"/>
  <path d="M18 27h26M18 35h18" stroke="#0f172a" stroke-width="5" stroke-linecap="round"/>
  <path d="M43 11c7 0 12 5 12 12 0 9-12 22-12 22S31 32 31 23c0-7 5-12 12-12z" fill="#f43f5e" stroke="#fecdd3" stroke-width="3"/>
  <circle cx="43" cy="23" r="4" fill="#fff1f2"/>
</svg>`;

const clientCss = `
body{--plan-nav-width:260px;--comments-width:48px;--plan-navbar-height:86px;margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,sans-serif}body.plan-nav-collapsed{--plan-nav-width:0}body.comments-open{--comments-width:320px}
#plan-navbar{position:sticky;top:0;z-index:30;min-height:86px;box-sizing:border-box;display:grid;grid-template-rows:auto auto;gap:8px;padding:10px 16px;border-bottom:1px solid #2b364d;background:#0f172a}#plan-navbar [hidden]{display:none!important}#plan-navbar-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}#plan-navbar a{color:#7dd3fc;text-decoration:none;font-weight:700}#plan-navbar a.nav-index{margin-right:auto}#plan-navbar .doc-kind-switcher{display:inline-flex;gap:2px;padding:3px;border:1px solid #334155;border-radius:999px;background:#08111f;margin-right:auto}#plan-navbar .doc-kind-seg{border-radius:999px;padding:5px 10px;color:#a7b0c0;font-size:12px;font-weight:850;text-decoration:none;white-space:nowrap}#plan-navbar .doc-kind-seg.active{background:#0ea5e9;color:#e0f2fe}.filter-control{display:inline-flex;align-items:center;gap:5px;border:1px solid #334155;border-radius:8px;background:#111827;padding:3px 6px;color:#cbd5e1;font-size:12px;font-weight:800}.filter-control select{max-width:150px;background:#020617;color:#e5e7eb;border:1px solid #7dd3fc;border-radius:6px;padding:6px 8px}.pin-button{border-color:#facc15!important;color:#fef08a!important}#plan-navbar button,#plan-navbar .tool-button{background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px 10px;cursor:pointer}#plan-navbar button:hover,#plan-navbar .tool-button:hover{border-color:#93c5fd}#plan-navbar .tool-button{display:inline-flex;align-items:center;justify-content:center;min-width:38px;min-height:34px;box-sizing:border-box;line-height:1}.download-tool{border-color:rgba(56,189,248,.72)!important;background:#075985!important;color:#ecfeff!important}#current-plan-bar{display:flex;align-items:center;gap:8px;min-width:0;border-top:1px solid rgba(71,85,105,.55);padding-top:8px;color:#cbd5e1}#current-plan-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f8fafc}.lifecycle-status{display:inline-flex;align-items:center;justify-content:center;color:#cbd5e1;border:1px solid #475569;background:#111827;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:850;line-height:1;white-space:nowrap;cursor:default;pointer-events:none}.lifecycle-status.archived{border-color:#64748b;color:#e2e8f0}.lifecycle-status.deferred{border-color:#f59e0b;color:#fde68a;background:rgba(120,53,15,.35)}#archive-status[hidden]{display:none}.current-plan-status-guidance{margin-left:auto;color:#a7b0c0;font-size:12px;font-weight:800}.current-plan-status-control+.current-plan-status-guidance{margin-left:0}#restore-plan{border-color:#22c55e;color:#bbf7d0}.comments-toggle{display:inline-flex;align-items:center;gap:6px}.comments-count{min-width:18px;height:18px;border-radius:999px;background:#7e22ce;color:white;display:inline-grid;place-items:center;padding:0 5px;font-size:11px;font-weight:900}.comment-status-banner{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:800;border:1px solid #475569;background:#1e293b;color:#cbd5e1;white-space:nowrap}.comment-status-banner.red{border-color:rgba(251,113,133,.7);background:rgba(127,29,29,.55);color:#fecaca}.comment-status-banner.yellow{border-color:rgba(234,179,8,.7);background:rgba(120,53,15,.55);color:#fde68a}.comment-status-banner.green{border-color:rgba(34,197,94,.7);background:rgba(22,101,52,.55);color:#dcfce7}
#app{display:grid;grid-template-columns:var(--plan-nav-width) minmax(0,1fr) var(--comments-width);min-height:calc(100vh - var(--plan-navbar-height));transition:grid-template-columns .18s ease}
.current-plan-status-control{display:inline-flex;align-items:center;gap:6px;margin-left:auto;color:#cbd5e1;font-size:12px;font-weight:850}.current-plan-status-control select{background:#020617;color:#e5e7eb;border:1px solid #7dd3fc;border-radius:6px;padding:6px 8px}.current-plan-status-error{color:#fecaca;font-size:12px;font-weight:800}
#plan-list-nav{grid-column:1;align-self:start;position:sticky;top:var(--plan-navbar-height);height:calc(100vh - var(--plan-navbar-height));box-sizing:border-box;border-right:1px solid #2b364d;background:#0b1220;padding:14px;overflow:auto}body.plan-nav-collapsed #plan-list-nav{padding:0;border-right:0;overflow:hidden}body.plan-nav-collapsed #plan-list-nav>*{visibility:hidden}#plan-list-nav h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#a7b0c0;margin:0}.plan-list-header{display:flex;align-items:center;justify-content:space-between;gap:8px}.plan-nav-filters{display:grid;gap:8px;margin:12px 0 14px;padding:10px;border:1px solid #253248;border-radius:12px;background:#08111f}.plan-nav-filters .filter-control{display:grid;gap:5px;align-items:stretch}.plan-nav-filters .filter-control select{width:100%;max-width:none}.plan-list-error{border:1px solid #f59e0b;background:rgba(245,158,11,.12);color:#fde68a;border-radius:8px;padding:8px;margin:10px 0;font-size:13px}.plan-list-empty{color:#a7b0c0;font-size:13px}.plan-nav-item{display:grid;gap:5px;padding:10px;margin:8px 0;border:1px solid #253248;border-radius:10px;background:#101827;color:#cbd5e1;text-decoration:none}.plan-nav-item:hover{border-color:#64748b}.plan-nav-item.active{border-color:#38bdf8;background:linear-gradient(135deg,rgba(14,165,233,.18),rgba(16,24,39,.95))}.plan-nav-item.attention{border-color:#f59e0b}.plan-nav-title{font-size:13px;font-weight:850;color:#f8fafc;line-height:1.25}.plan-nav-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;color:#a7b0c0;font-size:11px}.plan-nav-submeta{color:#8fa0b8;font-size:11px}.plan-nav-pill{border:1px solid #475569;border-radius:999px;padding:1px 6px;background:#0b1220}.plan-nav-pill.ready{border-color:#22c55e;color:#bbf7d0}.plan-nav-pill.not-ready{border-color:#f59e0b;color:#fde68a}
#review{grid-column:2;position:relative;min-width:0}#sidebar{grid-column:3;grid-row:1;align-self:start;position:sticky;top:var(--plan-navbar-height);height:calc(100vh - var(--plan-navbar-height));box-sizing:border-box;border-left:1px solid #2b364d;padding:0;background:#111827;overflow:hidden}#sidebar>h1,#sidebar>#sync-warning,#sidebar>#plan-notes-panel,#sidebar>#deferred-refresh-notice,#sidebar>#comments{display:none}body.comments-open #sidebar{padding:16px;overflow:auto}body.comments-open #sidebar>h1,body.comments-open #sidebar>#sync-warning,body.comments-open #sidebar>#plan-notes-panel,body.comments-open #sidebar>#deferred-refresh-notice,body.comments-open #sidebar>#comments{display:block}
#plan-touch-layer{display:none;position:absolute;top:0;left:0;width:100%;min-height:100%;z-index:22;background:transparent;pointer-events:none}
#plan-frame{width:100%;min-height:calc(100vh - var(--plan-navbar-height));border:0;background:white;display:block}.selection-box,.comment-anchor{position:fixed;pointer-events:none;border-radius:6px;transition:left .22s cubic-bezier(.2,0,.2,1),top .22s cubic-bezier(.2,0,.2,1),width .22s cubic-bezier(.2,0,.2,1),height .22s cubic-bezier(.2,0,.2,1),opacity .14s ease}.selection-box{z-index:8;box-sizing:border-box;background:transparent;box-shadow:none}.selection-box.hover{border:2px dotted rgba(56,189,248,.82)}.selection-box.active{z-index:9;border:2px dotted #38bdf8;box-shadow:0 0 0 1px rgba(255,255,255,.72)}.comment-anchor{z-index:7}.comment-anchor.pending{border:2px dotted rgba(192,132,252,.95);background:transparent;box-shadow:0 0 0 3px rgba(168,85,247,.08)}.comment-anchor.claimed{border:2px dotted rgba(234,179,8,.95);background:transparent;box-shadow:0 0 0 3px rgba(234,179,8,.10)}.comment-anchor.acknowledged{border:2px dotted rgba(34,197,94,.95);background:transparent;box-shadow:0 0 0 3px rgba(34,197,94,.10)}.comment-anchor.resolved{border:2px dotted rgba(59,130,246,.9);background:transparent;box-shadow:none}.comment-anchor-label{position:absolute;right:-10px;top:-12px;min-width:24px;height:24px;border-radius:999px;display:grid;place-items:center;padding:0 6px;font-weight:800;font-size:12px;box-shadow:0 8px 18px rgba(0,0,0,.35)}.comment-anchor.pending .comment-anchor-label{background:#a855f7;color:white;border:2px solid #e9d5ff}.comment-anchor.claimed .comment-anchor-label{background:#eab308;color:#1c1206;border:2px solid #fef08a}.comment-anchor.acknowledged .comment-anchor-label{background:#22c55e;color:white;border:2px solid #bbf7d0}.comment-anchor.resolved .comment-anchor-label{background:#3b82f6;color:white;border:2px solid #bfdbfe}.comment-row{border:1px solid #2b364d;padding:10px;margin:8px 0;border-radius:8px;background:#0f172a}.comment-row small{color:#a7b0c0}.marker{position:absolute;z-index:9;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:#0ea5e9;color:white;border:2px solid #dbeafe;font-weight:700;box-shadow:0 8px 18px rgba(0,0,0,.35);pointer-events:none}
#archive-toast{position:fixed;top:12px;right:16px;width:min(520px,calc(100vw - 32px));z-index:65;display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #38bdf8;border-radius:14px;background:rgba(15,23,42,.97);color:#e5e7eb;padding:12px 14px;box-shadow:0 18px 50px rgba(2,6,23,.64)}#archive-toast[hidden]{display:none}#archive-toast strong{color:#f8fafc}#archive-toast p{margin:2px 0 0;color:#a7b0c0;font-size:13px}#archive-toast button{border:2px solid #86efac;border-radius:10px;background:linear-gradient(180deg,#22c55e,#15803d);color:#052e16;padding:10px 18px;font-weight:950;box-shadow:0 0 0 3px rgba(34,197,94,.18),0 10px 24px rgba(21,128,61,.38);cursor:pointer}#archive-toast.error{border-color:#fb7185}#archive-toast.error button{display:none}#comments-tray-handle,#comments-status-filters{display:none}.comment-jump{margin-top:8px;min-height:34px;border:1px solid #475569;border-radius:999px;background:#1e293b;color:#dbeafe;padding:6px 10px;font-weight:800;cursor:pointer}#sync-warning{border:1px solid #f59e0b;background:rgba(245,158,11,.12);color:#fde68a;border-radius:8px;padding:10px;margin:8px 0 14px;font-size:13px}#deferred-refresh-notice{border:1px solid #38bdf8;background:rgba(56,189,248,.12);color:#bae6fd;border-radius:8px;padding:10px;margin:8px 0 14px;font-size:13px}#composer{position:fixed;right:calc(var(--comments-width) + 20px);top:calc(var(--plan-navbar-height) + 26px);background:#0f172a;border:1px solid #38bdf8;padding:12px;border-radius:8px;z-index:60;box-shadow:0 12px 32px rgba(0,0,0,.4)}#composer.discard-warning{border-color:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22),0 12px 32px rgba(0,0,0,.4)}
#composer-context{max-width:300px;margin:0 0 10px;border-left:3px solid #38bdf8;border-radius:8px;background:rgba(56,189,248,.12);color:#e0f2fe;padding:8px 10px;font-size:13px;line-height:1.35}#comment-discard-warning{margin-top:8px;color:#fecaca;font-size:13px;font-weight:700}#composer.discard-warning textarea{border-color:#ef4444}
#composer textarea{width:260px;height:90px;background:#020617;color:#e5e7eb;border:1px solid #2b364d;border-radius:6px;padding:8px;display:block;pointer-events:auto;touch-action:manipulation;-webkit-user-select:text;user-select:text}
#composer button{margin-top:8px;margin-right:8px}#plan-notes-panel{border:1px solid #2b364d;border-radius:10px;background:#0f172a;padding:10px;margin:0 0 14px}#plan-notes-panel h2{font-size:15px;margin:0 0 8px}#plan-notes .note-row{border-top:1px solid #263246;padding:8px 0}#plan-notes .note-row:first-child{border-top:0}#plan-note-body{width:100%;min-height:70px;box-sizing:border-box;background:#020617;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px}#add-plan-note{margin-top:8px;background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px 10px;cursor:pointer}.plan-review-selected{outline:2px dotted #38bdf8!important;box-shadow:none!important}#quick-open-backdrop{position:fixed;inset:0;z-index:70;display:grid;align-items:start;justify-items:center;padding-top:min(12vh,96px);background:rgba(2,6,23,.46)}#quick-open-backdrop[hidden]{display:none}#quick-open-dialog{width:min(680px,calc(100vw - 36px));max-height:min(78vh,720px);display:grid;grid-template-rows:auto auto auto auto minmax(0,1fr);overflow:hidden;border:1px solid #38bdf8;border-radius:16px;background:#0f172a;color:#e5e7eb;box-shadow:0 30px 90px rgba(2,6,23,.68)}.quick-open-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px 10px}.quick-open-header h2{margin:0;color:#f8fafc;font-size:18px}.quick-open-header p{margin:4px 0 0;color:#a7b0c0;font-size:13px}.quick-open-shortcut{border:1px solid #475569;border-bottom-color:#64748b;border-radius:7px;background:#111827;color:#dbeafe;padding:2px 8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:800}#quick-open-input{margin:0 18px 14px;width:calc(100% - 36px);box-sizing:border-box;border:1px solid #475569;border-radius:10px;background:#020617;color:#e5e7eb;padding:12px 14px;font:16px system-ui,sans-serif;outline:none}#quick-open-input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.18)}#quick-open-error,#quick-open-empty{margin:0 18px 12px;border-radius:10px;padding:10px 12px;font-size:13px}#quick-open-error{border:1px solid #f59e0b;background:rgba(245,158,11,.12);color:#fde68a}#quick-open-error button{margin-left:8px;border:1px solid #f59e0b;border-radius:6px;background:#1e293b;color:#fde68a;padding:4px 8px;cursor:pointer}#quick-open-empty{border:1px solid #475569;background:#111827;color:#a7b0c0}#quick-open-results{overflow:auto;border-top:1px solid #2b364d}#quick-open-result-list{padding:6px}.quick-open-result{display:grid;gap:3px;width:100%;box-sizing:border-box;text-align:left;border:1px solid transparent;border-radius:10px;background:transparent;color:#cbd5e1;padding:11px 12px;cursor:pointer}.quick-open-result:hover,.quick-open-result.active{border-color:#38bdf8;background:rgba(56,189,248,.14)}.quick-open-result-title{font-weight:850;color:#f8fafc;line-height:1.25}.quick-open-result-meta{font-size:12px;color:#a7b0c0}.lightbox{position:fixed;inset:36px calc(var(--comments-width) + 40px) 36px 36px;background:#020617;border:1px solid #38bdf8;z-index:50;display:grid;grid-template-rows:auto 1fr}.lightbox[hidden]{display:none}.lightbox header{display:flex;gap:8px;padding:10px;border-bottom:1px solid #2b364d}.lightbox img{max-width:100%;max-height:100%;place-self:center;transform-origin:center}.lightbox-stage{display:grid;overflow:hidden;position:relative}#image-selection-box{position:absolute;border:2px solid #38bdf8;background:rgba(56,189,248,.2);pointer-events:none}#mobile-comments-toggle{display:none}
@media(prefers-reduced-motion:reduce){.selection-box{transition:none}}
@media(max-width:760px),(pointer:coarse){body{overflow:hidden;--comments-width:0;--plan-navbar-height:88px}#plan-navbar{position:sticky;top:0;z-index:30;min-height:88px;box-sizing:border-box;gap:6px;padding:8px;overflow-x:auto;overscroll-behavior-x:contain}#plan-navbar-actions{justify-content:flex-start;gap:8px}#plan-navbar a,#plan-navbar button{flex:0 0 auto;min-height:40px;padding:8px 10px;font-size:13px;line-height:1.15;white-space:normal}#current-plan-bar{font-size:13px}#request-execution-review{max-width:170px}#build-plan{max-width:120px}#plan-navbar #desktop-plan-nav-toggle,#desktop-comments-toggle{display:none}#app{display:block;min-height:calc(100dvh - var(--plan-navbar-height))}#plan-list-nav{display:none}#review{height:calc(100dvh - var(--plan-navbar-height));overflow-y:auto;overscroll-behavior-y:contain;overflow-x:hidden;-webkit-overflow-scrolling:touch}#plan-frame{width:100%;min-height:calc(100dvh - var(--plan-navbar-height));border:0;display:block;pointer-events:none}#plan-touch-layer{display:block;position:absolute;top:0;left:0;width:100%;min-height:calc(100dvh - var(--plan-navbar-height));z-index:22;background:transparent;touch-action:pan-y;pointer-events:auto}#sidebar{position:fixed;left:0;right:0;bottom:0;top:auto;z-index:24;height:auto;max-height:min(72dvh,620px);box-sizing:border-box;border-left:0;border-top:1px solid #2b364d;border-radius:18px 18px 0 0;padding:12px 16px calc(16px + env(safe-area-inset-bottom));background:#111827;box-shadow:0 -16px 40px rgba(0,0,0,.45);overflow:auto;transform:translateY(100%);transition:transform .18s ease}#sidebar>h1,#sidebar>#sync-warning,#sidebar>#plan-notes-panel,#sidebar>#deferred-refresh-notice,#sidebar>#comments{display:block}body.comments-open #sidebar{transform:translateY(0)}#comments-tray-handle{display:block;width:44px;height:5px;border-radius:999px;background:#475569;margin:0 auto 10px}#comments-status-filters{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}.comment-status-chip{border:1px solid #475569;border-radius:999px;background:#0b1220;color:#dbeafe;padding:6px 9px;font-size:12px;font-weight:850}.comment-jump{min-height:44px}.comment-row-header{display:flex;align-items:center;justify-content:space-between;gap:8px}#sidebar h1{position:sticky;top:-12px;margin:0 0 12px;padding:8px 0 10px;background:#111827;font-size:20px;z-index:1}.comment-row{padding:12px;margin:10px 0}.comment-row p{margin:.55rem 0}.comments-empty{margin:0;color:#a7b0c0;font-size:14px}#mobile-comments-toggle{display:flex;position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:25;min-height:44px;align-items:center;gap:6px;border:1px solid #38bdf8;border-radius:999px;background:#075985;color:#e0f2fe;padding:0 14px;font-weight:800;box-shadow:0 12px 28px rgba(0,0,0,.35)}body.comments-open #mobile-comments-toggle{background:#0f172a;border-color:#64748b}#quick-open-backdrop{padding-top:18px;align-items:start}#quick-open-dialog{width:calc(100vw - 24px);max-height:calc(100dvh - 36px)}#composer{left:0;right:0;bottom:0;top:auto;z-index:60;box-sizing:border-box;border-left:0;border-right:0;border-bottom:0;border-radius:18px 18px 0 0;padding:14px 16px calc(16px + env(safe-area-inset-bottom));box-shadow:0 -16px 40px rgba(0,0,0,.48)}#composer-context{max-width:none;font-size:14px}#composer textarea{width:100%;height:122px;box-sizing:border-box;font-size:16px}#composer button{min-height:44px;padding:8px 12px}.lightbox{inset:0;z-index:50;border:0}.lightbox header{flex-wrap:wrap}.selection-box{border-radius:4px}.marker{width:28px;height:28px}}
${runtimeUpdateIndicatorStyles()}`;

const clientJs = `
import { finder } from '/vendor/finder.js';
import { Washi } from '/vendor/washi.js';
import mermaid from '/vendor/mermaid.esm.min.mjs';

const planId = document.body.dataset.planId;
const isCollaborationMode = document.body.dataset.reviewMode === 'collaboration';
const documentKind = isCollaborationMode ? 'document' : 'plan';
const navigatorItemNoun = isCollaborationMode ? 'documents' : 'plans';
let planTitleFallback = 'Plan Review';
try {
  const bytes = Uint8Array.from(atob(document.body.dataset.planTitleFallback || ''), char => char.charCodeAt(0));
  const decodedTitleFallback = new TextDecoder().decode(bytes) || planTitleFallback;
  planTitleFallback = decodedTitleFallback.replace(/\s+·\s+Plan Review$/i, '').trim() || decodedTitleFallback;
} catch {}
const boardColumnLabels = new Map();
try {
  const bytes = Uint8Array.from(atob(document.body.dataset.boardColumnLabels || ''), char => char.charCodeAt(0));
  const labels = JSON.parse(new TextDecoder().decode(bytes) || '{}');
  Object.entries(labels).forEach(([key, label]) => boardColumnLabels.set(key, String(label)));
} catch {}
const frame = document.getElementById('plan-frame');
const planNavbar = document.getElementById('plan-navbar');
const planTouchLayer = document.getElementById('plan-touch-layer');
const archivePlanButton = document.getElementById('archive-plan');
const restorePlanButton = document.getElementById('restore-plan');
const deferPlanButton = document.getElementById('defer-plan');
const resumePlanButton = document.getElementById('resume-plan');
const pinPlanButton = document.getElementById('pin-plan');
const projectFilterControl = document.getElementById('project-filter-control');
const stateFilterControl = document.getElementById('state-filter-control');
const statusFilterControl = document.getElementById('status-filter-control');
const currentPlanStatusControl = document.getElementById('current-plan-status-control');
const currentPlanStatusError = document.getElementById('current-plan-status-error');
const executionReviewButton = document.getElementById('request-execution-review');
const buildPlanButton = document.getElementById('build-plan');
const planNotes = document.getElementById('plan-notes');
const planNoteBody = document.getElementById('plan-note-body');
const addPlanNoteButton = document.getElementById('add-plan-note');
const composer = document.getElementById('composer');
const composerContext = document.getElementById('composer-context');
const body = document.getElementById('comment-body');
const discardWarning = document.getElementById('comment-discard-warning');
const submitCommentButton = document.getElementById('submit-comment');
const cancelCommentButton = document.getElementById('cancel-comment');
const comments = document.getElementById('comments');
const commentsStatusFilters = document.getElementById('comments-status-filters');
const mobileCommentsToggle = document.getElementById('mobile-comments-toggle');
const desktopPlanNavToggle = document.getElementById('desktop-plan-nav-toggle');
const desktopCommentsToggle = document.getElementById('desktop-comments-toggle');
const desktopCommentsCount = document.getElementById('desktop-comments-count');
const downloadRawPlan = document.getElementById('download-raw-plan');
const appShell = document.getElementById('app');
const planListNav = document.getElementById('plan-list-nav');
const planListItems = document.getElementById('plan-list-items');
const planListError = document.getElementById('plan-list-error');
const planListRetry = document.getElementById('plan-list-retry');
const quickOpenBackdrop = document.getElementById('quick-open-backdrop');
const quickOpenDialog = document.getElementById('quick-open-dialog');
const quickOpenInput = document.getElementById('quick-open-input');
const quickOpenStatus = document.getElementById('quick-open-status');
const quickOpenError = document.getElementById('quick-open-error');
const quickOpenRetry = document.getElementById('quick-open-retry');
const quickOpenEmpty = document.getElementById('quick-open-empty');
const quickOpenResults = document.getElementById('quick-open-results');
const quickOpenResultList = document.getElementById('quick-open-result-list');
const archiveToast = document.getElementById('archive-toast');
const archiveToastTitle = document.getElementById('archive-toast-title');
const archiveToastMessage = document.getElementById('archive-toast-message');
const archiveToastUndo = document.getElementById('archive-toast-undo');
const syncWarning = document.getElementById('sync-warning');
const deferredRefreshNotice = document.getElementById('deferred-refresh-notice');
const hoverSelectionBox = document.getElementById('hover-selection-box');
const activeSelectionBox = document.getElementById('active-selection-box');
const lightbox = document.getElementById('lightbox');
const lightboxImage = document.getElementById('lightbox-image');
const lightboxStage = document.getElementById('lightbox-stage');
const imageSelectionBox = document.getElementById('image-selection-box');
let hovered = null;
let selected = null;
let selectedForScreenshot = null;
let pendingAnchor = null;
let pendingCommentMutationId = null;
let submitInFlight = false;
let pendingDeleteError = null;
let markerCount = 0;
let markerComments = [];
let renderedComments = [];
let markerReflowQueued = false;
let selectionBoxReflowQueued = false;
let zoom = 1;
let panX = 0;
let panY = 0;
let panMode = false;
let versionId = null;
let loadMetaGeneration = 0;
let planRefreshGeneration = 0;
let latestEventSequence = 0;
let eventPollingStarted = false;
let eventPollTimer = null;
let eventPollController = null;
let eventPollInFlight = false;
let eventPollStopped = false;
let eventPollBackoffMs = 1000;
let metadataLoadPromise = null;
let metadataLoadTimer = null;
let pendingMetaOptions = null;
let deferredPlanRefresh = null;
let lightboxDragStart = null;
let lightboxPanStart = null;
let touchStart = null;
let wideScrollTouch = null;
let pointerStart = null;
let suppressSyntheticClickUntil = 0;
let washi = null;
let mermaidInitialized = false;
let mermaidRenderGeneration = 0;
let navigatorItems = [];
let navigatorLoadError = null;
let navigatorLoadGeneration = 0;
let quickOpenItems = [];
let quickOpenLoadGeneration = 0;
let quickOpenLoadPromise = null;
let quickOpenLoadError = null;
let navigatorFilterLoadPromise = null;
let navigatorFilterLoadUrl = '';
let localPlanArchived = false;
let quickOpenMatches = [];
let quickOpenActiveIndex = 0;
let quickOpenPreviousFocus = null;
// Must match the CSS mobile layout media query exactly: the overlay tap surface
// and #review native-scroll layout (and the iframe-to-content-height sizing in
// syncFrameHeight) activate on narrow widths OR any coarse-pointer device. iPad
// and phone landscape are wider than 760px but still coarse-pointer, so keying
// off width alone left the iframe unsized and the lower plan content unreachable.
function isMobileShell(){ return window.matchMedia('(max-width: 760px), (pointer: coarse)').matches; }
function debugTouch(label, data = {}){
}
const passiveTouchCapture = { capture: true, passive: true };
function updatePlanNavbarHeight(){
  if (!planNavbar) return;
  const height = Math.ceil(planNavbar.getBoundingClientRect().height);
  if (height <= 0) return;
  const next = height + 'px';
  if (document.body.style.getPropertyValue('--plan-navbar-height') === next) return;
  document.body.style.setProperty('--plan-navbar-height', next);
  scheduleMarkerReflow();
}
updatePlanNavbarHeight();
if (typeof ResizeObserver === 'function' && planNavbar) {
  new ResizeObserver(updatePlanNavbarHeight).observe(planNavbar);
}
function updateCommentsToggles(){
  const count = Number(mobileCommentsToggle?.dataset.commentCount || desktopCommentsToggle?.dataset.commentCount || '0');
  const open = document.body.classList.contains('comments-open');
  if (mobileCommentsToggle) {
    const statusText = mobileCommentsToggle.dataset.commentStatusText || (count ? 'Comments (' + count + ')' : 'Comments');
    mobileCommentsToggle.textContent = open ? 'Close comments' : statusText;
    mobileCommentsToggle.setAttribute('aria-expanded', String(open));
  }
  if (desktopCommentsToggle) {
    desktopCommentsToggle.setAttribute('aria-expanded', String(open));
    desktopCommentsToggle.setAttribute('aria-label', open ? 'Close comments' : 'Open comments');
    if (desktopCommentsCount) {
      desktopCommentsCount.hidden = count === 0;
      desktopCommentsCount.textContent = String(count);
    }
  }
}
function hasLayoutSensitiveOverlays(){
  return markerComments.length > 0 || Boolean(selected) || Boolean(hovered) || Boolean(pendingAnchor);
}
function reflowAfterShellTransition(){
  let reflowed = false;
  let fallback;
  const onTransitionEnd = event => {
    if (event.target !== appShell || event.propertyName !== 'grid-template-columns') return;
    reflowOnce();
  };
  const reflowOnce = () => {
    if (reflowed) return;
    reflowed = true;
    appShell?.removeEventListener('transitionend', onTransitionEnd);
    clearTimeout(fallback);
    reflowAfterContentChange();
  };
  fallback = setTimeout(reflowOnce, 260);
  appShell?.addEventListener('transitionend', onTransitionEnd);
}
function updatePlanNavToggle(){
  const open = !document.body.classList.contains('plan-nav-collapsed');
  if (!desktopPlanNavToggle) return;
  desktopPlanNavToggle.setAttribute('aria-expanded', String(open));
  desktopPlanNavToggle.setAttribute('aria-label', 'Plan Navigator');
  desktopPlanNavToggle.setAttribute('title', 'Plan Navigator');
}
function updateDownloadLink(){
  if (!downloadRawPlan) return;
  const suffix = versionId ? '?versionId=' + encodeURIComponent(versionId) : '';
  downloadRawPlan.setAttribute('href', '/download/' + encodeURIComponent(planId) + suffix);
}
const planNavStateCookieName = 'plan_review_plan_nav';
function writePlanNavSessionState(open){
  document.cookie = planNavStateCookieName + '=' + (open ? 'open' : 'closed') + '; Path=/; SameSite=Lax';
}
function syncPlanNavAccessibility(){
  const open = !document.body.classList.contains('plan-nav-collapsed');
  if (planListNav) {
    planListNav.inert = !open;
    planListNav.setAttribute('aria-hidden', String(!open));
  }
  updatePlanNavToggle();
}
function setPlanNavOpen(open){
  document.body.classList.toggle('plan-nav-collapsed', !open);
  syncPlanNavAccessibility();
  reflowAfterShellTransition();
}
function initializePlanNavState(){
  syncPlanNavAccessibility();
}
function setCommentsOpen(open){
  document.body.classList.toggle('comments-open', open);
  updateCommentsToggles();
  reflowAfterShellTransition();
}
function newCommentMutationId(){
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'comment-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
function ensurePendingCommentMutationId(){
  if (!pendingCommentMutationId) pendingCommentMutationId = newCommentMutationId();
  return pendingCommentMutationId;
}
function setSubmitInFlight(value){
  submitInFlight = value;
  if (submitCommentButton) submitCommentButton.disabled = value;
}
function updateComposerContext(){
  if (!composerContext) return;
  const anchor = pendingAnchor?.anchor || {};
  const heading = Array.isArray(anchor.headingPath) && anchor.headingPath.length ? anchor.headingPath[anchor.headingPath.length - 1] : '';
  const quote = String(anchor.textQuote?.exact || anchor.selectedText || anchor.textPreview || '').replace(/\s+/g, ' ').trim();
  const diagram = anchor.diagram?.elementLabel ? 'Mermaid: ' + anchor.diagram.elementLabel : '';
  const image = anchor.sourceUrl || anchor.imageAssetId ? 'Image: ' + String(anchor.sourceUrl || anchor.imageAssetId).split('/').pop().slice(0, 120) : '';
  const context = [heading && 'Section: ' + heading, quote && 'Selected: “' + quote.slice(0, 140) + (quote.length > 140 ? '…' : '') + '”', image, diagram].filter(Boolean).join(' · ');
  composerContext.textContent = context;
  composerContext.hidden = !context;
}
function showComposer(){
  if (pendingAnchor) ensurePendingCommentMutationId();
  if (isMobileShell()) setCommentsOpen(false);
  updateComposerContext();
  composer.hidden = false;
  body.focus();
}
function focusCommentBody(event){
  event?.stopPropagation?.();
  body.focus({ preventScroll: true });
}
body.addEventListener('touchstart', focusCommentBody, passiveTouchCapture);
body.addEventListener('pointerdown', focusCommentBody, { capture: true });
body.addEventListener('click', focusCommentBody, { capture: true });
submitCommentButton?.addEventListener('touchstart', event => event.stopPropagation(), passiveTouchCapture);
cancelCommentButton?.addEventListener('touchstart', event => event.stopPropagation(), passiveTouchCapture);
mobileCommentsToggle?.addEventListener('click', () => {
  setCommentsOpen(!document.body.classList.contains('comments-open'));
});
desktopPlanNavToggle?.addEventListener('click', () => {
  const open = document.body.classList.contains('plan-nav-collapsed');
  setPlanNavOpen(open);
  writePlanNavSessionState(open);
});
desktopCommentsToggle?.addEventListener('click', () => {
  setCommentsOpen(!document.body.classList.contains('comments-open'));
});
initializePlanNavState();
setCommentsOpen(!isMobileShell() && document.body.classList.contains('comments-open'));
updateDownloadLink();
let archiveToastTimer = null;
let archiveToastDismissHandlers = [];
function stopArchiveToastDismissal(){
  if (archiveToastTimer) clearTimeout(archiveToastTimer);
  archiveToastTimer = null;
  archiveToastDismissHandlers.forEach(([target, type, handler, options]) => target.removeEventListener(type, handler, options));
  archiveToastDismissHandlers = [];
}
function dismissArchiveToast(){
  stopArchiveToastDismissal();
  archiveToast?.setAttribute('hidden', '');
  archiveToast?.classList.remove('error');
}
function addArchiveToastDismissTarget(target, type, handler, options = true){
  if (!target) return;
  target.addEventListener(type, handler, options);
  archiveToastDismissHandlers.push([target, type, handler, options]);
}
function addArchiveToastDismissListeners(){
  const dismiss = event => {
    if (archiveToast?.contains(event.target)) return;
    dismissArchiveToast();
  };
  const dismissOnEscape = event => {
    if (event.key === 'Escape') dismissArchiveToast();
  };
  addArchiveToastDismissTarget(document, 'click', dismiss, true);
  addArchiveToastDismissTarget(document, 'pointerdown', dismiss, true);
  addArchiveToastDismissTarget(document, 'touchstart', dismiss, passiveTouchCapture);
  addArchiveToastDismissTarget(document, 'keydown', dismissOnEscape, true);
  addArchiveToastDismissTarget(window, 'scroll', dismiss, { passive: true });
  addArchiveToastDismissTarget(document.getElementById('review'), 'scroll', dismiss, { passive: true });
  addArchiveToastDismissTarget(planTouchLayer, 'click', dismiss, true);
  addArchiveToastDismissTarget(planTouchLayer, 'touchstart', dismiss, passiveTouchCapture);
  try {
    const doc = frame?.contentDocument;
    addArchiveToastDismissTarget(doc, 'click', dismiss, true);
    addArchiveToastDismissTarget(doc, 'scroll', dismiss, { passive: true });
  } catch {}
}
function setArchivedShellState(archived){
  const status = document.getElementById('archive-status');
  if (status) {
    status.hidden = !archived;
    status.textContent = archived ? 'Status: Archived' : '';
    status.className = archived ? 'lifecycle-status archived' : 'lifecycle-status archived';
    if (archived) {
      status.setAttribute('role', 'status');
      status.setAttribute('aria-label', 'Status: Archived');
      status.setAttribute('title', 'Archived');
    } else {
      status.removeAttribute('role');
      status.removeAttribute('aria-label');
      status.removeAttribute('title');
    }
  }
  const statusControlLabel = currentPlanStatusControl?.closest('.current-plan-status-control');
  if (statusControlLabel) statusControlLabel.hidden = archived;
  const statusGuidance = document.getElementById('current-plan-status-guidance');
  if (statusGuidance) {
    statusGuidance.hidden = !archived;
    statusGuidance.textContent = archived ? 'Restore this plan before changing its board status.' : '';
  }
  if (archived && stateFilterControl && selectHasValue(stateFilterControl, 'archived')) {
    stateFilterControl.value = 'archived';
    syncNavigatorFilterUrl();
  }
  if (archivePlanButton) { archivePlanButton.hidden = archived; archivePlanButton.disabled = false; }
  if (deferPlanButton) deferPlanButton.hidden = archived;
  if (resumePlanButton) resumePlanButton.hidden = true;
  if (restorePlanButton) { restorePlanButton.hidden = !archived; restorePlanButton.disabled = false; }
}
function mergePlanIntoItems(items, updatedPlan){
  if (!updatedPlan?.id) return items;
  return items.map(item => String(item?.plan?.id || '') === String(updatedPlan.id) ? { ...item, plan: { ...item.plan, ...updatedPlan } } : item);
}
function activeNavigatorItems(items){
  const filters = currentNavigatorFilters();
  return localPlanArchived && filters.state === 'active' ? items.filter(item => String(item?.plan?.id || '') !== String(planId)) : items;
}
function removeCurrentPlanFromRenderedNavigator(){
  planListItems?.querySelector('[data-plan-id="'+CSS.escape(String(planId))+'"]')?.remove();
}
function reconcileActiveNavigation(archived){
  localPlanArchived = archived;
  navigatorItems = activeNavigatorItems(navigatorItems);
  quickOpenItems = activeNavigatorItems(quickOpenItems);
  if (archived && currentNavigatorFilters().state !== 'archived') removeCurrentPlanFromRenderedNavigator();
  else renderPlanNavigatorItems(navigatorItems, navigatorItemNoun);
  if (quickOpenVisible()) renderQuickOpenResults();
}
function restartArchiveToastDismissal(delay = 10000){
  archiveToastTimer = setTimeout(dismissArchiveToast, delay);
  setTimeout(addArchiveToastDismissListeners, 0);
}
function showArchiveToast(message, options = {}){
  dismissArchiveToast();
  if (!archiveToast) return;
  archiveToast.classList.toggle('error', Boolean(options.error));
  archiveToast.setAttribute('aria-label', options.error ? 'Archive error' : 'Archived '+documentKind+' undo toast');
  if (archiveToastTitle) archiveToastTitle.textContent = message;
  if (archiveToastMessage) archiveToastMessage.textContent = options.error ? 'Check the service and try Archive again.' : 'Undo is available for 10 seconds. It clears when you keep working.';
  if (archiveToastUndo) archiveToastUndo.disabled = false;
  archiveToast.hidden = false;
  if (!options.error) archiveToastUndo?.focus({ preventScroll: true });
  restartArchiveToastDismissal(options.error ? 6000 : 10000);
}
archiveToastUndo?.addEventListener('click', async event => {
  event.stopPropagation();
  stopArchiveToastDismissal();
  archiveToastUndo.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive', { method: 'POST' }).catch(() => null);
  if (!res?.ok) {
    archiveToastUndo.disabled = false;
    if (archiveToastMessage) archiveToastMessage.textContent = 'Undo failed. The '+documentKind+' remains archived; use Archived '+documentKind+'s to restore it.';
    restartArchiveToastDismissal();
    return;
  }
  window.location.reload();
});
archivePlanButton?.addEventListener('click', async () => {
  archivePlanButton.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/archive', { method: 'POST' }).catch(() => null);
  if (!res?.ok) {
    archivePlanButton.disabled = false;
    showArchiveToast('Unable to archive '+documentKind+'.', { error: true });
    return;
  }
  const result = await res.json().catch(() => null);
  const archivedPlan = result?.data?.plan;
  setArchivedShellState(true);
  localPlanArchived = true;
  navigatorItems = activeNavigatorItems(mergePlanIntoItems(navigatorItems, archivedPlan));
  quickOpenLoadGeneration += 1;
  quickOpenLoadPromise = null;
  quickOpenItems = activeNavigatorItems(mergePlanIntoItems(quickOpenItems, archivedPlan));
  await loadPlanNavigator();
  if (quickOpenVisible()) {
    quickOpenItems = [];
    await loadQuickOpenItems().catch(error => { quickOpenLoadError = error; });
    renderQuickOpenResults();
  }
  showArchiveToast('Archived this '+documentKind+'.');
});
restorePlanButton?.addEventListener('click', async () => {
  restorePlanButton.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive', { method: 'POST' });
  if (!res.ok) {
    restorePlanButton.disabled = false;
    alert('Unable to restore '+documentKind+'.');
    return;
  }
  window.location.href = '/';
});
deferPlanButton?.addEventListener('click', async () => {
  const note = prompt('Why defer this '+documentKind+', and what should the next agent know?');
  if (!note || !note.trim()) return;
  deferPlanButton.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/defer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) });
  if (!res.ok) {
    deferPlanButton.disabled = false;
    alert('Unable to defer '+documentKind+'. Add a note/reason and try again.');
    return;
  }
  window.location.href = '/deferred';
});
resumePlanButton?.addEventListener('click', async () => {
  const note = prompt('Optional resume note for agents:') || undefined;
  resumePlanButton.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note?.trim() ? { note } : {}) });
  if (!res.ok) {
    resumePlanButton.disabled = false;
    alert('Unable to resume '+documentKind+'.');
    return;
  }
  window.location.href = '/';
});
async function saveOrganizerField(path, body, control){
  if (control) control.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!res?.ok) {
    if (control) control.disabled = false;
    alert('Unable to update '+documentKind+' organization.');
    return null;
  }
  const json = await res.json().catch(() => null);
  if (control) control.disabled = false;
  void loadPlanNavigator();
  return json;
}
pinPlanButton?.addEventListener('click', async () => {
  const pinned = pinPlanButton.getAttribute('aria-pressed') !== 'true';
  const json = await saveOrganizerField('/pin', { pinned }, pinPlanButton);
  if (!json?.ok) return;
  pinPlanButton.setAttribute('aria-pressed', String(pinned));
  pinPlanButton.setAttribute('aria-label', pinned ? 'Unpin plan' : 'Pin plan');
  pinPlanButton.setAttribute('title', pinned ? 'Unpin plan' : 'Pin plan');
  pinPlanButton.textContent = pinned ? '★' : '☆';
});
async function saveCurrentPlanStatus(){
  if (!currentPlanStatusControl) return;
  const previous = currentPlanStatusControl.dataset.currentValue || currentPlanStatusControl.value;
  const next = currentPlanStatusControl.value;
  if (!next || next === previous) return;
  if (currentPlanStatusError) { currentPlanStatusError.hidden = true; currentPlanStatusError.textContent = ''; }
  currentPlanStatusControl.disabled = true;
  let res;
  let json;
  try {
    res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/column', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boardColumnKey: next }) });
    json = await res.json();
  } catch {}
  currentPlanStatusControl.disabled = false;
  if (!res?.ok || !json?.ok) {
    currentPlanStatusControl.value = previous;
    const message = json?.error?.nextAction || json?.error?.message || 'Status was not changed. Check the service and retry.';
    if (currentPlanStatusError) { currentPlanStatusError.textContent = message; currentPlanStatusError.hidden = false; }
    return;
  }
  currentPlanStatusControl.dataset.currentValue = next;
  void loadPlanNavigator();
}
currentPlanStatusControl?.addEventListener('change', saveCurrentPlanStatus);
function urlNavigatorFilters(){
  const params = new URLSearchParams(window.location.search);
  const filters = {};
  if (params.has('projectKey')) filters.project = params.get('projectKey') || '';
  if (params.has('lifecycle')) filters.state = params.get('lifecycle') || '';
  if (statusFilterControl && params.has('boardColumnKey')) filters.status = params.get('boardColumnKey') || '';
  return filters;
}
function navigatorFilterSearch(filters = currentNavigatorFilters()){
  const params = new URLSearchParams();
  if (filters.project) params.set('projectKey', filters.project);
  else if (projectFilterControl) params.set('projectKey', '');
  if (filters.state) params.set('lifecycle', filters.state);
  else if (stateFilterControl) params.set('lifecycle', '');
  if (filters.status) params.set('boardColumnKey', filters.status);
  const query = params.toString();
  return query ? '?' + query : '';
}
function planNavigatorHref(id){ return '/p/' + encodeURIComponent(id) + navigatorFilterSearch(); }
function syncNavigatorFilterUrl(){
  const url = new URL(window.location.href);
  url.search = navigatorFilterSearch().slice(1);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}
function readStoredNavigatorFilters(){
  return urlNavigatorFilters();
}
function selectHasValue(control, value){ return Boolean(control && [...control.options].some(option => option.value === value)); }
function restoreNavigatorFilters(){
  const stored = readStoredNavigatorFilters();
  if ('project' in stored && selectHasValue(projectFilterControl, stored.project)) projectFilterControl.value = stored.project;
  if ('state' in stored && selectHasValue(stateFilterControl, stored.state)) stateFilterControl.value = stored.state;
  if ('status' in stored && selectHasValue(statusFilterControl, stored.status)) statusFilterControl.value = stored.status;
}
function currentNavigatorFilters(){
  const stored = readStoredNavigatorFilters();
  return {
    project: projectFilterControl ? projectFilterControl.value : String(stored.project || ''),
    state: stateFilterControl ? stateFilterControl.value : String(stored.state || ''),
    status: statusFilterControl ? statusFilterControl.value : ''
  };
}
function saveNavigatorFilters(){}
function navigatorApiUrl(){
  const params = new URLSearchParams({ limit: '200', currentPlanId: planId });
  const filters = currentNavigatorFilters();
  if (navigatorFiltersActive()) {
    params.set('projectKey', filters.project || '');
    params.set('lifecycle', filters.state || '');
    if (filters.status) params.set('boardColumnKey', filters.status);
  }
  return '/api/plans/navigator?' + params.toString();
}
async function loadNavigatorFilterSource(){
  const url = navigatorApiUrl();
  if (!navigatorFilterLoadPromise || navigatorFilterLoadUrl !== url) {
    navigatorFilterLoadUrl = url;
    const generation = ++navigatorLoadGeneration;
    navigatorFilterLoadPromise = (async () => {
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message || 'Unable to load filtered documents');
      return { url, generation, plans: Array.isArray(json.data.plans) ? json.data.plans : [] };
    })().finally(() => {
      if (navigatorFilterLoadUrl === url) {
        navigatorFilterLoadPromise = null;
        navigatorFilterLoadUrl = '';
      }
    });
  }
  const result = await navigatorFilterLoadPromise;
  if (result.url !== navigatorApiUrl() || result.generation !== navigatorLoadGeneration) return;
  navigatorItems = activeNavigatorItems(result.plans);
  renderPlanNavigatorItems(navigatorItems, navigatorItemNoun);
}
function applyNavigatorFilters(){
  saveNavigatorFilters();
  syncNavigatorFilterUrl();
  void loadNavigatorFilterSource().catch(error => {
    navigatorLoadError = error;
    if (planListError) { planListError.hidden = false; planListError.textContent = 'Unable to filter '+navigatorItemNoun+'. The current '+documentKind+' remains reviewable.'; }
  });
}
restoreNavigatorFilters();
projectFilterControl?.addEventListener('change', applyNavigatorFilters);
stateFilterControl?.addEventListener('change', applyNavigatorFilters);
statusFilterControl?.addEventListener('change', applyNavigatorFilters);
planListNav?.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('[data-plan-nav-item]') : null;
  if (!link) return;
  saveNavigatorFilters();
  const id = link.getAttribute('data-plan-id');
  if (id) link.setAttribute('href', planNavigatorHref(id));
});
addPlanNoteButton?.addEventListener('click', async () => {
  const body = planNoteBody?.value.trim();
  if (!body) return;
  addPlanNoteButton.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
  if (!res.ok) {
    addPlanNoteButton.disabled = false;
    alert('Unable to add '+documentKind+' note.');
    return;
  }
  if (planNoteBody) planNoteBody.value = '';
  addPlanNoteButton.disabled = false;
  await loadMeta();
});
executionReviewButton?.addEventListener('click', async () => {
  executionReviewButton.disabled = true;
  const originalText = executionReviewButton.textContent;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/request-execution-review', { method: 'POST' });
  if (!res.ok) {
    executionReviewButton.disabled = false;
    alert('Unable to request execution-ready review.');
    return;
  }
  executionReviewButton.textContent = 'Review requested';
  await scheduleMetaLoad();
  setTimeout(() => {
    executionReviewButton.disabled = false;
    executionReviewButton.textContent = originalText;
  }, 1600);
});
buildPlanButton?.addEventListener('click', async () => {
  buildPlanButton.disabled = true;
  const originalText = buildPlanButton.textContent;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/request-build-plan', { method: 'POST' });
  if (!res.ok) {
    buildPlanButton.disabled = false;
    alert('Unable to request plan build.');
    return;
  }
  buildPlanButton.textContent = 'Build requested';
  await scheduleMetaLoad();
  setTimeout(() => {
    buildPlanButton.disabled = false;
    buildPlanButton.textContent = originalText;
  }, 1600);
});
function mergeMetaOptions(left = {}, right = {}){
  return {
    reloadPlan: Boolean(left.reloadPlan || right.reloadPlan),
    forceReloadPlan: Boolean(left.forceReloadPlan || right.forceReloadPlan),
    bypassDialogDefer: Boolean(left.bypassDialogDefer || right.bypassDialogDefer),
    advanceEventSequence: Boolean(left.advanceEventSequence || right.advanceEventSequence)
  };
}
async function loadMeta(options = {}){
  const loadGeneration = ++loadMetaGeneration;
  const res = await fetch('/api/plans/'+planId);
  const json = await res.json();
  if (!eventPollingStarted || options.advanceEventSequence) {
    latestEventSequence = Math.max(latestEventSequence, Number(json.data.latestEventSequence || 0));
  }
  const latestVersionId = json.data.latestVersion.id;
  const shouldReloadPlan = options.reloadPlan && versionId && (latestVersionId !== versionId || options.forceReloadPlan);
  if (shouldReloadPlan) {
    if (!options.bypassDialogDefer && hasOpenCommentDialog()) {
      queueDeferredPlanRefresh({ versionId: latestVersionId, forceReloadPlan: Boolean(options.forceReloadPlan) });
	    } else {
	      const refreshGeneration = ++planRefreshGeneration;
	      void refreshPlanFrameContent(latestVersionId, { clearSelection: true, forceReloadPlan: Boolean(options.forceReloadPlan), refreshGeneration });
	    }
  } else if (!versionId) {
    versionId = latestVersionId;
    updateDownloadLink();
  }
  updateDownloadLink();
  if (loadGeneration !== loadMetaGeneration) {
    redrawMarkers();
    return;
  }
  renderSyncWarning(json.data.plan);
  renderPlanNotes(json.data.notes || []);
  renderComments(json.data.comments || []);
  void loadPlanNavigator();
}
function scheduleMetaLoad(options = {}){
  pendingMetaOptions = mergeMetaOptions(pendingMetaOptions || {}, options);
  if (metadataLoadPromise) {
    return metadataLoadPromise;
  }
  metadataLoadPromise = new Promise(resolve => {
    metadataLoadTimer = setTimeout(resolve, 50);
  }).then(async () => {
    metadataLoadTimer = null;
    const optionsToLoad = pendingMetaOptions || {};
    pendingMetaOptions = null;
    try {
      await loadMeta(optionsToLoad);
    } finally {
      metadataLoadPromise = null;
      if (pendingMetaOptions) {
        const nextOptions = pendingMetaOptions;
        pendingMetaOptions = null;
        void scheduleMetaLoad(nextOptions);
      }
    }
  });
  return metadataLoadPromise;
}
function replaceAttributes(target, source){
  for (const attr of [...target.attributes]) target.removeAttribute(attr.name);
  for (const attr of [...source.attributes]) target.setAttribute(attr.name, attr.value);
}
function normalizePlanTitle(value){ return String(value || '').replace(/\\s+/g, ' ').trim(); }
function planReviewTitle(title){
  const normalized = normalizePlanTitle(title) || planTitleFallback;
  return /(?:^|\\s)Plan Review$/i.test(normalized) ? normalized : normalized + ' · Plan Review';
}
function toolbarTitleFallback(){
  const normalized = normalizePlanTitle(planTitleFallback);
  return normalized.replace(/(?:\s+·)?\s+Plan Review$/i, '').trim() || normalized;
}
function renderedPlanTitleFromDocument(doc){
  return normalizePlanTitle(doc?.head?.querySelector?.('title')?.textContent || '') || toolbarTitleFallback();
}
function updateShellTitleFromRenderedDocument(doc){
  const title = renderedPlanTitleFromDocument(doc);
  document.title = planReviewTitle(title);
  document.getElementById('current-plan-title').textContent = title;
}
async function refreshPlanFrameContent(nextVersionId, options = {}){
  if (options.clearSelection) clearPendingSelection();
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !doc.documentElement || !doc.head || !doc.body) return;
  const scrollX = win?.scrollX || 0;
  const scrollY = win?.scrollY || 0;
  const shellScrollX = window.scrollX || 0;
  const shellScrollY = window.scrollY || 0;
  const reviewScrollTop = document.getElementById('review')?.scrollTop || 0;
  let parsed;
  try {
    const res = await fetch('/render/'+encodeURIComponent(planId)+'?versionId='+encodeURIComponent(nextVersionId), { cache: 'no-store' });
    if (!res.ok) throw new Error('Plan render refresh failed: ' + res.status);
    parsed = new DOMParser().parseFromString(await res.text(), 'text/html');
  } catch (error) {
    console.warn('Unable to refresh plan frame in place', error);
    return;
  }
  if (options.refreshGeneration !== planRefreshGeneration) return;
  if (hasOpenCommentDialog()) {
    queueDeferredPlanRefresh({ versionId: nextVersionId, forceReloadPlan: Boolean(options.forceReloadPlan) });
    return;
  }
  updateShellTitleFromRenderedDocument(parsed);
  replaceAttributes(doc.documentElement, parsed.documentElement);
  replaceAttributes(doc.head, parsed.head);
  replaceAttributes(doc.body, parsed.body);
  doc.head.replaceChildren(...[...parsed.head.childNodes].map(node => doc.importNode(node, true)));
  doc.body.replaceChildren(...[...parsed.body.childNodes].map(node => doc.importNode(node, true)));
  await renderMermaidDiagrams();
  ensureFrameMobileReadabilityStyles(doc);
  ensureFrameTapTargets(doc);
  syncFrameHeight();
  scheduleFrameImageReflows();
  versionId = nextVersionId;
  updateDownloadLink();
  hovered = null;
  selected = null;
  selectedForScreenshot = null;
  pendingAnchor = null;
  void mountWashiOverlay();
  restoreShellScroll(win, scrollX, scrollY, shellScrollX, shellScrollY, reviewScrollTop);
  requestAnimationFrame(scheduleMarkerReflow);
}
function hasOpenCommentDialog(){
  return !composer.hidden && (Boolean(pendingAnchor) || body.value.trim().length > 0);
}
function updateDeferredRefreshNotice(){
  if (!deferredRefreshNotice) return;
  deferredRefreshNotice.hidden = !deferredPlanRefresh;
}
function queueDeferredPlanRefresh(refresh){
  deferredPlanRefresh = refresh;
  updateDeferredRefreshNotice();
}
function clearDiscardWarning(){
  composer.classList.remove('discard-warning');
  if (discardWarning) discardWarning.hidden = true;
}
function showDiscardWarning(){
  composer.classList.add('discard-warning');
  if (discardWarning) discardWarning.hidden = false;
}
async function closeComposerFromEscape(){
  if (composer.hidden) return;
  if (body.value.trim().length > 0) {
    showDiscardWarning();
    return;
  }
  clearPendingSelection();
  await applyDeferredPlanRefreshIfIdle();
}
async function applyDeferredPlanRefreshIfIdle(){
  if (!deferredPlanRefresh || hasOpenCommentDialog()) return false;
  const refresh = deferredPlanRefresh;
  deferredPlanRefresh = null;
  updateDeferredRefreshNotice();
  await scheduleMetaLoad({ reloadPlan: true, forceReloadPlan: refresh.forceReloadPlan, bypassDialogDefer: true });
  return true;
}
function renderSyncWarning(plan){
  if (!plan || plan.lastSyncStatus !== 'failed') {
    syncWarning.hidden = true;
    syncWarning.textContent = '';
    return;
  }
  const error = plan.lastSyncError || {};
  syncWarning.textContent = 'Source sync failed for ' + (plan.sourcePath || plan.planPath) + ': ' + (error.message || 'unknown error');
  syncWarning.hidden = false;
}
function handlePlanVersionEvent(event){
  try {
    const data = JSON.parse(event.data || '{}');
    // Non-sync events for the current version are no-ops; synced events always
    // call loadMeta with forceReloadPlan because asset-only changes can reuse versionId.
    if (event.type !== 'plan.version.synced' && data.versionId && data.versionId === versionId) return;
  } catch {}
  scheduleMetaLoad({ reloadPlan: true, forceReloadPlan: event.type === 'plan.version.synced' });
}
function normalizeStoredEvent(event){
  return {
    type: String(event?.eventType || event?.type || ''),
    data: JSON.stringify(event?.payload || {})
  };
}
function handlePlanReviewEvent(event){
  if (event.type === 'plan.version.registered' || event.type === 'plan.version.synced') {
    handlePlanVersionEvent(event);
    return;
  }
  if (event.type === 'plan.sync.failed'
    || event.type === 'plan.columns.changed'
    || event.type === 'plan.note.created'
    || event.type === 'plan.deferred'
    || event.type === 'plan.resumed'
    || event.type === 'comment.created'
    || event.type === 'comment.claimed'
    || event.type === 'comment.acknowledged'
    || event.type === 'comment.resolved'
    || event.type === 'comment.released'
    || event.type === 'comment.deleted'
    || event.type === 'comment.thread_entry.created'
    || event.type === 'plan.mode.changed'
    || event.type === 'plan.lifecycle.changed'
    || event.type === 'plan.column.changed'
    || event.type === 'plan.pin.changed'
    || event.type === 'plan.project.changed') {
    scheduleMetaLoad();
  }
}
function renderPlanNotes(items){
  if (!planNotes) return;
  const rows = items.map(note => '<div class="note-row"><p>'+escapeHtml(note.body)+'</p><small>'+escapeHtml(note.createdBy?.displayName || (isCollaborationMode ? 'Document reviewer' : 'Plan reviewer'))+' · '+escapeHtml(new Date(note.createdAt).toLocaleString())+'</small></div>').join('');
  planNotes.innerHTML = rows || '<p class="comments-empty">No '+documentKind+' notes yet.</p>';
}
function renderCommentTraySummary(items){
  let pending = 0, claimed = 0, acknowledged = 0, resolved = 0;
  for (const c of items) {
    if (c.status === 'claimed') claimed += 1;
    else if (c.status === 'acknowledged') acknowledged += 1;
    else if (c.status === 'resolved') resolved += 1;
    else pending += 1;
  }
  const total = items.length;
  const statusText = total === 0 ? 'Comments' : 'Comments (' + total + (pending ? ' · ' + pending + ' pending' : '') + ')';
  if (mobileCommentsToggle) mobileCommentsToggle.dataset.commentStatusText = statusText;
  if (commentsStatusFilters) {
    const chips = [['All', total], ['Pending', pending], ['Claimed', claimed], ['Acked', acknowledged], ['Resolved', resolved]];
    commentsStatusFilters.innerHTML = chips.map(([label, count]) => '<span class="comment-status-chip">'+escapeHtml(label)+' '+Number(count)+'</span>').join('');
  }
}
function renderComments(items){
  renderedComments = items;
  renderMarkers(items);
  if (mobileCommentsToggle) mobileCommentsToggle.dataset.commentCount = String(items.length);
  if (desktopCommentsToggle) desktopCommentsToggle.dataset.commentCount = String(items.length);
  renderCommentTraySummary(items);
  updateCommentsToggles();
  const rows = items.map(c => {
    const response = c.agentResponse || {};
    const changed = Array.isArray(response.changedFiles) ? response.changedFiles.join(', ') : '';
    const metadata = [response.responseSummary || response.resolutionNote || response.note, changed, response.runId, response.handoffPath, response.commitSha].filter(Boolean).map(escapeHtml).join(' · ');
    const context = [c.anchor?.textPreview, c.anchor?.selectedText, c.anchor?.textQuote?.exact, c.anchor?.cssSelector].filter(Boolean).map(escapeHtml).join(' · ');
    const screenshot = c.screenshotAssetId ? '<a href="/comment-assets/'+encodeURIComponent(c.screenshotAssetId)+'">screenshot</a>' : '';
    const entries = Array.isArray(c.threadEntries) && c.threadEntries.length ? c.threadEntries : [{ role: 'human', body: c.body, createdBy: c.createdBy, createdAt: c.createdAt }];
    const thread = '<div class="comment-thread">'+entries.map(entry => '<div class="thread-entry '+escapeHtml(entry.role || '')+'"><strong>'+escapeHtml(entry.createdBy?.displayName || entry.role || 'Reviewer')+'</strong><p>'+escapeHtml(entry.body || '')+'</p><small>'+escapeHtml(entry.role || '')+' · '+escapeHtml(entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '')+'</small></div>').join('')+'</div>';
    const canDelete = c.status === 'pending' && !c.claim;
    const deleteError = pendingDeleteError?.commentId === c.id ? '<small class="comment-delete-error" data-delete-error="'+escapeHtml(c.id)+'">'+escapeHtml(pendingDeleteError.message)+'</small>' : '<small class="comment-delete-error" data-delete-error="'+escapeHtml(c.id)+'" hidden></small>';
    const deleteAction = canDelete || pendingDeleteError?.commentId === c.id ? '<p>'+(canDelete ? '<button type="button" data-delete-comment="'+escapeHtml(c.id)+'">Delete</button> ' : '')+deleteError+'</p>' : '';
    const jumpAction = '<button class="comment-jump" type="button" data-jump-comment="'+escapeHtml(c.id)+'" aria-label="Jump to comment #'+escapeHtml(c.sequence)+' anchor">Jump</button>';
    return '<div class="comment-row" data-comment-id="'+escapeHtml(c.id)+'"><div class="comment-row-header"><strong>#'+c.sequence+' '+escapeHtml(c.status)+'</strong>'+jumpAction+'</div>'+thread+'<small>'+escapeHtml(c.anchorType)+' · '+escapeHtml(c.anchorState)+(metadata ? ' · '+metadata : '')+'</small>'+(context ? '<p><small>Context: '+context+'</small></p>' : '')+(screenshot ? '<p><small>'+screenshot+'</small></p>' : '')+deleteAction+'</div>';
  }).join('');
  comments.innerHTML = rows || '<p class="comments-empty">No comments yet. Tap a '+documentKind+' section to start one.</p>';
  updateCommentStatusBanner(items);
}
function updateCommentStatusBanner(items){
  const banner = document.getElementById('comment-status-banner');
  if (!banner) return;
  let pending = 0, claimed = 0, acknowledged = 0, resolved = 0;
  for (const c of items) {
    if (c.status === 'claimed') claimed += 1;
    else if (c.status === 'acknowledged') acknowledged += 1;
    else if (c.status === 'resolved') resolved += 1;
    else pending += 1;
  }
  const total = items.length;
  banner.className = 'comment-status-banner';
  let state, label;
  if (total === 0 || resolved === total) {
    state = 'green';
    label = total === 0 ? 'No comments' : 'All resolved';
  } else if (pending > 0 && claimed === 0 && acknowledged === 0) {
    state = 'red';
    label = pending + ' pending';
  } else {
    state = 'yellow';
    const working = claimed + acknowledged;
    label = 'Agent working ' + working;
  }
  banner.classList.add(state);
  banner.textContent = label;
  banner.hidden = false;
}
async function deleteComment(commentId, button){
  const error = comments.querySelector('[data-delete-error="'+CSS.escape(commentId)+'"]');
  if (error) { error.hidden = true; error.textContent = ''; }
  button.disabled = true;
  let res;
  let json;
  try {
    res = await fetch('/api/comments/'+encodeURIComponent(commentId), { method: 'DELETE' });
    json = await res.json();
  } catch {
    if (error) { error.textContent = 'Unable to delete comment. Check the service and retry.'; error.hidden = false; }
    button.disabled = false;
    return;
  }
  if (!json.ok) {
    pendingDeleteError = { commentId, message: json.error?.message || 'Unable to delete comment.' };
    await loadMeta();
    return;
  }
  pendingDeleteError = null;
  await loadMeta();
}
function scrollToCommentAnchor(commentId){
  const comment = renderedComments.find(item => String(item.id) === String(commentId));
  if (!comment) return;
  const rect = currentRectForComment(comment);
  if (!rect) return;
  const frameRect = frame.getBoundingClientRect();
  if (isMobileShell()) {
    const review = document.getElementById('review');
    if (!review) return;
    const reviewRect = review.getBoundingClientRect();
    review.scrollTo({ top: Math.max(0, review.scrollTop + frameRect.top - reviewRect.top + rect.y - 72), behavior: 'auto' });
  } else {
    const navbarHeight = document.getElementById('plan-navbar')?.getBoundingClientRect().height || 0;
    window.scrollTo({ top: Math.max(0, window.scrollY + frameRect.top + rect.y - navbarHeight - 16), behavior: 'auto' });
    armPostProgrammaticScrollWheelHandoff();
  }
  scheduleMarkerReflow();
}
comments.addEventListener('click', event => {
  const target = event.target;
  const deleteButton = target instanceof Element ? target.closest('[data-delete-comment]') : null;
  if (deleteButton) {
    event.preventDefault();
    deleteComment(deleteButton.dataset.deleteComment, deleteButton);
    return;
  }
  const jumpButton = target instanceof Element ? target.closest('[data-jump-comment]') : null;
  if (jumpButton) {
    event.preventDefault();
    scrollToCommentAnchor(jumpButton.dataset.jumpComment);
  }
});
function escapeHtml(value){ return String(value).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function planItemComplete(item){ return item?.progress?.totalPhases > 0 && item.progress.completedPhases === item.progress.totalPhases; }
function planItemAttention(item){ return item?.plan?.watchMode === 'filesystem' && item?.plan?.lastSyncStatus === 'failed'; }
function planItemRatio(item){ return item?.progress?.totalPhases > 0 ? item.progress.completedPhases / item.progress.totalPhases : 0; }
function planItemRank(item){ if (planItemAttention(item)) return 3; if (planItemComplete(item)) return 0; if (item?.plan?.publicationMetadata?.executionReady) return 1; return 2; }
function planItemTitle(item){ return String(item?.displayTitle || item?.plan?.repoName + ' / ' + item?.plan?.slug); }
function sortPlanNavItems(items){ return [...items].sort((a,b)=>(Boolean(a?.plan?.pinnedAt)===Boolean(b?.plan?.pinnedAt)?0:a?.plan?.pinnedAt?-1:1)||planItemRank(a)-planItemRank(b)||planItemRatio(b)-planItemRatio(a)||String(b.activityAt||'').localeCompare(String(a.activityAt||''))||planItemTitle(a).localeCompare(planItemTitle(b))||String(a?.plan?.id||'').localeCompare(String(b?.plan?.id||''))); }
function boardColumnLabelForKey(key){ if(!key) return 'Unassigned'; if(boardColumnLabels.has(key)) return boardColumnLabels.get(key); const option=[statusFilterControl,currentPlanStatusControl].filter(Boolean).flatMap(control=>[...control.options]).find(option=>option.value===key); return option?.textContent?.trim() || key; }
function planItemStatus(item){ if (planItemAttention(item)) return 'Needs attention'; if (item?.plan?.lifecycleState === 'archived') return 'Archived · ' + boardColumnLabelForKey(item?.plan?.boardColumnKey); if (item?.plan?.lifecycleState === 'deferred') return 'Deferred · ' + boardColumnLabelForKey(item?.plan?.boardColumnKey); if (planItemComplete(item)) return 'Complete'; if (item?.plan?.reviewMode === 'collaboration') return 'Collaboration'; if (item?.plan?.publicationMetadata?.executionReady) return 'Execution ready'; return 'Execution not ready'; }
function planItemProgress(item){ return item?.progress?.totalPhases ? item.progress.completedPhases + '/' + item.progress.totalPhases : 'No phases'; }
function navigatorFiltersActive(){
  const urlFilters = urlNavigatorFilters();
  return Boolean(projectFilterControl?.value || stateFilterControl?.value || statusFilterControl?.value || 'project' in urlFilters || 'state' in urlFilters || 'status' in urlFilters);
}
function itemMatchesNavigatorFilters(item){
  const project = projectFilterControl?.value || '';
  const state = stateFilterControl?.value || '';
  const status = statusFilterControl?.value || '';
  if (project && item?.plan?.projectKey !== project) return false;
  if (state && item?.plan?.lifecycleState !== state) return false;
  if (status && item?.plan?.boardColumnKey !== status) return false;
  return true;
}
function filteredNavigatorItems(items){
  if (!navigatorFiltersActive()) return items;
  const filtered = items.filter(itemMatchesNavigatorFilters);
  const current = items.find(item => String(item?.plan?.id || '') === planId);
  return current && !filtered.some(item => String(item?.plan?.id || '') === planId) ? [current, ...filtered] : filtered;
}
function navigatorListTitle(label = 'plans'){
  const noun = label === 'documents' ? 'documents' : 'plans';
  const state = stateFilterControl?.value || '';
  const stateLabel = state === 'archived' ? 'Archived' : state === 'deferred' ? 'Deferred' : state === '' && navigatorFiltersActive() ? 'All' : 'Active';
  return stateLabel + ' ' + noun;
}
function renderPlanNavigatorItems(items, label = 'plans'){
  if (!planListItems) return;
  const title = navigatorListTitle(label);
  const heading = planListNav?.querySelector('.plan-list-header h2');
  if (heading) heading.textContent = title;
  planListNav?.setAttribute('aria-label', title);
  const visibleItems = filteredNavigatorItems(items);
  const html = sortPlanNavItems(visibleItems).map(item => {
    const id = String(item?.plan?.id || '');
    const active = id === planId;
    const status = planItemStatus(item);
    return '<a class="plan-nav-item'+(active ? ' active' : '')+(planItemAttention(item) ? ' attention' : '')+'" href="'+escapeHtml(planNavigatorHref(id))+'" data-plan-nav-item data-plan-id="'+escapeHtml(id)+'" aria-current="'+(active ? 'page' : 'false')+'"><span class="plan-nav-title">'+escapeHtml(planItemTitle(item))+'</span><span class="plan-nav-meta"><span class="plan-nav-pill '+(item?.plan?.reviewMode === 'collaboration' || item?.plan?.publicationMetadata?.executionReady ? 'ready' : 'not-ready')+'">'+escapeHtml(status)+'</span><span>'+escapeHtml(planItemProgress(item))+'</span></span><span class="plan-nav-submeta">pending '+Number(item?.counts?.pending || 0)+' · updated '+escapeHtml(String(item?.modifiedAt || ''))+'</span></a>';
  }).join('');
  planListItems.innerHTML = html || '<p class="plan-list-empty">No '+title.toLowerCase()+'.</p>';
}
function quickOpenVisible(){ return Boolean(quickOpenBackdrop && !quickOpenBackdrop.hidden); }
function normalizeQuickOpenText(value){ return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function orderedQuickOpenScore(text, query){
  if (!query) return 1;
  let position = 0;
  let first = -1;
  let last = -1;
  for (const char of query) {
    if (char === ' ') continue;
    const found = text.indexOf(char, position);
    if (found < 0) return 0;
    if (first < 0) first = found;
    last = found;
    position = found + 1;
  }
  const spread = Math.max(1, last - first + 1);
  return Math.max(1, 120 - spread);
}
function quickOpenFieldScore(rawText, rawQuery, weight){
  const text = normalizeQuickOpenText(rawText);
  const query = normalizeQuickOpenText(rawQuery);
  if (!text || !query) return 0;
  if (text === query) return weight + 600;
  if (text.startsWith(query)) return weight + 500;
  if (text.includes(query)) return weight + 350;
  const ordered = orderedQuickOpenScore(text, query);
  return ordered ? weight + ordered : 0;
}
function quickOpenFuzzyScore(item, query){
  const metadata = item?.plan?.publicationMetadata || {};
  const title = planItemTitle(item);
  const status = planItemStatus(item);
  const progress = planItemProgress(item);
  const commentsText = 'pending '+Number(item?.counts?.pending || 0)+' claimed '+Number(item?.counts?.claimed || 0)+' acknowledged '+Number(item?.counts?.acknowledged || 0)+' resolved '+Number(item?.counts?.resolved || 0);
  const metadataText = [item?.plan?.repoName, item?.plan?.slug, item?.plan?.repoKey, item?.plan?.reviewMode, item?.plan?.projectKey, item?.plan?.projectName, item?.plan?.lifecycleState, item?.plan?.boardColumnKey, item?.plan?.pinnedAt ? 'pinned' : '', metadata.executionReady ? 'execution ready' : 'execution not ready', metadata.linearIssue, item?.plan?.linearIssueKey, status, progress, commentsText, item?.latestNote?.body].join(' ');
  const pathText = [item?.plan?.planPath, item?.plan?.sourcePath, item?.plan?.rootPath, metadata.worktreePath, metadata.branch].join(' ');
  const score = Math.max(quickOpenFieldScore(title, query, 3000), quickOpenFieldScore(metadataText, query, 1500), quickOpenFieldScore(pathText, query, 250));
  if (!score) return 0;
  return score + (item?.plan?.id === planId ? -10 : 0);
}
function quickOpenMeta(item){
  return [item?.plan?.reviewMode, item?.plan?.projectName, item?.plan?.lifecycleState, item?.plan?.boardColumnKey, item?.plan?.publicationMetadata?.executionReady ? 'execution ready' : '', item?.plan?.pinnedAt ? 'pinned' : '', planItemProgress(item), 'pending '+Number(item?.counts?.pending || 0), item?.modifiedAt ? 'updated '+new Date(item.modifiedAt).toLocaleDateString() : ''].filter(Boolean).join(' · ');
}
function quickOpenResultsFor(query){
  const items = quickOpenItems.length ? quickOpenItems : navigatorItems;
  const sorted = query.trim()
    ? items.map(item => ({ item, score: quickOpenFuzzyScore(item, query) })).filter(match => match.score > 0).sort((a,b)=>b.score-a.score||planItemTitle(a.item).localeCompare(planItemTitle(b.item))||String(a.item?.plan?.id||'').localeCompare(String(b.item?.plan?.id||''))).map(match => match.item)
    : sortPlanNavItems(items);
  return sorted.slice(0, 15);
}
function setQuickOpenActiveIndex(index){
  if (!quickOpenMatches.length) {
    quickOpenActiveIndex = 0;
    quickOpenInput?.removeAttribute('aria-activedescendant');
    return;
  }
  quickOpenActiveIndex = (index + quickOpenMatches.length) % quickOpenMatches.length;
  const activeId = 'quick-open-result-' + quickOpenActiveIndex;
  quickOpenInput?.setAttribute('aria-activedescendant', activeId);
  quickOpenResultList?.querySelectorAll('[data-quick-open-result]').forEach((row, rowIndex) => {
    const active = rowIndex === quickOpenActiveIndex;
    row.classList.toggle('active', active);
    row.setAttribute('aria-selected', String(active));
    if (active) row.scrollIntoView({ block: 'nearest' });
  });
}
function renderQuickOpenResults(){
  if (!quickOpenResultList) return;
  const query = quickOpenInput?.value || '';
  quickOpenMatches = quickOpenLoadError ? [] : quickOpenResultsFor(query);
  const hasError = Boolean(quickOpenLoadError);
  if (quickOpenError) { quickOpenError.hidden = !hasError; quickOpenError.firstChild.textContent = hasError ? 'Plans could not be loaded. ' : ''; }
  if (quickOpenEmpty) quickOpenEmpty.hidden = hasError || quickOpenMatches.length > 0;
  quickOpenResultList.innerHTML = quickOpenMatches.map((item, index) => '<div id="quick-open-result-'+index+'" class="quick-open-result" role="option" tabindex="-1" data-quick-open-result data-plan-id="'+escapeHtml(String(item?.plan?.id || ''))+'"><span class="quick-open-result-title">'+escapeHtml(planItemTitle(item))+'</span><span class="quick-open-result-meta">'+escapeHtml(quickOpenMeta(item))+'</span></div>').join('');
  if (quickOpenStatus) {
    if (hasError) quickOpenStatus.textContent = 'Documents could not be loaded. Retry when the service is reachable.';
    else quickOpenStatus.textContent = quickOpenMatches.length ? quickOpenMatches.length+' matching document'+(quickOpenMatches.length === 1 ? '' : 's')+'.' : 'No matching documents.';
  }
  setQuickOpenActiveIndex(0);
}
function captureQuickOpenFocus(){
  try {
    const frameDoc = frame?.contentDocument;
    if (frameDoc?.hasFocus?.() && frameDoc.activeElement) return { element: frameDoc.activeElement };
  } catch {}
  return { element: document.activeElement };
}
function openQuickOpen(){
  if (!quickOpenBackdrop || !quickOpenInput) return;
  if (!quickOpenVisible()) quickOpenPreviousFocus = captureQuickOpenFocus();
  quickOpenBackdrop.hidden = false;
  quickOpenInput.value = '';
  renderQuickOpenResults();
  quickOpenInput.focus({ preventScroll: true });
  void loadQuickOpenItems().then(() => { if (quickOpenVisible()) renderQuickOpenResults(); }).catch(error => { quickOpenLoadError = error; if (quickOpenVisible()) renderQuickOpenResults(); });
  if (!navigatorItems.length && !navigatorLoadError) void loadPlanNavigator().then(() => { if (quickOpenVisible()) renderQuickOpenResults(); });
}
function closeQuickOpen(){
  if (!quickOpenBackdrop || !quickOpenVisible()) return;
  quickOpenBackdrop.hidden = true;
  const focusTarget = quickOpenPreviousFocus?.element;
  quickOpenPreviousFocus = null;
  try { focusTarget?.focus?.({ preventScroll: true }); } catch {}
}
function selectQuickOpenResult(){
  const item = quickOpenMatches[quickOpenActiveIndex];
  const id = item?.plan?.id;
  if (!id) return;
  window.location.href = '/p/' + encodeURIComponent(String(id));
}
function isQuickOpenShortcut(event){ return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && String(event.key || '').toLowerCase() === 'o'; }
function quickOpenFocusableElements(){
  if (!quickOpenDialog) return [];
  return [...quickOpenDialog.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0);
}
function trapQuickOpenFocus(event){
  const focusable = quickOpenFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    quickOpenDialog?.focus?.({ preventScroll: true });
    return;
  }
  const currentIndex = focusable.indexOf(document.activeElement);
  const nextIndex = event.shiftKey ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1) : (currentIndex < 0 || currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1);
  event.preventDefault();
  focusable[nextIndex].focus({ preventScroll: true });
}
function handleQuickOpenKeydown(event){
  if (isQuickOpenShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    openQuickOpen();
    return;
  }
  if (!quickOpenVisible()) return;
  if (event.key === 'Tab') {
    event.stopPropagation();
    trapQuickOpenFocus(event);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeQuickOpen();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    event.stopPropagation();
    setQuickOpenActiveIndex(quickOpenActiveIndex + 1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    setQuickOpenActiveIndex(quickOpenActiveIndex - 1);
    return;
  }
  if (event.key === 'Enter') {
    const targetButton = event.target instanceof Element ? event.target.closest('button') : null;
    if (targetButton && quickOpenDialog?.contains(targetButton)) return;
    event.preventDefault();
    event.stopPropagation();
    selectQuickOpenResult();
  }
}
async function loadQuickOpenItems(options = {}){
  if (quickOpenLoadPromise && !options.force) return quickOpenLoadPromise;
  if (!options.force && quickOpenItems.length) return Promise.resolve();
  if (options.force) quickOpenItems = [];
  const generation = ++quickOpenLoadGeneration;
  quickOpenLoadPromise = (async () => {
    const items = [];
    let cursor = '';
    do {
      const url = '/api/plans?includeArchived=true&includeDeferred=true&limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message || 'Unable to load quick-open documents');
      items.push(...(Array.isArray(json.data.plans) ? json.data.plans : []));
      cursor = json.data.nextCursor || '';
    } while (cursor);
    if (generation !== quickOpenLoadGeneration) return;
    quickOpenItems = activeNavigatorItems(items);
    quickOpenLoadError = null;
  })().finally(() => { if (generation === quickOpenLoadGeneration) quickOpenLoadPromise = null; });
  return quickOpenLoadPromise;
}
async function loadPlanNavigator(){
  if (!planListItems) return;
  const url = navigatorApiUrl();
  const generation = ++navigatorLoadGeneration;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error?.message || 'Unable to load plans');
    if (url !== navigatorApiUrl() || generation !== navigatorLoadGeneration) return;
    navigatorItems = activeNavigatorItems(Array.isArray(json.data.plans) ? json.data.plans : []);
    navigatorLoadError = null;
    renderPlanNavigatorItems(navigatorItems, navigatorItemNoun);
    if (planListError) planListError.hidden = true;
    if (planListRetry) planListRetry.hidden = true;
    if (quickOpenVisible()) renderQuickOpenResults();
  } catch (error) {
    if (url !== navigatorApiUrl() || generation !== navigatorLoadGeneration) return;
    navigatorLoadError = error;
    if (planListError) { planListError.hidden = false; planListError.textContent = 'Unable to load '+navigatorItemNoun+'. The current '+documentKind+' remains reviewable.'; }
    if (planListRetry) planListRetry.hidden = false;
    if (quickOpenVisible()) renderQuickOpenResults();
  }
}
planListRetry?.addEventListener('click', () => { void loadPlanNavigator(); });
quickOpenRetry?.addEventListener('click', () => {
  quickOpenItems = [];
  quickOpenLoadError = null;
  void Promise.all([loadQuickOpenItems(), loadPlanNavigator()]).then(renderQuickOpenResults).catch(error => { quickOpenLoadError = error; renderQuickOpenResults(); void loadPlanNavigator(); });
});
quickOpenInput?.addEventListener('input', renderQuickOpenResults);
quickOpenResultList?.addEventListener('mousemove', event => {
  const row = event.target instanceof Element ? event.target.closest('[data-quick-open-result]') : null;
  if (!row) return;
  const rows = [...quickOpenResultList.querySelectorAll('[data-quick-open-result]')];
  const index = rows.indexOf(row);
  if (index >= 0) setQuickOpenActiveIndex(index);
});
quickOpenResultList?.addEventListener('click', event => {
  const row = event.target instanceof Element ? event.target.closest('[data-quick-open-result]') : null;
  if (!row) return;
  event.preventDefault();
  const rows = [...quickOpenResultList.querySelectorAll('[data-quick-open-result]')];
  const index = rows.indexOf(row);
  if (index >= 0) setQuickOpenActiveIndex(index);
  selectQuickOpenResult();
});
quickOpenBackdrop?.addEventListener('mousedown', event => { if (event.target === quickOpenBackdrop) closeQuickOpen(); });
document.addEventListener('keydown', handleQuickOpenKeydown, true);
setInterval(() => { void loadPlanNavigator(); }, 30000);
function renderMarkers(items){
  markerComments = items.filter(comment => comment.anchor?.rect);
  redrawMarkers();
}
function selectorForPlanNodeId(planNodeId){
  return '[data-plan-node-id=' + JSON.stringify(String(planNodeId)) + ']';
}
function ensureFrameAnchorStyles(){
  const doc = frame.contentDocument;
  if (!doc) return null;
  let style = doc.getElementById('plan-review-comment-anchor-styles');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'plan-review-comment-anchor-styles';
    style.textContent = '.comment-anchor{position:absolute;pointer-events:none;border-radius:6px;box-sizing:border-box;z-index:2147483640}.comment-anchor.pending{border:2px dotted rgba(192,132,252,.95);background:transparent;box-shadow:0 0 0 3px rgba(168,85,247,.08)}.comment-anchor.claimed{border:2px dotted rgba(234,179,8,.95);background:transparent;box-shadow:0 0 0 3px rgba(234,179,8,.10)}.comment-anchor.acknowledged{border:2px dotted rgba(34,197,94,.95);background:transparent;box-shadow:0 0 0 3px rgba(34,197,94,.10)}.comment-anchor.resolved{border:2px dotted rgba(59,130,246,.9);background:transparent;box-shadow:none}.comment-anchor-label{position:absolute;right:-10px;top:-12px;min-width:24px;height:24px;border-radius:999px;display:grid;place-items:center;padding:0 6px;font-weight:800;font-size:12px;line-height:20px;box-shadow:0 8px 18px rgba(0,0,0,.35)}.comment-anchor.pending .comment-anchor-label{background:#a855f7;color:white;border:2px solid #e9d5ff}.comment-anchor.claimed .comment-anchor-label{background:#eab308;color:#1c1206;border:2px solid #fef08a}.comment-anchor.acknowledged .comment-anchor-label{background:#22c55e;color:white;border:2px solid #bbf7d0}.comment-anchor.resolved .comment-anchor-label{background:#3b82f6;color:white;border:2px solid #bfdbfe}';
    (doc.head || doc.documentElement).appendChild(style);
  }
  return doc;
}
function ensureFrameMermaidStyles(){
  const doc = frame.contentDocument;
  if (!doc) return null;
  let style = doc.getElementById('plan-review-mermaid-styles');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'plan-review-mermaid-styles';
    style.textContent = '.plan-mermaid-rendered{display:block;max-width:min(100%,980px);margin:1.4rem auto;padding:18px;background:linear-gradient(180deg,rgba(17,24,39,.96),rgba(15,23,42,.96));border:1px solid #2b364d;border-radius:16px;color:#e5e7eb;box-shadow:0 18px 45px rgba(15,23,42,.22);overflow:auto}.plan-mermaid-rendered svg{display:block;max-width:100%;height:auto;margin:0 auto;background:transparent}.plan-mermaid-rendered .plan-mermaid-source-copy{margin-top:12px;padding-top:10px;border-top:1px solid #2b364d;color:#a7b0c0;font-size:.92rem}.plan-mermaid-rendered .plan-mermaid-source-copy summary{cursor:pointer;color:#7dd3fc;font-weight:800}.plan-mermaid-rendered .plan-mermaid-source-copy pre{margin-top:8px;padding:10px;white-space:pre-wrap;background:#020617;color:#dbeafe;border:1px solid #263246;border-radius:8px}.plan-mermaid-error{display:block;margin:1.4rem auto;padding:16px;max-width:min(100%,980px);background:#2b1320;color:#ffe4e6;border:1px solid #fb7185;border-radius:16px}.plan-mermaid-error pre{white-space:pre-wrap;background:#020617;color:#fecaca;border:1px solid #7f1d1d;border-radius:8px;padding:10px}';
    (doc.head || doc.documentElement).appendChild(style);
  }
  return doc;
}
function ensureFrameMobileReadabilityStyles(doc = frame.contentDocument){
  if (!doc) return null;
  let style = doc.getElementById('plan-review-mobile-readability-styles');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'plan-review-mobile-readability-styles';
    style.textContent = '@media(max-width:760px),(pointer:coarse){html,body{width:100%!important;max-width:100%!important;min-width:0!important;overflow-x:hidden!important;box-sizing:border-box!important}body{font-size:16px!important;line-height:1.58!important;overflow-wrap:anywhere!important;word-break:normal!important;-webkit-text-size-adjust:100%!important}body *{box-sizing:border-box}main,article,section,header,footer,nav,aside,div,figure,figcaption,p,ul,ol,li,blockquote{max-width:100%!important;min-width:0!important}main,article,section{overflow-x:hidden!important}p,li,dd,dt,figcaption{font-size:max(1rem,16px)!important;line-height:1.58!important}h1{font-size:clamp(1.85rem,9vw,2.8rem)!important}h2{font-size:clamp(1.45rem,7vw,2.05rem)!important}h3{font-size:clamp(1.18rem,5.8vw,1.55rem)!important}img,video,canvas{max-width:100%!important;height:auto!important}svg{height:auto!important}table,pre,.plan-mermaid-rendered,.plan-mermaid-error,figure[data-plan-wide]{display:block!important}table,pre,.plan-mermaid-rendered,.plan-mermaid-error,figure[data-plan-wide],.plan-review-wide-scroll{max-width:100%!important;overflow-x:auto!important;overflow-y:visible!important;-webkit-overflow-scrolling:touch!important;overscroll-behavior-x:contain!important;border-inline-end:1px solid rgba(56,189,248,.55)!important;box-shadow:inset -18px 0 18px -18px rgba(56,189,248,.95)!important}.plan-review-wide-scroll>img,.plan-review-wide-scroll>picture>img{max-width:none!important;width:auto!important}table{width:max-content!important;min-width:100%!important;border-collapse:collapse!important}th,td{white-space:normal!important;overflow-wrap:anywhere!important;min-width:10rem!important}pre{white-space:pre!important}pre code{white-space:inherit!important;overflow-wrap:normal!important;word-break:normal!important}code{white-space:pre-wrap!important;overflow-wrap:anywhere!important}.plan-mermaid-rendered svg{max-width:none!important;width:max-content!important;min-width:min(46rem,180vw)!important}.grid,.cards,.card-grid,.mock-wall,.split-stage,[style*="grid-template-columns"]{grid-template-columns:minmax(0,1fr)!important}.toc{grid-template-columns:minmax(0,1fr)!important}}';
  }
  (doc.head || doc.documentElement).appendChild(style);
  ensureFrameWideScrollAffordances(doc);
  return doc;
}
function ensureFrameWideScrollAffordances(doc = frame.contentDocument){
  if (!doc) return;
  const win = frame.contentWindow;
  if (!win) return;
  const candidates = doc.body ? [...doc.body.querySelectorAll('main,article,section,div,figure,table,pre,.plan-mermaid-rendered,.plan-mermaid-error')] : [];
  const restoreMediaWidth = media => {
    if (!(media instanceof win.HTMLElement)) return;
    if (media.dataset.planReviewOriginalMinWidth !== undefined) {
      media.style.minWidth = media.dataset.planReviewOriginalMinWidth;
      delete media.dataset.planReviewOriginalMinWidth;
    } else if (media.dataset.planReviewWideMedia === 'true') {
      media.style.minWidth = '';
    }
    delete media.dataset.planReviewWideMedia;
  };
  for (const element of candidates) {
    if (!(element instanceof win.HTMLElement)) continue;
    const media = element.matches('figure') ? element.querySelector('img,picture > img') : null;
    if (!isMobileShell()) {
      element.classList.remove('plan-review-wide-scroll');
      restoreMediaWidth(media);
      continue;
    }
    const mediaWidth = media instanceof win.HTMLImageElement ? Number(media.getAttribute('width') || media.naturalWidth || 0) : 0;
    const availableWidth = Math.min(
      element.clientWidth || Number.POSITIVE_INFINITY,
      doc.documentElement?.clientWidth || Number.POSITIVE_INFINITY,
      doc.body?.clientWidth || Number.POSITIVE_INFINITY
    );
    if (media instanceof win.HTMLElement) {
      if (media.dataset.planReviewOriginalMinWidth === undefined) media.dataset.planReviewOriginalMinWidth = media.style.minWidth;
      media.dataset.planReviewWideMedia = 'true';
      media.style.minWidth = mediaWidth > availableWidth + 1 ? mediaWidth + 'px' : '';
    }
    if (element.scrollWidth > element.clientWidth + 1 || mediaWidth > availableWidth + 1) element.classList.add('plan-review-wide-scroll');
    else element.classList.remove('plan-review-wide-scroll');
  }
}
function ensureFrameTapTargets(doc = frame.contentDocument){
  if (!doc) return;
  let style = doc.getElementById('plan-review-tap-target-styles');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'plan-review-tap-target-styles';
    style.textContent = '[data-plan-node-id]{cursor:pointer;-webkit-tap-highlight-color:rgba(56,189,248,.18)}';
    (doc.head || doc.documentElement).appendChild(style);
  }
  doc.querySelectorAll('[data-plan-node-id]').forEach(element => {
    if (element.dataset.planReviewTapTarget === 'true') return;
    element.dataset.planReviewTapTarget = 'true';
    element.addEventListener('click', () => {}, false);
  });
}
function clearCommentAnchors(){
  document.querySelectorAll('.comment-anchor').forEach(marker => marker.remove());
  try {
    frame.contentDocument?.querySelectorAll('.comment-anchor').forEach(marker => marker.remove());
  } catch {}
}
function anchorTextMatches(target, anchor){
  const targetText = (target?.textContent || '').toLowerCase();
  const fragments = [anchor?.textQuote?.exact, anchor?.selectedText, anchor?.textPreview].filter(value => typeof value === 'string' && value.trim().length > 0);
  if (fragments.length === 0) return true;
  return fragments.some(fragment => {
    const text = fragment.toLowerCase();
    if (targetText.includes(text) || text.includes(targetText)) return true;
    const tokens = [...new Set(text.match(/[a-z0-9_-]{4,}/g) || [])];
    if (tokens.length === 0) return false;
    const matches = tokens.filter(token => targetText.includes(token)).length;
    return matches >= Math.min(2, tokens.length) && matches / tokens.length >= 0.35;
  });
}
function rectForTarget(target){
  const rect = target.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
function xpathTarget(doc, xpath){
  try {
    const result = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue?.nodeType === 1 ? result.singleNodeValue : null;
  } catch { return null; }
}
function currentRectForComment(comment){
  const anchor = comment.anchor || {};
  const hasDomTarget = Boolean(anchor.planNodeId || anchor.cssSelector || anchor.xpath);
  try {
    const doc = frame.contentDocument;
    if (doc) {
      const byNodeId = anchor.planNodeId ? doc.querySelector(selectorForPlanNodeId(anchor.planNodeId)) : null;
      if (byNodeId) return rectForTarget(byNodeId);
      const diagram = anchor.diagram || {};
      const diagramSource = diagram.kind === 'mermaid' && diagram.sourcePlanNodeId
        ? doc.querySelector('[data-plan-mermaid-source-node-id=' + JSON.stringify(String(diagram.sourcePlanNodeId)) + '],[data-plan-node-id=' + JSON.stringify(String(diagram.sourcePlanNodeId)) + ']')
        : null;
      const diagramElement = diagramSource && diagram.elementKey
        ? doc.querySelector('[data-plan-mermaid-source-node-id=' + JSON.stringify(String(diagram.sourcePlanNodeId)) + '][data-plan-mermaid-element-key=' + JSON.stringify(String(diagram.elementKey)) + ']')
        : null;
      if (diagramElement) return rectForTarget(diagramElement);
      if (diagramSource) return rectForTarget(diagramSource);
      const bySelector = anchor.cssSelector ? doc.querySelector(anchor.cssSelector) : null;
      if (bySelector && anchorTextMatches(bySelector, anchor)) return rectForTarget(bySelector);
      const byXpath = anchor.xpath ? xpathTarget(doc, anchor.xpath) : null;
      if (byXpath && anchorTextMatches(byXpath, anchor)) return rectForTarget(byXpath);
    }
  } catch {}
  return hasDomTarget ? null : anchor.rect;
}
function redrawMarkers(){
  document.querySelectorAll('.marker').forEach(marker => marker.remove());
  clearCommentAnchors();
  markerCount = 0;
  for (const comment of markerComments) {
    const rect = currentRectForComment(comment);
    if (!rect) continue;
    markerCount = Math.max(markerCount, Number(comment.sequence) || 0);
    addCommentAnchor(rect, comment);
  }
}
function scheduleMarkerReflow(){
  if (markerReflowQueued) return;
  markerReflowQueued = true;
  requestAnimationFrame(() => {
    markerReflowQueued = false;
    redrawMarkers();
    updateSelectionBoxes();
  });
}
// On mobile the parent #review element is the native scroll container and the
// iframe is laid out at its full content height (no internal iframe scroll), so
// a finger drag on #plan-touch-layer scrolls #review natively while taps still
// reach the overlay. Touch events do NOT reach parent-registered listeners on
// the iframe document in iOS Safari, so the overlay is the only reliable tap
// surface there — keep it on top with pointer-events:auto + touch-action:pan-y.
function syncFrameHeight(){
  const doc = frame.contentDocument;
  if (!doc) {
    frame.style.height = '';
    if (planTouchLayer) planTouchLayer.style.height = '';
    return;
  }
  const height = Math.max(
    doc.documentElement?.scrollHeight || 0,
    doc.body?.scrollHeight || 0
  );
  if (height > 0) {
    frame.style.height = height + 'px';
    if (planTouchLayer) planTouchLayer.style.height = isMobileShell() ? height + 'px' : '';
  }
}
function reflowAfterContentChange(){
  ensureFrameWideScrollAffordances();
  syncFrameHeight();
  scheduleMarkerReflow();
}
function scheduleFrameImageReflows(){
  const doc = frame.contentDocument;
  if (!doc) return;
  for (const image of [...doc.images]) {
    if (image.complete) continue;
    image.addEventListener('load', reflowAfterContentChange, { once: true });
    image.addEventListener('error', reflowAfterContentChange, { once: true });
    if (typeof image.decode === 'function') void image.decode().then(reflowAfterContentChange, reflowAfterContentChange);
  }
}
function mermaidSourceText(source){
  const code = source.matches?.('pre') ? source.querySelector(':scope > code.language-mermaid') : null;
  return (code?.textContent || source.textContent || '').trim();
}
function initializeMermaid(){
  if (mermaidInitialized) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, deterministicIds: true, deterministicIDSeed: planId, maxTextSize: 50000, theme: 'dark', themeVariables: { background: '#0f172a', primaryColor: '#1e3a8a', primaryTextColor: '#e5e7eb', primaryBorderColor: '#38bdf8', lineColor: '#93c5fd', textColor: '#e5e7eb' } });
  mermaidInitialized = true;
}
const allowedSvgTags = new Set(['svg','g','path','line','polyline','polygon','rect','circle','ellipse','text','tspan','defs','marker','style','title','desc']);
const allowedSvgAttrs = new Set(['id','class','style','role','viewBox','viewbox','xmlns','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','width','height','d','points','transform','marker-end','marker-start','marker-mid','orient','refX','refY','refx','refy','markerWidth','markerHeight','markerwidth','markerheight','text-anchor','dominant-baseline','font-size','font-family','font-weight','fill','stroke','stroke-width','stroke-dasharray','stroke-linecap','stroke-linejoin','opacity','fill-opacity','stroke-opacity','dy','dx','startOffset']);
function hasUnsafeSvgCss(text){
  const css = String(text || '');
  if (/@import|javascript:|data:|https?:|\\/\\/|expression\\(|-moz-binding/i.test(css)) return true;
  return /url\\(/i.test(css.replace(/url\\(\\s*['"]?#[a-zA-Z0-9_-]+['"]?\\s*\\)/gi, ''));
}
function isSafeSvgAttributeValue(name, value){
  const text = String(value || '').trim();
  if (/^(?:href|xlink:href|src)$/i.test(name)) return false;
  if (String(name || '').toLowerCase() === 'style') return !hasUnsafeSvgCss(text);
  if (/javascript:|data:|https?:|\\/\\//i.test(text)) return false;
  if (/url\\(/i.test(text) && !/^url\\(['"]?#[a-zA-Z0-9_-]+['"]?\\)$/i.test(text)) return false;
  return true;
}
function hardenMermaidSvg(svgText){
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (!svg || svg.tagName.toLowerCase() === 'parsererror') throw new Error('Mermaid returned invalid SVG');
  const nodes = [...svg.querySelectorAll('*'), svg];
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    if (!allowedSvgTags.has(tag)) {
      node.remove();
      continue;
    }
    if (tag === 'style' && hasUnsafeSvgCss(node.textContent || '')) {
      node.remove();
      continue;
    }
    for (const attr of [...node.attributes]) {
      const name = attr.name;
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || lower === 'xlink:href' || (lower === 'href' && tag !== 'a') || lower === 'src') {
        node.removeAttribute(name);
        continue;
      }
      if (lower.startsWith('aria-') || lower.startsWith('data-')) continue;
      if ((!allowedSvgAttrs.has(name) && !allowedSvgAttrs.has(lower)) || !isSafeSvgAttributeValue(name, attr.value)) node.removeAttribute(name);
    }
  }
  return new XMLSerializer().serializeToString(svg);
}
function mermaidElementLabel(element){
  return (element.getAttribute('data-id') || element.getAttribute('id') || element.textContent || element.tagName || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
}
function isMajorMermaidElement(element){
  return element.matches('g.node,g.cluster,g.edgePath,g.edgeLabel,.node,.cluster,.edgePath,.edgeLabel,.flowchart-link,path.flowchart-link,path[class*="edge"],path[marker-end],path[marker-start],line[marker-end],polyline[marker-end],polygon[marker-end]');
}
function prepareMermaidSvg(svg, wrapper, sourceNodeId){
  const candidates = [...svg.querySelectorAll('g.node,g.cluster,g.edgePath,g.edgeLabel,.node,.cluster,.edgePath,.edgeLabel,.flowchart-link,path.flowchart-link,path[class*="edge"],path[marker-end],path[marker-start],line[marker-end],polyline[marker-end],polygon[marker-end],text')];
  let index = 0;
  for (const element of candidates) {
    if (element.closest('[data-plan-mermaid-element="true"]') && !isMajorMermaidElement(element)) continue;
    const label = mermaidElementLabel(element);
    const existing = element.getAttribute('id') || element.getAttribute('data-id') || '';
    const keyBase = (existing || element.className?.baseVal || element.className || element.tagName || 'element') + '-' + index + '-' + hashString(label || element.outerHTML || String(index));
    const key = keyBase.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'element-' + index;
    element.setAttribute('data-plan-mermaid-element', 'true');
    element.setAttribute('data-plan-mermaid-source-node-id', sourceNodeId);
    element.setAttribute('data-plan-mermaid-element-key', key);
    element.setAttribute('data-plan-mermaid-element-label', label);
    element.setAttribute('data-plan-node-id', sourceNodeId + '--svg-' + key);
    index += 1;
  }
  wrapper.setAttribute('data-plan-mermaid-element', 'true');
  wrapper.setAttribute('data-plan-mermaid-source-node-id', sourceNodeId);
  wrapper.setAttribute('data-plan-mermaid-element-key', 'diagram');
  wrapper.setAttribute('data-plan-mermaid-element-label', 'Mermaid diagram');
}
function mermaidErrorPanel(doc, source, error){
  const panel = doc.createElement('div');
  panel.className = 'plan-mermaid-error';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Mermaid render error');
  for (const attr of source.attributes) {
    if (attr.name.startsWith('data-plan-')) panel.setAttribute(attr.name, attr.value);
  }
  panel.setAttribute('data-plan-mermaid-status', 'error');
  panel.innerHTML = '<strong>Mermaid diagram could not render.</strong><pre></pre><p></p>';
  panel.querySelector('pre').textContent = mermaidSourceText(source).slice(0, 1200);
  panel.querySelector('p').textContent = String(error?.message || error || 'Unknown Mermaid error').slice(0, 500);
  return panel;
}
async function renderMermaidDiagrams(){
  const doc = frame.contentDocument;
  if (!doc) return;
  ensureFrameMermaidStyles();
  const generation = ++mermaidRenderGeneration;
  const sources = [...doc.querySelectorAll('[data-plan-mermaid-source="true"]')].filter(source => !source.closest('.plan-mermaid-rendered'));
  if (sources.length === 0) return;
  initializeMermaid();
  for (const source of sources) {
    const sourceNodeId = source.getAttribute('data-plan-node-id') || 'mermaid-' + hashString(mermaidSourceText(source));
    const sourceHash = source.getAttribute('data-plan-mermaid-source-hash') || hashString(mermaidSourceText(source));
    try {
      const renderId = 'plan-mermaid-' + sourceNodeId.replace(/[^a-zA-Z0-9_-]+/g, '-') + '-' + sourceHash.slice(0, 12);
      const result = await mermaid.render(renderId, mermaidSourceText(source));
      if (generation !== mermaidRenderGeneration || !source.isConnected) return;
      const wrapper = doc.createElement('figure');
      wrapper.className = 'plan-mermaid-rendered';
      wrapper.setAttribute('data-plan-node-id', sourceNodeId);
      wrapper.setAttribute('data-plan-mermaid-source', 'true');
      wrapper.setAttribute('data-plan-mermaid-source-hash', sourceHash);
      wrapper.setAttribute('data-plan-mermaid-status', 'rendered');
      wrapper.innerHTML = hardenMermaidSvg(result.svg);
      const svg = wrapper.querySelector('svg');
      if (!svg) throw new Error('Mermaid did not return an SVG');
      svg.setAttribute('role', svg.getAttribute('role') || 'img');
      svg.setAttribute('aria-label', svg.getAttribute('aria-label') || 'Mermaid diagram');
      prepareMermaidSvg(svg, wrapper, sourceNodeId);
      const details = doc.createElement('details');
      details.className = 'plan-mermaid-source-copy';
      details.innerHTML = '<summary>Mermaid source</summary><pre></pre>';
      details.querySelector('pre').textContent = mermaidSourceText(source);
      wrapper.appendChild(details);
      source.replaceWith(wrapper);
    } catch (error) {
      if (generation !== mermaidRenderGeneration || !source.isConnected) return;
      source.replaceWith(mermaidErrorPanel(doc, source, error));
    }
  }
  scheduleMarkerReflow();
}
async function markerScreenshot(anchor){
  if (typeof html2canvas !== 'function' || !frame.contentDocument || !frame.contentWindow) {
    throw new Error('html2canvas unavailable');
  }
    const rect = anchor.rect || { x:0, y:0, width:1, height:1 };
    const target = selectedForScreenshot || frame.contentDocument.body;
    const targetRect = target.getBoundingClientRect();
    const cropWidth = Math.min(960, Math.max(320, targetRect.width || rect.width || 1));
    const cropHeight = Math.min(640, Math.max(220, targetRect.height || rect.height || 1));
    const captureRoot = document.createElement('div');
    captureRoot.style.position = 'fixed';
    captureRoot.style.left = '-10000px';
    captureRoot.style.top = '0';
    captureRoot.style.width = cropWidth + 'px';
    captureRoot.style.minHeight = cropHeight + 'px';
    captureRoot.style.padding = '16px';
    captureRoot.style.background = '#ffffff';
    captureRoot.style.color = '#0f172a';
    captureRoot.style.font = getComputedStyle(document.body).font;
    captureRoot.innerHTML = target.outerHTML || target.textContent || '';
    document.body.appendChild(captureRoot);
    let canvas;
    try {
      canvas = await Promise.race([
        html2canvas(captureRoot, { backgroundColor: '#ffffff', width: cropWidth, height: cropHeight, useCORS: false, allowTaint: false }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('html2canvas_timeout')), 1500))
      ]);
    } finally {
      captureRoot.remove();
    }
    const ctx = canvas.getContext('2d');
    const markerX = Math.min(canvas.width - 16, Math.max(16, rect.width ? rect.width - 10 : 16));
    const markerY = 16;
    ctx.fillStyle = '#0ea5e9'; ctx.strokeStyle = '#dbeafe'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(markerX, markerY, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = '700 13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(markerCount), markerX, markerY + 1);
  return { contentType:'image/png', bytesBase64: canvas.toDataURL('image/png').split(',')[1], width: canvas.width, height: canvas.height, captureRect: { x: targetRect.x, y: targetRect.y, width: cropWidth, height: cropHeight }, viewport:{ width:innerWidth, height:innerHeight } };
}
function domPathFor(element){
  const parts=[]; let node=element;
  while(node && node.nodeType===1 && parts.length<8){ const parent=node.parentElement; const index=parent ? [...parent.children].filter(child=>child.tagName===node.tagName).indexOf(node)+1 : 1; parts.unshift(node.tagName.toLowerCase()+'['+index+']'); node=parent; }
  return parts.join('/');
}
function xpathFor(element){ return '/' + domPathFor(element); }
function headingPathFor(element){
  const headings=[]; let node=element;
  while(node){ const heading=node.querySelector && node.querySelector('h1,h2,h3,h4,h5,h6'); if(heading) headings.unshift(heading.textContent.trim().slice(0,80)); node=node.parentElement; }
  return [...new Set(headings)].slice(-5);
}
function cssFor(element){
  try { return finder(element, { root: frame.contentDocument.body }); } catch {}
  if(element.id) return '#'+CSS.escape(element.id);
  const nodeId=element.getAttribute('data-plan-node-id');
  if(nodeId) return element.tagName.toLowerCase()+'[data-plan-node-id="'+nodeId.replace(/"/g,'')+'"]';
  return element.tagName.toLowerCase();
}
async function mountWashiOverlay(){
  try {
    if (washi) washi.unmount();
    washi = new Washi({ load: async () => [], save: async () => {}, update: async () => {}, delete: async () => {} });
    await washi.mount(frame, { readOnly: true, disableBuiltinDialog: true });
    washi.setMode('view');
  } catch (error) {
    console.warn('washi overlay unavailable', error);
  }
}
function addMarker(rect, label){
  if (!label) markerCount += 1;
  const frameRect = frame.getBoundingClientRect();
  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.textContent = String(label || markerCount);
  const x = Number(rect.x ?? rect.left ?? 0);
  const y = Number(rect.y ?? rect.top ?? 0);
  marker.style.left = Math.max(8, frameRect.left + x + Number(rect.width ?? 0) - 10) + 'px';
  marker.style.top = Math.max(8, frameRect.top + y - 10) + 'px';
  document.getElementById('review').appendChild(marker);
  return marker;
}
function anchorStatusClass(comment){
  return comment.status === 'claimed' || comment.status === 'acknowledged' || comment.status === 'resolved'
    ? comment.status
    : 'pending';
}
function addCommentAnchor(rect, comment){
  const doc = ensureFrameAnchorStyles();
  if (!doc) return null;
  const win = frame.contentWindow;
  const anchor = doc.createElement('div');
  anchor.className = 'comment-anchor ' + anchorStatusClass(comment);
  anchor.dataset.commentId = comment.id;
  const x = Number(rect.x ?? rect.left ?? 0);
  const y = Number(rect.y ?? rect.top ?? 0);
  const width = Number(rect.width ?? 0);
  const height = Number(rect.height ?? 0);
  anchor.style.left = ((win?.scrollX || 0) + x) + 'px';
  anchor.style.top = ((win?.scrollY || 0) + y) + 'px';
  anchor.style.width = Math.max(1, width) + 'px';
  anchor.style.height = Math.max(1, height) + 'px';
  const label = doc.createElement('div');
  label.className = 'comment-anchor-label';
  label.textContent = String(comment.sequence || '');
  anchor.appendChild(label);
  doc.body.appendChild(anchor);
  return anchor;
}
function assetIdFor(element){
  const value = element.getAttribute('data-plan-image-hash') || element.currentSrc || element.src || '';
  const match = value.match(/\\/assets\\/([^?#]+)/);
  return match ? match[1] : value || undefined;
}
function hashString(value){
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function eventPoint(event){
  const touch = event?.changedTouches?.[0] || event?.touches?.[0];
  if (touch) return { clientX: touch.clientX, clientY: touch.clientY };
  if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) return { clientX: event.clientX, clientY: event.clientY };
  return null;
}
function imagePointFor(element, event){
  const rect = element.getBoundingClientRect();
  const point = eventPoint(event);
  const x = point ? Math.min(1, Math.max(0, (point.clientX - rect.left) / Math.max(1, rect.width))) : 0.5;
  const y = point ? Math.min(1, Math.max(0, (point.clientY - rect.top) / Math.max(1, rect.height))) : 0.5;
  return { x, y };
}
function displayedRectFor(element){
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
function positionSelectionBox(box, element){
  if (!box || !element || !frame.contentDocument?.contains(element)) {
    if (box) box.hidden = true;
    return;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    box.hidden = true;
    return;
  }
  const frameRect = frame.getBoundingClientRect();
  box.style.left = (frameRect.left + rect.left) + 'px';
  box.style.top = (frameRect.top + rect.top) + 'px';
  box.style.width = rect.width + 'px';
  box.style.height = rect.height + 'px';
  box.hidden = false;
}
function updateSelectionBoxes(){
  positionSelectionBox(hoverSelectionBox, hovered && hovered !== selected ? hovered : null);
  positionSelectionBox(activeSelectionBox, selected);
}
const nativeInteractiveSelector = 'a[href],button,input,textarea,select,summary,area[href]';
function elementFromEvent(event){
  const rawTarget = event?.target;
  return rawTarget?.nodeType === 1 ? rawTarget : rawTarget?.parentElement;
}
function interactiveTargetFromElement(element){
  const nativeTarget = element?.closest?.(nativeInteractiveSelector);
  if (nativeTarget) return nativeTarget;
  const label = element?.closest?.('label');
  return label?.control ? label : null;
}
function interactiveTargetFromEvent(event){
  return interactiveTargetFromElement(elementFromEvent(event));
}
function interactiveTargetFromPoint(doc, event){
  const touch = event.changedTouches?.[0] || event.touches?.[0];
  if (!touch) return interactiveTargetFromEvent(event);
  return interactiveTargetFromElement(doc.elementFromPoint(touch.clientX, touch.clientY));
}
function interactiveTargetFromTouchPoint(doc, point){
  if (!point) return null;
  return interactiveTargetFromElement(doc.elementFromPoint(point.x, point.y));
}
function planShellUrlForAnchor(anchor){
  if (!anchor?.href) return null;
  const targetName = anchor.getAttribute?.('target');
  if (targetName && targetName !== '_self') return null;
  let url;
  try {
    url = new URL(anchor.href, frame.contentWindow?.location.href || window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 2 || pathParts[0] !== 'p') return null;
  return url.pathname + url.search + url.hash;
}
function shouldPreserveBrowserLinkActivation(event){
  if (!event) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;
  return typeof event.button === 'number' && event.button !== 0;
}
function navigatePlanShellLink(anchor, event){
  if (shouldPreserveBrowserLinkActivation(event)) return false;
  const url = planShellUrlForAnchor(anchor);
  if (!url) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  window.location.assign(url);
  return true;
}
function fragmentTargetForAnchor(anchor){
  if (!anchor?.href || !frame.contentWindow || !frame.contentDocument) return null;
  const targetName = anchor.getAttribute?.('target');
  if (targetName && targetName !== '_self') return null;
  const rawHref = anchor.getAttribute?.('href') || '';
  let url;
  try {
    url = new URL(anchor.href, frame.contentWindow.location.href);
  } catch {
    return null;
  }
  const isEmptyFragment = rawHref.trim() === '#' || url.href.endsWith('#');
  if ((!url.hash && !isEmptyFragment) || url.origin !== frame.contentWindow.location.origin || url.pathname !== frame.contentWindow.location.pathname || url.search !== frame.contentWindow.location.search) return null;
  let id = url.hash.slice(1);
  try { id = decodeURIComponent(id); } catch {}
  if (!id) return frame.contentDocument.documentElement;
  return frame.contentDocument.getElementById(id) || [...frame.contentDocument.querySelectorAll('a[name]')].find(item => item.getAttribute('name') === id) || null;
}
function scrollShellToFrameTarget(target){
  const rect = target.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  if (isMobileShell()) {
    const review = document.getElementById('review');
    if (!review) return;
    const reviewRect = review.getBoundingClientRect();
    review.scrollTo({ top: review.scrollTop + frameRect.top - reviewRect.top + rect.top, behavior: 'auto' });
    return;
  }
  const navbarHeight = document.getElementById('plan-navbar')?.getBoundingClientRect().height || 0;
  window.scrollTo({ top: window.scrollY + frameRect.top + rect.top - navbarHeight, behavior: 'auto' });
  armPostProgrammaticScrollWheelHandoff();
}
function navigateFrameFragmentLink(anchor, event){
  if (shouldPreserveBrowserLinkActivation(event)) return false;
  const target = fragmentTargetForAnchor(anchor);
  if (!target) return false;
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const url = new URL(anchor.href, frame.contentWindow.location.href);
  frame.contentWindow.history.pushState(null, '', url.pathname + url.search + url.hash);
  scrollShellToFrameTarget(target);
  scheduleMarkerReflow();
  return true;
}
function mermaidCommentTarget(element){
  return element?.closest?.('[data-plan-mermaid-element="true"],[data-plan-mermaid-source="true"]') || null;
}
function commentTargetFromEvent(event){
  const element = elementFromEvent(event);
  return mermaidCommentTarget(element) || element?.closest?.('[data-plan-node-id]') || element || null;
}
function commentTargetFromPoint(doc, event){
  const touch = event.changedTouches?.[0] || event.touches?.[0];
  if (!touch) return commentTargetFromEvent(event);
  const element = doc.elementFromPoint(touch.clientX, touch.clientY);
  return mermaidCommentTarget(element) || element?.closest?.('[data-plan-node-id]') || element || commentTargetFromEvent(event);
}
function commentTargetFromTouchPoint(doc, point, fallbackTarget){
  if (!point) return fallbackTarget;
  const element = doc.elementFromPoint(point.x, point.y);
  return mermaidCommentTarget(element) || element?.closest?.('[data-plan-node-id]') || element || fallbackTarget;
}
function frameTouchPoint(event){
  const point = eventPoint(event);
  if (!point) return null;
  const rect = frame.getBoundingClientRect();
  return { x: point.clientX - rect.left, y: point.clientY - rect.top };
}
function frameHorizontalScrollRegionFromPoint(point){
  const doc = frame.contentDocument;
  if (!doc || !point) return null;
  const target = doc.elementFromPoint(point.x, point.y);
  const region = target?.closest?.('table,pre,.plan-mermaid-rendered,.plan-mermaid-error,figure[data-plan-wide],.plan-review-wide-scroll');
  if (!region || typeof region.scrollWidth !== 'number' || typeof region.clientWidth !== 'number') return null;
  return region.scrollWidth > region.clientWidth + 1 ? region : null;
}
function startWideScrollTouch(point){
  const region = frameHorizontalScrollRegionFromPoint(point);
  wideScrollTouch = region && point ? { element: region, startX: point.x, startY: point.y, startScrollLeft: region.scrollLeft, active: false } : null;
}
function updateWideScrollTouch(point){
  if (!wideScrollTouch || !point) return false;
  const dx = point.x - wideScrollTouch.startX;
  const dy = point.y - wideScrollTouch.startY;
  if (!wideScrollTouch.active && (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy))) return false;
  wideScrollTouch.active = true;
  wideScrollTouch.element.scrollLeft = wideScrollTouch.startScrollLeft - dx;
  return true;
}
function clearWideScrollTouch(){ wideScrollTouch = null; }
function touchPoint(event){
  const point = eventPoint(event);
  return point ? { x: point.clientX, y: point.clientY } : null;
}
function touchMovedToPoint(start, point){
  if (!start || !point) return Boolean(start?.moved);
  return start.moved || Math.hypot(point.x - start.x, point.y - start.y) > 12;
}
function touchMoved(start, event){
  return touchMovedToPoint(start, touchPoint(event));
}
function eventForTouchPoint(point, fallbackEvent){
  return point ? { clientX: point.x, clientY: point.y } : fallbackEvent;
}
function activateFrameInteractiveTarget(point, sourceLabel, event){
  const doc = frame.contentDocument;
  if (!doc || !point) return false;
  const target = interactiveTargetFromTouchPoint(doc, point);
  if (!target) return false;
  debugTouch(sourceLabel + '-interactive', { tag: target.tagName, id: target.id || '', href: target.getAttribute?.('href') || '' });
  const anchor = target.closest?.('a[href],area[href]');
  if (anchor) {
    if (shouldPreserveBrowserLinkActivation(event)) return false;
    if (navigatePlanShellLink(anchor, event)) return true;
    if (navigateFrameFragmentLink(anchor, event)) return true;
    const href = anchor.href;
    const targetName = anchor.getAttribute('target');
    if (targetName && targetName !== '_self') {
      frame.contentWindow?.open(href, targetName, 'noopener,noreferrer');
    } else {
      frame.contentWindow.location.href = href;
    }
    return true;
  }
  target.click?.();
  return true;
}
function openComposerFromFramePoint(point, sourceLabel, event){
  const doc = frame.contentDocument;
  if (!doc || !point) {
    debugTouch(sourceLabel + '-blocked', { hasDoc: Boolean(doc), point });
    return false;
  }
  const interactive = interactiveTargetFromTouchPoint(doc, point);
  const target = commentTargetFromTouchPoint(doc, point, doc.body);
  debugTouch(sourceLabel, { point, interactive: Boolean(interactive), target: target?.tagName || null, id: target?.id || '', node: target?.getAttribute?.('data-plan-node-id') || null });
  if (interactive) return activateFrameInteractiveTarget(point, sourceLabel, event);
  return openElementComposer(target, eventForTouchPoint(point, event || null));
}
function openElementComposer(element, event){
  if (submitInFlight || !element || typeof element.getBoundingClientRect !== 'function') {
    debugTouch('open-blocked', { submitInFlight, hasElement: Boolean(element), tag: element?.tagName || null });
    return false;
  }
  selected = mermaidCommentTarget(element) || element.closest?.('[data-plan-node-id]') || element;
  selectedForScreenshot = selected;
  pendingAnchor = anchorForElement(selected, event);
  updateSelectionBoxes();
  if (selected.tagName?.toLowerCase() === 'img') showLightbox(selected);
  clearDiscardWarning();
  showComposer();
  debugTouch('open-composer', { tag: selected.tagName, id: selected.id || '', node: selected.getAttribute('data-plan-node-id'), x: event?.clientX, y: event?.clientY });
  return true;
}
function prepareMobileTextSelectionSurround(){
  if (!isMobileShell()) return;
  selected = selectedForScreenshot;
  updateSelectionBoxes();
}
function releaseMobileNativeSelection(selection){
  if (!isMobileShell()) return;
  setTimeout(() => {
    try {
      selection.removeAllRanges();
    } catch {}
    body.focus({ preventScroll: true });
  }, 0);
}
function scheduleSelectionBoxUpdate(){
  if (selectionBoxReflowQueued) return;
  selectionBoxReflowQueued = true;
  requestAnimationFrame(() => {
    selectionBoxReflowQueued = false;
    updateSelectionBoxes();
  });
}
function clearPendingSelection(){
  hovered = null;
  selected = null;
  selectedForScreenshot = null;
  pendingAnchor = null;
  pendingCommentMutationId = null;
  setSubmitInFlight(false);
  body.value = '';
  clearDiscardWarning();
  if (composerContext) { composerContext.textContent = ''; composerContext.hidden = true; }
  composer.hidden = true;
  lightbox.hidden = true;
  imageSelectionBox.hidden = true;
  updateSelectionBoxes();
}
function applyImageTransform(){
  lightboxImage.style.transform = 'translate('+panX+'px, '+panY+'px) scale('+zoom+')';
  if (pendingAnchor?.type === 'image') pendingAnchor.anchor.zoomState = { scale: zoom, panX, panY };
}
function anchorForElement(element, event){
  const rect = element.getBoundingClientRect();
  const isImage = element.tagName.toLowerCase() === 'img';
  const point = isImage ? imagePointFor(element, event) : undefined;
  const mermaidWrapper = element.closest?.('.plan-mermaid-rendered,.plan-mermaid-error');
  const sourcePlanNodeId = mermaidWrapper?.getAttribute('data-plan-mermaid-source-node-id') || mermaidWrapper?.getAttribute('data-plan-node-id');
  const sourceHash = mermaidWrapper?.getAttribute('data-plan-mermaid-source-hash');
  const elementKey = element.getAttribute('data-plan-mermaid-element-key') || (mermaidWrapper ? 'diagram' : undefined);
  const elementLabel = element.getAttribute('data-plan-mermaid-element-label') || (mermaidWrapper ? mermaidElementLabel(element) : undefined);
  return {
    type: isImage ? 'image' : 'dom',
    anchor: {
      planNodeId: element.getAttribute('data-plan-node-id'),
      cssSelector: cssFor(element),
      domPath: domPathFor(element),
      xpath: xpathFor(element),
      textQuote: { exact: element.textContent.trim().slice(0, 160), prefix: '', suffix: '' },
      headingPath: headingPathFor(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
      textPreview: element.textContent.trim().slice(0, 120),
      outerHtmlPreview: element.outerHTML.slice(0, 500),
      sourceUrl: element.getAttribute('data-plan-image-source') || element.currentSrc || element.src || undefined,
      imageAssetId: isImage ? assetIdFor(element) : undefined,
      imageHash: isImage ? (element.getAttribute('data-plan-image-hash') || hashString(element.currentSrc || element.src || element.outerHTML)) : undefined,
      naturalSize: isImage ? { width: element.naturalWidth, height: element.naturalHeight } : undefined,
      displayedRect: isImage ? displayedRectFor(element) : undefined,
      zoomState: isImage ? { scale: zoom, panX, panY } : undefined,
      normalizedPoint: point,
      diagram: sourcePlanNodeId && sourceHash ? { kind: 'mermaid', sourcePlanNodeId, sourceHash, elementKey, elementLabel } : undefined
    },
    rect
  };
}
function showLightbox(element){
  lightboxImage.src = element.currentSrc || element.src;
  lightboxImage.alt = element.alt || 'Plan image';
  zoom = 1;
  panX = 0;
  panY = 0;
  panMode = false;
  applyImageTransform();
  imageSelectionBox.hidden = true;
  lightbox.hidden = false;
}
function lightboxImagePoint(event){
  const rect = lightboxImage.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)))
  };
}
function updateImageRectangle(start, end){
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (pendingAnchor?.type === 'image') {
    pendingAnchor.anchor.normalizedRect = { x, y, width, height };
    pendingAnchor.anchor.zoomState = { scale: zoom, panX, panY };
    pendingAnchor.anchor.displayedRect = displayedRectFor(selected);
  }
  const imageRect = lightboxImage.getBoundingClientRect();
  const stageRect = lightboxStage.getBoundingClientRect();
  imageSelectionBox.style.left = (imageRect.left - stageRect.left + x * imageRect.width) + 'px';
  imageSelectionBox.style.top = (imageRect.top - stageRect.top + y * imageRect.height) + 'px';
  imageSelectionBox.style.width = (width * imageRect.width) + 'px';
  imageSelectionBox.style.height = (height * imageRect.height) + 'px';
  imageSelectionBox.hidden = width < 0.01 || height < 0.01;
}
function anchorForSelection(selection){
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const context = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const start = range.startContainer.parentElement || context || frame.contentDocument.body;
  const end = range.endContainer.parentElement || start;
  const contextElement = context || start;
  selectedForScreenshot = contextElement;
  return {
    type: 'text_range',
    anchor: {
      startContainerSelector: cssFor(start),
      startOffset: range.startOffset,
      endContainerSelector: cssFor(end),
      endOffset: range.endOffset,
      selectedText: selection.toString(),
      clientRects: [...range.getClientRects()].map(item => ({ x:item.x, y:item.y, width:item.width, height:item.height })),
      planNodeId: contextElement.getAttribute('data-plan-node-id'),
      cssSelector: cssFor(contextElement),
      domPath: domPathFor(contextElement),
      xpath: xpathFor(contextElement),
      textQuote: { exact: selection.toString(), prefix: contextElement.textContent.slice(0, 80), suffix: contextElement.textContent.slice(-80) },
      headingPath: headingPathFor(contextElement),
      textPreview: selection.toString().slice(0,120),
      outerHtmlPreview: contextElement.outerHTML.slice(0, 500),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight }
    },
    rect
  };
}
let frameListenersAttached = false;
function attachFrameListeners(){
  if (frameListenersAttached || !frame.contentDocument) return;
  frameListenersAttached = true;
  const doc = frame.contentDocument;
  ensureFrameTapTargets(doc);
  doc.addEventListener('keydown', handleQuickOpenKeydown, true);
  debugTouch('listeners-attached', { readyState: doc.readyState, url: doc.location.href });
  const adoptTextSelection = () => {
    if (submitInFlight || !composer.hidden) return false;
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
    pendingAnchor = anchorForSelection(selection);
    prepareMobileTextSelectionSurround();
    clearDiscardWarning();
    showComposer();
    releaseMobileNativeSelection(selection);
    return true;
  };
  doc.addEventListener('mouseup', () => { adoptTextSelection(); }, true);
  doc.addEventListener('touchstart', event => {
    const point = touchPoint(event);
    touchStart = point ? { ...point, moved: false } : null;
    debugTouch('touchstart', { point, target: elementFromEvent(event)?.tagName || null, id: elementFromEvent(event)?.id || '' });
    if (interactiveTargetFromPoint(doc, event)) {
      hovered = null;
      scheduleSelectionBoxUpdate();
      return;
    }
    const target = commentTargetFromEvent(event);
    if (target && target !== hovered) {
      hovered = target;
      scheduleSelectionBoxUpdate();
    }
  }, passiveTouchCapture);
  doc.addEventListener('touchmove', event => {
    if (!touchStart) return;
    if (touchMoved(touchStart, event)) {
      touchStart.moved = true;
      debugTouch('touchmove-moved', { point: touchPoint(event) });
      hovered = null;
      scheduleSelectionBoxUpdate();
    }
  }, passiveTouchCapture);
  doc.addEventListener('touchend', event => {
    const endPoint = touchPoint(event);
    const fallbackTarget = commentTargetFromEvent(event);
    const endedOnInteractiveTarget = Boolean(interactiveTargetFromTouchPoint(doc, endPoint) || interactiveTargetFromEvent(event));
    const target = commentTargetFromTouchPoint(doc, endPoint, fallbackTarget);
    const anchorEvent = eventForTouchPoint(endPoint, event);
    const start = touchStart;
    touchStart = null;
    const moved = touchMovedToPoint(start, endPoint);
    debugTouch('touchend', { endPoint, start, moved, interactive: endedOnInteractiveTarget, target: target?.tagName || null, id: target?.id || '', node: target?.getAttribute?.('data-plan-node-id') || null });
    if (moved || endedOnInteractiveTarget) return;
    if (adoptTextSelection()) {
      debugTouch('adopt-selection-sync');
      return;
    }
    if (openElementComposer(target, anchorEvent)) suppressSyntheticClickUntil = Date.now() + 700;
    setTimeout(() => {
      if (adoptTextSelection()) debugTouch('adopt-selection-deferred');
    }, 120);
  }, true);
  doc.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const point = touchPoint(event);
    pointerStart = point ? { ...point, moved: false } : null;
  }, true);
  doc.addEventListener('pointermove', event => {
    if (!pointerStart || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    if (touchMoved(pointerStart, event)) pointerStart.moved = true;
  }, true);
  doc.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const endPoint = touchPoint(event);
    const start = pointerStart;
    pointerStart = null;
    if (touchMovedToPoint(start, endPoint) || Date.now() < suppressSyntheticClickUntil) return;
    if (interactiveTargetFromEvent(event)) return;
    if (adoptTextSelection()) return;
    if (openElementComposer(commentTargetFromEvent(event), event)) suppressSyntheticClickUntil = Date.now() + 700;
  }, true);
  doc.addEventListener('mousemove', event => {
    if (interactiveTargetFromEvent(event)) {
      hovered = null;
      scheduleSelectionBoxUpdate();
      return;
    }
    const target = commentTargetFromEvent(event);
    if (target && target !== hovered) {
      hovered = target;
      scheduleSelectionBoxUpdate();
    }
  }, true);
  doc.addEventListener('mouseleave', () => {
    hovered = null;
    scheduleSelectionBoxUpdate();
  }, true);
  doc.addEventListener('click', event => {
    debugTouch('click', { target: elementFromEvent(event)?.tagName || null, id: elementFromEvent(event)?.id || '', suppressed: Date.now() < suppressSyntheticClickUntil });
    const interactiveTarget = interactiveTargetFromEvent(event);
    if (interactiveTarget) {
      const anchor = interactiveTarget.closest?.('a[href],area[href]');
      if (anchor && (navigatePlanShellLink(anchor, event) || navigateFrameFragmentLink(anchor, event))) return;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() < suppressSyntheticClickUntil) return;
    if (adoptTextSelection()) return;
    openElementComposer(commentTargetFromEvent(event), event);
  }, true);
  doc.addEventListener('scroll', scheduleMarkerReflow, true);
  frame.contentWindow?.addEventListener('scroll', scheduleMarkerReflow);
  frame.contentWindow?.addEventListener('resize', scheduleMarkerReflow);
}
frame.addEventListener('load', () => { frameListenersAttached = false; attachFrameListeners(); void renderMermaidDiagrams().finally(() => { ensureFrameMobileReadabilityStyles(); mountWashiOverlay(); syncFrameHeight(); redrawMarkers(); }); });
frame.addEventListener('touchstart', event => {
  const point = frameTouchPoint(event);
  touchStart = point ? { ...point, moved: false } : null;
  debugTouch('frame-touchstart', { point });
}, passiveTouchCapture);
frame.addEventListener('touchmove', event => {
  if (!touchStart) return;
  const point = frameTouchPoint(event);
  if (touchMovedToPoint(touchStart, point)) {
    touchStart.moved = true;
    debugTouch('frame-touchmove-moved', { point });
  }
}, passiveTouchCapture);
frame.addEventListener('touchend', event => {
  const point = frameTouchPoint(event);
  const start = touchStart;
  touchStart = null;
  const moved = touchMovedToPoint(start, point);
  debugTouch('frame-touchend', { point, start, moved });
  if (moved) return;
  if (openComposerFromFramePoint(point, 'frame-open', event)) suppressSyntheticClickUntil = Date.now() + 700;
}, true);
frame.addEventListener('click', event => {
  if (Date.now() < suppressSyntheticClickUntil) return;
  const point = frameTouchPoint(event);
  if (openComposerFromFramePoint(point, 'frame-click-open', event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
planTouchLayer?.addEventListener('touchstart', event => {
  const point = frameTouchPoint(event);
  touchStart = point ? { ...point, moved: false } : null;
  startWideScrollTouch(point);
  debugTouch('layer-touchstart', { point, wideScroll: Boolean(wideScrollTouch) });
}, passiveTouchCapture);
planTouchLayer?.addEventListener('touchmove', event => {
  if (!touchStart) return;
  const point = frameTouchPoint(event);
  if (updateWideScrollTouch(point)) touchStart.moved = true;
  else if (touchMovedToPoint(touchStart, point)) touchStart.moved = true;
  debugTouch('layer-touchmove', { point, moved: Boolean(touchStart?.moved), wideScroll: Boolean(wideScrollTouch?.active) });
}, passiveTouchCapture);
planTouchLayer?.addEventListener('touchend', event => {
  const point = frameTouchPoint(event);
  const start = touchStart;
  const moved = touchMovedToPoint(start, point) || Boolean(wideScrollTouch?.active);
  touchStart = null;
  clearWideScrollTouch();
  debugTouch('layer-touchend', { point, start, moved });
  if (moved) return;
  if (openComposerFromFramePoint(point, 'layer-open', event)) suppressSyntheticClickUntil = Date.now() + 700;
}, true);
planTouchLayer?.addEventListener('click', event => {
  if (Date.now() < suppressSyntheticClickUntil) return;
  const point = frameTouchPoint(event);
  if (openComposerFromFramePoint(point, 'layer-click-open', event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
planTouchLayer?.addEventListener('wheel', event => {
  const point = frameTouchPoint(event);
  const region = frameHorizontalScrollRegionFromPoint(point);
  if (!region || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  region.scrollLeft += event.deltaX;
  event.preventDefault();
  event.stopPropagation();
}, { passive: false });
// Vertical wheel/trackpad scrolling stays native on #review. Horizontal deltas
// that start over iframe-local wide regions are proxied above because the mobile
// overlay intentionally keeps the iframe from receiving pointer input.
document.getElementById('review')?.addEventListener('scroll', scheduleMarkerReflow, { passive: true });
window.addEventListener('resize', () => { updatePlanNavbarHeight(); ensureFrameWideScrollAffordances(); syncFrameHeight(); scheduleMarkerReflow(); });
window.addEventListener('scroll', scheduleMarkerReflow, { passive: true });
let postProgrammaticScrollHandoffTimer = null;
function clearPostProgrammaticScrollWheelHandoff(){
  if (postProgrammaticScrollHandoffTimer) clearTimeout(postProgrammaticScrollHandoffTimer);
  postProgrammaticScrollHandoffTimer = null;
  if (planTouchLayer) {
    planTouchLayer.style.display = '';
    planTouchLayer.style.pointerEvents = '';
    planTouchLayer.style.minHeight = '';
  }
}
function armPostProgrammaticScrollWheelHandoff(){
  if (isMobileShell() || !planTouchLayer) return;
  clearPostProgrammaticScrollWheelHandoff();
  planTouchLayer.style.display = 'block';
  planTouchLayer.style.pointerEvents = 'auto';
  planTouchLayer.style.minHeight = Math.max(frame?.offsetHeight || 0, document.getElementById('review')?.scrollHeight || 0, window.innerHeight) + 'px';
  const clearAfterInput = () => clearPostProgrammaticScrollWheelHandoff();
  window.addEventListener('wheel', clearAfterInput, { once: true, capture: true, passive: true });
  window.addEventListener('pointerdown', clearAfterInput, { once: true, capture: true, passive: true });
  window.addEventListener('mousedown', clearAfterInput, { once: true, capture: true, passive: true });
  postProgrammaticScrollHandoffTimer = setTimeout(() => {
    window.removeEventListener('wheel', clearAfterInput, true);
    window.removeEventListener('pointerdown', clearAfterInput, true);
    window.removeEventListener('mousedown', clearAfterInput, true);
    clearPostProgrammaticScrollWheelHandoff();
  }, 120);
}
function restoreShellScroll(frameWindow, frameScrollX, frameScrollY, shellScrollX, shellScrollY, reviewScrollTop){
  frameWindow?.scrollTo(frameScrollX, frameScrollY);
  window.scrollTo(shellScrollX, shellScrollY);
  document.getElementById('review')?.scrollTo(0, reviewScrollTop);
  armPostProgrammaticScrollWheelHandoff();
}

if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') setTimeout(() => { attachFrameListeners(); void renderMermaidDiagrams().finally(() => { ensureFrameMobileReadabilityStyles(); mountWashiOverlay(); syncFrameHeight(); redrawMarkers(); }); }, 0);
document.getElementById('close-lightbox').addEventListener('click', () => { lightbox.hidden = true; });
document.getElementById('zoom-in').addEventListener('click', () => { zoom = Math.min(4, zoom + .25); applyImageTransform(); });
document.getElementById('zoom-out').addEventListener('click', () => { zoom = Math.max(.5, zoom - .25); applyImageTransform(); });
document.getElementById('zoom-reset').addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; applyImageTransform(); });
document.getElementById('pan-toggle').addEventListener('click', () => { panMode = !panMode; });
document.getElementById('cancel-comment').addEventListener('click', async () => {
  clearPendingSelection();
  await applyDeferredPlanRefreshIfIdle();
});
body.addEventListener('input', () => {
  if (body.value.trim().length === 0) clearDiscardWarning();
});
lightboxStage.addEventListener('mousedown', event => {
  if (!selected || selected.tagName.toLowerCase() !== 'img') return;
  if (panMode && zoom > 1) {
    lightboxPanStart = { clientX: event.clientX, clientY: event.clientY, panX, panY };
    return;
  }
  lightboxDragStart = lightboxImagePoint(event);
  updateImageRectangle(lightboxDragStart, lightboxDragStart);
});
lightboxStage.addEventListener('mousemove', event => {
  if (lightboxPanStart) {
    panX = lightboxPanStart.panX + event.clientX - lightboxPanStart.clientX;
    panY = lightboxPanStart.panY + event.clientY - lightboxPanStart.clientY;
    applyImageTransform();
    return;
  }
  if (!lightboxDragStart) return;
  updateImageRectangle(lightboxDragStart, lightboxImagePoint(event));
});
window.addEventListener('mouseup', event => {
  if (lightboxPanStart) {
    lightboxPanStart = null;
    return;
  }
  if (!lightboxDragStart) return;
  updateImageRectangle(lightboxDragStart, lightboxImagePoint(event));
  lightboxDragStart = null;
});
async function submitPendingComment(){
  if (!pendingAnchor || !body.value.trim() || submitInFlight) return;
  const anchor = pendingAnchor;
  const note = body.value;
  const mutationId = ensurePendingCommentMutationId();
  setSubmitInFlight(true);
  const marker = addMarker(anchor.rect);
  try {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    let screenshot;
    try {
      screenshot = await markerScreenshot(anchor);
    } catch (error) {
      console.warn('Unable to capture marker screenshot; submitting comment without screenshot.', error);
    }
    const res = await fetch('/api/plans/'+planId+'/comments', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ versionId, body: note, anchorType:anchor.type, anchor: anchor.anchor, markerScreenshot: screenshot, createdBy:{ displayName: localStorage.getItem('plan-reviewer-name') || 'Anonymous reviewer' }, clientMutationId: mutationId })
    });
    const json = await res.json();
    if (!json.ok) {
      marker.remove();
      await loadMeta();
      if (json.error?.code === 'duplicate_comment_deleted') {
        clearPendingSelection();
        alert(json.error.message);
        await applyDeferredPlanRefreshIfIdle();
        return;
      }
      alert(json.error?.message || 'Unable to submit comment.');
      setSubmitInFlight(false);
      return;
    }
    clearPendingSelection();
    await loadMeta();
    if (isMobileShell()) setCommentsOpen(true);
    await applyDeferredPlanRefreshIfIdle();
  } catch (error) {
    marker.remove();
    console.warn('Unable to submit comment.', error);
    alert('Unable to submit comment. Check the plan-review service and retry.');
    setSubmitInFlight(false);
  }
}
body.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeComposerFromEscape();
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  submitPendingComment();
});
submitCommentButton?.addEventListener('click', submitPendingComment);
function clearEventPollTimer(){
  if (!eventPollTimer) return;
  clearTimeout(eventPollTimer);
  eventPollTimer = null;
}
function scheduleEventPoll(delayMs){
  clearEventPollTimer();
  if (eventPollStopped || document.hidden) return;
  eventPollTimer = setTimeout(() => {
    eventPollTimer = null;
    void pollEvents();
  }, delayMs);
}
function abortEventPoll(){
  if (!eventPollController) return;
  eventPollController.abort();
  eventPollController = null;
}
async function pollEvents(){
  if (eventPollStopped || eventPollInFlight || document.hidden) return;
  eventPollInFlight = true;
  eventPollController = new AbortController();
  try {
    const url = '/api/plans/'+planId+'/events/poll?mode=all&afterSequence='+encodeURIComponent(String(latestEventSequence))+'&limit=200';
    const res = await fetch(url, { cache: 'no-store', signal: eventPollController.signal });
    if (!res.ok) throw new Error('Event poll failed: ' + res.status);
    const json = await res.json();
    const events = Array.isArray(json.data?.events) ? json.data.events : [];
    for (const storedEvent of events) {
      latestEventSequence = Math.max(latestEventSequence, Number(storedEvent.sequence || 0));
      handlePlanReviewEvent(normalizeStoredEvent(storedEvent));
    }
    if (events.length < 200) {
      latestEventSequence = Math.max(latestEventSequence, Number(json.data?.latestSequence || 0));
    }
    eventPollBackoffMs = 1000;
    scheduleEventPoll(events.length >= 200 ? 0 : 1000);
  } catch (error) {
    if (!eventPollStopped && !document.hidden && error?.name !== 'AbortError') {
      console.warn('Unable to poll plan events', error);
      scheduleEventPoll(eventPollBackoffMs);
      eventPollBackoffMs = Math.min(10000, eventPollBackoffMs * 2);
    }
  } finally {
    eventPollController = null;
    eventPollInFlight = false;
  }
}
function startEventPolling(){
  eventPollingStarted = true;
  eventPollStopped = false;
  scheduleEventPoll(0);
}
function stopEventPolling(){
  eventPollStopped = true;
  clearEventPollTimer();
  abortEventPoll();
}
function refreshAfterVisibilityRestore(){
  void scheduleMetaLoad({ reloadPlan: true, forceReloadPlan: true, advanceEventSequence: true }).catch(error => {
    console.warn('Unable to refresh plan after visibility restore', error);
  }).finally(() => {
    eventPollBackoffMs = 1000;
    scheduleEventPoll(0);
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearEventPollTimer();
    abortEventPoll();
    return;
  }
  eventPollStopped = false;
  refreshAfterVisibilityRestore();
});
window.addEventListener('pagehide', stopEventPolling);
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  eventPollStopped = false;
  if (document.hidden) return;
  refreshAfterVisibilityRestore();
});
loadMeta({ advanceEventSequence: true }).then(startEventPolling).catch(error => console.warn('Unable to load plan metadata', error));
`;

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof PlanReviewError) {
    reply.code(error.statusCode).send(fail(error));
    return;
  }
  if (error instanceof ZodError) {
    const wrapped = new PlanReviewError(
      'validation_failed',
      'Request body failed validation',
      400,
      { issues: error.issues },
      'Correct the request payload to match the documented endpoint contract, then retry.'
    );
    reply.code(400).send(fail(wrapped));
    return;
  }
  const wrapped = new PlanReviewError('internal_error', error instanceof Error ? error.message : String(error), 500);
  reply.code(500).send(fail(wrapped));
}

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlElement = DefaultTreeAdapterMap['element'];

interface AnchorTarget {
  node: HtmlElement;
  planNodeId: string;
  id?: string;
  selector?: string;
  tagName: string;
  domPath: string;
  xpath: string;
  headingPath: string[];
  textPreview: string;
  outerHtmlPreview: string;
  anchorCommand: string;
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node && typeof node.tagName === 'string';
}

function attr(node: HtmlElement, name: string): string | undefined {
  return node.attrs.find(item => item.name === name)?.value;
}

function textContent(node: HtmlNode): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('childNodes' in node && Array.isArray(node.childNodes)) return node.childNodes.map(child => textContent(child as HtmlNode)).join('');
  return '';
}

function compactText(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function exactIdFromSelector(selector: string): string {
  return selector.slice(1).replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_match, escape: string) => {
    const hex = /^[0-9a-fA-F]/.test(escape) ? escape.trim() : '';
    return hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : escape;
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cssIdentifier(value: string): string {
  return Array.from(value).map((char, index) => {
    const leadingDigit = /^\d$/.test(char) && (index === 0 || (index === 1 && value.startsWith('-')));
    if (leadingDigit) return `\\${(char.codePointAt(0)?.toString(16) ?? '').padStart(6, '0')}`;
    if (/^[A-Za-z0-9_-]$/.test(char)) return char;
    return `\\${char}`;
  }).join('');
}

function cssIdSelector(value: string): string {
  return `#${cssIdentifier(value)}`;
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function outerHtml(node: HtmlElement): string {
  const attributes = node.attrs.map(item => ` ${item.name}="${htmlAttribute(item.value)}"`).join('');
  const children = serialize(node);
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  return voidTags.has(node.tagName.toLowerCase()) ? `<${node.tagName}${attributes}>` : `<${node.tagName}${attributes}>${children}</${node.tagName}>`;
}

function traverseHtml(node: HtmlNode, visitor: (node: HtmlElement, ancestors: HtmlElement[]) => void, ancestors: HtmlElement[] = []): void {
  const nextAncestors = isHtmlElement(node) ? [...ancestors, node] : ancestors;
  if (isHtmlElement(node)) visitor(node, ancestors);
  if ('childNodes' in node && Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) traverseHtml(child as HtmlNode, visitor, nextAncestors);
  }
}

function elementIndexAmongSiblings(node: HtmlElement, ancestors: HtmlElement[]): number {
  const parent = ancestors.at(-1);
  if (!parent?.childNodes) return 1;
  let index = 0;
  for (const child of parent.childNodes) {
    if (isHtmlElement(child as HtmlNode) && (child as HtmlElement).tagName === node.tagName) index += 1;
    if (child === node) return index;
  }
  return 1;
}

function firstDescendantHeadingText(node: HtmlElement): string | undefined {
  if (!('childNodes' in node) || !Array.isArray(node.childNodes)) return undefined;
  for (const child of node.childNodes) {
    if (!isHtmlElement(child as HtmlNode)) continue;
    const element = child as HtmlElement;
    if (/^h[1-6]$/i.test(element.tagName)) return compactText(textContent(element), 80);
    const nested = firstDescendantHeadingText(element);
    if (nested) return nested;
  }
  return undefined;
}

function headingPathForElement(node: HtmlElement, ancestors: HtmlElement[]): string[] {
  const headings: string[] = [];
  for (const element of [node, ...ancestors].reverse()) {
    const heading = firstDescendantHeadingText(element);
    if (heading && !headings.includes(heading)) headings.push(heading);
  }
  return headings.slice(-5);
}

function buildAnchorTargets(planId: string, renderedHtml: string): Array<Omit<AnchorTarget, 'node'>> {
  const document = parse(renderedHtml) as DefaultTreeAdapterMap['document'];
  const targets: Array<Omit<AnchorTarget, 'node'>> = [];
  const headingStack: string[] = [];
  const semanticTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'figure', 'img', 'table', 'ul', 'ol', 'pre']);
  traverseHtml(document as unknown as HtmlNode, (node, ancestors) => {
    const tagName = node.tagName.toLowerCase();
    const headingLevel = /^h([1-6])$/.exec(tagName)?.[1];
    const nodeId = attr(node, 'data-plan-node-id');
    const explicitId = attr(node, 'id');
    const textPreview = compactText(textContent(node), 160);
    if (headingLevel && textPreview) {
      const level = Number(headingLevel);
      headingStack.splice(level - 1);
      headingStack[level - 1] = textPreview.slice(0, 80);
    }
    if (!nodeId || (!explicitId && !semanticTags.has(tagName))) return;
    const parts = [...ancestors, node].filter(item => item.tagName).map((item, index, all) => {
      const parentAncestors = all.slice(0, index);
      return `${item.tagName.toLowerCase()}[${elementIndexAmongSiblings(item, parentAncestors)}]`;
    });
    const selector = explicitId ? cssIdSelector(explicitId) : undefined;
    targets.push({
      planNodeId: nodeId,
      id: explicitId,
      selector,
      tagName,
      domPath: parts.join('/'),
      xpath: `/${parts.join('/')}`,
      headingPath: headingPathForElement(node, ancestors),
      textPreview: tagName === 'img' ? compactText(attr(node, 'alt') ?? attr(node, 'title') ?? '', 160) : textPreview,
      outerHtmlPreview: compactText(outerHtml(node), 500),
      anchorCommand: `plan-review comments add ${planId} --plan-node-id ${shellQuote(nodeId)} --body ${shellQuote('<comment>')} --agent ${shellQuote('<agent-name>')} --json`
    });
  });
  return targets;
}

function nativeTargetMatchesAnchor(target: { planNodeId?: string; selector?: string }, anchor: Record<string, unknown>): boolean {
  if (target.planNodeId && target.planNodeId === anchor.planNodeId) return true;
  if (!target.selector || typeof anchor.cssSelector !== 'string') return false;
  return exactIdFromSelector(target.selector) === exactIdFromSelector(anchor.cssSelector);
}

function resolveDomAnchor(planId: string, renderedHtml: string, target: { planNodeId?: string; selector?: string }) {
  const document = parse(renderedHtml) as DefaultTreeAdapterMap['document'];
  const targets = buildAnchorTargets(planId, renderedHtml);
  const wantedId = target.selector ? exactIdFromSelector(target.selector) : undefined;
  const matches: AnchorTarget[] = [];
  traverseHtml(document as unknown as HtmlNode, (node, ancestors) => {
    const planNodeId = attr(node, 'data-plan-node-id');
    if (!planNodeId) return;
    const exactSelectorMatch = wantedId !== undefined && attr(node, 'id') === wantedId;
    const nodeIdMatch = target.planNodeId !== undefined && planNodeId === target.planNodeId;
    if (!nodeIdMatch && !exactSelectorMatch) return;
    const nodeIdAttr = attr(node, 'id');
    const listed = targets.find(item => item.planNodeId === planNodeId) ?? {
      planNodeId,
      id: nodeIdAttr,
      selector: nodeIdAttr ? cssIdSelector(nodeIdAttr) : undefined,
      tagName: node.tagName.toLowerCase(),
      domPath: '',
      xpath: '',
      headingPath: headingPathForElement(node, ancestors),
      textPreview: compactText(textContent(node), 160),
      outerHtmlPreview: compactText(outerHtml(node), 500),
      anchorCommand: `plan-review comments add ${planId} --plan-node-id ${shellQuote(planNodeId)} --body ${shellQuote('<comment>')} --agent ${shellQuote('<agent-name>')} --json`
    };
    const parts = [...ancestors, node].filter(item => item.tagName).map((item, index, all) => {
      const parentAncestors = all.slice(0, index);
      return `${item.tagName.toLowerCase()}[${elementIndexAmongSiblings(item, parentAncestors)}]`;
    });
    matches.push({ node, ...listed, domPath: listed.domPath || parts.join('/'), xpath: listed.xpath || `/${parts.join('/')}` });
  });
  if (matches.length > 1) {
    throw new PlanReviewError(
      'validation_failed',
      'DOM comment target matched multiple rendered nodes',
      400,
      { target, matches: matches.map(item => ({ planNodeId: item.planNodeId, selector: item.selector, textPreview: item.textPreview })) },
      'Refresh the plan read surface with plan-review show <planId> --json and retry with a unique anchorTargets[].planNodeId.'
    );
  }
  const resolved = matches[0];
  if (!resolved) {
    throw new PlanReviewError(
      'validation_failed',
      'DOM comment target was not found in the latest rendered plan',
      400,
      { target },
      'Refresh the plan read surface with plan-review show <planId> --json and retry with a current anchorTargets[].planNodeId.'
    );
  }
  return {
    planNodeId: resolved.planNodeId,
    cssSelector: resolved.id ? cssIdSelector(resolved.id) : `${resolved.tagName}[data-plan-node-id="${cssString(resolved.planNodeId)}"]`,
    domPath: resolved.domPath,
    xpath: resolved.xpath,
    textQuote: { exact: resolved.textPreview.slice(0, 160), prefix: '', suffix: '' },
    headingPath: resolved.headingPath,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    viewport: { width: 1, height: 1 },
    textPreview: resolved.textPreview.slice(0, 120),
    outerHtmlPreview: resolved.outerHtmlPreview
  };
}

export function createApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = new PlanReviewStore(options.dbPath);
  const bus = createEventBus();
  const sourceSync = new SourceSyncService(store, bus);
  const deliveryConfig = { ...resolveDeliveryWorkerConfig(), ...(options.delivery ?? {}) };
  const deliveryWorker = new DeliveryWorker(store, {
    enabled: deliveryConfig.enabled,
    intervalMs: deliveryConfig.intervalMs,
    serviceUrl: deliveryConfig.serviceUrl,
    clientFactory: options.delivery?.clientFactory,
    eventBus: bus
  });
  void sourceSync.rehydrateFromStore();
  deliveryWorker.start();
  const emitExpired = (planId?: string) => {
    const events = store.releaseExpiredClaims(planId);
    for (const event of events) bus.emitEvent(event);
    return events;
  };
  const deliveryRuntime = () => ({
    workerEnabled: deliveryConfig.enabled,
    mode: deliveryConfig.mode,
    serviceUrl: deliveryConfig.serviceUrl,
    status: deliveryConfig.enabled ? 'enabled' : 'disabled',
    message: deliveryConfig.enabled
      ? 'Automatic Codex delivery worker is enabled.'
      : 'Automatic Codex delivery is disabled by service config. Set PLAN_REVIEW_CODEX_DELIVERY=1 to enable the worker; manual agent next remains available.'
  });
  let cachedUpdateStatus = options.updateChecks?.initialStatus;
  let cachedUpdateConfig: UpdateCheckConfig | undefined;
  const readUpdateCheckConfig = () => {
    const resolved = resolveUpdateCheckConfig({ userConfigFile: options.updateChecks?.configFile });
    return {
      ...resolved,
      enabled: options.updateChecks?.enabled ?? resolved.enabled,
      stableFormulaUrl: options.updateChecks?.stableFormulaUrl ?? resolved.stableFormulaUrl,
      headCompareUrl: options.updateChecks?.headCompareUrl ?? resolved.headCompareUrl,
      timeoutMs: options.updateChecks?.timeoutMs ?? resolved.timeoutMs,
      cacheMs: options.updateChecks?.cacheMs ?? resolved.cacheMs
    };
  };
  const updateCheckConfig = () => cachedUpdateConfig ??= readUpdateCheckConfig();
  const cachedRuntimeUpdateStatus = () => {
    const config = updateCheckConfig();
    const checkedAt = cachedUpdateStatus ? Date.parse(cachedUpdateStatus.checkedAt) : Number.NaN;
    return config.enabled && cachedUpdateStatus && Number.isFinite(checkedAt) && Date.now() - checkedAt <= config.cacheMs
      ? cachedUpdateStatus
      : undefined;
  };
  const runtimeUpdateStatus = async () => {
    const config = updateCheckConfig();
    if (!config.enabled) {
      return {
        status: 'unknown' as const,
        checkedAt: new Date().toISOString(),
        current: readBuildIdentity(),
        automaticChecksEnabled: false,
        nextAction: 'Automatic update checks are disabled. Manual checks remain available with plan-review update check --json.'
      };
    }
    const checkedAt = cachedUpdateStatus ? Date.parse(cachedUpdateStatus.checkedAt) : Number.NaN;
    if (cachedUpdateStatus && Number.isFinite(checkedAt) && Date.now() - checkedAt <= config.cacheMs) {
      return { ...cachedUpdateStatus, automaticChecksEnabled: true };
    }
    try {
      cachedUpdateStatus = options.updateChecks?.checker
        ? await options.updateChecks.checker()
        : await checkForUpdates({
          stableFormulaUrl: config.stableFormulaUrl,
          headCompareUrl: config.headCompareUrl,
          timeoutMs: config.timeoutMs
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cachedUpdateStatus = {
        status: 'check_failed',
        checkedAt: new Date().toISOString(),
        current: readBuildIdentity(),
        error: message,
        nextAction: `Update metadata could not be reached (${message}). Retry with plan-review update check --json, or verify network access to the configured metadata endpoint.`
      };
    }
    return { ...cachedUpdateStatus, automaticChecksEnabled: true };
  };

  app.addHook('onClose', async () => {
    deliveryWorker.stop();
    await sourceSync.close();
    store.close();
  });

  app.get('/health', async () => ok({ status: 'ok' }));
  app.get('/favicon.ico', async (_request, reply) => reply.header('Cache-Control', 'no-store').type('image/svg+xml').send(faviconSvg));
  app.get('/favicon.svg', async (_request, reply) => reply.header('Cache-Control', 'no-store').type('image/svg+xml').send(faviconSvg));
  app.get('/client.css', async (_request, reply) => reply.header('Cache-Control', 'no-store').type('text/css').send(clientCss));
  app.get('/client.js', async (_request, reply) => reply.header('Cache-Control', 'no-store').type('application/javascript').send(clientJs));
  app.get('/vendor/html2canvas.js', async (_request, reply) => {
    reply
      .type('application/javascript')
      .send(fs.readFileSync(path.join(path.dirname(resolvedModuleFile('html2canvas')), 'html2canvas.min.js')));
  });
  app.get('/vendor/finder.js', async (_request, reply) => {
    reply.type('application/javascript').send(fs.readFileSync(resolvedModuleFile('@medv/finder')));
  });
  app.get('/vendor/washi.js', async (_request, reply) => {
    reply.type('application/javascript').send(fs.readFileSync(resolvedModuleFile('@washi-ui/core')));
  });
  app.get('/vendor/mermaid.esm.min.mjs', async (_request, reply) => {
    reply.type('application/javascript').send(fs.readFileSync(resolvedModuleFile('mermaid/dist/mermaid.esm.min.mjs')));
  });
  app.get('/vendor/chunks/mermaid.esm.min/:file', async (request, reply) => {
    const file = String((request.params as { file?: string }).file ?? '');
    if (!/^[a-zA-Z0-9._-]+\.mjs$/.test(file)) throw new PlanReviewError('not_found', 'Mermaid vendor chunk was not found', 404);
    reply.type('application/javascript').send(fs.readFileSync(path.join(path.dirname(resolvedModuleFile('mermaid/dist/mermaid.esm.min.mjs')), 'chunks', 'mermaid.esm.min', file)));
  });

  app.get('/', async (request, reply) => {
    const query = request.query as { q?: string; repoKey?: string; projectKey?: string; status?: string; boardColumnKey?: string; view?: 'kanban' | 'all' | 'collab'; type?: 'plan' | 'collaborative' };
    const configuration = store.getConfiguration();
    const lifecycleCounts = store.countPlansByLifecycle();
    const activePlans = store.listPlans({ lifecycleState: 'active', projectKey: query.projectKey || undefined });
    const view = configuration.kanbanEnabled && query.view !== 'all' && query.view !== 'collab' ? 'kanban' : 'all';
    const effectiveQuery = configuration.kanbanEnabled ? query : { ...query, boardColumnKey: undefined };
    const filtered = filterPlans(activePlans, effectiveQuery).plans;
    const projectName = query.projectKey ? store.listPlanProjects().find(project => project.projectKey === query.projectKey)?.projectName : undefined;
    reply.type('text/html').send(indexHtml(filtered, lifecycleCounts.archived, lifecycleCounts.deferred, store.listBoardColumns(), view, projectName, query.view === 'collab' ? 'collaborative' : query.type, configuration.kanbanEnabled, cachedRuntimeUpdateStatus()));
  });

  app.get('/deferred', async (_request, reply) => {
    const configuration = store.getConfiguration();
    const lifecycleCounts = store.countPlansByLifecycle();
    reply.type('text/html').send(deferredHtml(store.listPlans({ lifecycleState: 'deferred' }), lifecycleCounts.archived, configuration.kanbanEnabled));
  });

  app.get('/archive', async (_request, reply) => {
    const configuration = store.getConfiguration();
    const lifecycleCounts = store.countPlansByLifecycle();
    reply.type('text/html').send(archiveHtml(store.listPlans({ lifecycleState: 'archived' }), lifecycleCounts.deferred, configuration.kanbanEnabled));
  });

  app.get('/configuration', async (_request, reply) => {
    reply.type('text/html').send(configurationHtml(store.getConfiguration(), store.listBoardColumns({ includeHidden: true }), store.countActivePlanningPlansByColumn(), updateCheckConfig(), cachedUpdateStatus));
  });

  app.get('/api/configuration', async (_request, reply) => {
    try {
      return ok({ configuration: store.getConfiguration(), defaults: defaultAppConfiguration });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.put('/api/configuration', async (request, reply) => {
    try {
      const parsed = appConfigurationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new PlanReviewError(
          'validation_failed',
          'Configuration failed validation',
          400,
          { issues: parsed.error.issues },
          'Send all configuration fields. Side-panel and Kanban values must be booleans; skill names must use lowercase letters, numbers, underscores, or dashes.'
        );
      }
      return ok({ configuration: store.saveConfiguration(parsed.data), defaults: defaultAppConfiguration });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/runtime/update', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return ok(await runtimeUpdateStatus());
  });

  app.put('/api/configuration/update-checks', async (request, reply) => {
    try {
      const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') {
        throw new PlanReviewError('validation_failed', 'enabled must be a boolean', 400, { enabled });
      }
      const current = updateCheckConfig();
      const userConfig = setUpdateChecksEnabled(enabled, current.userConfigFile);
      cachedUpdateConfig = readUpdateCheckConfig();
      if (!enabled) cachedUpdateStatus = undefined;
      return ok({ updateChecks: cachedUpdateConfig, userConfig });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/columns', async (_request, reply) => {
    reply.type('text/html').send(configurationHtml(store.getConfiguration(), store.listBoardColumns({ includeHidden: true }), store.countActivePlanningPlansByColumn(), updateCheckConfig(), cachedUpdateStatus));
  });

  app.get('/api/plans', async (request, reply) => {
    try {
      const query = request.query as { q?: string; repoKey?: string; projectKey?: string; status?: string; reviewMode?: 'planning' | 'collaboration'; boardColumnKey?: string; lifecycle?: 'active' | 'deferred' | 'archived'; limit?: string; cursor?: string; currentPlanId?: string; includeArchived?: string; includeDeferred?: string };
      const configuration = store.getConfiguration();
      const effectiveBoardColumnKey = configuration.kanbanEnabled ? query.boardColumnKey || undefined : undefined;
      const effectiveQuery = configuration.kanbanEnabled ? query : { ...query, boardColumnKey: undefined };
      const { plans, nextCursor } = filterPlans(store.listPlans({ includeArchived: query.includeArchived === 'true', includeDeferred: query.includeDeferred === 'true', lifecycleState: query.lifecycle, projectKey: query.projectKey || undefined, reviewMode: query.reviewMode, boardColumnKey: effectiveBoardColumnKey }), effectiveQuery);
      return ok({ plans, nextCursor });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/navigator', async (request, reply) => {
    try {
      const query = request.query as { limit?: string; currentPlanId?: string; projectKey?: string; lifecycle?: string; boardColumnKey?: string };
      if (query.limit && !/^\d+$/.test(query.limit)) {
        throw new PlanReviewError('validation_failed', 'limit must be a non-negative integer', 400, { limit: query.limit });
      }
      const limit = query.limit ? Number(query.limit) : 200;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new PlanReviewError('validation_failed', 'limit must be between 1 and 200', 400, { limit: query.limit });
      }
      if (query.lifecycle && query.lifecycle !== 'active' && query.lifecycle !== 'deferred' && query.lifecycle !== 'archived') {
        throw new PlanReviewError('validation_failed', 'lifecycle must be active, deferred, archived, or empty', 400, { lifecycle: query.lifecycle });
      }
      const configuration = store.getConfiguration();
      const boardColumnKey = configuration.kanbanEnabled ? query.boardColumnKey : undefined;
      const hasNavigatorFilter = Object.prototype.hasOwnProperty.call(query, 'projectKey') || Object.prototype.hasOwnProperty.call(query, 'lifecycle') || (configuration.kanbanEnabled && Object.prototype.hasOwnProperty.call(query, 'boardColumnKey'));
      const filters: ReviewShellNavigatorFilters = {
        project: query.projectKey || '',
        state: (query.lifecycle || '') as ReviewShellNavigatorFilters['state'],
        status: boardColumnKey || '',
        active: hasNavigatorFilter
      };
      return ok({ plans: hasNavigatorFilter ? filteredReviewShellNavigatorItems(store, query.currentPlanId, filters, limit) : planNavigatorItemsFor(store, { limit, currentPlanId: query.currentPlanId }) });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/register', async (request, reply) => {
    try {
      const input = registerPlanSchema.parse(request.body);
      const rendered = renderPlan(input);
      const result = store.registerPlan(input, rendered.renderedHtml, rendered.warnings);
      bus.emitEvent(result.event);
      await sourceSync.register(result.planId);
      const { plan } = store.getPlan(result.planId);
      return ok({
        planId: result.planId,
        versionId: result.versionId,
        repoId: result.repoId,
        reviewUrl: result.reviewUrl,
        indexUrl: result.indexUrl,
        watchCommand: result.watchCommand,
        sourceSync: {
          watchMode: plan.watchMode,
          sourcePath: plan.sourcePath,
          status: plan.lastSyncStatus,
          error: plan.lastSyncError,
          active: plan.lifecycleState === 'active' && plan.watchMode === 'filesystem' && plan.lastSyncStatus !== 'failed'
        },
        reviewMode: plan.reviewMode,
        publicationMetadata: plan.publicationMetadata,
        codexDelivery: store.getDeliveryTarget(plan.id, 'codex'),
        hermesDelivery: store.getDeliveryTarget(plan.id, 'hermes'),
        renderedWithWarnings: rendered.warnings,
        agentInstructions: buildRegistrationAgentInstructions({ planId: result.planId, reviewUrl: result.reviewUrl, serviceUrl: requestServiceUrl(request, deliveryConfig.serviceUrl) })
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/p/:planId', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      let title = planTitleFallback(plan);
      try {
        title = renderedHtmlTitle(store.getRenderedHtml(plan.id)) ?? title;
      } catch {}
      const columns = store.listBoardColumns();
      const allColumns = store.listBoardColumns({ includeHidden: true });
      const projects = store.listPlanProjects();
      const configuration = store.getConfiguration();
      const navigatorFilters = normalizeReviewShellNavigatorFilters(request.query as { projectKey?: string; lifecycle?: string; boardColumnKey?: string }, plan, columns, projects);
      if (!configuration.kanbanEnabled) navigatorFilters.status = '';
      const planNavigatorOpen = planNavigatorOpenFromCookie(request.headers.cookie, configuration.showPlanNavigatorByDefault);
      reply.header('Cache-Control', 'no-store').type('text/html').send(reviewShell(plan, title, reviewShellTitle(title), filteredReviewShellNavigatorItems(store, plan.id, navigatorFilters), columns, projects, configuration, navigatorFilters, allColumns, planNavigatorOpen, cachedRuntimeUpdateStatus()));
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/render/:planId', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const query = request.query as { versionId?: string };
      reply
        .header('Content-Security-Policy', "default-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:")
        .type('text/html')
        .send(store.getRenderedHtml(planId, query.versionId));
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/download/:planId', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const query = request.query as { versionId?: string };
      const source = store.getPlanSourceExport(planId, query.versionId);
      const artifact = buildPlanExport({ slug: source.plan.slug, html: source.html, assets: source.assets });
      reply
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', contentDispositionAttachment(artifact.filename))
        .type(artifact.contentType)
        .send(artifact.buffer);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/:planId', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan, version } = store.getPlan(planId);
      emitExpired(plan.id);
      return ok({
        plan,
        latestVersion: version,
        assets: store.listPlanAssets(version.id),
        versions: [version],
        counts: store.getPlanCounts(plan.id),
        progress: store.getPlanProgress(plan.id),
        latestNote: store.listPlanNotes(plan.id, { limit: 1 })[0],
        notes: store.listPlanNotes(plan.id),
        comments: store.listComments(plan.id),
        anchorTargets: buildAnchorTargets(plan.id, store.getRenderedHtml(plan.id)),
        delivery: {
          codex: store.getDeliveryTarget(plan.id, 'codex'),
          hermes: store.getDeliveryTarget(plan.id, 'hermes'),
          outbox: store.listDeliveryRows(plan.id),
          runtime: deliveryRuntime()
        },
        latestEventSequence: store.latestEventSequence(plan.id, 'all'),
        reviewUrl: `/p/${plan.id}`
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.patch('/api/plans/:planId', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const input = changePlanModeSchema.parse(request.body);
      const result = store.changePlanMode(plan.id, input.reviewMode);
      bus.emitEvent(result.event);
      return ok({ plan: result.plan, changed: result.changed });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/board-columns', async (_request, reply) => {
    try {
      return ok({ columns: store.listBoardColumns() });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.put('/api/board-columns', async (request, reply) => {
    try {
      const result = store.saveBoardColumns(saveBoardColumnsSchema.parse(request.body));
      for (const event of result.events) bus.emitEvent(event);
      return ok(result);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.put('/api/plans/:planId/lifecycle', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const input = setPlanLifecycleSchema.parse(request.body);
      if (input.lifecycleState === 'deferred') {
        const result = store.deferPlan(planId, { note: input.note!, createdBy: input.createdBy, clientMutationId: input.clientMutationId });
        for (const event of result.events) bus.emitEvent(event);
        await sourceSync.unregister(result.plan.id);
        return ok({ plan: result.plan, note: result.note, changed: true });
      }
      const result = store.setPlanLifecycleState(planId, input.lifecycleState);
      bus.emitEvent(result.event);
      if (result.changed) {
        if (result.plan.lifecycleState === 'active') {
          await sourceSync.register(result.plan.id);
          await sourceSync.syncNow(result.plan.id, 'manual');
        } else {
          await sourceSync.unregister(result.plan.id);
        }
      }
      return ok({ plan: result.plan, changed: result.changed });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.put('/api/plans/:planId/column', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      if (!store.getConfiguration().kanbanEnabled) {
        throw new PlanReviewError(
          'feature_disabled',
          'Kanban board is disabled',
          409,
          { planId },
          'Enable Kanban in Configuration, then retry the column move.'
        );
      }
      const input = setPlanBoardColumnSchema.parse(request.body);
      const result = store.setPlanBoardColumn(planId, input.boardColumnKey);
      bus.emitEvent(result.event);
      return ok({ plan: result.plan, column: result.column, changed: result.changed });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.put('/api/plans/:planId/pin', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const input = setPlanPinnedSchema.parse(request.body);
      const result = store.setPlanPinned(planId, input.pinned);
      bus.emitEvent(result.event);
      return ok({ plan: result.plan, changed: result.changed });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.put('/api/plans/:planId/project', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const input = setPlanProjectSchema.parse(request.body);
      const result = store.setPlanProject(planId, input);
      bus.emitEvent(result.event);
      return ok({ plan: result.plan, changed: result.changed });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.put('/api/plans/:planId/pull-request', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const pullRequest = planPullRequestSchema.parse(request.body);
      return ok({ planId: plan.id, pullRequest: store.upsertPullRequest(plan.id, pullRequest) });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.delete('/api/plans/:planId/pull-request', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      store.clearPullRequest(plan.id);
      return ok({ planId: plan.id, pullRequest: null });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/:planId/delivery/:adapter', async (request, reply) => {
    try {
      const { planId, adapter } = request.params as { planId: string; adapter: string };
      const parsedAdapter = deliveryAdapterSchema.parse(adapter);
      const { plan } = store.getPlan(planId);
      return ok({
        target: store.getDeliveryTarget(plan.id, parsedAdapter),
        outbox: store.listDeliveryRows(plan.id, parsedAdapter),
        runtime: deliveryRuntime()
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.put('/api/plans/:planId/delivery/:adapter', async (request, reply) => {
    try {
      const { planId, adapter } = request.params as { planId: string; adapter: string };
      const parsedAdapter = deliveryAdapterSchema.parse(adapter);
      const { plan } = store.getPlan(planId);
      const input = deliveryTargetUpdateSchema.parse({ adapter: parsedAdapter, ...(request.body as Record<string, unknown> ?? {}) });
      const result = store.upsertDeliveryTarget(plan.id, input);
      deliveryWorker.wake();
      return ok(result);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/:planId/delivery/outbox', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const query = request.query as { adapter?: string };
      const adapter = query.adapter ? deliveryAdapterSchema.parse(query.adapter) : undefined;
      const { plan } = store.getPlan(planId);
      return ok({ outbox: store.listDeliveryRows(plan.id, adapter), runtime: deliveryRuntime() });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/delivery/:adapter/retry', async (request, reply) => {
    try {
      const { planId, adapter } = request.params as { planId: string; adapter: string };
      const parsedAdapter = deliveryAdapterSchema.parse(adapter);
      const body = (request.body ?? {}) as { commentId?: string };
      const { plan } = store.getPlan(planId);
      const result = store.retryDeliveryRows(plan.id, parsedAdapter, body.commentId);
      deliveryWorker.wake();
      return ok(result);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/archive', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const result = store.archivePlan(plan.id);
      bus.emitEvent(result.event);
      await sourceSync.unregister(result.plan.id);
      return ok({ plan: result.plan });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/unarchive', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const result = store.unarchivePlan(plan.id);
      bus.emitEvent(result.event);
      await sourceSync.register(result.plan.id);
      await sourceSync.syncNow(result.plan.id, 'manual');
      return ok({ plan: result.plan });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/defer', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const input = deferPlanSchema.safeParse(request.body);
      if (!input.success) {
        throw new PlanReviewError(
          'validation_failed',
          'Defer requires a non-empty note/reason',
          400,
          { issues: input.error.issues },
          'Retry with --note "why paused and next step" or POST {"note":"why paused and next step"}.'
        );
      }
      const result = store.deferPlan(plan.id, input.data);
      for (const event of result.events) bus.emitEvent(event);
      await sourceSync.unregister(result.plan.id);
      return ok({ plan: result.plan, note: result.note });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/resume', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const result = store.resumePlan(plan.id, resumePlanSchema.parse(request.body ?? {}));
      for (const event of result.events) bus.emitEvent(event);
      await sourceSync.register(result.plan.id);
      await sourceSync.syncNow(result.plan.id, 'manual');
      return ok({ plan: result.plan, note: result.note });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/notes', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const result = store.createPlanNote(plan.id, createPlanNoteSchema.parse(request.body));
      if (result.event) bus.emitEvent(result.event);
      return ok({ note: result.note, created: result.created });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/:planId/notes', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const query = request.query as { limit?: string };
      const { plan } = store.getPlan(planId);
      return ok({ notes: store.listPlanNotes(plan.id, { limit: query.limit ? Number(query.limit) : undefined }) });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/request-execution-review', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan, version } = store.getPlan(planId);
      const configuration = store.getConfiguration();
      const result = store.createComment(plan.id, {
        versionId: version.id,
        body: executionReviewRequestBody(plan.planPath, configuration.executionReadySkillName),
        anchorType: 'dom',
        anchor: {
          cssSelector: 'body',
          textPreview: 'Plan execution-ready review request',
          headingPath: ['Plan'],
          rect: { x: 0, y: 0, width: 1, height: 1 },
          viewport: { width: 1, height: 1 }
        },
        createdBy: { displayName: 'Plan reviewer' }
      });
      if (result.created) {
        bus.emitEvent(result.event);
        deliveryWorker.wake();
      }
      return ok({ comment: result.comment, created: result.created });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/request-build-plan', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan, version } = store.getPlan(planId);
      const configuration = store.getConfiguration();
      const result = store.createComment(plan.id, {
        versionId: version.id,
        body: buildPlanRequestBody(plan.planPath, configuration.buildPlanSkillName),
        anchorType: 'dom',
        anchor: {
          cssSelector: 'body',
          textPreview: 'Plan build request',
          headingPath: ['Plan'],
          rect: { x: 0, y: 0, width: 1, height: 1 },
          viewport: { width: 1, height: 1 }
        },
        createdBy: { displayName: 'Plan reviewer' }
      });
      if (result.created) {
        bus.emitEvent(result.event);
        deliveryWorker.wake();
      }
      return ok({ comment: result.comment, created: result.created });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/comments', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const input = createCommentSchema.parse(request.body);
      if (input.createdBy?.type === 'agent') {
        throw new PlanReviewError(
          'validation_failed',
          'Agent-authored comments must use the native DOM comment endpoint',
          400,
          {},
          'Retry with POST /api/plans/:planId/comments/dom or plan-review comments add.'
        );
      }
      const result = store.createComment(plan.id, input);
      if (result.created) {
        bus.emitEvent(result.event);
        deliveryWorker.wake();
      }
      return ok(result);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/comments/dom', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan, version } = store.getPlan(planId);
      const input = createDomCommentSchema.parse(request.body);
      const existing = input.clientMutationId ? store.getCommentByClientMutationId(plan.id, input.clientMutationId) : undefined;
      if (existing) {
        if (existing.comment.deletedAt) {
          throw new PlanReviewError(
            'duplicate_comment_deleted',
            'This comment draft was already submitted and then deleted.',
            409,
            { commentId: existing.comment.id, clientMutationId: input.clientMutationId },
            'Refresh the comments list and start a new comment if you still need to submit feedback.'
          );
        }
        if (existing.comment.body !== input.body || existing.comment.anchorType !== 'dom' || !nativeTargetMatchesAnchor(input.target, existing.comment.anchor)) {
          throw new PlanReviewError(
            'duplicate_comment_conflict',
            'This comment draft identifier was already used for different comment content.',
            409,
            { commentId: existing.comment.id, clientMutationId: input.clientMutationId },
            'Refresh the comments list before retrying, or start a new comment from the current selection.'
          );
        }
        return ok({ comment: existing.comment, event: existing.event, created: false });
      }
      const anchor = resolveDomAnchor(plan.id, store.getRenderedHtml(plan.id), input.target);
      const result = store.createComment(plan.id, {
        versionId: version.id,
        body: input.body,
        anchorType: 'dom',
        anchor,
        createdBy: input.createdBy,
        clientMutationId: input.clientMutationId
      });
      if (result.created) {
        bus.emitEvent(result.event);
        deliveryWorker.wake();
      }
      return ok(result);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/:planId/comments', async (request, reply) => {
    try {
	      const { planId } = request.params as { planId: string };
	      const query = request.query as { status?: string; anchorState?: string; sinceSequence?: string; versionId?: string };
	      const { plan } = store.getPlan(planId);
	      emitExpired(plan.id);
	      return ok({
        comments: store.listComments(plan.id, {
          status: query.status,
          anchorState: query.anchorState,
          versionId: query.versionId,
          sinceSequence: query.sinceSequence ? Number(query.sinceSequence) : undefined
        })
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/plans/:planId/comments/claim', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const agentId = request.headers['x-agent-id']?.toString() || 'plan-review-cli';
      const result = store.claimComments(plan.id, claimCommentsSchema.parse(request.body), agentId);
      for (const event of result.events) bus.emitEvent(event);
      return ok(result);
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/comments/:commentId/replies', async (request, reply) => {
    try {
      const { commentId } = request.params as { commentId: string };
      const result = store.appendThreadEntry(commentId, appendThreadEntrySchema.parse(request.body));
      if (result.created) bus.emitEvent(result.event);
      return ok({ comment: result.comment, entry: result.entry, created: result.created });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/comments/:commentId/ack', async (request, reply) => {
    try {
	      const { commentId } = request.params as { commentId: string };
	      const result = store.ackComment(commentId, ackCommentSchema.parse(request.body));
	      for (const event of result.expiredEvents ?? []) bus.emitEvent(event);
	      if ('event' in result && result.event) bus.emitEvent(result.event);
      return ok({ comment: result.comment, alreadyAcknowledged: result.alreadyAcknowledged });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/comments/:commentId/resolve', async (request, reply) => {
    try {
      const { commentId } = request.params as { commentId: string };
      const result = store.resolveComment(commentId, resolveCommentSchema.parse(request.body));
      if ('event' in result && result.event) bus.emitEvent(result.event);
      return ok({ comment: result.comment, alreadyResolved: result.alreadyResolved });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/comments/:commentId/release', async (request, reply) => {
    try {
      const { commentId } = request.params as { commentId: string };
      const input = releaseCommentSchema.parse(request.body);
      const result = store.releaseComment(commentId, input.claimId, input.reason);
      bus.emitEvent(result.event);
      return ok({ comment: result.comment });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.delete('/api/comments/:commentId', async (request, reply) => {
    try {
      const { commentId } = request.params as { commentId: string };
      const result = store.deleteComment(commentId);
      for (const event of result.expiredEvents ?? []) bus.emitEvent(event);
      bus.emitEvent(result.event);
      return ok({ comment: result.comment });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.post('/api/agent/queue/claim', async (request, reply) => {
    try {
      const input = claimQueueSchema.parse(request.body ?? {});
      const agentId = request.headers['x-agent-id']?.toString() || 'plan-review-cli';
      const result = store.claimNextAcrossQueue(input, agentId);
      for (const event of result.events) bus.emitEvent(event);
      const comment = result.claimed[0];
      if (!comment?.claim?.id) return ok({ ...buildAgentNextEmpty('all'), skipped: result.skipped ?? [] });
      const { plan } = store.getPlan(comment.planId);
      const host = requestServiceUrl(request, deliveryConfig.serviceUrl);
      return ok({
        ...buildAgentNextClaimed({
          planId: plan.id,
          commentId: comment.id,
          claimId: comment.claim.id,
          conversationPayload: comment.conversationPayload,
          serviceUrl: host,
          reviewMode: plan.reviewMode,
          planPath: plan.planPath,
          sourcePath: plan.sourcePath,
          source: { path: plan.sourcePath, watchMode: plan.watchMode, lastSyncStatus: plan.lastSyncStatus }
        }),
        leaseExpiresAt: result.leaseExpiresAt,
        skipped: result.skipped ?? []
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

	  app.get('/api/agent/queue', async (request) => {
	    const query = request.query as { repoKey?: string; planId?: string; limit?: string };
	    emitExpired(query.planId);
	    return ok(store.queueSnapshot({
      repoKey: query.repoKey,
      planId: query.planId,
      limit: query.limit ? Number(query.limit) : undefined
    }));
  });

  app.get('/api/plans/:planId/events/poll', async (request, reply) => {
    try {
	      const { planId } = request.params as { planId: string };
	      const query = request.query as { afterSequence?: string; mode?: 'all' | 'queue'; limit?: string };
	      const { plan } = store.getPlan(planId);
	      emitExpired(plan.id);
	      return ok({
        events: store.eventsAfter(plan.id, Number(query.afterSequence ?? 0), query.mode ?? 'queue', Number(query.limit ?? 200)),
        latestSequence: store.latestEventSequence(plan.id, 'all'),
        retryAfterMs: 10000
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/:planId/events', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const query = request.query as { mode?: 'all' | 'queue'; afterSequence?: string };
    try {
	      const { plan } = store.getPlan(planId);
	      emitExpired(plan.id);
	      const lastEventId = Number(request.headers['last-event-id'] ?? 0);
      const queryAfterSequence = Number(query.afterSequence ?? 0);
      const afterSequence = Math.max(
        Number.isFinite(lastEventId) ? lastEventId : 0,
        Number.isFinite(queryAfterSequence) ? queryAfterSequence : 0
      );
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      reply.raw.write(`event: connected\ndata: ${JSON.stringify({ serverTime: new Date().toISOString() })}\n\n`);
      for (const event of store.eventsAfter(plan.id, afterSequence, query.mode ?? 'queue')) {
        reply.raw.write(eventForSse(event));
      }
      const off = bus.onEvent(plan.id, event => {
        if ((query.mode ?? 'queue') === 'queue' && !event.eventType.startsWith('comment.')) return;
        reply.raw.write(eventForSse(event));
      });
	      const heartbeat = setInterval(() => {
	        emitExpired(plan.id);
	        reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ latestSequence: store.latestEventSequence(plan.id, 'all'), serverTime: new Date().toISOString() })}\n\n`);
      }, 15000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        off();
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/assets/:assetId', async (request, reply) => {
    try {
      const { assetId } = request.params as { assetId: string };
      const asset = store.getAsset(assetId);
      reply.header('cache-control', 'public, max-age=31536000, immutable').type(asset.contentType).send(fs.readFileSync(asset.blobPath));
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/comment-assets/:assetId', async (request, reply) => {
    try {
      const { assetId } = request.params as { assetId: string };
      const asset = store.getAsset(assetId);
      reply.header('cache-control', 'public, max-age=31536000, immutable').type(asset.contentType).send(fs.readFileSync(asset.blobPath));
    } catch (error) {
      sendError(reply, error);
    }
  });

  return app;
}
