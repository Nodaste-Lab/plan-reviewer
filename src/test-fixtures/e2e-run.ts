import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, request } from 'playwright';
import { createApp } from '../server/app.js';
import { sha256 } from '../util.js';

const app = createApp({ dbPath: `/tmp/plan-reviewer-e2e-${process.pid}.sqlite` });
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const context = await request.newContext({ baseURL: baseUrl });
  const imageBytesBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lqSL4wAAAABJRU5ErkJggg==';
  const slowImageBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="180"><rect width="120" height="180" fill="#38bdf8"/></svg>');
  const slowImageBytesBase64 = slowImageBytes.toString('base64');
  const slowImageAssetPath = `/assets/${sha256(slowImageBytes)}`;
  const html = `<!doctype html><html><head><title>E2E Plan</title></head><body><main><div style="height:240px"></div><section id="dom-annotation"><h1>DOM annotation</h1><p>Plan index target.</p></section><section id="link-annotation"><h2>Link annotation</h2><p id="link-comment-target"><span id="link-adjacent-text">Commentable text before</span> <a id="plan-test-link" href="#link-target">fragment link</a> <span>after link.</span></p><p><a id="blank-plan-link" href="${baseUrl}/favicon.svg" target="_blank">Open asset in new tab</a></p><p><label id="wrapping-control-label"><input id="wrapped-control" type="checkbox"> <span id="wrapped-control-label-text">Toggle wrapped control</span></label></p><div id="link-target" style="margin-top:20px">Link target</div></section><section id="text-annotation"><h2>Text annotation</h2><p id="text-target">Text range context target for reviewer selection.</p></section><figure><img src="./diagram.png" alt="image annotation" width="120" height="90"></figure><div style="height:1200px"></div></main></body></html>`;
  const register = await context.post('/api/plans/register', {
    data: {
      repoKey: 'e2e-repo',
      repoName: 'e2e',
      rootPath: '/tmp/e2e',
      branch: 'main',
      commitSha: 'e2e',
      planPath: 'thoughts/plans/e2e.html',
      slug: 'e2e',
      html,
      fileHash: sha256(html),
      publicationMetadata: {
        worktreePath: '/tmp/e2e',
        branch: 'main',
        linearIssue: 'NOD-E2E',
        executionReady: false,
        executionReadyBasis: 'agent-review-results'
      },
      assets: [{ sourceUrl: './diagram.png', absolutePath: '/tmp/e2e/diagram.png', bytesBase64: imageBytesBase64 }],
      updateMode: 'upsert'
    }
  });
  assert.equal(register.ok(), true);
  const registered = (await register.json()).data as { planId: string; versionId: string };
  const missingSourcePath = path.join(os.tmpdir(), `plan-review-e2e-missing-${process.pid}.html`);
  fs.rmSync(missingSourcePath, { force: true });
  const missingSourceRegister = await context.post('/api/plans/register', {
    data: {
      repoKey: 'e2e-repo',
      repoName: 'e2e',
      rootPath: '/tmp/e2e',
      branch: 'main',
      commitSha: 'e2e-missing',
      planPath: 'thoughts/plans/e2e-missing.html',
      slug: 'e2e-missing',
      html: '<!doctype html><html><body><main><p>Missing source e2e</p></main></body></html>',
      fileHash: sha256('missing-source-e2e'),
      sourcePath: missingSourcePath,
      sourceMtimeMs: 0,
      sourceSize: 0,
      watchMode: 'filesystem',
      publicationMetadata: {
        worktreePath: '/tmp/e2e',
        branch: 'main',
        linearIssue: 'NOD-E2E',
        executionReady: false,
        executionReadyBasis: 'agent-review-results'
      },
      updateMode: 'upsert'
    }
  });
  assert.equal(missingSourceRegister.ok(), true);

  const index = await context.get('/');
  assert.equal(index.ok(), true);
  const indexHtml = await index.text();
  assert.match(indexHtml, /Plan Review Index/);
  assert.match(indexHtml, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
  const favicon = await context.get('/favicon.svg');
  assert.equal(favicon.ok(), true);
  assert.equal(favicon.headers()['cache-control'], 'no-store');
  assert.match(favicon.headers()['content-type'] ?? '', /^image\/svg\+xml/);
  const faviconSvg = await favicon.text();
  assert.match(faviconSvg, /Plan review comments/);
  assert.match(faviconSvg, /#f43f5e/);
  const faviconIco = await context.get('/favicon.ico');
  assert.equal(faviconIco.ok(), true);
  assert.match(faviconIco.headers()['content-type'] ?? '', /^image\/svg\+xml/);
  const shellResponse = await context.get(`/p/${registered.planId}`);
  assert.equal(shellResponse.ok(), true);
  assert.equal(shellResponse.headers()['cache-control'], 'no-store');
  const shellHtml = await shellResponse.text();
  assert.match(shellHtml, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(shellHtml, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
  const clientJsResponse = await context.get('/client.js');
  assert.equal(clientJsResponse.ok(), true);
  assert.equal(clientJsResponse.headers()['cache-control'], 'no-store');
  const clientCssResponse = await context.get('/client.css');
  assert.equal(clientCssResponse.ok(), true);
  assert.equal(clientCssResponse.headers()['cache-control'], 'no-store');
  const clientCssText = await clientCssResponse.text();
  assert.doesNotMatch(clientCssText, /9999px/);
  assert.doesNotMatch(clientCssText, /\.selection-box\.hover\{[^}]*background:/);
  assert.doesNotMatch(clientCssText, /\.selection-box\.active\{[^}]*background:/);
  assert.match(clientCssText, /\.selection-box\.hover\{[^}]*border:2px dotted/);
  assert.match(clientCssText, /\.selection-box\.active\{[^}]*border:2px dotted/);
  assert.match(clientCssText, /@media\(prefers-reduced-motion:reduce\)\{\.selection-box\{transition:none\}\}/);

  const rendered = await context.get(`/render/${registered.planId}`);
  assert.equal(rendered.ok(), true);
  const renderedHtml = await rendered.text();
  assert.match(renderedHtml, /data-plan-node-id="dom-annotation"/);
  const assetPath = renderedHtml.match(/src="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(assetPath);
  const planAsset = await context.get(assetPath);
  assert.equal(planAsset.ok(), true);
  assert.equal(planAsset.headers()['cache-control'], 'public, max-age=31536000, immutable');

  const domComment = await context.post(`/api/plans/${registered.planId}/comments`, {
    data: {
      versionId: registered.versionId,
      body: 'DOM annotation comment',
      anchorType: 'dom',
      anchor: { planNodeId: 'dom-annotation', cssSelector: 'section', textPreview: 'DOM annotation' }
    }
  });
  assert.equal(domComment.ok(), true);

  const imageComment = await context.post(`/api/plans/${registered.planId}/comments`, {
    data: {
      versionId: registered.versionId,
      body: 'Image annotation comment',
      anchorType: 'image',
      anchor: {
        cssSelector: 'img[alt="image annotation"]',
        sourceUrl: './diagram.png',
        naturalSize: { width: 1, height: 1 },
        normalizedRect: { x: 0, y: 0, width: 1, height: 1 }
      }
    }
  });
  assert.equal(imageComment.ok(), true);

  const stormHtml = '<!doctype html><html><body><main>' +
    Array.from({ length: 40 }, (_, index) => `<section id="storm-${index}"><h2>Storm ${index}</h2><p>Event storm target ${index}</p></section>`).join('') +
    '</main></body></html>';
  const registerStormPlan = async (slug: string) => {
    const response = await context.post('/api/plans/register', {
      data: {
        repoKey: `e2e-${slug}-repo`,
        repoName: `e2e-${slug}`,
        rootPath: `/tmp/e2e-${slug}`,
        branch: 'main',
        commitSha: `e2e-${slug}`,
        planPath: `thoughts/plans/${slug}.html`,
        slug,
        html: stormHtml,
        fileHash: sha256(stormHtml),
        publicationMetadata: {
          worktreePath: `/tmp/e2e-${slug}`,
          branch: 'main',
          executionReady: false,
          executionReadyBasis: 'agent-review-results'
        },
        updateMode: 'upsert'
      }
    });
    assert.equal(response.ok(), true);
    return (await response.json()).data as { planId: string; versionId: string };
  };
  const registerTinyPlan = async (slug: string) => {
    const tinyHtml = `<!doctype html><html><body><main><section id="${slug}"><h1>${slug}</h1><p>Many tabs target.</p></section></main></body></html>`;
    const response = await context.post('/api/plans/register', {
      data: {
        repoKey: `e2e-${slug}-repo`,
        repoName: `e2e-${slug}`,
        rootPath: `/tmp/e2e-${slug}`,
        branch: 'main',
        commitSha: `e2e-${slug}`,
        planPath: `thoughts/plans/${slug}.html`,
        slug,
        html: tinyHtml,
        fileHash: sha256(tinyHtml),
        publicationMetadata: {
          worktreePath: `/tmp/e2e-${slug}`,
          branch: 'main',
          executionReady: false,
          executionReadyBasis: 'agent-review-results'
        },
        updateMode: 'upsert'
      }
    });
    assert.equal(response.ok(), true);
    return (await response.json()).data as { planId: string; versionId: string };
  };
  const createStormComment = (planId: string, versionId: string, index: number, bodyPrefix = 'Storm comment') => context.post(`/api/plans/${planId}/comments`, {
    data: {
      versionId,
      body: `${bodyPrefix} ${index}`,
      anchorType: 'dom',
      anchor: {
        planNodeId: `storm-${index % 40}`,
        cssSelector: `#storm-${index % 40}`,
        textPreview: `Event storm target ${index % 40}`,
        rect: { x: 20, y: 30 + (index % 40) * 20, width: 240, height: 44 },
        viewport: { width: 1280, height: 720 }
      }
    }
  });
  const installMetadataRequestCounter = async (page: import('playwright').Page) => {
    await page.addInitScript(() => {
      const stats = { count: 0, active: 0, maxActive: 0, durations: [] as number[] };
      (window as typeof window & { __planMetaStats?: typeof stats }).__planMetaStats = stats;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const rawUrl = String(args[0]);
        let counts = false;
        try {
          const url = new URL(rawUrl, window.location.origin);
          counts = /^\/api\/plans\/[^/]+$/.test(url.pathname);
        } catch {}
        if (!counts) return originalFetch(...args);
        const started = performance.now();
        stats.count += 1;
        stats.active += 1;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        try {
          return await originalFetch(...args);
        } finally {
          stats.active -= 1;
          stats.durations.push(performance.now() - started);
        }
      };
    });
  };
  const metadataStats = (page: import('playwright').Page) => page.evaluate(() => {
    const stats = (window as typeof window & { __planMetaStats?: { count: number; active: number; maxActive: number; durations: number[] } }).__planMetaStats;
    return {
      count: stats?.count ?? 0,
      active: stats?.active ?? 0,
      maxActive: stats?.maxActive ?? 0,
      maxDuration: Math.max(0, ...(stats?.durations ?? []))
    };
  });
  const installEventSourceCounter = async (page: import('playwright').Page) => {
    await page.addInitScript(() => {
      const stats = { count: 0, urls: [] as string[] };
      (window as typeof window & { __eventSourceStats?: typeof stats }).__eventSourceStats = stats;
      const OriginalEventSource = window.EventSource;
      const WrappedEventSource = function(this: EventSource, url: string | URL, eventSourceInitDict?: EventSourceInit) {
        stats.count += 1;
        stats.urls.push(String(url));
        return new OriginalEventSource(url, eventSourceInitDict);
      } as unknown as typeof EventSource;
      WrappedEventSource.prototype = OriginalEventSource.prototype;
      Object.defineProperty(WrappedEventSource, 'CONNECTING', { value: OriginalEventSource.CONNECTING });
      Object.defineProperty(WrappedEventSource, 'OPEN', { value: OriginalEventSource.OPEN });
      Object.defineProperty(WrappedEventSource, 'CLOSED', { value: OriginalEventSource.CLOSED });
      window.EventSource = WrappedEventSource;
    });
  };
  const eventSourceStats = (page: import('playwright').Page) => page.evaluate(() => {
    const stats = (window as typeof window & { __eventSourceStats?: { count: number; urls: string[] } }).__eventSourceStats;
    return { count: stats?.count ?? 0, urls: stats?.urls ?? [] };
  });
  const commentRows = (page: import('playwright').Page) => page.evaluate(() => document.querySelectorAll('.comment-row').length);

  const browser = await chromium.launch({ headless: true });
  try {
    const historical = await registerStormPlan('event-storm-historical');
    for (let index = 0; index < 350; index += 1) {
      const response = await createStormComment(historical.planId, historical.versionId, index, 'Historical storm comment');
      assert.equal(response.ok(), true);
    }
    const historicalPage = await browser.newPage();
    await installMetadataRequestCounter(historicalPage);
    await historicalPage.goto(`${baseUrl}/p/${historical.planId}`);
    await historicalPage.waitForFunction(() => document.querySelectorAll('.comment-row').length === 350, undefined, { timeout: 20000 });
    const historicalStats = await metadataStats(historicalPage);
    assert.equal(await commentRows(historicalPage), 350);
    assert.equal(historicalStats.maxActive <= 1, true, `historical metadata requests overlapped: ${JSON.stringify(historicalStats)}`);
    assert.equal(historicalStats.count <= 3, true, `historical replay caused too many metadata requests: ${JSON.stringify(historicalStats)}`);
    await historicalPage.close();

    const burst = await registerStormPlan('event-storm-burst');
    const burstPage = await browser.newPage();
    await installMetadataRequestCounter(burstPage);
    await burstPage.goto(`${baseUrl}/p/${burst.planId}`);
    await burstPage.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('No comments yet'));
    const beforeBurst = await metadataStats(burstPage);
    await Promise.all(Array.from({ length: 120 }, (_, index) => createStormComment(burst.planId, burst.versionId, index, 'Burst storm comment')));
    await burstPage.waitForFunction(() => document.querySelectorAll('.comment-row').length === 120, undefined, { timeout: 20000 });
    const afterBurst = await metadataStats(burstPage);
    assert.equal(await commentRows(burstPage), 120);
    assert.equal(afterBurst.maxActive <= 1, true, `burst metadata requests overlapped: ${JSON.stringify(afterBurst)}`);
    assert.equal(afterBurst.count - beforeBurst.count <= 4, true, `burst caused too many metadata requests: before=${JSON.stringify(beforeBurst)} after=${JSON.stringify(afterBurst)}`);

    const trailing = await registerStormPlan('event-storm-trailing');
    const trailingPage = await browser.newPage();
    await installMetadataRequestCounter(trailingPage);
    await trailingPage.goto(`${baseUrl}/p/${trailing.planId}`);
    await trailingPage.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('No comments yet'));
    let delayNextMeta = true;
    let resumeMetadata: (() => void) | null = null;
    const delayedMetadataSeen = new Promise<void>(resolve => {
      trailingPage.route(`**/api/plans/${trailing.planId}`, async route => {
        if (delayNextMeta) {
          delayNextMeta = false;
          resolve();
          await new Promise<void>(resume => {
            resumeMetadata = resume;
          });
        }
        await route.continue();
      });
    });
    const firstTrailing = await createStormComment(trailing.planId, trailing.versionId, 0, 'Trailing storm comment');
    assert.equal(firstTrailing.ok(), true);
    await delayedMetadataSeen;
    const lastTrailing = await createStormComment(trailing.planId, trailing.versionId, 1, 'Trailing storm comment');
    assert.equal(lastTrailing.ok(), true);
    const resumeMeta = resumeMetadata as (() => void) | null;
    assert.ok(resumeMeta);
    resumeMeta();
    await trailingPage.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Trailing storm comment 1'), undefined, { timeout: 10000 });
    const trailingStats = await metadataStats(trailingPage);
    assert.equal(await commentRows(trailingPage), 2);
	    assert.equal(trailingStats.maxActive <= 1, true, `trailing refresh metadata requests overlapped: ${JSON.stringify(trailingStats)}`);
	    await trailingPage.unroute(`**/api/plans/${trailing.planId}`);
	    await trailingPage.close();
	    await burstPage.close();
	    for (const stormPlan of [historical, burst, trailing]) {
	      const archive = await context.post(`/api/plans/${stormPlan.planId}/archive`);
	      assert.equal(archive.ok(), true);
	    }

    const manyTabPlans = await Promise.all(Array.from({ length: 10 }, (_value, index) => registerTinyPlan(`many-tabs-${index}`)));
    const manyTabContext = await browser.newContext();
    const manyTabRequests = { sse: 0, poll: 0 };
    try {
      const manyTabPages = [];
      for (const plan of manyTabPlans) {
        const tab = await manyTabContext.newPage();
        await installEventSourceCounter(tab);
        tab.on('request', request => {
          const url = new URL(request.url());
          if (/\/api\/plans\/[^/]+\/events$/.test(url.pathname)) manyTabRequests.sse += 1;
          if (/\/api\/plans\/[^/]+\/events\/poll$/.test(url.pathname)) manyTabRequests.poll += 1;
        });
        await tab.goto(`${baseUrl}/p/${plan.planId}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await tab.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('No comments yet'), undefined, { timeout: 10000 });
        manyTabPages.push(tab);
      }
      const finalFetchOk = await Promise.race([
        manyTabPages[0].evaluate(async () => {
          const response = await fetch('/api/plans?limit=1', { cache: 'no-store' });
          return response.ok;
        }),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))
      ]);
      assert.equal(finalFetchOk, true, 'same-origin fetch timed out after opening many review pages');
      const sourceStats = await Promise.all(manyTabPages.map(tab => eventSourceStats(tab)));
      assert.equal(sourceStats.reduce((sum, stats) => sum + stats.count, 0), 0, `browser review pages constructed EventSource: ${JSON.stringify(sourceStats)}`);
      assert.equal(manyTabRequests.sse, 0, `browser review pages requested SSE route ${manyTabRequests.sse} times`);
      assert.equal(manyTabRequests.poll > 0, true, `browser review pages did not request finite poll route: ${JSON.stringify(manyTabRequests)}`);
    } finally {
      await manyTabContext.close();
      for (const plan of manyTabPlans) {
        const archive = await context.post(`/api/plans/${plan.planId}/archive`);
        assert.equal(archive.ok(), true);
      }
    }

	    const page = await browser.newPage();
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('[data-attention-filter]');
    assert.equal(await page.locator('.plan-card').count(), 2);
    await page.fill('#q', 'e2e');
    await page.click('[data-attention-filter]');
    await page.waitForFunction(() => document.querySelectorAll('.plan-card:not([hidden])').length === 1);
    assert.match(await page.locator('.plan-card:not([hidden])').innerText(), /Source missing/);
    assert.match(await page.locator('.plan-card:not([hidden])').innerText(), /Showing cached copy/);
    const navSwitch = await registerTinyPlan('nav-switch');
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    assert.equal(await page.title(), 'E2E Plan · Plan Review');
    await page.waitForSelector('#plan-list-nav');
    await page.waitForSelector('#desktop-comments-toggle[aria-expanded="false"]');
    assert.match(await page.locator('#plan-list-nav').innerText(), /E2E Plan/);
    assert.equal(await page.evaluate(() => document.body.classList.contains('comments-open')), false);
    assert.equal(await page.evaluate(() => Math.round(document.querySelector<HTMLElement>('#sidebar')!.getBoundingClientRect().width) <= 60), true);
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => document.body.classList.contains('comments-open'));
    await page.waitForFunction(() => Math.round(document.querySelector<HTMLElement>('#sidebar')!.getBoundingClientRect().width) >= 300);
    assert.equal(await page.locator('#desktop-comments-toggle').getAttribute('aria-expanded'), 'true');
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('comments-open'));
    await page.click(`#plan-list-nav a[href="/p/${navSwitch.planId}"]`);
    await page.waitForURL(`${baseUrl}/p/${navSwitch.planId}`);
    assert.equal(await page.locator('#plan-list-nav [aria-current="page"]').getAttribute('data-plan-id'), navSwitch.planId);
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    assert.equal((await context.post(`/api/plans/${navSwitch.planId}/archive`)).ok(), true);
    let planListRequests = 0;
    let failNextPlanList = true;
    await page.route('**/api/plans/navigator?limit=200&currentPlanId=*', async route => {
      planListRequests += 1;
      if (failNextPlanList) {
        failNextPlanList = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'forced navigator failure' } }) });
        return;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.waitForSelector('#plan-list-error:not([hidden])');
    assert.match(await page.locator('#plan-list-error').innerText(), /current plan remains reviewable/i);
    assert.equal(await page.locator('#plan-frame').count(), 1);
    await page.click('#plan-list-retry');
    await page.waitForSelector('#plan-list-error', { state: 'hidden' });
    assert.match(await page.locator('#plan-list-nav').innerText(), /E2E Plan/);
    await page.waitForTimeout(500);
    assert.equal(planListRequests <= 3, true, `navigator refresh made too many requests: ${planListRequests}`);
    await page.unroute('**/api/plans/navigator?limit=200&currentPlanId=*');
    await page.evaluate(() => {
      const globals = window as typeof window & { html2canvas?: unknown; __html2canvasCalls?: number; __html2canvasMode?: 'success' | 'fail' };
      globals.__html2canvasCalls = 0;
      globals.__html2canvasMode = 'success';
      globals.html2canvas = async (element: HTMLElement) => {
        globals.__html2canvasCalls = (globals.__html2canvasCalls ?? 0) + 1;
        if (globals.__html2canvasMode === 'fail') {
          throw new Error('forced marker screenshot failure');
        }
        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 220;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#0f172a';
        ctx.font = '16px system-ui';
        ctx.fillText(element.textContent?.trim().slice(0, 80) || element.tagName, 16, 40);
        return canvas;
      };
    });
    await page.waitForSelector('#plan-frame');

    const mermaidSource = 'flowchart TD\n  Start[Start] --> Done[Done]';
    const mermaidHtml = `<!doctype html><html><head><title>Mermaid E2E</title></head><body><main><h1>Mermaid E2E</h1><pre class="mermaid">${mermaidSource}</pre><pre class="mermaid">not-a-real-diagram</pre><p id="mermaid-side-text">Mermaid side text v1</p></main></body></html>`;
    const mermaidRegister = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-mermaid-repo',
        repoName: 'e2e-mermaid',
        rootPath: '/tmp/e2e-mermaid',
        branch: 'main',
        commitSha: 'e2e-mermaid-v1',
        planPath: 'thoughts/plans/e2e-mermaid.html',
        slug: 'e2e-mermaid',
        html: mermaidHtml,
        fileHash: sha256(mermaidHtml),
        publicationMetadata: { worktreePath: '/tmp/e2e-mermaid', branch: 'main', linearIssue: 'NOD-E2E', executionReady: false, executionReadyBasis: 'agent-review-results' },
        updateMode: 'upsert'
      }
    });
    assert.equal(mermaidRegister.ok(), true);
    const mermaidPlan = (await mermaidRegister.json()).data as { planId: string; versionId: string };
    const mermaidPage = await browser.newPage();
    await mermaidPage.addInitScript(() => {
      const globals = window as typeof window & { html2canvas?: unknown };
      globals.html2canvas = async (element: HTMLElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 220;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#0f172a';
        ctx.fillText(element.textContent?.trim().slice(0, 80) || element.tagName, 16, 40);
        return canvas;
      };
    });
    await mermaidPage.goto(`${baseUrl}/p/${mermaidPlan.planId}`);
    await mermaidPage.waitForFunction(() => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('.plan-mermaid-rendered svg')), undefined, { timeout: 15000 });
    assert.equal(await mermaidPage.evaluate(() => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('script'))), false);
    assert.equal(await mermaidPage.evaluate(() => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('.plan-mermaid-error'))), true);
    const mermaidVisual = await mermaidPage.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')!.contentDocument!;
      const rect = doc.querySelector<SVGElement>('.plan-mermaid-rendered svg .node rect, .plan-mermaid-rendered svg rect')!;
      return {
        styleCount: doc.querySelectorAll('.plan-mermaid-rendered svg style').length,
        rectFill: doc.defaultView!.getComputedStyle(rect).fill
      };
    });
    assert.equal(mermaidVisual.styleCount > 0, true);
    assert.notEqual(mermaidVisual.rectFill, 'rgb(0, 0, 0)');
    const clickedMermaid = await mermaidPage.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const doc = iframe.contentDocument!;
      const target = doc.querySelector<SVGElement>('[data-plan-mermaid-element="true"][data-plan-mermaid-element-key].flowchart-link,path[data-plan-mermaid-element="true"][data-plan-mermaid-element-key][class*="edge"],path[data-plan-mermaid-element="true"][data-plan-mermaid-element-key][marker-end]')!;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe.contentWindow ?? window }));
      return { nodeId: target.getAttribute('data-plan-node-id'), key: target.getAttribute('data-plan-mermaid-element-key'), label: target.getAttribute('data-plan-mermaid-element-label') };
    });
    assert.ok(clickedMermaid.nodeId?.includes('--svg-'));
    await mermaidPage.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    await mermaidPage.fill('#comment-body', 'Explain this Mermaid edge');
    await mermaidPage.click('#submit-comment');
    await mermaidPage.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Explain this Mermaid edge'));
    const mermaidCommentsResponse = await context.get(`/api/plans/${mermaidPlan.planId}/comments`);
    assert.equal(mermaidCommentsResponse.ok(), true);
    const mermaidComment = (await mermaidCommentsResponse.json()).data.comments[0];
    assert.equal(mermaidComment.anchorType, 'dom');
    assert.equal(mermaidComment.anchor.diagram.kind, 'mermaid');
    assert.equal(mermaidComment.anchor.diagram.elementKey, clickedMermaid.key);
    assert.equal(mermaidComment.conversationPayload.evidence.diagram.elementKey, clickedMermaid.key);
    assert.ok(mermaidComment.conversationPayload.evidence.screenshotAssetId);
    await mermaidPage.reload();
    await mermaidPage.waitForFunction(() => (document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelectorAll('.comment-anchor').length ?? 0) >= 1, undefined, { timeout: 15000 });
    const mermaidUpdatedHtml = `<!doctype html><html><head><title>Mermaid E2E</title></head><body><main><h1>Mermaid E2E</h1><pre class="mermaid">${mermaidSource}</pre><pre class="mermaid">not-a-real-diagram</pre><p id="mermaid-side-text">Mermaid side text v2</p></main></body></html>`;
    const mermaidUpdated = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-mermaid-repo',
        repoName: 'e2e-mermaid',
        rootPath: '/tmp/e2e-mermaid',
        branch: 'main',
        commitSha: 'e2e-mermaid-v2',
        planPath: 'thoughts/plans/e2e-mermaid.html',
        slug: 'e2e-mermaid',
        html: mermaidUpdatedHtml,
        fileHash: sha256(mermaidUpdatedHtml),
        publicationMetadata: { worktreePath: '/tmp/e2e-mermaid', branch: 'main', linearIssue: 'NOD-E2E', executionReady: false, executionReadyBasis: 'agent-review-results' },
        updateMode: 'upsert'
      }
    });
    assert.equal(mermaidUpdated.ok(), true);
    await mermaidPage.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
      return Boolean(doc?.body.textContent?.includes('Mermaid side text v2') && doc.querySelector('.plan-mermaid-rendered svg') && doc.querySelector('.comment-anchor'));
    }, undefined, { timeout: 15000 });

    const hardeningHtml = '<!doctype html><html><body><main><pre class="mermaid">flowchart TD; A-->B;</pre></main></body></html>';
    const hardeningRegister = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-mermaid-hardening-repo',
        repoName: 'e2e-mermaid-hardening',
        rootPath: '/tmp/e2e-mermaid-hardening',
        branch: 'main',
        commitSha: 'e2e-mermaid-hardening',
        planPath: 'thoughts/plans/e2e-mermaid-hardening.html',
        slug: 'e2e-mermaid-hardening',
        html: hardeningHtml,
        fileHash: sha256(hardeningHtml),
        publicationMetadata: { worktreePath: '/tmp/e2e-mermaid-hardening', branch: 'main', linearIssue: 'NOD-E2E', executionReady: false, executionReadyBasis: 'agent-review-results' },
        updateMode: 'upsert'
      }
    });
    assert.equal(hardeningRegister.ok(), true);
    const hardeningPlan = (await hardeningRegister.json()).data as { planId: string; versionId: string };
    const hardeningPage = await browser.newPage();
    await hardeningPage.route('**/vendor/mermaid.esm.min.mjs', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `export default { initialize(){}, async render(){ return { svg: '<svg viewBox="0 0 100 50" onclick="alert(1)"><style>.safe{fill:#fff;stroke:#000}</style><style>.bad{fill:url(https://example.com/x)}</style><g class="node" id="safe-node"><rect class="safe" width="80" height="30" style="fill:url(javascript:bad)"/><text>Safe</text></g><foreignObject><div>bad</div></foreignObject><use href="#safe-node"></use><animate attributeName="x"></animate><set attributeName="x"></set><image href="https://example.com/x.png"/><path xlink:href="javascript:bad" d="M0 0L10 10"/></svg>' }; } };`
      });
    });
    await hardeningPage.goto(`${baseUrl}/p/${hardeningPlan.planId}`);
    await hardeningPage.waitForFunction(() => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('.plan-mermaid-rendered svg')), undefined, { timeout: 15000 });
    const hardened = await hardeningPage.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')!.contentDocument!;
      const svg = doc.querySelector('.plan-mermaid-rendered svg')!;
      return {
        hasRect: Boolean(svg.querySelector('rect')),
        hasOnclick: Boolean(svg.querySelector('[onclick]')),
        hasForeignObject: Boolean(svg.querySelector('foreignObject')),
        hasUse: Boolean(svg.querySelector('use')),
        hasAnimate: Boolean(svg.querySelector('animate')),
        hasSet: Boolean(svg.querySelector('set')),
        hasImage: Boolean(svg.querySelector('image')),
        hasHref: Boolean(svg.querySelector('[href],[xlink\\:href]')),
        safeStyleText: svg.querySelector('style')?.textContent || '',
        hasUnsafeStyleText: /https?:|javascript:|url\(/i.test([...svg.querySelectorAll('style')].map(style => style.textContent || '').join('\n')),
        hasStyleAttribute: Boolean(svg.querySelector('[style]'))
      };
    });
    assert.deepEqual(hardened, { hasRect: true, hasOnclick: false, hasForeignObject: false, hasUse: false, hasAnimate: false, hasSet: false, hasImage: false, hasHref: false, safeStyleText: '.safe{fill:#fff;stroke:#000}', hasUnsafeStyleText: false, hasStyleAttribute: false });
    await hardeningPage.close();
    await mermaidPage.close();

    const commentAnchorCount = () => page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelectorAll('.comment-anchor').length ?? 0);
    const selectionBoxState = (selector: string, targetSelector: string) => page.evaluate(({ selector, targetSelector }) => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const box = document.querySelector<HTMLElement>(selector)!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>(targetSelector)!;
      const frameRect = iframe.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const style = getComputedStyle(box);
      return {
        hidden: box.hidden,
        background: style.backgroundColor,
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        leftDelta: Math.abs(boxRect.left - (frameRect.left + targetRect.left)),
        topDelta: Math.abs(boxRect.top - (frameRect.top + targetRect.top)),
        widthDelta: Math.abs(boxRect.width - targetRect.width),
        heightDelta: Math.abs(boxRect.height - targetRect.height),
        text: box.textContent?.trim() ?? ''
      };
    }, { selector, targetSelector });
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const target = iframe.contentDocument!.querySelector('#dom-annotation')!;
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: iframe.contentWindow ?? window }));
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#hover-selection-box')?.hidden === false);
    const hoverBox = await selectionBoxState('#hover-selection-box', '#dom-annotation');
    assert.equal(hoverBox.hidden, false);
    assert.equal(hoverBox.background, 'rgba(0, 0, 0, 0)');
    assert.equal(hoverBox.borderStyle, 'dotted');
    assert.equal(hoverBox.borderWidth, '2px');
    assert.equal(hoverBox.leftDelta <= 1, true);
    assert.equal(hoverBox.topDelta <= 1, true);
    assert.equal(hoverBox.widthDelta <= 1, true);
    assert.equal(hoverBox.heightDelta <= 1, true);
    assert.equal(hoverBox.text, '');
    await page.frameLocator('#plan-frame').locator('#plan-test-link').hover();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#hover-selection-box')?.hidden), true);
    await page.frameLocator('#plan-frame').locator('#plan-test-link').click();
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.location.hash === '#link-target');
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#composer')?.hidden), true);
    const popupPromise = page.waitForEvent('popup', { timeout: 3000 });
    await page.frameLocator('#plan-frame').locator('#blank-plan-link').click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    assert.match(popup.url(), /\/favicon\.svg$/);
    await popup.close();
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#composer')?.hidden), true);
    await page.frameLocator('#plan-frame').locator('#wrapped-control-label-text').click();
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector<HTMLInputElement>('#wrapped-control')?.checked === true);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#composer')?.hidden), true);
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      iframe.contentWindow?.history.replaceState(null, '', iframe.contentWindow.location.pathname);
      iframe.contentWindow?.scrollTo(0, 0);
      iframe.contentDocument!.querySelector('#link-adjacent-text')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe.contentWindow ?? window }));
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    await page.click('#cancel-comment');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === true);
    const openDomComposer = async () => {
      await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame');
        const target = iframe?.contentDocument?.querySelector('#dom-annotation');
        target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe?.contentWindow ?? window }));
      });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    };
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#dom-annotation'));
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => document.body.classList.contains('comments-open'));
    const frameWidthWithCommentsOpen = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.getBoundingClientRect().width ?? 0);
    await openDomComposer();
    assert.equal(await page.evaluate(() => document.body.classList.contains('comments-open')), true);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.getBoundingClientRect().width ?? 0), frameWidthWithCommentsOpen);
    await page.click('#cancel-comment');
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('comments-open'));
    await openDomComposer();
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const box = document.querySelector<HTMLElement>('#active-selection-box')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('#dom-annotation')!;
      const boxRect = box.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return !box.hidden && Math.abs(boxRect.width - targetRect.width) <= 1 && Math.abs(boxRect.height - targetRect.height) <= 1;
    });
    const activeBox = await selectionBoxState('#active-selection-box', '#dom-annotation');
    assert.equal(activeBox.hidden, false);
    assert.equal(activeBox.background, 'rgba(0, 0, 0, 0)');
    assert.equal(activeBox.borderStyle, 'dotted');
    assert.equal(activeBox.borderWidth, '2px');
    assert.equal(activeBox.leftDelta <= 1, true);
    assert.equal(activeBox.topDelta <= 1, true);
    assert.equal(activeBox.widthDelta <= 1, true);
    assert.equal(activeBox.heightDelta <= 1, true);
    assert.equal(activeBox.text, '');
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollTo(0, 120));
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const box = document.querySelector<HTMLElement>('#active-selection-box')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('#dom-annotation')!;
      const frameRect = iframe.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return Math.abs(boxRect.left - (frameRect.left + targetRect.left)) <= 1
        && Math.abs(boxRect.top - (frameRect.top + targetRect.top)) <= 1
        && Math.abs(boxRect.width - targetRect.width) <= 1
        && Math.abs(boxRect.height - targetRect.height) <= 1;
    });
    const activeBoxAfterScroll = await selectionBoxState('#active-selection-box', '#dom-annotation');
    assert.equal(activeBoxAfterScroll.leftDelta <= 1, true);
    assert.equal(activeBoxAfterScroll.topDelta <= 1, true);
    assert.equal(activeBoxAfterScroll.widthDelta <= 1, true);
    assert.equal(activeBoxAfterScroll.heightDelta <= 1, true);
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollTo(0, 0));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === true);

    await openDomComposer();
    await page.fill('#comment-body', 'Unsaved draft warning');
    await page.keyboard.press('Escape');
    assert.equal(await page.inputValue('#comment-body'), 'Unsaved draft warning');
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#composer')?.hidden), false);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#composer')?.classList.contains('discard-warning')), true);
    assert.match(await page.locator('#comment-discard-warning').innerText(), /comment would be lost/i);
    assert.match(await page.locator('#comment-discard-warning').innerText(), /Cancel/);
    await page.click('#cancel-comment');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === true);

    let delayNextCommentPost = false;
    let resumeCommentPost: (() => void) | null = null;
    let delayedCommentPostSeen = new Promise<void>(resolve => {
      page.route(`**/api/plans/${registered.planId}/comments`, async route => {
        if (route.request().method() === 'POST' && delayNextCommentPost) {
          delayNextCommentPost = false;
          resolve();
          await new Promise<void>(resume => {
            resumeCommentPost = resume;
          });
        }
        await route.continue();
      });
    });
    const countCommentsWithBody = async (body: string) => {
      const response = await context.get(`/api/plans/${registered.planId}/comments`);
      assert.equal(response.ok(), true);
      return ((await response.json()).data.comments as Array<{ body: string }>).filter(comment => comment.body === body).length;
    };
    await openDomComposer();
    await page.fill('#comment-body', 'Browser duplicate submit guard');
    delayNextCommentPost = true;
    await page.click('#submit-comment');
    await delayedCommentPostSeen;
    assert.equal(await page.evaluate(() => document.querySelector<HTMLButtonElement>('#submit-comment')?.disabled), true);
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const target = iframe.contentDocument!.querySelector('#text-target')!;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe.contentWindow ?? window }));
    });
    assert.equal(await page.inputValue('#comment-body'), 'Browser duplicate submit guard');
    assert.equal(await page.evaluate(() => document.querySelector<HTMLButtonElement>('#submit-comment')?.disabled), true);
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#submit-comment')?.click());
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    const resumeDuplicateSubmit = resumeCommentPost as (() => void) | null;
    assert.ok(resumeDuplicateSubmit);
    resumeDuplicateSubmit();
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser duplicate submit guard'));
    assert.equal(await countCommentsWithBody('Browser duplicate submit guard'), 1);

    delayedCommentPostSeen = new Promise<void>(resolve => {
      page.route(`**/api/plans/${registered.planId}/comments`, async route => {
        if (route.request().method() === 'POST' && delayNextCommentPost) {
          delayNextCommentPost = false;
          resolve();
          await new Promise<void>(resume => {
            resumeCommentPost = resume;
          });
        }
        await route.continue();
      });
    });
    await openDomComposer();
    await page.fill('#comment-body', 'Browser keyboard button submit guard');
    delayNextCommentPost = true;
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await delayedCommentPostSeen;
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#submit-comment')?.click());
    const resumeKeyboardSubmit = resumeCommentPost as (() => void) | null;
    assert.ok(resumeKeyboardSubmit);
    resumeKeyboardSubmit();
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser keyboard button submit guard'));
    assert.equal(await countCommentsWithBody('Browser keyboard button submit guard'), 1);
    await page.unroute(`**/api/plans/${registered.planId}/comments`);
    await page.evaluate(() => { (window as typeof window & { __html2canvasCalls?: number }).__html2canvasCalls = 0; });

    await openDomComposer();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    await page.fill('#comment-body', 'Browser DOM annotation comment');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');
    assert.equal(await page.inputValue('#comment-body'), 'Browser DOM annotation comment\nsecond line');
    assert.equal((await page.locator('#comments').innerText()).includes('Browser DOM annotation comment'), false);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser DOM annotation comment'));
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('second line'));
    await page.waitForFunction(() => (document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelectorAll('.comment-anchor').length ?? 0) > 0);
    assert.equal(await commentAnchorCount() >= 1, true);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector<HTMLElement>('.comment-anchor')?.getAttribute('style')?.includes('NaN')), false);
    const pendingAnchorStyle = await page.evaluate(() => {
      const anchor = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector<HTMLElement>('.comment-anchor.pending');
      if (!anchor) return null;
      const style = getComputedStyle(anchor);
      return { background: style.backgroundColor, borderStyle: style.borderStyle, borderWidth: style.borderWidth };
    });
    assert.ok(pendingAnchorStyle);
    assert.equal(pendingAnchorStyle.background, 'rgba(0, 0, 0, 0)');
    assert.equal(pendingAnchorStyle.borderStyle, 'dotted');
    assert.equal(pendingAnchorStyle.borderWidth, '2px');
    assert.equal(await page.evaluate(() => (window as typeof window & { __html2canvasCalls?: number }).__html2canvasCalls), 1);
    const markerTopBeforeScroll = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('.comment-anchor')?.getBoundingClientRect().top ?? 0);
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollTo(0, 120));
    await page.waitForFunction(
      before => Math.abs((document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('.comment-anchor')?.getBoundingClientRect().top ?? before) - before) > 20,
      markerTopBeforeScroll
    );
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollTo(0, 0));

    await page.evaluate(() => { (window as typeof window & { __html2canvasMode?: 'success' | 'fail' }).__html2canvasMode = 'fail'; });
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame');
      const target = iframe?.contentDocument?.querySelector('#dom-annotation');
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe?.contentWindow ?? window }));
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    await page.fill('#comment-body', 'Browser DOM annotation without screenshot');
    await page.click('#submit-comment');
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser DOM annotation without screenshot'));
    assert.equal(await page.evaluate(() => (window as typeof window & { __html2canvasCalls?: number }).__html2canvasCalls), 2);
    await page.evaluate(() => { (window as typeof window & { __html2canvasMode?: 'success' | 'fail' }).__html2canvasMode = 'success'; });

    await openDomComposer();
    await page.fill('#comment-body', 'Browser delete pending comment');
    await page.click('#submit-comment');
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser delete pending comment'));
    if (!await page.evaluate(() => document.body.classList.contains('comments-open'))) await page.click('#desktop-comments-toggle');
    const deleteRow = page.locator('.comment-row').filter({ hasText: 'Browser delete pending comment' });
    await deleteRow.getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => !document.querySelector('#comments')?.textContent?.includes('Browser delete pending comment'));
    assert.equal(await countCommentsWithBody('Browser delete pending comment'), 0);

    await openDomComposer();
    await page.fill('#comment-body', 'Browser delete conflict guidance');
    await page.click('#submit-comment');
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser delete conflict guidance'));
    await page.route('**/api/comments/*', async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'invalid_state', message: 'Only pending unclaimed comments can be deleted', details: {}, nextAction: 'Refresh and retry after the claim is released.' } })
      });
    });
    if (!await page.evaluate(() => document.body.classList.contains('comments-open'))) await page.click('#desktop-comments-toggle');
    const conflictRow = page.locator('.comment-row').filter({ hasText: 'Browser delete conflict guidance' });
    await conflictRow.getByRole('button', { name: 'Delete' }).click();
    await conflictRow.locator('.comment-delete-error').waitFor({ state: 'visible' });
    assert.match(await conflictRow.locator('.comment-delete-error').innerText(), /Only pending unclaimed comments can be deleted/);
    await page.unroute('**/api/comments/*');

    const claimedUiComment = await context.post(`/api/plans/${registered.planId}/comments`, {
      data: {
        versionId: registered.versionId,
        body: 'Browser claimed delete unavailable',
        anchorType: 'dom',
        anchor: { planNodeId: 'dom-annotation', cssSelector: '#dom-annotation', textPreview: 'DOM annotation', rect: { x: 0, y: 240, width: 200, height: 80 } }
      }
    });
    assert.equal(claimedUiComment.ok(), true);
    const claimedUi = (await claimedUiComment.json()).data.comment as { id: string };
    const claimedUiClaim = await context.post(`/api/plans/${registered.planId}/comments/claim`, { data: { mode: 'selected', commentIds: [claimedUi.id] } });
    assert.equal(claimedUiClaim.ok(), true);
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser claimed delete unavailable'));
    if (!await page.evaluate(() => document.body.classList.contains('comments-open'))) await page.click('#desktop-comments-toggle');
    const claimedRowDeleteButtons = await page.locator('.comment-row').filter({ hasText: 'Browser claimed delete unavailable' }).getByRole('button', { name: 'Delete' }).count();
    assert.equal(claimedRowDeleteButtons, 0);

    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const doc = iframe.contentDocument!;
      const target = doc.querySelector('#text-target')!;
      const text = target.firstChild!;
      const range = doc.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 18);
      const selection = doc.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: iframe.contentWindow ?? window }));
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    await page.fill('#comment-body', 'Browser text annotation comment');
    await page.click('#submit-comment');
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser text annotation comment'));
    assert.equal(await page.evaluate(() => (window as typeof window & { __html2canvasCalls?: number }).__html2canvasCalls), 5);

    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame');
      iframe?.contentDocument?.getSelection()?.removeAllRanges();
      const target = iframe?.contentDocument?.querySelector('img[alt="image annotation"]');
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe?.contentWindow ?? window }));
    });
    await page.waitForSelector('#lightbox:not([hidden])');
    await page.click('#zoom-in');
    await page.click('#zoom-in');
    await page.click('#pan-toggle');
    const stageBox = await page.locator('#lightbox-stage').boundingBox();
    assert.ok(stageBox);
    await page.mouse.move(stageBox.x + stageBox.width * 0.5, stageBox.y + stageBox.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.width * 0.55, stageBox.y + stageBox.height * 0.55);
    await page.mouse.up();
    await page.click('#pan-toggle');
    const imageBox = await page.locator('#lightbox-image').boundingBox();
    assert.ok(imageBox);
    await page.mouse.move(imageBox.x + imageBox.width * 0.25, imageBox.y + imageBox.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(imageBox.x + imageBox.width * 0.75, imageBox.y + imageBox.height * 0.65);
    await page.mouse.up();
    await page.waitForSelector('#image-selection-box:not([hidden])');
    await page.fill('#comment-body', 'Browser image annotation comment');
    await page.click('#submit-comment');
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser image annotation comment'));
    assert.equal(await page.evaluate(() => (window as typeof window & { __html2canvasCalls?: number }).__html2canvasCalls), 6);
    assert.match(await page.locator('#comments').innerText(), /image · mapped/);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Browser image annotation comment'));
    await page.waitForFunction(() => (document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelectorAll('.comment-anchor').length ?? 0) >= 3);

    const staleDomComment = await context.post(`/api/plans/${registered.planId}/comments`, {
      data: {
        versionId: registered.versionId,
        body: 'Legacy DOM annotation with loose fallback selector',
        anchorType: 'dom',
        anchor: { planNodeId: 'dom-annotation', cssSelector: 'section', textPreview: 'DOM annotation', rect: { x: 0, y: 240, width: 200, height: 80 } }
      }
    });
    assert.equal(staleDomComment.ok(), true);
    const staleDom = (await staleDomComment.json()).data as { comment: { id: string } };
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Legacy DOM annotation with loose fallback selector'));
    await page.waitForFunction(() => (document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelectorAll('.comment-anchor').length ?? 0) >= 4);

    const resolvedFallbackComment = await context.post(`/api/plans/${registered.planId}/comments`, {
      data: {
        versionId: registered.versionId,
        body: 'Resolved DOM annotation maps by selector fallback',
        anchorType: 'dom',
        anchor: { planNodeId: 'old-node-id', cssSelector: '#text-target', xpath: '/html/body/main/section[2]/p', textPreview: 'Text range context target', rect: { x: 0, y: 0, width: 20, height: 20 } }
      }
    });
    assert.equal(resolvedFallbackComment.ok(), true);
    const resolvedFallback = (await resolvedFallbackComment.json()).data as { comment: { id: string } };
    const resolvedResponse = await context.post(`/api/comments/${resolvedFallback.comment.id}/resolve`, {
      data: { resolutionNote: 'Resolved in e2e regression' }
    });
    assert.equal(resolvedResponse.ok(), true);
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Resolved DOM annotation maps by selector fallback'));

    let delayNextRender = false;
    let resumeDelayedRender: (() => void) | null = null;
    const delayedRenderSeen = new Promise<void>(resolve => {
      page.route(`**/render/${registered.planId}*`, async route => {
        const url = new URL(route.request().url());
        if (delayNextRender && url.searchParams.has('versionId')) {
          delayNextRender = false;
          resolve();
          await new Promise<void>(resume => {
            resumeDelayedRender = resume;
          });
        }
        await route.continue();
      });
    });
    delayNextRender = true;
    const staleRaceHtml = html.replace('<title>E2E Plan</title>', '<title>Race Stale Plan</title>').replace('Plan index target.', 'Race stale target.');
    const staleRace = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-repo',
        repoName: 'e2e',
        rootPath: '/tmp/e2e',
        branch: 'main',
        commitSha: 'e2e-race-stale',
        planPath: 'thoughts/plans/e2e.html',
        slug: 'e2e',
        html: staleRaceHtml,
        fileHash: sha256(staleRaceHtml),
        publicationMetadata: {
          worktreePath: '/tmp/e2e',
          branch: 'main',
          linearIssue: 'NOD-E2E',
          executionReady: false,
          executionReadyBasis: 'agent-review-results'
        },
        assets: [{ sourceUrl: './diagram.png', absolutePath: '/tmp/e2e/diagram.png', bytesBase64: imageBytesBase64 }],
        updateMode: 'upsert'
      }
    });
    assert.equal(staleRace.ok(), true);
    await delayedRenderSeen;
    const newestRaceHtml = html.replace('<title>E2E Plan</title>', '<title>Race Newest Plan</title>').replace('Plan index target.', 'Race newest target.');
    const newestRace = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-repo',
        repoName: 'e2e',
        rootPath: '/tmp/e2e',
        branch: 'main',
        commitSha: 'e2e-race-newest',
        planPath: 'thoughts/plans/e2e.html',
        slug: 'e2e',
        html: newestRaceHtml,
        fileHash: sha256(newestRaceHtml),
        publicationMetadata: {
          worktreePath: '/tmp/e2e',
          branch: 'main',
          linearIssue: 'NOD-E2E',
          executionReady: false,
          executionReadyBasis: 'agent-review-results'
        },
        assets: [{ sourceUrl: './diagram.png', absolutePath: '/tmp/e2e/diagram.png', bytesBase64: imageBytesBase64 }],
        updateMode: 'upsert'
      }
    });
    assert.equal(newestRace.ok(), true);
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body.textContent?.includes('Race newest target'));
    await page.waitForFunction(() => document.title === 'Race Newest Plan · Plan Review');
    await page.waitForFunction(() => document.querySelector('#current-plan-title')?.textContent === 'Race Newest Plan');
    const resumeRender = resumeDelayedRender as (() => void) | null;
    assert.ok(resumeRender);
    resumeRender();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => {
      const text = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body.textContent ?? '';
      return text.includes('Race newest target') && !text.includes('Race stale target');
    }), true);
    await page.unroute(`**/render/${registered.planId}*`);

    const bodyTitleRefreshHtml = html
      .replace('<title>E2E Plan</title>', '')
      .replace('<section id="text-annotation">', '<svg><title>Inline Icon Title</title></svg><section id="text-annotation">')
      .replace('Race newest target.', 'Body title fallback target.');
    const bodyTitleRefresh = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-repo',
        repoName: 'e2e',
        rootPath: '/tmp/e2e',
        branch: 'main',
        commitSha: 'e2e-body-title-refresh',
        planPath: 'thoughts/plans/e2e.html',
        slug: 'e2e',
        html: bodyTitleRefreshHtml,
        fileHash: sha256(bodyTitleRefreshHtml),
        publicationMetadata: {
          worktreePath: '/tmp/e2e',
          branch: 'main',
          linearIssue: 'NOD-E2E',
          executionReady: false,
          executionReadyBasis: 'agent-review-results'
        },
        assets: [{ sourceUrl: './diagram.png', absolutePath: '/tmp/e2e/diagram.png', bytesBase64: imageBytesBase64 }],
        updateMode: 'upsert'
      }
    });
    assert.equal(bodyTitleRefresh.ok(), true);
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('main title')?.textContent === 'Inline Icon Title');
    await page.waitForFunction(() => document.title === 'e2e / e2e · Plan Review');


    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      (window as typeof window & { __planFrameLoadCount?: number }).__planFrameLoadCount = 0;
      iframe.addEventListener('load', () => {
        (window as typeof window & { __planFrameLoadCount?: number }).__planFrameLoadCount =
          ((window as typeof window & { __planFrameLoadCount?: number }).__planFrameLoadCount ?? 0) + 1;
      });
      iframe.contentWindow?.scrollTo(0, 120);
    });
    const frameSrcBeforePlanUpdate = await page.getAttribute('#plan-frame', 'src');

    let delayMissingRender = false;
    let resumeMissingRender: (() => void) | null = null;
    const missingRenderSeen = new Promise<void>(resolve => {
      page.route(`**/render/${registered.planId}*`, async route => {
        const url = new URL(route.request().url());
        if (delayMissingRender && url.searchParams.has('versionId')) {
          delayMissingRender = false;
          resolve();
          await new Promise<void>(resume => {
            resumeMissingRender = resume;
          });
        }
        await route.continue();
      });
    });
    delayMissingRender = true;
    let resumeSlowImage: (() => void) | null = null;
    const slowImageSeen = new Promise<void>(resolve => {
      page.route(`**${slowImageAssetPath}`, async route => {
        resolve();
        await new Promise<void>(resume => {
          resumeSlowImage = resume;
        });
        await route.continue();
      });
    });
    const missingDomHtml = html
      .replace('<section id="dom-annotation"><h1>DOM annotation</h1><p>Plan index target.</p></section>', '')
      .replace('<section id="text-annotation">', '<figure><img src="./slow.svg" alt="slow image"></figure><section id="text-annotation">');
    const changed = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-repo',
        repoName: 'e2e',
        rootPath: '/tmp/e2e',
        branch: 'main',
        commitSha: 'e2e-missing-dom',
        planPath: 'thoughts/plans/e2e.html',
        slug: 'e2e',
        html: missingDomHtml,
        fileHash: sha256(missingDomHtml),
        publicationMetadata: {
          worktreePath: '/tmp/e2e',
          branch: 'main',
          linearIssue: 'NOD-E2E',
          executionReady: false,
          executionReadyBasis: 'agent-review-results'
        },
        assets: [
          { sourceUrl: './diagram.png', absolutePath: '/tmp/e2e/diagram.png', bytesBase64: imageBytesBase64 },
          { sourceUrl: './slow.svg', absolutePath: '/tmp/e2e/slow.svg', bytesBase64: slowImageBytesBase64 }
        ],
        updateMode: 'upsert'
      }
    });
    assert.equal(changed.ok(), true);
    await missingRenderSeen;
    const commentDuringRefresh = await context.post(`/api/plans/${registered.planId}/comments`, {
      data: {
        versionId: registered.versionId,
        body: 'Comment created during render refresh',
        anchorType: 'dom',
        anchor: { cssSelector: '#text-target', textPreview: 'Text range context target', rect: { x: 0, y: 0, width: 20, height: 20 } }
      }
    });
    assert.equal(commentDuringRefresh.ok(), true);
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Comment created during render refresh'));
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const target = iframe.contentDocument!.querySelector('#text-target')!;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe.contentWindow ?? window }));
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    await page.fill('#comment-body', 'Draft opened during render refresh');
    const resumeMissing = resumeMissingRender as (() => void) | null;
    assert.ok(resumeMissing);
    resumeMissing();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#deferred-refresh-notice')?.hidden === false);
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Comment created during render refresh'));
    assert.equal(await page.inputValue('#comment-body'), 'Draft opened during render refresh');
    assert.equal(await page.evaluate(() => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#dom-annotation'))), true);
    await page.click('#cancel-comment');
    await page.waitForFunction(() => !document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#dom-annotation'));
    await slowImageSeen;
    const resumeImage = resumeSlowImage as (() => void) | null;
    assert.ok(resumeImage);
    resumeImage();
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector<HTMLImageElement>('img[alt="slow image"]');
      return Boolean(image?.complete && image.naturalHeight > 0);
    });
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Comment created during render refresh'));
    await page.unroute(`**/render/${registered.planId}*`);
    await page.unroute(`**${slowImageAssetPath}`);
    assert.equal(await page.getAttribute('#plan-frame', 'src'), frameSrcBeforePlanUpdate);
    assert.equal(await page.evaluate(() => (window as typeof window & { __planFrameLoadCount?: number }).__planFrameLoadCount), 0);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY), 120);
    await page.waitForFunction(
      commentId => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector(`.comment-anchor.addressed[data-comment-id="${commentId}"]`)),
      resolvedFallback.comment.id
    );
    await page.waitForFunction(commentId => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
      const anchor = doc?.querySelector<HTMLElement>(`.comment-anchor.addressed[data-comment-id="${commentId}"]`);
      const target = doc?.querySelector<HTMLElement>('#text-target');
      if (!anchor || !target) return false;
      const anchorRect = anchor.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return Math.abs(anchorRect.y - targetRect.y) <= 1 && Math.abs(anchorRect.width - targetRect.width) <= 1;
    }, resolvedFallback.comment.id);
    assert.equal(await page.evaluate(commentId => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
      const anchor = doc?.querySelector<HTMLElement>(`.comment-anchor.pending[data-comment-id="${commentId}"]`);
      const target = doc?.querySelector<HTMLElement>('#text-target');
      if (!anchor || !target) return false;
      const anchorRect = anchor.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return Math.abs(anchorRect.y - targetRect.y) <= 1;
    }, staleDom.comment.id), false);
    const resolvedAnchor = await page.evaluate(commentId => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
      const anchor = doc?.querySelector<HTMLElement>(`.comment-anchor.addressed[data-comment-id="${commentId}"]`);
      const target = doc?.querySelector<HTMLElement>('#text-target');
      if (!anchor || !target) return null;
      const anchorRect = anchor.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return {
        borderStyle: getComputedStyle(anchor).borderStyle,
        anchorY: Math.round(anchorRect.y),
        targetY: Math.round(targetRect.y),
        anchorWidth: Math.round(anchorRect.width),
        targetWidth: Math.round(targetRect.width)
      };
    }, resolvedFallback.comment.id);
    assert.ok(resolvedAnchor);
    assert.equal(resolvedAnchor.borderStyle, 'dotted');
    assert.equal(Math.abs(resolvedAnchor.anchorY - resolvedAnchor.targetY) <= 1, true);
    assert.equal(Math.abs(resolvedAnchor.anchorWidth - resolvedAnchor.targetWidth) <= 1, true);
    await page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('#comment-body')!;
      const originalFocus = textarea.focus.bind(textarea);
      (window as typeof window & { __commentBodyFocusCount?: number }).__commentBodyFocusCount = 0;
      textarea.focus = () => {
        (window as typeof window & { __commentBodyFocusCount?: number }).__commentBodyFocusCount =
          ((window as typeof window & { __commentBodyFocusCount?: number }).__commentBodyFocusCount ?? 0) + 1;
        originalFocus();
      };
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const target = iframe.contentDocument!.querySelector('#text-target')!;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe.contentWindow ?? window }));
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    assert.equal(await page.evaluate(() => (window as typeof window & { __commentBodyFocusCount?: number }).__commentBodyFocusCount), 1);
    await page.click('#cancel-comment');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === true);

    const touchContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 486, height: 902 } });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.goto(`${baseUrl}/p/${registered.planId}`);
      await touchPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#plan-test-link'));
      const linkBox = await touchPage.frameLocator('#plan-frame').locator('#plan-test-link').boundingBox();
      assert.ok(linkBox);
      await touchPage.touchscreen.tap(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
      await touchPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.location.hash === '#link-target');
      await touchPage.waitForTimeout(180);
      assert.equal(await touchPage.evaluate(() => document.querySelector<HTMLElement>('#composer')?.hidden), true);
      await touchPage.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        iframe.contentWindow?.history.replaceState(null, '', iframe.contentWindow.location.pathname);
        iframe.contentWindow?.scrollTo(0, 0);
      });
      const adjacentBox = await touchPage.frameLocator('#plan-frame').locator('#link-adjacent-text').boundingBox();
      assert.ok(adjacentBox);
      await touchPage.touchscreen.tap(adjacentBox.x + adjacentBox.width / 2, adjacentBox.y + adjacentBox.height / 2);
      await touchPage.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    } finally {
      await touchContext.close();
    }

    const mobilePlanNote = await context.post(`/api/plans/${registered.planId}/notes`, { data: { body: 'Mobile plan note remains visible.' } });
    assert.equal(mobilePlanNote.ok(), true);
    await page.setViewportSize({ width: 486, height: 902 });
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#text-target'));
    await page.click('#mobile-comments-toggle');
    await page.waitForFunction(() => document.body.classList.contains('comments-open'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('#plan-notes-panel')!).display !== 'none'), true);
    assert.match(await page.locator('#plan-notes-panel').innerText(), /Mobile plan note remains visible/);
    await page.click('#mobile-comments-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('comments-open'));
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const doc = iframe.contentDocument!;
      const target = doc.querySelector<HTMLElement>('#text-target')!;
      const text = target.firstChild!;
      const range = doc.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 10);
      const selection = doc.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      const touch = { clientX: rect.left + Math.max(1, rect.width / 2), clientY: rect.top + Math.max(1, rect.height / 2) };
      const end = new Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(end, 'touches', { value: [] });
      Object.defineProperty(end, 'changedTouches', { value: [touch] });
      target.dispatchEvent(end);
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const selection = iframe.contentDocument!.getSelection()!;
      return document.activeElement?.id === 'comment-body' && selection.toString() === '' && selection.isCollapsed;
    });
    assert.deepEqual(await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const selection = iframe.contentDocument!.getSelection()!;
      return {
        activeElementId: document.activeElement?.id,
        selectedText: selection.toString(),
        isCollapsed: selection.isCollapsed
      };
    }), { activeElementId: 'comment-body', selectedText: '', isCollapsed: true });
    await page.keyboard.type('Mobile selected text composer accepts typing');
    assert.equal(await page.inputValue('#comment-body'), 'Mobile selected text composer accepts typing');
    await page.click('#cancel-comment');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === true);
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const doc = iframe.contentDocument!;
      const target = doc.querySelector<HTMLElement>('#text-target')!;
      const rect = target.getBoundingClientRect();
      const touch = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      const start = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(start, 'touches', { value: [touch] });
      Object.defineProperty(start, 'changedTouches', { value: [touch] });
      target.dispatchEvent(start);
      let changedTouches = [touch];
      const end = new Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(end, 'touches', { value: [] });
      Object.defineProperty(end, 'changedTouches', { get: () => changedTouches });
      doc.dispatchEvent(end);
      changedTouches = [];
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    await page.click('#cancel-comment');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === true);
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('#text-target')!;
      const rect = target.getBoundingClientRect();
      const touch = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      const start = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(start, 'touches', { value: [touch] });
      Object.defineProperty(start, 'changedTouches', { value: [touch] });
      target.dispatchEvent(start);
      const end = new Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(end, 'touches', { value: [] });
      Object.defineProperty(end, 'changedTouches', { value: [touch] });
      target.dispatchEvent(end);
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    const mobileActiveBox = await selectionBoxState('#active-selection-box', '#text-target');
    assert.equal(mobileActiveBox.hidden, false);
    assert.equal(mobileActiveBox.background, 'rgba(0, 0, 0, 0)');
    assert.equal(mobileActiveBox.borderStyle, 'dotted');
    assert.equal(mobileActiveBox.text, '');
    assert.equal(mobileActiveBox.leftDelta <= 1, true);
    assert.equal(mobileActiveBox.topDelta <= 1, true);
    assert.equal(mobileActiveBox.widthDelta <= 1, true);
    assert.equal(mobileActiveBox.heightDelta <= 1, true);
    await page.fill('#comment-body', 'Mobile touch annotation comment');
    await page.click('#submit-comment');
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Mobile touch annotation comment'));
    assert.equal(await page.evaluate(() => document.body.classList.contains('comments-open')), true);
    await page.click('#mobile-comments-toggle');
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('img[alt="image annotation"]')!;
      const rect = target.getBoundingClientRect();
      const touch = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      const start = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(start, 'touches', { value: [touch] });
      Object.defineProperty(start, 'changedTouches', { value: [touch] });
      target.dispatchEvent(start);
      const end = new Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(end, 'touches', { value: [] });
      Object.defineProperty(end, 'changedTouches', { value: [touch] });
      target.dispatchEvent(end);
    });
    await page.waitForSelector('#lightbox:not([hidden])');
    assert.equal(await page.evaluate(() => {
      const controls = [...document.querySelectorAll<HTMLElement>('#comment-body,#submit-comment')];
      return controls.every(control => {
        const rect = control.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return top === control || Boolean(top?.closest?.('#comment-body,#submit-comment'));
      });
    }), true);
    await page.fill('#comment-body', 'Mobile image touch comment');
    await page.click('#submit-comment');
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Mobile image touch comment'));
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.goto(`${baseUrl}/`);
    await page.once('dialog', dialog => dialog.accept());
    await page.click(`[data-archive-plan="${registered.planId}"]`);
    await page.waitForFunction(planId => !document.querySelector(`[data-plan-id="${planId}"]`), registered.planId);
    await page.goto(`${baseUrl}/archive`);
    await page.waitForSelector(`[data-plan-id="${registered.planId}"]`);
    await page.click(`[data-plan-id="${registered.planId}"] a[href="/p/${registered.planId}"]`);
    await page.waitForSelector('#restore-plan');
    assert.equal(await page.locator('#archive-plan').count(), 0);
    assert.match(await page.locator('#plan-navbar').innerText(), /Archived/);

    await page.goto(`${baseUrl}/archive`);
    await page.route('**/api/plans/*/unarchive', route => route.abort('failed'));
    await page.click(`[data-plan-id="${registered.planId}"] [data-restore-plan]`);
    await page.waitForSelector(`[data-plan-id="${registered.planId}"] .restore-error:not([hidden])`);
    assert.equal(await page.locator(`[data-plan-id="${registered.planId}"]`).count(), 1);
    await page.unroute('**/api/plans/*/unarchive');
    await page.click(`[data-plan-id="${registered.planId}"] [data-restore-plan]`);
    await page.waitForFunction(planId => !document.querySelector(`[data-plan-id="${planId}"]`), registered.planId);
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector(`[data-plan-id="${registered.planId}"]`);
  } finally {
    await browser.close();
  }

  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-e2e-sync-'));
  const syncPath = path.join(syncDir, 'live-plan.html');
  const syncHtmlV1 = '<!doctype html><html><body><main><section id="sync-target"><h1>Plan sync</h1><p>Source sync v1</p></section></main></body></html>';
  fs.writeFileSync(syncPath, syncHtmlV1);
  const syncStat = fs.statSync(syncPath);
  const syncRegister = await context.post('/api/plans/register', {
    data: {
      repoKey: 'e2e-sync-repo',
      repoName: 'e2e-sync',
      rootPath: syncDir,
      branch: 'main',
      commitSha: 'e2e-sync',
      planPath: 'live-plan.html',
      slug: 'e2e-sync',
      html: syncHtmlV1,
      fileHash: sha256(syncHtmlV1),
      publicationMetadata: {
        worktreePath: syncDir,
        branch: 'main',
        executionReady: false,
        executionReadyBasis: 'agent-review-results'
      },
      sourcePath: syncPath,
      sourceMtimeMs: syncStat.mtimeMs,
      sourceSize: syncStat.size,
      watchMode: 'filesystem',
      updateMode: 'upsert'
    }
  });
  assert.equal(syncRegister.ok(), true);
  const syncRegistered = (await syncRegister.json()).data as { planId: string; versionId: string };
  const syncBrowser = await chromium.launch({ headless: true });
  try {
    const syncPage = await syncBrowser.newPage();
    await syncPage.goto(`${baseUrl}/p/${syncRegistered.planId}`);
    await syncPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v1'));
    await syncPage.waitForSelector('#plan-navbar');
    assert.equal(await syncPage.locator('#plan-navbar a').getAttribute('href'), '/');
    const openSyncComposer = async () => {
      await syncPage.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame');
        const target = iframe?.contentDocument?.querySelector('#sync-target');
        target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe?.contentWindow ?? window }));
      });
      await syncPage.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    };

    await openSyncComposer();
    await syncPage.fill('#comment-body', 'Draft survives source sync');
    const syncHtmlV2 = syncHtmlV1.replace('Source sync v1', 'Source sync v2');
    fs.writeFileSync(syncPath, syncHtmlV2);
    await syncPage.waitForFunction(
      () => document.querySelector<HTMLElement>('#deferred-refresh-notice')?.hidden === false || document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v2'),
      undefined,
      { timeout: 5000 }
    );
    assert.equal(await syncPage.inputValue('#comment-body'), 'Draft survives source sync');
    assert.equal(await syncPage.evaluate(() => document.querySelector<HTMLElement>('#composer')?.hidden), false);
    assert.equal(await syncPage.evaluate(() => document.querySelector<HTMLElement>('#deferred-refresh-notice')?.hidden), false);
    assert.equal(await syncPage.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v1')), true);
    assert.equal(await syncPage.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v2')), false);
    await syncPage.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await syncPage.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Draft survives source sync'));
    await syncPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v2'));
    await syncPage.waitForFunction(() => document.querySelector<HTMLElement>('#deferred-refresh-notice')?.hidden !== false);

    await openSyncComposer();
    await syncPage.fill('#comment-body', 'Draft cancelled after source sync');
    const syncHtmlV3 = syncHtmlV2.replace('Source sync v2', 'Source sync v3');
    fs.writeFileSync(syncPath, syncHtmlV3);
    await syncPage.waitForFunction(() => document.querySelector<HTMLElement>('#deferred-refresh-notice')?.hidden === false, undefined, { timeout: 5000 });
    assert.equal(await syncPage.inputValue('#comment-body'), 'Draft cancelled after source sync');
    await syncPage.click('#cancel-comment');
    await syncPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v3'));
    assert.equal((await syncPage.locator('#comments').innerText()).includes('Draft cancelled after source sync'), false);

    fs.rmSync(syncPath);
    await syncPage.waitForFunction(() => document.querySelector<HTMLElement>('#sync-warning')?.hidden === false);
    fs.writeFileSync(syncPath, syncHtmlV3);
    await syncPage.waitForFunction(() => document.querySelector<HTMLElement>('#sync-warning')?.hidden === true);

    await syncPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const syncHtmlV4 = syncHtmlV3.replace('Source sync v3', 'Source sync v4');
    fs.writeFileSync(syncPath, syncHtmlV4);
    await syncPage.waitForTimeout(1000);
    assert.equal(await syncPage.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v4')), false);
    await syncPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await syncPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v4'), undefined, { timeout: 5000 });

    await syncPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const syncHtmlV5 = syncHtmlV4.replace('Source sync v4', 'Source sync v5');
    fs.writeFileSync(syncPath, syncHtmlV5);
    await syncPage.waitForTimeout(1000);
    assert.equal(await syncPage.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v5')), false);
    let failedVisibleCatchup = false;
    await syncPage.route(`${baseUrl}/api/plans/${syncRegistered.planId}`, async route => {
      if (!failedVisibleCatchup) {
        failedVisibleCatchup = true;
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
        return;
      }
      await route.continue();
    });
    await syncPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await syncPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v5'), undefined, { timeout: 5000 });
    assert.equal(failedVisibleCatchup, true);

    await syncPage.evaluate(() => {
      const event = new Event('pagehide');
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);
    });
    const syncHtmlV6 = syncHtmlV5.replace('Source sync v5', 'Source sync v6');
    fs.writeFileSync(syncPath, syncHtmlV6);
    await syncPage.waitForTimeout(1000);
    assert.equal(await syncPage.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v6')), false);
    await syncPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      const event = new Event('pageshow');
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);
    });
    await syncPage.waitForTimeout(1000);
    assert.equal(await syncPage.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v6')), false);
    await syncPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await syncPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body?.textContent?.includes('Source sync v6'), undefined, { timeout: 5000 });
  } finally {
    await syncBrowser.close();
    fs.rmSync(syncDir, { recursive: true, force: true });
  }

  const deferredSyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-e2e-deferred-sync-'));
  try {
    const deferredSyncPath = path.join(deferredSyncDir, 'deferred-live-plan.html');
    const deferredSyncHtmlV1 = '<!doctype html><html><body><main><section id="deferred-sync-target"><h1>Deferred sync</h1><p>Deferred sync v1</p></section></main></body></html>';
    fs.writeFileSync(deferredSyncPath, deferredSyncHtmlV1);
    const deferredSyncStat = fs.statSync(deferredSyncPath);
    const deferredRegister = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-deferred-sync-repo',
        repoName: 'e2e-deferred-sync',
        rootPath: deferredSyncDir,
        branch: 'main',
        commitSha: 'e2e-deferred-sync',
        planPath: 'deferred-live-plan.html',
        slug: 'e2e-deferred-sync',
        html: deferredSyncHtmlV1,
        fileHash: sha256(deferredSyncHtmlV1),
        publicationMetadata: {
          worktreePath: deferredSyncDir,
          branch: 'main',
          executionReady: false,
          executionReadyBasis: 'agent-review-results'
        },
        sourcePath: deferredSyncPath,
        sourceMtimeMs: deferredSyncStat.mtimeMs,
        sourceSize: deferredSyncStat.size,
        watchMode: 'filesystem',
        updateMode: 'upsert'
      }
    });
    assert.equal(deferredRegister.ok(), true);
    const deferredRegistered = (await deferredRegister.json()).data as { planId: string; versionId: string };

    const addedNote = await context.post(`/api/plans/${deferredRegistered.planId}/notes`, { data: { body: 'E2E note before defer.' } });
    assert.equal(addedNote.ok(), true);
    const pendingComment = await context.post(`/api/plans/${deferredRegistered.planId}/comments`, {
      data: {
        versionId: deferredRegistered.versionId,
        body: 'Pending comment should wait while deferred.',
        anchorType: 'dom',
        anchor: { planNodeId: 'deferred-sync-target', cssSelector: '#deferred-sync-target', textPreview: 'Deferred sync' }
      }
    });
    assert.equal(pendingComment.ok(), true);

    const deferred = await context.post(`/api/plans/${deferredRegistered.planId}/defer`, { data: { note: 'E2E pause before source sync catches up.' } });
    assert.equal(deferred.ok(), true);
    assert.equal((await deferred.json()).data.plan.lifecycleState, 'deferred');
    const deferredQueue = await context.get(`/api/agent/queue?planId=${deferredRegistered.planId}`);
    assert.equal(deferredQueue.ok(), true);
    assert.deepEqual((await deferredQueue.json()).data.items, []);
    const deferredPageResponse = await context.get('/deferred');
    assert.equal(deferredPageResponse.ok(), true);
    assert.match(await deferredPageResponse.text(), /E2E pause before source sync catches up/);
    const deferredNotes = await context.get(`/api/plans/${deferredRegistered.planId}/notes`);
    assert.equal(deferredNotes.ok(), true);
    assert.equal(((await deferredNotes.json()).data.notes as Array<unknown>).length, 2);

    const deferredSyncHtmlV2 = deferredSyncHtmlV1.replace('Deferred sync v1', 'Deferred sync v2');
    fs.writeFileSync(deferredSyncPath, deferredSyncHtmlV2);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const stillDeferredRender = await context.get(`/render/${deferredRegistered.planId}`);
    assert.equal(stillDeferredRender.ok(), true);
    const stillDeferredHtml = await stillDeferredRender.text();
    assert.match(stillDeferredHtml, /Deferred sync v1/);
    assert.doesNotMatch(stillDeferredHtml, /Deferred sync v2/);

    const resumed = await context.post(`/api/plans/${deferredRegistered.planId}/resume`, { data: { note: 'E2E resume after pause.' } });
    assert.equal(resumed.ok(), true);
    assert.equal((await resumed.json()).data.plan.lifecycleState, 'active');
    let resumedHtml = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const resumedRender = await context.get(`/render/${deferredRegistered.planId}`);
      assert.equal(resumedRender.ok(), true);
      resumedHtml = await resumedRender.text();
      if (/Deferred sync v2/.test(resumedHtml)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.match(resumedHtml, /Deferred sync v2/);
    const resumedQueue = await context.get(`/api/agent/queue?planId=${deferredRegistered.planId}`);
    assert.equal(resumedQueue.ok(), true);
    assert.equal(((await resumedQueue.json()).data.items as Array<unknown>).length, 1);
  } finally {
    fs.rmSync(deferredSyncDir, { recursive: true, force: true });
  }

  const comments = await context.get(`/api/plans/${registered.planId}/comments`);
  const commentData = (await comments.json()).data.comments as Array<{ body: string; screenshotAssetId?: string; anchor?: { selectedText?: string; planNodeId?: string; domPath?: string; xpath?: string; textQuote?: unknown; normalizedPoint?: { x?: number; y?: number }; normalizedRect?: { width: number; height: number }; displayedRect?: unknown; zoomState?: { scale: number; panX?: number; panY?: number }; imageHash?: string } }>;
  const uiComment = commentData.find(comment => comment.body === 'Browser DOM annotation comment\nsecond line');
  assert.ok(uiComment?.screenshotAssetId);
  const uiFallbackComment = commentData.find(comment => comment.body === 'Browser DOM annotation without screenshot');
  assert.ok(uiFallbackComment);
  assert.equal(uiFallbackComment.screenshotAssetId, undefined);
  const uiTextComment = commentData.find(comment => comment.body === 'Browser text annotation comment');
  assert.equal(uiTextComment?.anchor?.selectedText, 'Text range context');
  assert.equal(uiTextComment.anchor.planNodeId, 'text-target');
  assert.ok(uiTextComment.anchor.domPath);
  assert.ok(uiTextComment.anchor.xpath);
  assert.ok(uiTextComment.anchor.textQuote);
  const uiImageComment = commentData.find(comment => comment.body === 'Browser image annotation comment');
  assert.ok(uiImageComment?.anchor?.normalizedPoint);
  assert.ok(uiImageComment.anchor.normalizedRect);
  assert.equal(uiImageComment.anchor.normalizedRect.width > 0, true);
  assert.equal(uiImageComment.anchor.normalizedRect.height > 0, true);
  assert.ok(uiImageComment.anchor.displayedRect);
  assert.equal(typeof uiImageComment.anchor.zoomState?.scale, 'number');
  assert.equal((uiImageComment.anchor.zoomState?.panX ?? 0) !== 0 || (uiImageComment.anchor.zoomState?.panY ?? 0) !== 0, true);
  assert.equal(typeof uiImageComment.anchor.imageHash, 'string');
  const mobileImageComment = commentData.find(comment => comment.body === 'Mobile image touch comment');
  const mobileImagePoint = mobileImageComment?.anchor?.normalizedPoint;
  assert.equal(typeof mobileImagePoint?.x, 'number');
  assert.equal(typeof mobileImagePoint?.y, 'number');
  assert.equal(Number.isFinite(mobileImagePoint?.x), true);
  assert.equal(Number.isFinite(mobileImagePoint?.y), true);
  const asset = await context.get(`/comment-assets/${uiComment.screenshotAssetId}`);
  assert.equal(asset.ok(), true);
  const assetBody = await asset.body();
  assert.ok(assetBody.length > 100, `expected non-trivial marker screenshot, got ${assetBody.length} bytes`);

  await context.dispose();
  console.log('e2e scenarios passed: plan index, dom annotation, image annotation, plan sync, deferred notes resume sync');
} finally {
  await app.close();
}
