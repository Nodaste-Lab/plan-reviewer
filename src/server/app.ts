import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { ZodError } from 'zod';
import {
  ackCommentSchema,
  appendThreadEntrySchema,
  changePlanModeSchema,
  claimCommentsSchema,
  claimQueueSchema,
  createCommentSchema,
  createPlanNoteSchema,
  deferPlanSchema,
  deliveryAdapterSchema,
  deliveryTargetUpdateSchema,
  planPullRequestSchema,
  registerPlanSchema,
  releaseCommentSchema,
  resolveCommentSchema,
  resumePlanSchema
} from '../schemas.js';
import { renderPlan } from '../render/render.js';
import { buildRegistrationAgentInstructions } from '../registrationInstructions.js';
import { PlanReviewStore, type StoredEvent } from '../storage/database.js';
import { SourceSyncService } from './sourceSync.js';
import { fail, ok, PlanReviewError } from '../util.js';
import { planTitleFallback, renderedHtmlTitle, reviewShellTitle } from '../planTitles.js';
import { resolveDeliveryWorkerConfig, type DeliveryWorkerConfig } from '../config.js';
import { DeliveryWorker, type DeliveryWorkerOptions } from '../delivery/worker.js';
import { buildAgentNextClaimed, buildAgentNextEmpty } from '../agentNext.js';

export interface AppOptions {
  dbPath: string;
  delivery?: Partial<DeliveryWorkerConfig> & Pick<DeliveryWorkerOptions, 'clientFactory'>;
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
  return `body{margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:32px}a{color:#7dd3fc}.page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.page-header h1{margin:0 0 8px}.nav-link,.restore-plan,.archive-plan{background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px 10px;cursor:pointer;text-decoration:none;font-weight:700}.nav-link.primary,.restore-plan{border-color:#38bdf8;color:#bae6fd}.restore-plan{border-color:#22c55e;color:#bbf7d0}.toolbar{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:10px;margin:18px 0}.toolbar input,.toolbar select{background:#0f172a;color:#e5e7eb;border:1px solid #2b364d;border-radius:6px;padding:10px}.plan-card{border:1px solid #2563eb;border-left:5px solid #2563eb;background:#111827;border-radius:8px;padding:16px;margin:12px 0}.plan-card.complete{border-color:#16a34a;border-left-color:#16a34a}.plan-card.needs-attention{border-color:#f59e0b;border-left-color:#f59e0b;background:linear-gradient(180deg,rgba(245,158,11,.10),#111827 42%)}.plan-card.archived{border-color:#64748b;border-left-color:#64748b}.plan-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.plan-card-header h2{margin-top:0}.plan-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-end}.archive-plan:hover,.restore-plan:hover,.nav-link:hover{border-color:#93c5fd}.plan-metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin:12px 0}.plan-metadata div{min-width:0}.plan-metadata dt{color:#a7b0c0;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.03em}.plan-metadata dd{margin:3px 0 0;overflow-wrap:anywhere}.ready-pill{display:inline-block;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:800}.ready-pill.ready{background:#166534;color:#dcfce7}.ready-pill.not-ready{background:#7f1d1d;color:#fecaca}.pr-status{margin:6px 0}.pr-pill{display:inline-block;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:800;text-decoration:none;background:#334155;color:#e2e8f0}.pr-pill.open{background:#1d4ed8;color:#dbeafe}.pr-pill.merged{background:#166534;color:#dcfce7}.pr-pill.closed{background:#7f1d1d;color:#fecaca}.pr-pill.unknown,.pr-pill.stale{background:#92400e;color:#ffedd5}.pr-error{color:#fecaca}.progress-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;margin:12px 0}.progress-bar{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:5px}.progress-segment{height:14px;border:1px solid #64748b;border-radius:3px;background:transparent}.progress-segment.complete{background:#22c55e;border-color:#22c55e}.progress-count,.progress-empty,.muted,.comment-counts,.timestamp-row{color:#a7b0c0;font-size:13px}.comment-counts,.timestamp-row{margin:6px 0}.row-label{color:#e5e7eb;font-weight:800}.status-pill{display:inline-block;border-radius:999px;padding:2px 8px;background:#1d4ed8;color:#dbeafe;font-size:12px;font-weight:700}.complete .status-pill{background:#166534;color:#dcfce7}.status-pill.attention{background:#fbbf24;color:#1c1206}.archived .status-pill{background:#334155;color:#cbd5e1}.attention-summary,.sync-warning-card{border:1px solid rgba(245,158,11,.45);border-radius:8px;background:rgba(245,158,11,.10);padding:12px;margin:12px 0;color:#fde68a}.attention-summary{display:flex;align-items:center;justify-content:space-between;gap:12px}.attention-summary button{background:#92400e;color:#ffedd5;border:1px solid rgba(245,158,11,.65);border-radius:999px;padding:6px 10px;cursor:pointer;font-weight:800}.sync-warning-card.archived-source{border-color:#475569;background:#0f172a;color:#cbd5e1}.sync-warning-card p{margin:.35rem 0 0}.sync-warning-card code{display:inline-block;max-width:100%;overflow-wrap:anywhere}.repair-command code{display:block;margin-top:.25rem;padding:.35rem .5rem}.empty-state,.restore-error{border:1px solid #475569;border-radius:8px;background:#0f172a;padding:14px;margin:12px 0;color:#cbd5e1}.restore-error{border-color:#fb7185;color:#fecdd3}code{background:#0f172a;color:#dbeafe;padding:.1rem .25rem;border-radius:4px}@media(max-width:680px){.page-header,.toolbar,.progress-row,.plan-metadata{grid-template-columns:1fr;display:grid}.plan-card-header{display:block}.plan-actions{justify-content:flex-start;margin-bottom:8px}}`;
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
  return `${item.plan.repoName} ${item.plan.repoKey} ${item.plan.slug} ${item.plan.reviewMode} ${fullyQualifiedPlanPath(item)} ${metadata?.worktreePath ?? ''} ${metadata?.branch ?? ''} ${item.latestNote?.body ?? ''}${linearTerms}${prTerms}${attentionTerms}`.toLowerCase();
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
  return [...plans].sort((a, b) => planNavigatorRank(a) - planNavigatorRank(b)
    || planProgressRatio(b) - planProgressRatio(a)
    || String(b.activityAt).localeCompare(String(a.activityAt))
    || displayTitle(a).localeCompare(displayTitle(b))
    || String(a.plan.id).localeCompare(String(b.plan.id)));
}

function planNavigatorStatus(item: ListedPlan): string {
  if (planNeedsAttention(item)) return 'Needs attention';
  if (planComplete(item)) return 'Complete';
  if (item.plan.reviewMode === 'collaboration') return 'Collaboration';
  if (item.plan.publicationMetadata?.executionReady) return 'Execution ready';
  return 'Execution not ready';
}

function planNavigatorProgress(item: ListedPlan): string {
  if (!item.progress.totalPhases) return 'No phases';
  return `${item.progress.completedPhases}/${item.progress.totalPhases}`;
}

function planNavigatorItemHtml(item: ListedPlan, currentPlanId: string): string {
  const active = item.plan.id === currentPlanId;
  const status = planNavigatorStatus(item);
  return `<a class="plan-nav-item${active ? ' active' : ''}${planNeedsAttention(item) ? ' attention' : ''}" href="/p/${escapeHtml(item.plan.id)}" data-plan-nav-item data-plan-id="${escapeHtml(item.plan.id)}" aria-current="${active ? 'page' : 'false'}">
    <span class="plan-nav-title">${escapeHtml(displayTitle(item))}</span>
    <span class="plan-nav-meta"><span class="plan-nav-pill ${item.plan.reviewMode === 'collaboration' || item.plan.publicationMetadata?.executionReady ? 'ready' : 'not-ready'}">${escapeHtml(status)}</span><span>${escapeHtml(planNavigatorProgress(item))}</span></span>
    <span class="plan-nav-submeta">pending ${item.counts.pending} · updated <time datetime="${escapeHtml(item.modifiedAt)}" data-local-timestamp>${escapeHtml(item.modifiedAt)}</time></span>
  </a>`;
}

function planNavigatorHtml(plans: ListedPlan[], currentPlanId: string, label = 'plans'): string {
  const items = sortPlansForNavigator(plans).map(item => planNavigatorItemHtml(item, currentPlanId)).join('');
  const title = label === 'documents' ? 'Active documents' : 'Active plans';
  const empty = label === 'documents' ? 'No active documents.' : 'No active plans.';
  return `<aside id="plan-list-nav" aria-label="${escapeHtml(title)}"><div class="plan-list-header"><h2>${escapeHtml(title)}</h2><button id="plan-list-retry" type="button" hidden>Retry</button></div><div class="plan-list-error" id="plan-list-error" hidden>Unable to load ${escapeHtml(label)}.</div><div id="plan-list-items">${items || `<p class="plan-list-empty">${escapeHtml(empty)}</p>`}</div></aside>`;
}

function planCardHtml(item: ListedPlan): string {
  const complete = planComplete(item);
  const needsAttention = planNeedsAttention(item);
  const statusLabel = needsAttention ? 'Source missing' : complete ? 'Complete' : 'Incomplete';
  const cardClass = needsAttention ? 'needs-attention' : complete ? 'complete' : 'incomplete';
  const prStatus = item.plan.pullRequest?.status ?? item.plan.pullRequest?.state ?? 'unlinked';
  return `<article class="plan-card ${cardClass}" data-plan-id="${escapeHtml(item.plan.id)}" data-repo="${escapeHtml(item.plan.repoName)}" data-pr-status="${escapeHtml(prStatus)}" data-search="${escapeHtml(planCardSearch(item))}" data-needs-attention="${needsAttention ? 'true' : 'false'}" aria-label="${escapeHtml(`${item.plan.repoName} / ${item.plan.slug}: ${statusLabel}`)}">
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

function indexHtml(plans: ReturnType<PlanReviewStore['listPlans']>, archivedCount: number, deferredCount: number): string {
  const repos = [...new Set(plans.map(item => item.plan.repoName))].sort();
  const attentionCount = plans.filter(planNeedsAttention).length;
  const attentionSummary = attentionCount
    ? `<div class="attention-summary" role="status"><strong>${attentionCount} ${attentionCount === 1 ? 'plan · source file missing' : 'plans · source files missing'}</strong><span>Cached copies still open.</span><button type="button" data-attention-filter aria-pressed="false">Needs attention</button></div>`
    : '';
  const startedPlans = plans.filter(hasStartedPlanProgress);
  const notStartedPlans = plans.filter(item => !hasStartedPlanProgress(item));
  const rows = [repoGroupsHtml(startedPlans), repoGroupsHtml(notStartedPlans)].filter(Boolean).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plan Review Index</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <style>${baseIndexStyles()}</style>
  </head><body><main><div class="page-header"><div><h1>Plan Review Index</h1><p class="muted">Active plans are shown by default.</p></div><div class="plan-actions"><a class="nav-link primary" href="/deferred">Deferred (${deferredCount}) →</a><a class="nav-link primary" href="/archive">Archived (${archivedCount}) →</a></div></div>${attentionSummary}<div class="toolbar"><input id="q" placeholder="Filter plans" aria-label="Filter plans"><select id="repo" aria-label="Filter by repo"><option value="">All repos</option>${repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('')}</select></div><div id="plans">${rows || '<p>No active plans registered.</p>'}</div><script>
  const q=document.getElementById('q'), repo=document.getElementById('repo'), attentionFilter=document.querySelector('[data-attention-filter]'), cards=[...document.querySelectorAll('.plan-card')];
  let attentionOnly=false;
  function matchesSearch(card,text){if(!text)return true; const status=card.dataset.prStatus; if(text==='merged')return status==='merged'; if(text==='unmerged')return !!status&&status!=='merged'&&status!=='unlinked'; return card.dataset.search.includes(text);}  function apply(){const text=q.value.toLowerCase().trim(), r=repo.value; cards.forEach(card=>{card.hidden=!!((r&&card.dataset.repo!==r)||(text&&!matchesSearch(card,text))||(attentionOnly&&card.dataset.needsAttention!=='true'));}); document.querySelectorAll('.repo-group').forEach(group=>{group.hidden=!group.querySelector('.plan-card:not([hidden])');});}
  ${localTimestampScript()}
  q.addEventListener('input',apply); repo.addEventListener('change',apply); attentionFilter?.addEventListener('click',()=>{attentionOnly=!attentionOnly; attentionFilter.setAttribute('aria-pressed', String(attentionOnly)); apply();});
  document.addEventListener('click',async event=>{const target=event.target; const button=target instanceof Element ? target.closest('[data-archive-plan]') : null; if(!button) return; if(!confirm('Archive this plan?')) return; button.disabled=true; const planId=button.dataset.archivePlan; const res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/archive',{method:'POST'}); if(!res.ok){button.disabled=false; alert('Unable to archive plan.'); return;} button.closest('.plan-card')?.remove(); const index=cards.findIndex(card=>card.dataset.planId===planId); if(index>=0) cards.splice(index,1); apply();});
  </script></main></body></html>`;
}

function archiveHtml(plans: ReturnType<PlanReviewStore['listPlans']>, deferredCount = 0): string {
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
    <style>${baseIndexStyles()}</style>
  </head><body><main><div class="page-header"><div><h1>Archived Plans</h1><p class="muted">Archived plans stay out of the active index but remain inspectable and restorable.</p></div><div class="plan-actions"><a class="nav-link primary" href="/">← Active index</a><a class="nav-link primary" href="/deferred">Deferred (${deferredCount}) →</a></div></div><div class="toolbar"><input id="q" placeholder="Filter archived plans" aria-label="Filter archived plans"><select id="repo" aria-label="Filter by repo"><option value="">All repos</option>${repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('')}</select></div><p class="muted" id="archive-count">${archivedPlans.length} archived</p><div id="plans">${rows || empty}</div>${rows ? filteredEmpty : ''}<script>
  const q=document.getElementById('q'), repo=document.getElementById('repo'), cards=[...document.querySelectorAll('.plan-card')], filteredEmpty=document.getElementById('archive-filter-empty'), count=document.getElementById('archive-count');
  function matchesSearch(card,text){if(!text)return true; const status=card.dataset.prStatus; if(text==='merged')return status==='merged'; if(text==='unmerged')return !!status&&status!=='merged'&&status!=='unlinked'; return card.dataset.search.includes(text);}  function apply(){const text=q.value.toLowerCase().trim(), r=repo.value; let visible=0; cards.forEach(card=>{card.hidden=!!((r&&card.dataset.repo!==r)||(text&&!matchesSearch(card,text))); if(!card.hidden) visible++;}); if(filteredEmpty) filteredEmpty.hidden=visible>0||cards.length===0; if(count) count.textContent=visible+' archived';}
  ${localTimestampScript()}
  q?.addEventListener('input',apply); repo?.addEventListener('change',apply); document.getElementById('clear-filters')?.addEventListener('click',()=>{q.value=''; repo.value=''; apply();});
  document.addEventListener('click',async event=>{const target=event.target; const button=target instanceof Element ? target.closest('[data-restore-plan]') : null; if(!button) return; button.disabled=true; const card=button.closest('.plan-card'); const error=card?.querySelector('.restore-error'); if(error) error.hidden=true; const planId=button.dataset.restorePlan; let res; try{res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive',{method:'POST'});}catch{button.disabled=false; if(error) error.hidden=false; return;} if(!res.ok){button.disabled=false; if(error) error.hidden=false; return;} card?.remove(); const index=cards.findIndex(item=>item.dataset.planId===planId); if(index>=0) cards.splice(index,1); apply();});
  </script></main></body></html>`;
}

function deferredHtml(plans: ReturnType<PlanReviewStore['listPlans']>, archivedCount = 0): string {
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
    <style>${baseIndexStyles()}</style>
  </head><body><main><div class="page-header"><div><h1>Deferred Plans</h1><p class="muted">Deferred plans are paused for later pickup and keep their notes with the plan.</p></div><div class="plan-actions"><a class="nav-link primary" href="/">← Active index</a><a class="nav-link primary" href="/archive">Archived (${archivedCount}) →</a></div></div><div class="toolbar"><input id="q" placeholder="Filter deferred plans" aria-label="Filter deferred plans"><select id="repo" aria-label="Filter by repo"><option value="">All repos</option>${repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('')}</select></div><p class="muted" id="deferred-count">${deferredPlans.length} deferred</p><div id="plans">${rows || empty}</div>${rows ? filteredEmpty : ''}<script>
  const q=document.getElementById('q'), repo=document.getElementById('repo'), cards=[...document.querySelectorAll('.plan-card')], filteredEmpty=document.getElementById('deferred-filter-empty'), count=document.getElementById('deferred-count');
  function apply(){const text=q.value.toLowerCase(), r=repo.value; let visible=0; cards.forEach(card=>{card.hidden=!!((r&&card.dataset.repo!==r)||(text&&!card.dataset.search.includes(text))); if(!card.hidden) visible++;}); if(filteredEmpty) filteredEmpty.hidden=visible>0||cards.length===0; if(count) count.textContent=visible+' deferred';}
  ${localTimestampScript()}
  q?.addEventListener('input',apply); repo?.addEventListener('change',apply); document.getElementById('clear-filters')?.addEventListener('click',()=>{q.value=''; repo.value=''; apply();});
  document.addEventListener('click',async event=>{const target=event.target; const resume=target instanceof Element ? target.closest('[data-resume-plan]') : null; const archive=target instanceof Element ? target.closest('[data-archive-plan]') : null; const button=resume||archive; if(!button) return; button.disabled=true; const card=button.closest('.plan-card'); const error=card?.querySelector('.restore-error'); if(error) error.hidden=true; const planId=resume ? button.dataset.resumePlan : button.dataset.archivePlan; const path=resume ? '/resume' : '/archive'; let res; try{res=await fetch('/api/plans/'+encodeURIComponent(planId)+path,{method:'POST',headers:{'content-type':'application/json'},body: resume ? '{}' : undefined});}catch{button.disabled=false; if(error) error.hidden=false; return;} if(!res.ok){button.disabled=false; if(error) error.hidden=false; return;} card?.remove(); const index=cards.findIndex(item=>item.dataset.planId===planId); if(index>=0) cards.splice(index,1); apply();});
  </script></main></body></html>`;
}

function filterPlans(plans: ReturnType<PlanReviewStore['listPlans']>, query: { q?: string; repoKey?: string; status?: string; limit?: string; cursor?: string; currentPlanId?: string }) {
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
    const matchesStatus = !query.status || Number(item.counts[query.status as keyof typeof item.counts] ?? 0) > 0;
    const haystack = planCardSearch(item);
    const trimmedText = text?.trim();
    const prStatus = item.plan.pullRequest?.status ?? item.plan.pullRequest?.state;
    const matchesText = !trimmedText
      || (trimmedText === 'merged' ? prStatus === 'merged' : trimmedText === 'unmerged' ? Boolean(item.plan.pullRequest && prStatus !== 'merged') : haystack.includes(trimmedText));
    return matchesRepo && matchesStatus && matchesText;
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

const executionReviewRequestBody = 'Review this plan with both codex and claude code, iterating on the plan until both agents agree it is execution ready';
const clientAssetVersion = 'mobile-overlay-native-scroll-v5';

function buildPlanRequestBody(planPath: string): string {
  return `/skill:scoped-plan-run thoughts/plans/${path.basename(planPath)}`;
}

function reviewShell(plan: ReturnType<PlanReviewStore['getPlan']>['plan'], currentTitle: string, shellTitle: string, plans: ListedPlan[]): string {
  const escapedPlanId = escapeHtml(plan.id);
  const escapedShellTitle = escapeHtml(shellTitle);
  const escapedCurrentTitle = escapeHtml(currentTitle);
  const isCollaboration = plan.reviewMode === 'collaboration';
  const readyLabel = isCollaboration ? 'Collaboration mode' : plan.publicationMetadata?.executionReady ? 'Execution ready' : 'Execution not ready';
  const encodedTitleFallback = escapeHtml(encodeClientData(reviewShellTitle(planTitleFallback(plan))));
  const reviewButton = isCollaboration ? '' : '<button id="request-execution-review" type="button">Request execution-ready review</button>';
  const buildButton = isCollaboration ? '' : '<button id="build-plan" type="button">Build Plan</button>';
  const commentsButton = '<button id="desktop-comments-toggle" class="comments-toggle" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Open comments">Comments <span id="desktop-comments-count" class="comments-count" hidden></span></button>';
  const indexLink = isCollaboration ? '<a href="/">← Document index</a>' : '<a href="/">← Plan index</a>';
  const archiveLabel = isCollaboration ? 'Archive document' : 'Archive plan';
  const restoreLabel = isCollaboration ? 'Restore document' : 'Restore plan';
  const resumeLabel = isCollaboration ? 'Resume document' : 'Resume plan';
  const deferAction = isCollaboration ? '' : '<button id="defer-plan" type="button">Defer plan</button>';
  const navActions = plan.archivedAt
    ? `<a href="/archive">← Archive</a>${reviewButton}${buildButton}<span id="archive-status" class="archive-status">Archived</span><button id="restore-plan" type="button">${restoreLabel}</button>${commentsButton}`
    : plan.lifecycleState === 'deferred'
      ? `<a href="/deferred">← Deferred</a>${reviewButton}${buildButton}<span id="archive-status" class="archive-status">Deferred</span><button id="resume-plan" type="button">${resumeLabel}</button><button id="archive-plan" type="button">${archiveLabel}</button>${commentsButton}`
      : `${indexLink}${reviewButton}${buildButton}<span id="archive-status" class="archive-status" hidden></span>${deferAction}<button id="archive-plan" type="button">${archiveLabel}</button>${commentsButton}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapedShellTitle}</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="stylesheet" href="/client.css?v=${clientAssetVersion}">
  </head><body data-plan-id="${escapedPlanId}" data-review-mode="${escapeHtml(plan.reviewMode)}" data-plan-title-fallback="${encodedTitleFallback}">
    <nav id="plan-navbar" aria-label="Plan actions"><div id="plan-navbar-actions">${navActions}</div><div id="current-plan-bar"><strong id="current-plan-title">${escapedCurrentTitle}</strong><span class="ready-pill ${isCollaboration || plan.publicationMetadata?.executionReady ? 'ready' : 'not-ready'}">${escapeHtml(readyLabel)}</span></div></nav>
    <div id="app">
      ${planNavigatorHtml(plans, plan.id, isCollaboration ? 'documents' : 'plans')}
      <main id="review"><iframe id="plan-frame" sandbox="allow-same-origin allow-popups" src="/render/${escapedPlanId}"></iframe><div id="plan-touch-layer" aria-hidden="true"></div><button id="mobile-comments-toggle" class="comments-toggle" type="button" aria-controls="sidebar" aria-expanded="false">Comments</button><div id="hover-selection-box" class="selection-box hover" hidden></div><div id="active-selection-box" class="selection-box active" hidden></div></main>
      <aside id="sidebar"><h1>Comments</h1><div id="sync-warning" hidden></div><section id="plan-notes-panel"><h2>${isCollaboration ? 'Document notes' : 'Plan notes'}</h2><div id="plan-notes"></div><textarea id="plan-note-body" placeholder="${isCollaboration ? 'Add context for agents' : 'Add a plan note for agents'}"></textarea><button id="add-plan-note" type="button">Add note</button></section><div id="deferred-refresh-notice" hidden>Document updated in the background. Finish or cancel this comment to refresh.</div><div id="comments"></div></aside>
    </div>
    <div id="lightbox" class="lightbox" hidden><header><button id="zoom-out">-</button><button id="zoom-reset">Reset</button><button id="zoom-in">+</button><button id="pan-toggle">Pan</button><button id="close-lightbox">Close</button></header><div id="lightbox-stage" class="lightbox-stage"><img id="lightbox-image" alt=""><div id="image-selection-box" hidden></div></div></div>
    <div id="composer" hidden><textarea id="comment-body" placeholder="Comment on selection" inputmode="text" enterkeyhint="done" autocapitalize="sentences"></textarea><div id="comment-discard-warning" hidden>Your comment would be lost. Use Cancel to discard it.</div><button id="submit-comment">Submit</button><button id="cancel-comment">Cancel</button></div>
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
body{--comments-width:48px;margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,sans-serif}body.comments-open{--comments-width:320px}
#plan-navbar{min-height:86px;box-sizing:border-box;display:grid;grid-template-rows:auto auto;gap:8px;padding:10px 16px;border-bottom:1px solid #2b364d;background:#0f172a}#plan-navbar-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}#plan-navbar a{color:#7dd3fc;text-decoration:none;font-weight:700;margin-right:auto}#plan-navbar button{background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px 10px;cursor:pointer}#plan-navbar button:hover{border-color:#93c5fd}#current-plan-bar{display:flex;align-items:center;gap:8px;min-width:0;border-top:1px solid rgba(71,85,105,.55);padding-top:8px;color:#cbd5e1}#current-plan-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f8fafc}.archive-status{color:#cbd5e1;border:1px solid #475569;background:#1e293b;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:800}#restore-plan{border-color:#22c55e;color:#bbf7d0}.comments-toggle{display:inline-flex;align-items:center;gap:6px}.comments-count{min-width:18px;height:18px;border-radius:999px;background:#7e22ce;color:white;display:inline-grid;place-items:center;padding:0 5px;font-size:11px;font-weight:900}
#app{display:grid;grid-template-columns:260px minmax(0,1fr) var(--comments-width);min-height:calc(100vh - 86px);transition:grid-template-columns .18s ease}
#plan-list-nav{grid-column:1;border-right:1px solid #2b364d;background:#0b1220;padding:14px;overflow:auto}#plan-list-nav h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#a7b0c0;margin:0}.plan-list-header{display:flex;align-items:center;justify-content:space-between;gap:8px}.plan-list-error{border:1px solid #f59e0b;background:rgba(245,158,11,.12);color:#fde68a;border-radius:8px;padding:8px;margin:10px 0;font-size:13px}.plan-list-empty{color:#a7b0c0;font-size:13px}.plan-nav-item{display:grid;gap:5px;padding:10px;margin:8px 0;border:1px solid #253248;border-radius:10px;background:#101827;color:#cbd5e1;text-decoration:none}.plan-nav-item:hover{border-color:#64748b}.plan-nav-item.active{border-color:#38bdf8;background:linear-gradient(135deg,rgba(14,165,233,.18),rgba(16,24,39,.95))}.plan-nav-item.attention{border-color:#f59e0b}.plan-nav-title{font-size:13px;font-weight:850;color:#f8fafc;line-height:1.25}.plan-nav-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;color:#a7b0c0;font-size:11px}.plan-nav-submeta{color:#8fa0b8;font-size:11px}.plan-nav-pill{border:1px solid #475569;border-radius:999px;padding:1px 6px;background:#0b1220}.plan-nav-pill.ready{border-color:#22c55e;color:#bbf7d0}.plan-nav-pill.not-ready{border-color:#f59e0b;color:#fde68a}
#review{grid-column:2;position:relative;min-width:0}#sidebar{grid-column:3;grid-row:1;border-left:1px solid #2b364d;padding:0;background:#111827;overflow:hidden}#sidebar>h1,#sidebar>#sync-warning,#sidebar>#plan-notes-panel,#sidebar>#deferred-refresh-notice,#sidebar>#comments{display:none}body.comments-open #sidebar{padding:16px;overflow:auto}body.comments-open #sidebar>h1,body.comments-open #sidebar>#sync-warning,body.comments-open #sidebar>#plan-notes-panel,body.comments-open #sidebar>#deferred-refresh-notice,body.comments-open #sidebar>#comments{display:block}
#plan-touch-layer{display:none}
#plan-frame{width:100%;height:calc(100vh - 86px);border:0;background:white}.selection-box,.comment-anchor{position:fixed;pointer-events:none;border-radius:6px;transition:left .22s cubic-bezier(.2,0,.2,1),top .22s cubic-bezier(.2,0,.2,1),width .22s cubic-bezier(.2,0,.2,1),height .22s cubic-bezier(.2,0,.2,1),opacity .14s ease}.selection-box{z-index:8;box-sizing:border-box;background:transparent;box-shadow:none}.selection-box.hover{border:2px dotted rgba(56,189,248,.82)}.selection-box.active{z-index:9;border:2px dotted #38bdf8;box-shadow:0 0 0 1px rgba(255,255,255,.72)}.comment-anchor{z-index:7}.comment-anchor.pending{border:2px dotted rgba(192,132,252,.95);background:transparent;box-shadow:0 0 0 3px rgba(168,85,247,.08)}.comment-anchor.addressed{border:2px dotted rgba(216,180,254,.9);background:transparent;box-shadow:none}.comment-anchor-label{position:absolute;right:-10px;top:-12px;min-width:24px;height:24px;border-radius:999px;display:grid;place-items:center;padding:0 6px;background:#7e22ce;color:white;border:2px solid #f3e8ff;font-weight:800;font-size:12px;box-shadow:0 8px 18px rgba(0,0,0,.35)}.comment-anchor.addressed .comment-anchor-label{display:none}.comment-row{border:1px solid #2b364d;padding:10px;margin:8px 0;border-radius:8px;background:#0f172a}.comment-row small{color:#a7b0c0}.marker{position:absolute;z-index:9;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:#0ea5e9;color:white;border:2px solid #dbeafe;font-weight:700;box-shadow:0 8px 18px rgba(0,0,0,.35);pointer-events:none}
#sync-warning{border:1px solid #f59e0b;background:rgba(245,158,11,.12);color:#fde68a;border-radius:8px;padding:10px;margin:8px 0 14px;font-size:13px}#deferred-refresh-notice{border:1px solid #38bdf8;background:rgba(56,189,248,.12);color:#bae6fd;border-radius:8px;padding:10px;margin:8px 0 14px;font-size:13px}#composer{position:fixed;right:calc(var(--comments-width) + 20px);top:112px;background:#0f172a;border:1px solid #38bdf8;padding:12px;border-radius:8px;z-index:20;box-shadow:0 12px 32px rgba(0,0,0,.4)}#composer.discard-warning{border-color:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22),0 12px 32px rgba(0,0,0,.4)}
#comment-discard-warning{margin-top:8px;color:#fecaca;font-size:13px;font-weight:700}#composer.discard-warning textarea{border-color:#ef4444}
#composer textarea{width:260px;height:90px;background:#020617;color:#e5e7eb;border:1px solid #2b364d;border-radius:6px;padding:8px;display:block;pointer-events:auto;touch-action:manipulation;-webkit-user-select:text;user-select:text}
#composer button{margin-top:8px;margin-right:8px}#plan-notes-panel{border:1px solid #2b364d;border-radius:10px;background:#0f172a;padding:10px;margin:0 0 14px}#plan-notes-panel h2{font-size:15px;margin:0 0 8px}#plan-notes .note-row{border-top:1px solid #263246;padding:8px 0}#plan-notes .note-row:first-child{border-top:0}#plan-note-body{width:100%;min-height:70px;box-sizing:border-box;background:#020617;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px}#add-plan-note{margin-top:8px;background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px 10px;cursor:pointer}.plan-review-selected{outline:2px dotted #38bdf8!important;box-shadow:none!important}.lightbox{position:fixed;inset:36px calc(var(--comments-width) + 40px) 36px 36px;background:#020617;border:1px solid #38bdf8;z-index:12;display:grid;grid-template-rows:auto 1fr}.lightbox[hidden]{display:none}.lightbox header{display:flex;gap:8px;padding:10px;border-bottom:1px solid #2b364d}.lightbox img{max-width:100%;max-height:100%;place-self:center;transform-origin:center}.lightbox-stage{display:grid;overflow:hidden;position:relative}#image-selection-box{position:absolute;border:2px solid #38bdf8;background:rgba(56,189,248,.2);pointer-events:none}#mobile-comments-toggle{display:none}
@media(prefers-reduced-motion:reduce){.selection-box{transition:none}}
@media(max-width:760px),(pointer:coarse){body{overflow:hidden;--comments-width:0}#plan-navbar{position:sticky;top:0;z-index:30;min-height:88px;box-sizing:border-box;gap:6px;padding:8px;overflow-x:auto;overscroll-behavior-x:contain}#plan-navbar-actions{justify-content:flex-start;gap:8px}#plan-navbar a,#plan-navbar button{flex:0 0 auto;min-height:40px;padding:8px 10px;font-size:13px;line-height:1.15;white-space:normal}#current-plan-bar{font-size:13px}#request-execution-review{max-width:170px}#build-plan{max-width:120px}#desktop-comments-toggle{display:none}#app{display:block;min-height:calc(100dvh - 88px)}#plan-list-nav{display:none}#review{height:calc(100dvh - 88px);overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch}#plan-frame{width:100%;min-height:calc(100dvh - 88px);border:0;display:block;pointer-events:none}#plan-touch-layer{display:block;position:absolute;top:0;left:0;width:100%;min-height:calc(100dvh - 88px);z-index:22;background:transparent;touch-action:pan-y;pointer-events:auto}#sidebar{position:fixed;left:0;right:0;bottom:0;top:auto;z-index:24;max-height:min(72dvh,620px);box-sizing:border-box;border-left:0;border-top:1px solid #2b364d;border-radius:18px 18px 0 0;padding:12px 16px calc(16px + env(safe-area-inset-bottom));background:#111827;box-shadow:0 -16px 40px rgba(0,0,0,.45);overflow:auto;transform:translateY(100%);transition:transform .18s ease}#sidebar>h1,#sidebar>#sync-warning,#sidebar>#plan-notes-panel,#sidebar>#deferred-refresh-notice,#sidebar>#comments{display:block}body.comments-open #sidebar{transform:translateY(0)}#sidebar h1{position:sticky;top:-12px;margin:0 0 12px;padding:8px 0 10px;background:#111827;font-size:20px;z-index:1}.comment-row{padding:12px;margin:10px 0}.comment-row p{margin:.55rem 0}.comments-empty{margin:0;color:#a7b0c0;font-size:14px}#mobile-comments-toggle{display:flex;position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:25;min-height:44px;align-items:center;gap:6px;border:1px solid #38bdf8;border-radius:999px;background:#075985;color:#e0f2fe;padding:0 14px;font-weight:800;box-shadow:0 12px 28px rgba(0,0,0,.35)}body.comments-open #mobile-comments-toggle{background:#0f172a;border-color:#64748b}#composer{left:0;right:0;bottom:0;top:auto;z-index:60;box-sizing:border-box;border-left:0;border-right:0;border-bottom:0;border-radius:18px 18px 0 0;padding:14px 16px calc(16px + env(safe-area-inset-bottom));box-shadow:0 -16px 40px rgba(0,0,0,.48)}#composer textarea{width:100%;height:122px;box-sizing:border-box;font-size:16px}#composer button{min-height:44px;padding:8px 12px}.lightbox{inset:0;z-index:50;border:0}.lightbox header{flex-wrap:wrap}.selection-box{border-radius:4px}.marker{width:28px;height:28px}}
`;

const clientJs = `
import { finder } from '/vendor/finder.js';
import { Washi } from '/vendor/washi.js';
import mermaid from '/vendor/mermaid.esm.min.mjs';

const planId = document.body.dataset.planId;
const isCollaborationMode = document.body.dataset.reviewMode === 'collaboration';
const documentKind = isCollaborationMode ? 'document' : 'plan';
let planTitleFallback = 'Plan Review';
try {
  const bytes = Uint8Array.from(atob(document.body.dataset.planTitleFallback || ''), char => char.charCodeAt(0));
  const decodedTitleFallback = new TextDecoder().decode(bytes) || planTitleFallback;
  planTitleFallback = decodedTitleFallback.replace(/\s+·\s+Plan Review$/i, '').trim() || decodedTitleFallback;
} catch {}
const frame = document.getElementById('plan-frame');
const planTouchLayer = document.getElementById('plan-touch-layer');
const archivePlanButton = document.getElementById('archive-plan');
const restorePlanButton = document.getElementById('restore-plan');
const deferPlanButton = document.getElementById('defer-plan');
const resumePlanButton = document.getElementById('resume-plan');
const executionReviewButton = document.getElementById('request-execution-review');
const buildPlanButton = document.getElementById('build-plan');
const planNotes = document.getElementById('plan-notes');
const planNoteBody = document.getElementById('plan-note-body');
const addPlanNoteButton = document.getElementById('add-plan-note');
const composer = document.getElementById('composer');
const body = document.getElementById('comment-body');
const discardWarning = document.getElementById('comment-discard-warning');
const submitCommentButton = document.getElementById('submit-comment');
const cancelCommentButton = document.getElementById('cancel-comment');
const comments = document.getElementById('comments');
const mobileCommentsToggle = document.getElementById('mobile-comments-toggle');
const desktopCommentsToggle = document.getElementById('desktop-comments-toggle');
const desktopCommentsCount = document.getElementById('desktop-comments-count');
const planListItems = document.getElementById('plan-list-items');
const planListError = document.getElementById('plan-list-error');
const planListRetry = document.getElementById('plan-list-retry');
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
let pointerStart = null;
let suppressSyntheticClickUntil = 0;
let washi = null;
let mermaidInitialized = false;
let mermaidRenderGeneration = 0;
// Must match the CSS mobile layout media query exactly: the overlay tap surface
// and #review native-scroll layout (and the iframe-to-content-height sizing in
// syncFrameHeight) activate on narrow widths OR any coarse-pointer device. iPad
// and phone landscape are wider than 760px but still coarse-pointer, so keying
// off width alone left the iframe unsized and the lower plan content unreachable.
function isMobileShell(){ return window.matchMedia('(max-width: 760px), (pointer: coarse)').matches; }
function debugTouch(label, data = {}){
}
function updateCommentsToggles(){
  const count = Number(mobileCommentsToggle?.dataset.commentCount || desktopCommentsToggle?.dataset.commentCount || '0');
  const open = document.body.classList.contains('comments-open');
  if (mobileCommentsToggle) {
    mobileCommentsToggle.textContent = open ? 'Close' : count ? 'Comments (' + count + ')' : 'Comments';
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
function setCommentsOpen(open){
  document.body.classList.toggle('comments-open', open);
  updateCommentsToggles();
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
function showComposer(){
  if (pendingAnchor) ensurePendingCommentMutationId();
  if (isMobileShell()) setCommentsOpen(false);
  composer.hidden = false;
  body.focus();
}
function focusCommentBody(event){
  event?.stopPropagation?.();
  body.focus({ preventScroll: true });
}
body.addEventListener('touchstart', focusCommentBody, { capture: true });
body.addEventListener('pointerdown', focusCommentBody, { capture: true });
body.addEventListener('click', focusCommentBody, { capture: true });
submitCommentButton?.addEventListener('touchstart', event => event.stopPropagation(), { capture: true });
cancelCommentButton?.addEventListener('touchstart', event => event.stopPropagation(), { capture: true });
mobileCommentsToggle?.addEventListener('click', () => {
  setCommentsOpen(!document.body.classList.contains('comments-open'));
});
desktopCommentsToggle?.addEventListener('click', () => {
  setCommentsOpen(!document.body.classList.contains('comments-open'));
});
archivePlanButton?.addEventListener('click', async () => {
  if (!confirm('Archive this '+documentKind+'?')) return;
  archivePlanButton.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/archive', { method: 'POST' });
  if (!res.ok) {
    archivePlanButton.disabled = false;
    alert('Unable to archive '+documentKind+'.');
    return;
  }
  window.location.href = '/';
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
  }
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
  syncFrameHeight();
  scheduleFrameImageReflows();
  versionId = nextVersionId;
  hovered = null;
  selected = null;
  selectedForScreenshot = null;
  pendingAnchor = null;
  void mountWashiOverlay();
  win?.scrollTo(scrollX, scrollY);
  requestAnimationFrame(() => {
    win?.scrollTo(scrollX, scrollY);
    scheduleMarkerReflow();
  });
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
    || event.type === 'plan.mode.changed') {
    scheduleMetaLoad();
  }
}
function renderPlanNotes(items){
  if (!planNotes) return;
  const rows = items.map(note => '<div class="note-row"><p>'+escapeHtml(note.body)+'</p><small>'+escapeHtml(note.createdBy?.displayName || (isCollaborationMode ? 'Document reviewer' : 'Plan reviewer'))+' · '+escapeHtml(new Date(note.createdAt).toLocaleString())+'</small></div>').join('');
  planNotes.innerHTML = rows || '<p class="comments-empty">No '+documentKind+' notes yet.</p>';
}
function renderComments(items){
  renderMarkers(items);
  if (mobileCommentsToggle) mobileCommentsToggle.dataset.commentCount = String(items.length);
  if (desktopCommentsToggle) desktopCommentsToggle.dataset.commentCount = String(items.length);
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
    return '<div class="comment-row" data-comment-id="'+escapeHtml(c.id)+'"><strong>#'+c.sequence+' '+escapeHtml(c.status)+'</strong>'+thread+'<small>'+escapeHtml(c.anchorType)+' · '+escapeHtml(c.anchorState)+(metadata ? ' · '+metadata : '')+'</small>'+(context ? '<p><small>Context: '+context+'</small></p>' : '')+(screenshot ? '<p><small>'+screenshot+'</small></p>' : '')+deleteAction+'</div>';
  }).join('');
  comments.innerHTML = rows || '<p class="comments-empty">No comments yet. Tap a '+documentKind+' section to start one.</p>';
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
comments.addEventListener('click', event => {
  const target = event.target;
  const button = target instanceof Element ? target.closest('[data-delete-comment]') : null;
  if (!button) return;
  event.preventDefault();
  deleteComment(button.dataset.deleteComment, button);
});
function escapeHtml(value){ return String(value).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function planItemComplete(item){ return item?.progress?.totalPhases > 0 && item.progress.completedPhases === item.progress.totalPhases; }
function planItemAttention(item){ return item?.plan?.watchMode === 'filesystem' && item?.plan?.lastSyncStatus === 'failed'; }
function planItemRatio(item){ return item?.progress?.totalPhases > 0 ? item.progress.completedPhases / item.progress.totalPhases : 0; }
function planItemRank(item){ if (planItemAttention(item)) return 3; if (planItemComplete(item)) return 0; if (item?.plan?.publicationMetadata?.executionReady) return 1; return 2; }
function planItemTitle(item){ return String(item?.displayTitle || item?.plan?.repoName + ' / ' + item?.plan?.slug); }
function sortPlanNavItems(items){ return [...items].sort((a,b)=>planItemRank(a)-planItemRank(b)||planItemRatio(b)-planItemRatio(a)||String(b.activityAt||'').localeCompare(String(a.activityAt||''))||planItemTitle(a).localeCompare(planItemTitle(b))||String(a?.plan?.id||'').localeCompare(String(b?.plan?.id||''))); }
function planItemStatus(item){ if (planItemAttention(item)) return 'Needs attention'; if (planItemComplete(item)) return 'Complete'; if (item?.plan?.reviewMode === 'collaboration') return 'Collaboration'; if (item?.plan?.publicationMetadata?.executionReady) return 'Execution ready'; return 'Execution not ready'; }
function planItemProgress(item){ return item?.progress?.totalPhases ? item.progress.completedPhases + '/' + item.progress.totalPhases : 'No phases'; }
function renderPlanNavigatorItems(items, label = 'plans'){
  if (!planListItems) return;
  const html = sortPlanNavItems(items).map(item => {
    const id = String(item?.plan?.id || '');
    const active = id === planId;
    const status = planItemStatus(item);
    return '<a class="plan-nav-item'+(active ? ' active' : '')+(planItemAttention(item) ? ' attention' : '')+'" href="/p/'+encodeURIComponent(id)+'" data-plan-nav-item data-plan-id="'+escapeHtml(id)+'" aria-current="'+(active ? 'page' : 'false')+'"><span class="plan-nav-title">'+escapeHtml(planItemTitle(item))+'</span><span class="plan-nav-meta"><span class="plan-nav-pill '+(item?.plan?.reviewMode === 'collaboration' || item?.plan?.publicationMetadata?.executionReady ? 'ready' : 'not-ready')+'">'+escapeHtml(status)+'</span><span>'+escapeHtml(planItemProgress(item))+'</span></span><span class="plan-nav-submeta">pending '+Number(item?.counts?.pending || 0)+' · updated '+escapeHtml(String(item?.modifiedAt || ''))+'</span></a>';
  }).join('');
  planListItems.innerHTML = html || '<p class="plan-list-empty">No active '+(label === 'documents' ? 'documents' : 'plans')+'.</p>';
}
async function loadPlanNavigator(){
  if (!planListItems) return;
  try {
    const res = await fetch('/api/plans/navigator?limit=200&currentPlanId=' + encodeURIComponent(planId), { cache: 'no-store' });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error?.message || 'Unable to load plans');
    renderPlanNavigatorItems(json.data.plans || [], document.querySelector('#plan-list-nav')?.getAttribute('aria-label') === 'Active documents' ? 'documents' : 'plans');
    if (planListError) planListError.hidden = true;
    if (planListRetry) planListRetry.hidden = true;
  } catch (error) {
    if (planListError) { planListError.hidden = false; planListError.textContent = 'Unable to load plans. The current plan remains reviewable.'; }
    if (planListRetry) planListRetry.hidden = false;
  }
}
planListRetry?.addEventListener('click', () => { void loadPlanNavigator(); });
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
  ensureFrameTapTargets(doc);
  let style = doc.getElementById('plan-review-comment-anchor-styles');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'plan-review-comment-anchor-styles';
    style.textContent = '.comment-anchor{position:absolute;pointer-events:none;border-radius:6px;box-sizing:border-box;z-index:2147483640}.comment-anchor.pending{border:2px dotted rgba(192,132,252,.95);background:transparent;box-shadow:0 0 0 3px rgba(168,85,247,.08)}.comment-anchor.addressed{border:2px dotted rgba(216,180,254,.9);background:transparent;box-shadow:none}.comment-anchor-label{position:absolute;right:-10px;top:-12px;min-width:24px;height:24px;border-radius:999px;display:grid;place-items:center;padding:0 6px;background:#7e22ce;color:white;border:2px solid #f3e8ff;font-weight:800;font-size:12px;line-height:20px;box-shadow:0 8px 18px rgba(0,0,0,.35)}.comment-anchor.addressed .comment-anchor-label{display:none}';
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
  if (isMobileShell() && doc) {
    const height = Math.max(
      doc.documentElement?.scrollHeight || 0,
      doc.body?.scrollHeight || 0
    );
    if (height > 0) {
      frame.style.height = height + 'px';
      if (planTouchLayer) planTouchLayer.style.height = height + 'px';
    }
  } else {
    frame.style.height = '';
    if (planTouchLayer) planTouchLayer.style.height = '';
  }
}
function reflowAfterContentChange(){
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
function isCommentAddressed(comment){
  return comment.status === 'acknowledged' || comment.status === 'resolved';
}
function addCommentAnchor(rect, comment){
  const doc = ensureFrameAnchorStyles();
  if (!doc) return null;
  const win = frame.contentWindow;
  const anchor = doc.createElement('div');
  anchor.className = 'comment-anchor ' + (isCommentAddressed(comment) ? 'addressed' : 'pending');
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
function activateFrameInteractiveTarget(point, sourceLabel){
  const doc = frame.contentDocument;
  if (!doc || !point) return false;
  const target = interactiveTargetFromTouchPoint(doc, point);
  if (!target) return false;
  debugTouch(sourceLabel + '-interactive', { tag: target.tagName, id: target.id || '', href: target.getAttribute?.('href') || '' });
  const anchor = target.closest?.('a[href],area[href]');
  if (anchor) {
    const href = anchor.href;
    const targetName = anchor.getAttribute('target');
    if (targetName && targetName !== '_self') {
      frame.contentWindow?.open(href, targetName);
    } else {
      frame.contentWindow.location.href = href;
    }
    return true;
  }
  target.click?.();
  return true;
}
function openComposerFromFramePoint(point, sourceLabel){
  const doc = frame.contentDocument;
  if (!doc || !point) {
    debugTouch(sourceLabel + '-blocked', { hasDoc: Boolean(doc), point });
    return false;
  }
  const interactive = interactiveTargetFromTouchPoint(doc, point);
  const target = commentTargetFromTouchPoint(doc, point, doc.body);
  debugTouch(sourceLabel, { point, interactive: Boolean(interactive), target: target?.tagName || null, id: target?.id || '', node: target?.getAttribute?.('data-plan-node-id') || null });
  if (interactive) return activateFrameInteractiveTarget(point, sourceLabel);
  return openElementComposer(target, eventForTouchPoint(point, null));
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
  }, true);
  doc.addEventListener('touchmove', event => {
    if (!touchStart) return;
    if (touchMoved(touchStart, event)) {
      touchStart.moved = true;
      debugTouch('touchmove-moved', { point: touchPoint(event) });
      hovered = null;
      scheduleSelectionBoxUpdate();
    }
  }, true);
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
    if (interactiveTargetFromEvent(event)) return;
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
frame.addEventListener('load', () => { frameListenersAttached = false; attachFrameListeners(); void renderMermaidDiagrams().finally(() => { mountWashiOverlay(); syncFrameHeight(); redrawMarkers(); }); });
frame.addEventListener('touchstart', event => {
  const point = frameTouchPoint(event);
  touchStart = point ? { ...point, moved: false } : null;
  debugTouch('frame-touchstart', { point });
}, true);
frame.addEventListener('touchmove', event => {
  if (!touchStart) return;
  const point = frameTouchPoint(event);
  if (touchMovedToPoint(touchStart, point)) {
    touchStart.moved = true;
    debugTouch('frame-touchmove-moved', { point });
  }
}, true);
frame.addEventListener('touchend', event => {
  const point = frameTouchPoint(event);
  const start = touchStart;
  touchStart = null;
  const moved = touchMovedToPoint(start, point);
  debugTouch('frame-touchend', { point, start, moved });
  if (moved) return;
  if (openComposerFromFramePoint(point, 'frame-open')) suppressSyntheticClickUntil = Date.now() + 700;
}, true);
frame.addEventListener('click', event => {
  if (Date.now() < suppressSyntheticClickUntil) return;
  const point = frameTouchPoint(event);
  if (openComposerFromFramePoint(point, 'frame-click-open')) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
planTouchLayer?.addEventListener('touchstart', event => {
  const point = frameTouchPoint(event);
  touchStart = point ? { ...point, moved: false } : null;
  debugTouch('layer-touchstart', { point });
}, true);
planTouchLayer?.addEventListener('touchmove', event => {
  if (!touchStart) return;
  const point = frameTouchPoint(event);
  if (touchMovedToPoint(touchStart, point)) touchStart.moved = true;
  debugTouch('layer-touchmove', { point, moved: Boolean(touchStart?.moved) });
}, true);
planTouchLayer?.addEventListener('touchend', event => {
  const point = frameTouchPoint(event);
  const start = touchStart;
  const moved = touchMovedToPoint(start, point);
  touchStart = null;
  debugTouch('layer-touchend', { point, start, moved });
  if (moved) return;
  if (openComposerFromFramePoint(point, 'layer-open')) suppressSyntheticClickUntil = Date.now() + 700;
}, true);
planTouchLayer?.addEventListener('click', event => {
  if (Date.now() < suppressSyntheticClickUntil) return;
  const point = frameTouchPoint(event);
  if (openComposerFromFramePoint(point, 'layer-click-open')) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
// No custom wheel handler: #review is the native scroll container, so wheel and
// trackpad scrolling over the overlay are handled natively, preserving iPadOS
// momentum/inertia. preventDefault + manual scrollBy would opt out of the native
// scroller and make trackpad scrolling stop abruptly. Marker reflow is driven by
// the #review scroll listener below.
document.getElementById('review')?.addEventListener('scroll', scheduleMarkerReflow, { passive: true });
window.addEventListener('resize', () => { syncFrameHeight(); scheduleMarkerReflow(); });
if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') setTimeout(() => { attachFrameListeners(); void renderMermaidDiagrams().finally(() => { mountWashiOverlay(); syncFrameHeight(); redrawMarkers(); }); }, 0);
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
    const query = request.query as { q?: string; repoKey?: string; status?: string };
    const allPlans = store.listPlans({ includeArchived: true, includeDeferred: true });
    const activePlans = allPlans.filter(item => item.plan.lifecycleState === 'active');
    const archivedCount = allPlans.filter(item => item.plan.lifecycleState === 'archived').length;
    const deferredCount = allPlans.filter(item => item.plan.lifecycleState === 'deferred').length;
    reply.type('text/html').send(indexHtml(filterPlans(activePlans, query).plans, archivedCount, deferredCount));
  });

  app.get('/deferred', async (_request, reply) => {
    const allPlans = store.listPlans({ includeArchived: true, includeDeferred: true });
    reply.type('text/html').send(deferredHtml(allPlans, allPlans.filter(item => item.plan.lifecycleState === 'archived').length));
  });

  app.get('/archive', async (_request, reply) => {
    const allPlans = store.listPlans({ includeArchived: true, includeDeferred: true });
    reply.type('text/html').send(archiveHtml(allPlans, allPlans.filter(item => item.plan.lifecycleState === 'deferred').length));
  });

  app.get('/api/plans', async (request, reply) => {
    try {
      const query = request.query as { q?: string; repoKey?: string; status?: string; lifecycle?: 'active' | 'deferred' | 'archived'; limit?: string; cursor?: string; currentPlanId?: string; includeArchived?: string; includeDeferred?: string };
      const { plans, nextCursor } = filterPlans(store.listPlans({ includeArchived: query.includeArchived === 'true', includeDeferred: query.includeDeferred === 'true', lifecycleState: query.lifecycle }), query);
      return ok({ plans, nextCursor });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/navigator', async (request, reply) => {
    try {
      const query = request.query as { limit?: string; currentPlanId?: string };
      if (query.limit && !/^\d+$/.test(query.limit)) {
        throw new PlanReviewError('validation_failed', 'limit must be a non-negative integer', 400, { limit: query.limit });
      }
      const limit = query.limit ? Number(query.limit) : 200;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new PlanReviewError('validation_failed', 'limit must be between 1 and 200', 400, { limit: query.limit });
      }
      return ok({ plans: store.listPlans({ limit, currentPlanId: query.currentPlanId }) });
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
      reply.header('Cache-Control', 'no-store').type('text/html').send(reviewShell(plan, title, reviewShellTitle(title), store.listPlans({ limit: 200, currentPlanId: plan.id })));
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
      const result = store.createComment(plan.id, {
        versionId: version.id,
        body: executionReviewRequestBody,
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
      const result = store.createComment(plan.id, {
        versionId: version.id,
        body: buildPlanRequestBody(plan.planPath),
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
      const result = store.createComment(plan.id, createCommentSchema.parse(request.body));
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
