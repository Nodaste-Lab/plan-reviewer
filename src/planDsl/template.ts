import { slugify } from '../util.js';

export interface MarkdocFrontmatter {
  title?: string;
  status?: string;
  executionReady?: boolean;
  linear?: string;
  planId?: string;
  surfaces?: string[];
  [key: string]: unknown;
}

export interface TocEntry {
  id: string;
  title: string;
}

interface TocGroup {
  title: string;
  entries: TocEntry[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function statusLabel(frontmatter: MarkdocFrontmatter): string {
  if (frontmatter.status) return String(frontmatter.status);
  return frontmatter.executionReady ? 'execution-ready' : 'browser-review-draft';
}

function groupTocEntries(entries: TocEntry[]): TocGroup[] {
  const groups: TocGroup[] = [
    { title: 'Overview', entries: [] },
    { title: 'Contracts', entries: [] },
    { title: 'Execution', entries: [] },
    { title: 'Delivery', entries: [] }
  ];
  const byTitle = new Map(groups.map(group => [group.title, group]));

  for (const entry of entries) {
    const id = entry.id.toLowerCase();
    const title = entry.title.toLowerCase();
    if (id.startsWith('phase') || id === 'progress' || id === 'delivery') {
      byTitle.get('Execution')!.entries.push(entry);
    } else if (id.includes('acceptance') || id.startsWith('ac-') || id === 'bdd' || id.startsWith('bdd-') || id === 'verification' || title.includes('acceptance') || title.includes('bdd')) {
      byTitle.get('Contracts')!.entries.push(entry);
    } else if (id === 'log' || id === 'resume' || id.includes('deviation') || title.includes('log')) {
      byTitle.get('Delivery')!.entries.push(entry);
    } else {
      byTitle.get('Overview')!.entries.push(entry);
    }
  }

  return groups.filter(group => group.entries.length > 0);
}

function renderToc(tocEntries: TocEntry[]): string {
  if (!tocEntries.length) return '<span class="muted">No section entries generated.</span>';
  return groupTocEntries(tocEntries).map(group => `
      <div class="toc-group">
        <h3>${escapeHtml(group.title)}</h3>
        ${group.entries.map(entry => `<a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</a>`).join('\n        ')}
      </div>`).join('');
}

export function renderPlanTemplate(frontmatter: MarkdocFrontmatter, bodyHtml: string, tocEntries: TocEntry[], sourcePath?: string): string {
  const title = String(frontmatter.title ?? 'Untitled Plan');
  const planId = String(frontmatter.planId ?? slugify(title));
  const surfaces = Array.isArray(frontmatter.surfaces) ? frontmatter.surfaces : [];
  const linear = frontmatter.linear === undefined ? undefined : String(frontmatter.linear);
  const toc = renderToc(tocEntries);
  return `<!doctype html>
<!-- Generated from ${escapeHtml(sourcePath ?? 'Markdoc source')}. Do not hand-edit this HTML while the .markdoc source exists. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; --bg:#08111f; --panel:#101a2c; --panel-2:#0c1525; --text:#e6edf7; --muted:#9fb0c7; --accent:#66d9ef; --border:#25344d; --code:#06101e; }
    * { box-sizing: border-box; }
    body { margin:0; background:radial-gradient(circle at top left, rgba(102,217,239,.10), transparent 30%), var(--bg); color:var(--text); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height:1.56; }
    main { max-width:1180px; margin:0 auto; padding:38px 22px 80px; }
    header, section, article, figure { border:1px solid var(--border); background:linear-gradient(180deg, rgba(16,26,44,.96), rgba(12,21,37,.96)); border-radius:18px; padding:22px; margin:18px 0; box-shadow:0 16px 50px rgba(0,0,0,.18); }
    header { border-color:rgba(102,217,239,.55); }
    h1, h2, h3, h4 { line-height:1.18; margin:0 0 12px; }
    h1 { font-size:clamp(2rem, 5vw, 3.65rem); letter-spacing:-.04em; }
    h2 { font-size:1.45rem; color:#f8fbff; }
    h3 { color:#dbeafe; margin-top:18px; }
    h4 { color:#c4b5fd; }
    p { margin:0 0 12px; }
    a { color:#7dd3fc; }
    code, pre { background:var(--code); color:#dbeafe; border:1px solid #213149; border-radius:8px; }
    code { padding:.12rem .35rem; }
    pre { padding:14px; overflow:auto; white-space:pre-wrap; }
    table { width:100%; border-collapse:collapse; margin-top:10px; }
    th, td { border:1px solid var(--border); padding:10px; vertical-align:top; text-align:left; }
    th { color:#bfdbfe; background:#0b1322; }
    .status { display:inline-flex; gap:8px; align-items:center; border-radius:999px; border:1px solid rgba(251,191,36,.6); color:#fde68a; padding:5px 11px; font-weight:800; background:rgba(251,191,36,.10); }
    .meta { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; margin-top:18px; }
    .meta div, .callout, .card { background:rgba(12,21,37,.82); border:1px solid var(--border); border-radius:13px; padding:12px; }
    .label { display:block; color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.08em; font-weight:800; }
    .toc { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px; align-items:start; }
    .toc-group { display:grid; grid-auto-rows:max-content; align-content:start; align-items:start; gap:6px; padding:13px; border:1px solid var(--border); border-radius:14px; background:rgba(6,16,30,.42); }
    .toc-group h3 { margin:0 0 4px; color:#bfdbfe; font-size:.82rem; text-transform:uppercase; letter-spacing:.08em; }
    .toc a { display:block; padding:3px 0; text-decoration:none; line-height:1.25; }
    .progress-list { list-style:none; padding-left:0; }
    .progress-list li { display:flex; gap:10px; align-items:flex-start; }
    .progress-list input { margin-top:.35rem; }
    .phase { border-color:rgba(167,139,250,.45); }
    .decision { border-left:4px solid var(--accent); padding-left:12px; }
    .mockup { border:1px dashed var(--border); border-radius:12px; padding:14px; background:rgba(6,16,30,.72); }
    .muted { color:var(--muted); }
  </style>
</head>
<body>
<main id="${escapeHtml(planId)}" data-generated-from="markdoc" data-markdoc-source="${escapeHtml(sourcePath ?? '')}">
  <header id="title">
    <p class="status">Status: ${escapeHtml(statusLabel(frontmatter))}</p>
    <h1>${escapeHtml(title)}</h1>
    ${linear ? `<p id="linear-reference"><strong>Linear issue:</strong> ${escapeHtml(linear)}</p>` : ''}
    <div class="meta" id="plan-metadata">
      ${sourcePath ? `<div><span class="label">Source</span><code>${escapeHtml(sourcePath)}</code></div>` : ''}
      ${surfaces.length ? `<div><span class="label">Primary surfaces</span>${surfaces.map(item => `<code>${escapeHtml(item)}</code>`).join(', ')}</div>` : ''}
    </div>
  </header>
  <section id="toc"><h2>Contents</h2><nav class="toc" aria-label="Plan contents">${toc}
    </nav></section>
  ${bodyHtml.replace(/^<article>|<\/article>$/g, '')}
</main>
</body>
</html>`;
}
