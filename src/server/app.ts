import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import {
  ackCommentSchema,
  claimCommentsSchema,
  createCommentSchema,
  registerPlanSchema,
  releaseCommentSchema,
  resolveCommentSchema
} from '../schemas.js';
import { renderPlan } from '../render/render.js';
import { PlanReviewStore, type StoredEvent } from '../storage/database.js';
import { SourceSyncService } from './sourceSync.js';
import { fail, ok, PlanReviewError } from '../util.js';

export interface AppOptions {
  dbPath: string;
}

interface EventBus {
  emitEvent(event: StoredEvent): void;
  onEvent(planId: string, handler: (event: StoredEvent) => void): () => void;
}

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

function progressHtml(progress: ReturnType<PlanReviewStore['listPlans']>[number]['progress']): string {
  if (!progress.totalPhases) return '<p class="progress-empty">No phase progress markers found.</p>';
  const label = `${progress.completedPhases} of ${progress.totalPhases} phases complete`;
  const segments = progress.phases.map((phase, index) => `<span class="progress-segment${phase.complete ? ' complete' : ''}" title="${escapeHtml(phase.label || `Phase ${index + 1}`)}"></span>`).join('');
  return `<div class="progress-row"><div class="progress-bar" aria-label="${escapeHtml(label)}">${segments}</div><span class="progress-count">${escapeHtml(label)}</span></div>`;
}

function baseIndexStyles(): string {
  return `body{margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:32px}a{color:#7dd3fc}.page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.page-header h1{margin:0 0 8px}.nav-link,.restore-plan,.archive-plan{background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px 10px;cursor:pointer;text-decoration:none;font-weight:700}.nav-link.primary,.restore-plan{border-color:#38bdf8;color:#bae6fd}.restore-plan{border-color:#22c55e;color:#bbf7d0}.toolbar{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:10px;margin:18px 0}.toolbar input,.toolbar select{background:#0f172a;color:#e5e7eb;border:1px solid #2b364d;border-radius:6px;padding:10px}.plan-card{border:1px solid #2563eb;border-left:5px solid #2563eb;background:#111827;border-radius:8px;padding:16px;margin:12px 0}.plan-card.complete{border-color:#16a34a;border-left-color:#16a34a}.plan-card.archived{border-color:#64748b;border-left-color:#64748b}.plan-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.plan-card-header h2{margin-top:0}.plan-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.archive-plan:hover,.restore-plan:hover,.nav-link:hover{border-color:#93c5fd}.progress-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;margin:12px 0}.progress-bar{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:5px}.progress-segment{height:14px;border:1px solid #64748b;border-radius:3px;background:transparent}.progress-segment.complete{background:#22c55e;border-color:#22c55e}.progress-count,.progress-empty,.muted{color:#a7b0c0;font-size:13px}.status-pill{display:inline-block;margin-right:8px;border-radius:999px;padding:2px 8px;background:#1d4ed8;color:#dbeafe;font-size:12px;font-weight:700}.complete .status-pill{background:#166534;color:#dcfce7}.archived .status-pill{background:#334155;color:#cbd5e1}.empty-state,.restore-error{border:1px solid #475569;border-radius:8px;background:#0f172a;padding:14px;margin:12px 0;color:#cbd5e1}.restore-error{border-color:#fb7185;color:#fecdd3}code{background:#0f172a;color:#dbeafe;padding:.1rem .25rem;border-radius:4px}@media(max-width:680px){.page-header,.toolbar,.progress-row{grid-template-columns:1fr;display:grid}.plan-card-header{display:block}.plan-actions{justify-content:flex-start;margin-bottom:8px}}`;
}

function planCardSearch(item: ReturnType<PlanReviewStore['listPlans']>[number]): string {
  return `${item.plan.repoName} ${item.plan.repoKey} ${item.plan.slug} ${item.plan.planPath}`.toLowerCase();
}

function indexHtml(plans: ReturnType<PlanReviewStore['listPlans']>, archivedCount: number): string {
  const repos = [...new Set(plans.map(item => item.plan.repoName))].sort();
  const rows = repos
    .map(repoName => {
      const repoPlans = plans.filter(item => item.plan.repoName === repoName);
      return `<section class="repo-group" data-repo-group="${escapeHtml(repoName)}"><h2>${escapeHtml(repoName)}</h2>${repoPlans.map(item => {
        const complete = item.progress.totalPhases > 0 && item.progress.completedPhases === item.progress.totalPhases;
        return `<article class="plan-card ${complete ? 'complete' : 'incomplete'}" data-plan-id="${escapeHtml(item.plan.id)}" data-repo="${escapeHtml(item.plan.repoName)}" data-search="${escapeHtml(planCardSearch(item))}">
      <div class="plan-card-header"><h2><a href="/p/${escapeHtml(item.plan.id)}">${escapeHtml(item.plan.repoName)} / ${escapeHtml(item.plan.slug)}</a></h2><button class="archive-plan" type="button" data-archive-plan="${escapeHtml(item.plan.id)}">Archive</button></div>
      <p><code>${escapeHtml(item.plan.planPath)}</code></p>
      ${progressHtml(item.progress)}
      <p><span class="status-pill">${complete ? 'Complete' : 'Incomplete'}</span> Branch <code>${escapeHtml(item.latestVersion.branch)}</code> · pending ${item.counts.pending} · claimed ${item.counts.claimed} · acknowledged ${item.counts.acknowledged} · resolved ${item.counts.resolved} · activity ${escapeHtml(item.activityAt)}</p>
    </article>`;
      }).join('\n')}</section>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plan Review Index</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <style>${baseIndexStyles()}</style>
  </head><body><main><div class="page-header"><div><h1>Plan Review Index</h1><p class="muted">Active plans are shown by default.</p></div><a class="nav-link primary" href="/archive">Archived (${archivedCount}) →</a></div><div class="toolbar"><input id="q" placeholder="Filter plans" aria-label="Filter plans"><select id="repo" aria-label="Filter by repo"><option value="">All repos</option>${repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('')}</select></div><div id="plans">${rows || '<p>No plans registered.</p>'}</div><script>
  const q=document.getElementById('q'), repo=document.getElementById('repo'), cards=[...document.querySelectorAll('.plan-card')];
  function apply(){const text=q.value.toLowerCase(), r=repo.value; cards.forEach(card=>{card.hidden=!!((r&&card.dataset.repo!==r)||(text&&!card.dataset.search.includes(text)));}); document.querySelectorAll('.repo-group').forEach(group=>{group.hidden=!group.querySelector('.plan-card:not([hidden])');});}
  q.addEventListener('input',apply); repo.addEventListener('change',apply);
  document.addEventListener('click',async event=>{const target=event.target; const button=target instanceof Element ? target.closest('[data-archive-plan]') : null; if(!button) return; if(!confirm('Archive this plan?')) return; button.disabled=true; const planId=button.dataset.archivePlan; const res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/archive',{method:'POST'}); if(!res.ok){button.disabled=false; alert('Unable to archive plan.'); return;} button.closest('.plan-card')?.remove(); const index=cards.findIndex(card=>card.dataset.planId===planId); if(index>=0) cards.splice(index,1); apply();});
  </script></main></body></html>`;
}

function archiveHtml(plans: ReturnType<PlanReviewStore['listPlans']>): string {
  const archivedPlans = plans
    .filter(item => item.plan.archivedAt)
    .sort((a, b) => String(b.plan.archivedAt).localeCompare(String(a.plan.archivedAt)) || String(b.activityAt).localeCompare(String(a.activityAt)) || String(a.plan.repoName).localeCompare(String(b.plan.repoName)) || String(a.plan.slug).localeCompare(String(b.plan.slug)) || String(a.plan.id).localeCompare(String(b.plan.id)));
  const repos = [...new Set(archivedPlans.map(item => item.plan.repoName))].sort();
  const rows = archivedPlans.map(item => {
    const complete = item.progress.totalPhases > 0 && item.progress.completedPhases === item.progress.totalPhases;
    return `<article class="plan-card archived ${complete ? 'complete' : 'incomplete'}" data-plan-id="${escapeHtml(item.plan.id)}" data-repo="${escapeHtml(item.plan.repoName)}" data-search="${escapeHtml(planCardSearch(item))}">
      <div class="plan-card-header"><h2>${escapeHtml(item.plan.repoName)} / ${escapeHtml(item.plan.slug)}</h2><div class="plan-actions"><a class="nav-link primary" href="/p/${escapeHtml(item.plan.id)}">Open</a><button class="restore-plan" type="button" data-restore-plan="${escapeHtml(item.plan.id)}">Restore</button></div></div>
      <p><code>${escapeHtml(item.plan.planPath)}</code></p>
      ${progressHtml(item.progress)}
      <p><span class="status-pill">Archived ${escapeHtml(item.plan.archivedAt)}</span> pending ${item.counts.pending} · claimed ${item.counts.claimed} · acknowledged ${item.counts.acknowledged} · resolved ${item.counts.resolved} · activity ${escapeHtml(item.activityAt)}</p>
      <p class="restore-error" hidden>Restore failed. The plan is still archived; check the service and try Restore again.</p>
    </article>`;
  }).join('\n');
  const empty = '<p class="empty-state" id="archive-empty">No archived plans yet.</p>';
  const filteredEmpty = '<p class="empty-state" id="archive-filter-empty" hidden>No archived plans match the current filters. <button type="button" id="clear-filters">Clear filters</button></p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Archived Plans</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <style>${baseIndexStyles()}</style>
  </head><body><main><div class="page-header"><div><h1>Archived Plans</h1><p class="muted">Archived plans stay out of the active index but remain inspectable and restorable.</p></div><a class="nav-link primary" href="/">← Active index</a></div><div class="toolbar"><input id="q" placeholder="Filter archived plans" aria-label="Filter archived plans"><select id="repo" aria-label="Filter by repo"><option value="">All repos</option>${repos.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`).join('')}</select></div><p class="muted" id="archive-count">${archivedPlans.length} archived</p><div id="plans">${rows || empty}</div>${rows ? filteredEmpty : ''}<script>
  const q=document.getElementById('q'), repo=document.getElementById('repo'), cards=[...document.querySelectorAll('.plan-card')], filteredEmpty=document.getElementById('archive-filter-empty'), count=document.getElementById('archive-count');
  function apply(){const text=q.value.toLowerCase(), r=repo.value; let visible=0; cards.forEach(card=>{card.hidden=!!((r&&card.dataset.repo!==r)||(text&&!card.dataset.search.includes(text))); if(!card.hidden) visible++;}); if(filteredEmpty) filteredEmpty.hidden=visible>0||cards.length===0; if(count) count.textContent=visible+' archived';}
  q?.addEventListener('input',apply); repo?.addEventListener('change',apply); document.getElementById('clear-filters')?.addEventListener('click',()=>{q.value=''; repo.value=''; apply();});
  document.addEventListener('click',async event=>{const target=event.target; const button=target instanceof Element ? target.closest('[data-restore-plan]') : null; if(!button) return; button.disabled=true; const card=button.closest('.plan-card'); const error=card?.querySelector('.restore-error'); if(error) error.hidden=true; const planId=button.dataset.restorePlan; let res; try{res=await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive',{method:'POST'});}catch{button.disabled=false; if(error) error.hidden=false; return;} if(!res.ok){button.disabled=false; if(error) error.hidden=false; return;} card?.remove(); const index=cards.findIndex(item=>item.dataset.planId===planId); if(index>=0) cards.splice(index,1); apply();});
  </script></main></body></html>`;
}

function filterPlans(plans: ReturnType<PlanReviewStore['listPlans']>, query: { q?: string; repoKey?: string; status?: string; limit?: string; cursor?: string }) {
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
    const haystack = `${item.plan.repoName} ${item.plan.repoKey} ${item.plan.slug} ${item.plan.planPath}`.toLowerCase();
    const matchesText = !text || haystack.includes(text);
    return matchesRepo && matchesStatus && matchesText;
  });
  const offset = parseInteger(query.cursor, 'cursor', 0) ?? 0;
  const limit = parseInteger(query.limit, 'limit', 1, 200);
  const page = limit ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
  return {
    plans: page,
    nextCursor: limit && offset + limit < filtered.length ? String(offset + limit) : undefined
  };
}

function reviewShell(plan: ReturnType<PlanReviewStore['getPlan']>['plan']): string {
  const escapedPlanId = escapeHtml(plan.id);
  const navActions = plan.archivedAt
    ? `<a href="/archive">← Archive</a><span id="archive-status" class="archive-status">Archived</span><button id="restore-plan" type="button">Restore plan</button>`
    : `<a href="/">← Plan index</a><span id="archive-status" class="archive-status" hidden></span><button id="archive-plan" type="button">Archive plan</button>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plan ${escapedPlanId}</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="stylesheet" href="/client.css">
  </head><body data-plan-id="${escapedPlanId}">
    <nav id="plan-navbar" aria-label="Plan actions">${navActions}</nav>
    <div id="app">
      <aside id="sidebar"><h1>Comments</h1><div id="sync-warning" hidden></div><div id="deferred-refresh-notice" hidden>Plan updated in the background. Finish or cancel this comment to refresh.</div><div id="comments"></div></aside>
      <main id="review"><iframe id="plan-frame" sandbox="allow-same-origin" src="/render/${escapedPlanId}"></iframe><div id="hover-selection-box" class="selection-box hover" hidden></div><div id="active-selection-box" class="selection-box active" hidden></div></main>
    </div>
    <div id="lightbox" class="lightbox" hidden><header><button id="zoom-out">-</button><button id="zoom-reset">Reset</button><button id="zoom-in">+</button><button id="pan-toggle">Pan</button><button id="close-lightbox">Close</button></header><div id="lightbox-stage" class="lightbox-stage"><img id="lightbox-image" alt=""><div id="image-selection-box" hidden></div></div></div>
    <div id="composer" hidden><textarea id="comment-body" placeholder="Comment on selection"></textarea><div id="comment-discard-warning" hidden>Your comment would be lost. Use Cancel to discard it.</div><button id="submit-comment">Submit</button><button id="cancel-comment">Cancel</button></div>
    <script src="/vendor/html2canvas.js"></script>
    <script type="module" src="/client.js"></script>
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
body{margin:0;background:#0b1020;color:#e5e7eb;font-family:system-ui,sans-serif}
#plan-navbar{height:52px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 16px;border-bottom:1px solid #2b364d;background:#0f172a}#plan-navbar a{color:#7dd3fc;text-decoration:none;font-weight:700}#plan-navbar button{background:#1e293b;color:#e5e7eb;border:1px solid #475569;border-radius:6px;padding:8px 10px;cursor:pointer}#plan-navbar button:hover{border-color:#93c5fd}.archive-status{color:#cbd5e1;border:1px solid #475569;background:#1e293b;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:800;margin-left:auto}#restore-plan{border-color:#22c55e;color:#bbf7d0}
#app{display:grid;grid-template-columns:minmax(0,1fr) 320px;min-height:calc(100vh - 52px)}
#review{grid-column:1;position:relative}#sidebar{grid-column:2;grid-row:1;border-left:1px solid #2b364d;padding:16px;background:#111827}
#plan-frame{width:100%;height:calc(100vh - 52px);border:0;background:white}.selection-box,.comment-anchor{position:fixed;pointer-events:none;border-radius:6px;transition:left .08s ease,top .08s ease,width .08s ease,height .08s ease}.selection-box{z-index:8;box-shadow:0 0 0 9999px rgba(2,6,23,.08),0 10px 24px rgba(0,0,0,.25)}.selection-box.hover{border:2px solid rgba(125,211,252,.9);background:rgba(56,189,248,.10)}.selection-box.active{z-index:9;border:3px solid #38bdf8;background:rgba(56,189,248,.16);box-shadow:0 0 0 4px rgba(56,189,248,.18),0 12px 32px rgba(0,0,0,.35)}.comment-anchor{z-index:7}.comment-anchor.pending{border:3px solid #a855f7;background:rgba(168,85,247,.22);box-shadow:0 0 0 4px rgba(168,85,247,.16),0 12px 30px rgba(0,0,0,.28)}.comment-anchor.addressed{border:2px dotted rgba(216,180,254,.9);background:transparent;box-shadow:none}.comment-anchor-label{position:absolute;right:-10px;top:-12px;min-width:24px;height:24px;border-radius:999px;display:grid;place-items:center;padding:0 6px;background:#7e22ce;color:white;border:2px solid #f3e8ff;font-weight:800;font-size:12px;box-shadow:0 8px 18px rgba(0,0,0,.35)}.comment-anchor.addressed .comment-anchor-label{display:none}.comment-row{border:1px solid #2b364d;padding:10px;margin:8px 0;border-radius:8px;background:#0f172a}.comment-row small{color:#a7b0c0}.marker{position:absolute;z-index:9;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:#0ea5e9;color:white;border:2px solid #dbeafe;font-weight:700;box-shadow:0 8px 18px rgba(0,0,0,.35);pointer-events:none}
#sync-warning{border:1px solid #f59e0b;background:rgba(245,158,11,.12);color:#fde68a;border-radius:8px;padding:10px;margin:8px 0 14px;font-size:13px}#deferred-refresh-notice{border:1px solid #38bdf8;background:rgba(56,189,248,.12);color:#bae6fd;border-radius:8px;padding:10px;margin:8px 0 14px;font-size:13px}#composer{position:fixed;right:340px;top:80px;background:#0f172a;border:1px solid #38bdf8;padding:12px;border-radius:8px;z-index:20;box-shadow:0 12px 32px rgba(0,0,0,.4)}#composer.discard-warning{border-color:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22),0 12px 32px rgba(0,0,0,.4)}
#comment-discard-warning{margin-top:8px;color:#fecaca;font-size:13px;font-weight:700}#composer.discard-warning textarea{border-color:#ef4444}
#composer textarea{width:260px;height:90px;background:#020617;color:#e5e7eb;border:1px solid #2b364d;border-radius:6px;padding:8px;display:block}
	#composer button{margin-top:8px;margin-right:8px}.plan-review-selected{outline:3px solid #38bdf8!important;box-shadow:0 0 0 4px rgba(56,189,248,.2)!important}.lightbox{position:fixed;inset:36px 360px 36px 36px;background:#020617;border:1px solid #38bdf8;z-index:12;display:grid;grid-template-rows:auto 1fr}.lightbox[hidden]{display:none}.lightbox header{display:flex;gap:8px;padding:10px;border-bottom:1px solid #2b364d}.lightbox img{max-width:100%;max-height:100%;place-self:center;transform-origin:center}.lightbox-stage{display:grid;overflow:hidden;position:relative}#image-selection-box{position:absolute;border:2px solid #38bdf8;background:rgba(56,189,248,.2);pointer-events:none}
`;

const clientJs = `
import { finder } from '/vendor/finder.js';
import { Washi } from '/vendor/washi.js';

const planId = document.body.dataset.planId;
const frame = document.getElementById('plan-frame');
const archivePlanButton = document.getElementById('archive-plan');
const restorePlanButton = document.getElementById('restore-plan');
const composer = document.getElementById('composer');
const body = document.getElementById('comment-body');
const discardWarning = document.getElementById('comment-discard-warning');
const comments = document.getElementById('comments');
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
let markerCount = 0;
let markerComments = [];
let markerReflowQueued = false;
let zoom = 1;
let panX = 0;
let panY = 0;
let panMode = false;
let versionId = null;
let deferredPlanRefresh = null;
let lightboxDragStart = null;
let lightboxPanStart = null;
let washi = null;
archivePlanButton?.addEventListener('click', async () => {
  if (!confirm('Archive this plan?')) return;
  archivePlanButton.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/archive', { method: 'POST' });
  if (!res.ok) {
    archivePlanButton.disabled = false;
    alert('Unable to archive plan.');
    return;
  }
  window.location.href = '/';
});
restorePlanButton?.addEventListener('click', async () => {
  restorePlanButton.disabled = true;
  const res = await fetch('/api/plans/'+encodeURIComponent(planId)+'/unarchive', { method: 'POST' });
  if (!res.ok) {
    restorePlanButton.disabled = false;
    alert('Unable to restore plan.');
    return;
  }
  window.location.href = '/';
});
async function loadMeta(options = {}){
  const res = await fetch('/api/plans/'+planId);
  const json = await res.json();
  const latestVersionId = json.data.latestVersion.id;
  const shouldReloadPlan = options.reloadPlan && versionId && (latestVersionId !== versionId || options.forceReloadPlan);
  if (shouldReloadPlan) {
    if (!options.bypassDialogDefer && hasOpenCommentDialog()) {
      queueDeferredPlanRefresh({ versionId: latestVersionId, forceReloadPlan: Boolean(options.forceReloadPlan) });
    } else {
      reloadPlanFrame(latestVersionId, { clearSelection: true });
    }
  } else if (!versionId) {
    versionId = latestVersionId;
  }
  renderSyncWarning(json.data.plan);
  renderComments(json.data.comments || []);
}
function reloadPlanFrame(nextVersionId, options = {}){
  if (options.clearSelection) clearPendingSelection();
  frame.src = '/render/'+encodeURIComponent(planId)+'?versionId='+encodeURIComponent(nextVersionId)+'&t='+Date.now();
  versionId = nextVersionId;
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
  await loadMeta({ reloadPlan: true, forceReloadPlan: refresh.forceReloadPlan, bypassDialogDefer: true });
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
  loadMeta({ reloadPlan: true, forceReloadPlan: event.type === 'plan.version.synced' });
}
function renderComments(items){
  renderMarkers(items);
  comments.innerHTML = items.map(c => {
    const response = c.agentResponse || {};
    const changed = Array.isArray(response.changedFiles) ? response.changedFiles.join(', ') : '';
    const metadata = [response.responseSummary || response.resolutionNote || response.note, changed, response.runId, response.handoffPath, response.commitSha].filter(Boolean).map(escapeHtml).join(' · ');
    const context = [c.anchor?.textPreview, c.anchor?.selectedText, c.anchor?.textQuote?.exact, c.anchor?.cssSelector].filter(Boolean).map(escapeHtml).join(' · ');
    const screenshot = c.screenshotAssetId ? '<a href="/comment-assets/'+encodeURIComponent(c.screenshotAssetId)+'">screenshot</a>' : '';
    return '<div class="comment-row"><strong>#'+c.sequence+' '+escapeHtml(c.status)+'</strong><p>'+escapeHtml(c.body)+'</p><small>'+escapeHtml(c.anchorType)+' · '+escapeHtml(c.anchorState)+(metadata ? ' · '+metadata : '')+'</small>'+(context ? '<p><small>Context: '+context+'</small></p>' : '')+(screenshot ? '<p><small>'+screenshot+'</small></p>' : '')+'</div>';
  }).join('');
}
function escapeHtml(value){ return String(value).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
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
    style.textContent = '.comment-anchor{position:absolute;pointer-events:none;border-radius:6px;box-sizing:border-box;z-index:2147483640}.comment-anchor.pending{border:3px solid #a855f7;background:rgba(168,85,247,.22);box-shadow:0 0 0 4px rgba(168,85,247,.16),0 12px 30px rgba(0,0,0,.28)}.comment-anchor.addressed{border:2px dotted rgba(216,180,254,.9);background:transparent;box-shadow:none}.comment-anchor-label{position:absolute;right:-10px;top:-12px;min-width:24px;height:24px;border-radius:999px;display:grid;place-items:center;padding:0 6px;background:#7e22ce;color:white;border:2px solid #f3e8ff;font-weight:800;font-size:12px;line-height:20px;box-shadow:0 8px 18px rgba(0,0,0,.35)}.comment-anchor.addressed .comment-anchor-label{display:none}';
    (doc.head || doc.documentElement).appendChild(style);
  }
  return doc;
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
function imagePointFor(element, event){
  const rect = element.getBoundingClientRect();
  const x = event ? Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))) : 0.5;
  const y = event ? Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))) : 0.5;
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
function clearPendingSelection(){
  selected = null;
  selectedForScreenshot = null;
  pendingAnchor = null;
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
      normalizedPoint: point
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
  doc.addEventListener('mouseup', () => {
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
    pendingAnchor = anchorForSelection(selection);
    composer.hidden = false;
    body.focus();
  }, true);
  doc.addEventListener('mousemove', event => {
    const target = event.target.closest?.('[data-plan-node-id]') || event.target;
    if (target && target !== hovered) {
      hovered = target;
      updateSelectionBoxes();
    }
  }, true);
  doc.addEventListener('mouseleave', () => {
    hovered = null;
    updateSelectionBoxes();
  }, true);
  doc.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    selected = event.target.closest('[data-plan-node-id]') || event.target;
    selectedForScreenshot = selected;
    pendingAnchor = anchorForElement(selected, event);
    updateSelectionBoxes();
    if (selected.tagName.toLowerCase() === 'img') showLightbox(selected);
    clearDiscardWarning();
    composer.hidden = false;
    body.focus();
  }, true);
  doc.addEventListener('scroll', scheduleMarkerReflow, true);
  frame.contentWindow?.addEventListener('scroll', scheduleMarkerReflow);
  frame.contentWindow?.addEventListener('resize', scheduleMarkerReflow);
}
frame.addEventListener('load', () => { frameListenersAttached = false; attachFrameListeners(); mountWashiOverlay(); redrawMarkers(); });
window.addEventListener('resize', scheduleMarkerReflow);
if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') setTimeout(attachFrameListeners, 0);
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
  if (!pendingAnchor || !body.value.trim()) return;
  const note = body.value;
  const marker = addMarker(pendingAnchor.rect);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  let screenshot;
  try {
    screenshot = await markerScreenshot(pendingAnchor);
  } catch (error) {
    console.warn('Unable to capture marker screenshot; submitting comment without screenshot.', error);
  }
  const res = await fetch('/api/plans/'+planId+'/comments', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ versionId, body: note, anchorType:pendingAnchor.type, anchor: pendingAnchor.anchor, markerScreenshot: screenshot, createdBy:{ displayName: localStorage.getItem('plan-reviewer-name') || 'Anonymous reviewer' } })
  });
  const json = await res.json();
  if (!json.ok) { marker.remove(); alert(json.error.message); }
  clearPendingSelection();
  await loadMeta();
  await applyDeferredPlanRefreshIfIdle();
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
document.getElementById('submit-comment').addEventListener('click', submitPendingComment);
const source = new EventSource('/api/plans/'+planId+'/events?mode=all');
source.addEventListener('plan.version.registered', handlePlanVersionEvent);
source.addEventListener('plan.version.synced', handlePlanVersionEvent);
source.addEventListener('plan.sync.failed', () => loadMeta());
source.addEventListener('comment.created', () => loadMeta());
source.addEventListener('comment.claimed', () => loadMeta());
source.addEventListener('comment.acknowledged', () => loadMeta());
source.addEventListener('comment.resolved', () => loadMeta());
source.addEventListener('comment.released', () => loadMeta());
loadMeta();
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
  void sourceSync.rehydrateFromStore();
  const emitExpired = (planId?: string) => {
    const events = store.releaseExpiredClaims(planId);
    for (const event of events) bus.emitEvent(event);
    return events;
  };

  app.addHook('onClose', async () => {
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

  app.get('/', async (request, reply) => {
    const query = request.query as { q?: string; repoKey?: string; status?: string };
    const allPlans = store.listPlans({ includeArchived: true });
    const activePlans = allPlans.filter(item => !item.plan.archivedAt);
    const archivedCount = allPlans.length - activePlans.length;
    reply.type('text/html').send(indexHtml(filterPlans(activePlans, query).plans, archivedCount));
  });

  app.get('/archive', async (_request, reply) => {
    reply.type('text/html').send(archiveHtml(store.listPlans({ includeArchived: true })));
  });

  app.get('/api/plans', async (request, reply) => {
    try {
      const query = request.query as { q?: string; repoKey?: string; status?: string; limit?: string; cursor?: string; includeArchived?: string };
      const { plans, nextCursor } = filterPlans(store.listPlans({ includeArchived: query.includeArchived === 'true' }), query);
      return ok({ plans, nextCursor });
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
          active: !plan.archivedAt && plan.watchMode === 'filesystem' && plan.lastSyncStatus !== 'failed'
        },
        renderedWithWarnings: rendered.warnings
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/p/:planId', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      reply.header('Cache-Control', 'no-store').type('text/html').send(reviewShell(plan));
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
        counts: store.listPlans({ includeArchived: true }).find(item => item.plan.id === plan.id)?.counts ?? { pending: 0, claimed: 0, acknowledged: 0, resolved: 0 },
        progress: store.listPlans({ includeArchived: true }).find(item => item.plan.id === plan.id)?.progress ?? { totalPhases: 0, completedPhases: 0, phases: [] },
        comments: store.listComments(plan.id),
        reviewUrl: `/p/${plan.id}`
      });
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

  app.post('/api/plans/:planId/comments', async (request, reply) => {
    try {
      const { planId } = request.params as { planId: string };
      const { plan } = store.getPlan(planId);
      const result = store.createComment(plan.id, createCommentSchema.parse(request.body));
      if (result.created) bus.emitEvent(result.event);
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
        latestSequence: store.eventsAfter(plan.id, 0, 'all', 10000).at(-1)?.sequence ?? 0,
        retryAfterMs: 10000
      });
    } catch (error) {
      sendError(reply, error);
    }
  });

  app.get('/api/plans/:planId/events', async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const query = request.query as { mode?: 'all' | 'queue' };
    try {
	      const { plan } = store.getPlan(planId);
	      emitExpired(plan.id);
	      const lastEventId = Number(request.headers['last-event-id'] ?? 0);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      reply.raw.write(`event: connected\ndata: ${JSON.stringify({ serverTime: new Date().toISOString() })}\n\n`);
      for (const event of store.eventsAfter(plan.id, lastEventId, query.mode ?? 'queue')) {
        reply.raw.write(eventForSse(event));
      }
      const off = bus.onEvent(plan.id, event => {
        if ((query.mode ?? 'queue') === 'queue' && !event.eventType.startsWith('comment.')) return;
        reply.raw.write(eventForSse(event));
      });
	      const heartbeat = setInterval(() => {
	        emitExpired(plan.id);
	        reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ latestSequence: store.eventsAfter(plan.id).at(-1)?.sequence ?? 0, serverTime: new Date().toISOString() })}\n\n`);
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
