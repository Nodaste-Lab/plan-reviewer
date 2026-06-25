import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, request } from 'playwright';
import { unzipSync, strFromU8 } from 'fflate';
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
  const html = `<!doctype html><html><head><title>E2E Plan</title></head><body><main><div style="height:240px"></div><section id="dom-annotation"><h1>DOM annotation</h1><p>Plan index target.</p></section><section id="link-annotation"><h2>Link annotation</h2><p id="link-comment-target"><span id="link-adjacent-text">Commentable text before</span> <a id="plan-test-link" href="#link-target">fragment link</a> <span>after link.</span></p><p><a id="blank-plan-link" href="${baseUrl}/favicon.svg" target="_blank">Open asset in new tab</a></p><p><label id="wrapping-control-label"><input id="wrapped-control" type="checkbox"> <span id="wrapped-control-label-text">Toggle wrapped control</span></label></p><div id="link-target" style="margin-top:20px">Link target</div></section><section id="text-annotation"><h2>Text annotation</h2><p id="text-target">Text range context target for reviewer selection.</p></section><figure><img src="./diagram.png" alt="image annotation" width="120" height="90"></figure><p id="width-sensitive-reflow">${'Width-sensitive desktop shell transition content wraps across many lines. '.repeat(80)}</p><p><a id="empty-fragment-link" href="#">Back to top</a></p><div style="height:1200px"></div></main></body></html>`;
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
  const deferredRegister = await context.post('/api/plans/register', {
    data: {
      repoKey: 'e2e-repo',
      repoName: 'e2e',
      rootPath: '/tmp/e2e',
      branch: 'main',
      commitSha: 'e2e-deferred',
      planPath: 'thoughts/plans/e2e-deferred.html',
      slug: 'e2e-deferred',
      html: '<!doctype html><html><body><main><p>Deferred archive undo e2e</p></main></body></html>',
      fileHash: sha256('deferred-archive-undo-e2e'),
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
  assert.equal(deferredRegister.ok(), true);
  const deferredRegistered = (await deferredRegister.json()).data as { planId: string; versionId: string };
  const deferredResponse = await context.post(`/api/plans/${deferredRegistered.planId}/defer`, { data: { note: 'Paused for deferred archive undo e2e' } });
  assert.equal(deferredResponse.ok(), true);

  const index = await context.get('/');
  assert.equal(index.ok(), true);
  const indexHtml = await index.text();
  assert.match(indexHtml, /Plans · Kanban/);
  assert.match(indexHtml, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
  const allDocumentsIndex = await context.get('/?view=all');
  assert.equal(allDocumentsIndex.ok(), true);
  assert.match(await allDocumentsIndex.text(), /Plan Review Index/);
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
  const clientJsText = await clientJsResponse.text();
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
  assert.doesNotMatch(clientCssText, /#plan-frame\{[^}]*;height:calc\(100vh - 86px\)/);
  assert.match(clientCssText, /#plan-frame\{[^}]*min-height:calc\(100vh - 86px\)[^}]*display:block/);
  // Mobile review surface contract: the parent #review is the native scroll
  // container, the iframe is laid out at full content height (so #review can
  // scroll it natively), and #plan-touch-layer sits on top as the tap surface.
  // This is load-bearing: iOS Safari never delivers iframe touch events to
  // parent-registered listeners, so the overlay (a parent element) must be the
  // tap surface, and native scroll must come from #review (touch-action), not
  // from JS emulation or from the iframe being the input target.
  assert.match(clientCssText, /#review\{height:calc\(100dvh - 88px\);overflow-y:auto;[^}]*-webkit-overflow-scrolling:touch\}/);
  assert.match(clientCssText, /#plan-frame\{width:100%;min-height:calc\(100dvh - 88px\);border:0;display:block;pointer-events:none\}/);
  assert.match(clientCssText, /#plan-touch-layer\{display:block;[^}]*touch-action:pan-y;pointer-events:auto\}/);
  // The old JS scroll-emulation must stay gone (it produced janky non-native scroll).
  assert.doesNotMatch(clientJsText, /touchScrollStart\.scrollY \+ touchScrollStart\.clientY - raw\.clientY/);
  assert.doesNotMatch(clientJsText, /frame\.contentWindow\.scrollBy/);

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
  const registerQuickOpenPlan = async (slug: string, title: string, planPath: string) => {
    const quickHtml = `<!doctype html><html><head><title>${title}</title></head><body><main><section id="${slug}"><h1>${title}</h1><p>Quick open target for ${slug}.</p></section></main></body></html>`;
    const response = await context.post('/api/plans/register', {
      data: {
        repoKey: `e2e-${slug}-repo`,
        repoName: `e2e-${slug}`,
        rootPath: `/tmp/e2e-${slug}`,
        branch: 'main',
        commitSha: `e2e-${slug}`,
        planPath,
        slug,
        html: quickHtml,
        fileHash: sha256(quickHtml),
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
  const installTouchListenerRecorder = async (page: import('playwright').Page) => {
    await page.addInitScript(() => {
      type TouchListenerRecord = { type: string; target: string; passive: boolean; capture: boolean; path: string };
      const records: TouchListenerRecord[] = [];
      (window as typeof window & { __touchListenerRecords?: TouchListenerRecord[] }).__touchListenerRecords = records;
      const originalAddEventListener = EventTarget.prototype.addEventListener;
      const describeTarget = (target: EventTarget) => {
        if (target === window) return 'window';
        if (target === document) return 'document';
        if (target instanceof HTMLIFrameElement && target.id) return `#${target.id}`;
        if (target instanceof HTMLElement) return target.id ? `#${target.id}` : target.tagName.toLowerCase();
        if (target instanceof Document) return 'document';
        return Object.prototype.toString.call(target);
      };
      EventTarget.prototype.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if (type === 'touchstart' || type === 'touchmove') {
          records.push({
            type,
            target: describeTarget(this),
            passive: typeof options === 'object' && options !== null && options.passive === true,
            capture: typeof options === 'boolean' ? options : Boolean(options?.capture),
            path: window.location.pathname
          });
        }
        return originalAddEventListener.call(this, type, listener, options);
      };
    });
  };
  const touchListenerRecords = async (page: import('playwright').Page) => {
    type TouchListenerRecord = { type: string; target: string; passive: boolean; capture: boolean; path: string };
    const readRecords = () => ((window as typeof window & { __touchListenerRecords?: TouchListenerRecord[] }).__touchListenerRecords ?? []);
    const parentRecords = await page.evaluate(readRecords);
    const frameRecords = await Promise.all(page.frames().filter(frame => frame !== page.mainFrame()).map(frame => frame.evaluate(readRecords).catch(() => [] as TouchListenerRecord[])));
    return parentRecords.concat(...frameRecords);
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const nativeHtmlV1 = '<!doctype html><html><head><title>Native Agent Comment E2E</title></head><body><main><section id="native-target"><h1>Native target</h1><p>Original native agent target text.</p></section></main></body></html>';
    const nativeRegistrationPayload = {
      repoKey: 'e2e-native-agent-repo',
      repoName: 'e2e-native-agent',
      rootPath: '/tmp/e2e-native-agent',
      branch: 'main',
      commitSha: 'e2e-native-agent-v1',
      planPath: 'thoughts/plans/native-agent.html',
      slug: 'native-agent',
      html: nativeHtmlV1,
      fileHash: sha256(nativeHtmlV1),
      publicationMetadata: { worktreePath: '/tmp/e2e-native-agent', branch: 'main', executionReady: false, executionReadyBasis: 'agent-review-results' },
      updateMode: 'upsert'
    };
    const nativeRegister = await context.post('/api/plans/register', { data: nativeRegistrationPayload });
    assert.equal(nativeRegister.ok(), true);
    const nativePlan = (await nativeRegister.json()).data as { planId: string; versionId: string };
    const nativeDetailBefore = await context.get(`/api/plans/${nativePlan.planId}`);
    assert.equal(nativeDetailBefore.ok(), true);
    const nativeTargets = (await nativeDetailBefore.json()).data.anchorTargets as Array<{ planNodeId: string; anchorCommand: string }>;
    assert.equal(nativeTargets.some(target => target.planNodeId === 'native-target' && /comments add/.test(target.anchorCommand)), true);
    const nativeComment = await context.post(`/api/plans/${nativePlan.planId}/comments/dom`, {
      data: {
        body: 'Native agent DOM annotation comment',
        target: { planNodeId: 'native-target' },
        createdBy: { type: 'agent', displayName: 'Codex E2E', agentId: 'codex-e2e' },
        clientMutationId: 'native-agent-e2e-1'
      }
    });
    assert.equal(nativeComment.ok(), true);
    const nativeDetailAfter = await context.get(`/api/plans/${nativePlan.planId}`);
    assert.equal(nativeDetailAfter.ok(), true);
    assert.equal((await nativeDetailAfter.json()).data.counts.pending, 1);
    const nativePage = await browser.newPage();
    await nativePage.goto(`${baseUrl}/p/${nativePlan.planId}`);
    await nativePage.click('#desktop-comments-toggle');
    await nativePage.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Native agent DOM annotation comment'));
    assert.match(await nativePage.locator('#comments').innerText(), /Codex E2E/);
    assert.match(await nativePage.locator('#comments').innerText(), /agent/);
    await nativePage.waitForFunction(() => (document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelectorAll('.comment-anchor').length ?? 0) === 1);
    await nativePage.close();
    const nativeHtmlV2 = nativeHtmlV1.replace('Original native agent target text.', 'Updated native agent target text.');
    const nativeReregister = await context.post('/api/plans/register', { data: { ...nativeRegistrationPayload, commitSha: 'e2e-native-agent-v2', html: nativeHtmlV2, fileHash: sha256(nativeHtmlV2) } });
    assert.equal(nativeReregister.ok(), true);
    const nativeCommentsAfterSync = await context.get(`/api/plans/${nativePlan.planId}/comments`);
    assert.equal(nativeCommentsAfterSync.ok(), true);
    assert.equal((await nativeCommentsAfterSync.json()).data.comments[0].anchorState, 'stale');
    assert.equal((await context.post(`/api/plans/${nativePlan.planId}/archive`)).ok(), true);

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
    await page.goto(`${baseUrl}/?view=all`);
    await page.waitForSelector('[data-attention-filter]');
    assert.equal(await page.locator('.plan-card').count(), 2);
    await page.fill('#q', 'e2e');
    await page.click('[data-attention-filter]');
    await page.waitForFunction(() => document.querySelectorAll('.plan-card:not([hidden])').length === 1);
    assert.match(await page.locator('.plan-card:not([hidden])').innerText(), /Source missing/);
    assert.match(await page.locator('.plan-card:not([hidden])').innerText(), /Showing cached copy/);
    const navSwitch = await registerTinyPlan('nav-switch');
    const quickTitlePlan = await registerQuickOpenPlan('quick-open-title-match', 'Queue-backed agent next comment delivery', 'thoughts/plans/queue-backed-agent-next.html');
    const quickPathPlan = await registerQuickOpenPlan('quick-open-path-only', 'Unrelated plan title', 'thoughts/plans/queue-agent-path-only.html');
    const linkedPlanHtml = `<!doctype html><html><body><main><section id="linked-plan-source"><h1>Linked plan source</h1><p><a id="linked-plan-link" href="${baseUrl}/p/${navSwitch.planId}">Open linked plan</a></p></section></main></body></html>`;
    const linkedPlanResponse = await context.post('/api/plans/register', {
      data: {
        repoKey: 'e2e-linked-plan-repo',
        repoName: 'e2e-linked-plan',
        rootPath: '/tmp/e2e-linked-plan',
        branch: 'main',
        commitSha: 'e2e-linked-plan',
        planPath: 'thoughts/plans/linked-plan.html',
        slug: 'linked-plan',
        html: linkedPlanHtml,
        fileHash: sha256(linkedPlanHtml),
        publicationMetadata: {
          worktreePath: '/tmp/e2e-linked-plan',
          branch: 'main',
          executionReady: false,
          executionReadyBasis: 'agent-review-results'
        },
        updateMode: 'upsert'
      }
    });
    assert.equal(linkedPlanResponse.ok(), true);
    const linkedPlan = (await linkedPlanResponse.json()).data as { planId: string; versionId: string };
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    assert.equal(await page.title(), 'E2E Plan · Plan Review');
    await page.waitForSelector('#plan-list-nav', { state: 'attached' });
    await page.waitForSelector('#desktop-plan-nav-toggle[aria-expanded="false"]');
    await page.waitForFunction(() => document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForSelector('#desktop-comments-toggle[aria-expanded="false"]');
    await page.waitForSelector('#download-raw-plan[aria-label="Download raw plan"]');
    await page.click('#desktop-plan-nav-toggle');
    await page.waitForSelector('#desktop-plan-nav-toggle[aria-expanded="true"]');
    await page.waitForFunction(() => !document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForSelector('#plan-list-nav .plan-nav-filters #project-filter-control');
    await page.waitForSelector('#plan-list-nav .plan-nav-filters #state-filter-control');
    await page.waitForSelector('#plan-list-nav .plan-nav-filters #status-filter-control');
    await page.waitForSelector('#current-plan-bar #current-plan-status-control');
    assert.equal(await page.locator('#plan-navbar-actions #project-filter-control').count(), 0);
    assert.equal(await page.locator('#plan-navbar-actions #state-filter-control').count(), 0);
    assert.equal(await page.locator('#plan-navbar-actions #status-filter-control').count(), 0);
    assert.equal(await page.locator('#desktop-plan-nav-toggle').getAttribute('aria-label'), 'Plan Navigator');
    assert.equal(await page.locator('#desktop-plan-nav-toggle').getAttribute('title'), 'Plan Navigator');
    assert.equal(await page.locator('#download-raw-plan').getAttribute('title'), 'Download raw plan HTML; ZIP includes required assets.');
    assert.equal(await page.locator('#download-raw-plan').getAttribute('href'), `/download/${registered.planId}?versionId=${registered.versionId}`);
    assert.equal(await page.locator('#current-plan-status-control').inputValue(), 'backlog');
    await page.selectOption('#current-plan-status-control', 'in_progress');
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('#current-plan-status-control')?.value === 'in_progress');
    const statusDetail = await context.get(`/api/plans/${registered.planId}`);
    assert.equal(statusDetail.ok(), true);
    assert.equal(((await statusDetail.json()).data as { plan: { boardColumnKey: string } }).plan.boardColumnKey, 'in_progress');
    await page.route(`**/api/plans/${registered.planId}/column`, async route => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'forced status failure' } }) });
    }, { times: 1 });
    await page.selectOption('#current-plan-status-control', 'ready_to_pull');
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('#current-plan-status-control')?.value === 'in_progress');
    await page.waitForSelector('#current-plan-status-error:not([hidden])');
    assert.match(await page.locator('#current-plan-status-error').innerText(), /Status was not changed|retry/i);
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame');
      if (!iframe?.contentDocument) return false;
      const contentHeight = iframe.contentDocument.documentElement.scrollHeight;
      return contentHeight > 0 && Math.abs(iframe.offsetHeight - contentHeight) <= 2;
    });
    const desktopScrollSurfaceBefore = await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      return {
        outerScrollable: document.documentElement.scrollHeight - document.documentElement.clientHeight > 200,
        frameSizedToContent: Math.abs(iframe.offsetHeight - iframe.contentDocument!.documentElement.scrollHeight) <= 2,
        frameInternalScrollY: iframe.contentWindow?.scrollY ?? 0
      };
    });
    assert.deepEqual(desktopScrollSurfaceBefore, { outerScrollable: true, frameSizedToContent: true, frameInternalScrollY: 0 });
    const desktopStickyColumnHeights = await page.evaluate(() => {
      const expected = window.innerHeight - 86;
      return {
        expected,
        planNavHeight: Math.round(document.querySelector<HTMLElement>('#plan-list-nav')!.getBoundingClientRect().height),
        sidebarHeight: Math.round(document.querySelector<HTMLElement>('#sidebar')!.getBoundingClientRect().height)
      };
    });
    assert.equal(Math.abs(desktopStickyColumnHeights.planNavHeight - desktopStickyColumnHeights.expected) <= 2, true);
    assert.equal(Math.abs(desktopStickyColumnHeights.sidebarHeight - desktopStickyColumnHeights.expected) <= 2, true);
    const desktopFrameBox = await page.locator('#plan-frame').boundingBox();
    assert.ok(desktopFrameBox);
    await page.mouse.move(desktopFrameBox.x + desktopFrameBox.width / 2, desktopFrameBox.y + 220);
    await page.mouse.wheel(0, 420);
    await page.waitForFunction(() => window.scrollY > 0);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY), 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollY === 0);
    const beforeNoOverlaySidebarToggle = await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      return iframe.contentDocument!.documentElement.scrollHeight;
    });
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => document.body.classList.contains('comments-open'));
    await page.waitForFunction(previousHeight => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame');
      if (!iframe?.contentDocument) return false;
      const contentHeight = iframe.contentDocument.documentElement.scrollHeight;
      return contentHeight > previousHeight && Math.abs(iframe.offsetHeight - contentHeight) <= 2;
    }, beforeNoOverlaySidebarToggle);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY), 0);
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('comments-open'));
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame');
      if (!iframe?.contentDocument) return false;
      return Math.abs(iframe.offsetHeight - iframe.contentDocument.documentElement.scrollHeight) <= 2;
    });
    const [rawPlanDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#download-raw-plan').click()
    ]);
    assert.match(rawPlanDownload.suggestedFilename(), /^e2e-\d{4}-\d{2}-\d{2}-\d{6}Z\.zip$/);
    const rawPlanDownloadPath = await rawPlanDownload.path();
    assert(rawPlanDownloadPath);
    const entries = unzipSync(fs.readFileSync(rawPlanDownloadPath));
    const entryNames = Object.keys(entries).sort();
    const zipRoot = entryNames[0].split('/')[0];
    const exportedHtml = strFromU8(entries[`${zipRoot}/${zipRoot}.html`]);
    assert.match(exportedHtml, /assets\/diagram-[a-f0-9]{8}\.png/);
    assert.doesNotMatch(exportedHtml, /plan-navbar|id="comments"|plan-frame/);
    assert.equal(await page.locator('#composer').isHidden(), true);
    assert.match(await page.locator('#plan-list-nav').textContent() ?? '', /E2E Plan/);
    await page.keyboard.press('Control+O');
    await page.waitForSelector('#quick-open-dialog:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'quick-open-input');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'quick-open-input');
    await page.fill('#quick-open-input', 'queue agent');
    await page.waitForSelector('[data-quick-open-result]');
    const quickOpenTitles = await page.locator('[data-quick-open-result] .quick-open-result-title').allInnerTexts();
    assert.equal(quickOpenTitles[0], 'Queue-backed agent next comment delivery');
    assert.equal(quickOpenTitles.includes('Unrelated plan title'), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('[data-quick-open-result][aria-selected="true"] .quick-open-result-title').innerText(), 'Unrelated plan title');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForURL(`${baseUrl}/p/${quickTitlePlan.planId}`);
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.keyboard.press('Control+O');
    await page.fill('#quick-open-input', 'path only');
    await page.locator('[data-quick-open-result]', { hasText: 'Unrelated plan title' }).click();
    await page.waitForURL(`${baseUrl}/p/${quickPathPlan.planId}`);
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.keyboard.press('Control+O');
    await page.fill('#quick-open-input', 'zzzz-no-active-plan-match');
    await page.waitForSelector('#quick-open-empty:not([hidden])');
    await page.keyboard.press('Enter');
    assert.equal(page.url(), `${baseUrl}/p/${registered.planId}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#quick-open-dialog', { state: 'hidden' });
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('#text-target')!;
      target.setAttribute('tabindex', '-1');
      target.focus();
    });
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')!.contentDocument!.activeElement?.id), 'text-target');
    await page.keyboard.press('Control+O');
    await page.waitForSelector('#quick-open-dialog:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#quick-open-dialog', { state: 'hidden' });
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')!.contentDocument!.activeElement?.id), 'text-target');
    await page.frameLocator('#plan-frame').locator('#dom-annotation').click();
    await page.waitForSelector('#composer:not([hidden])');
    await page.fill('#comment-body', 'Quick open preserves draft');
    await page.keyboard.press('Control+O');
    await page.waitForSelector('#quick-open-dialog:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#quick-open-dialog', { state: 'hidden' });
    assert.equal(await page.inputValue('#comment-body'), 'Quick open preserves draft');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'comment-body');
    await page.click('#cancel-comment');
    assert.equal(await page.evaluate(() => document.body.classList.contains('comments-open')), false);
    assert.equal(await page.evaluate(() => document.body.classList.contains('plan-nav-collapsed')), false);
    assert.equal(await page.evaluate(() => document.querySelector('#plan-navbar-actions')?.firstElementChild?.id), 'desktop-plan-nav-toggle');
    assert.equal(await page.evaluate(() => Math.round(document.querySelector<HTMLElement>('#sidebar')!.getBoundingClientRect().width) <= 60), true);
    assert.equal(await page.evaluate(() => Math.round(document.querySelector<HTMLElement>('#plan-list-nav')!.getBoundingClientRect().width) >= 250), true);
    assert.equal(await page.locator('#plan-list-nav').getAttribute('aria-hidden'), 'false');
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#plan-list-nav')!.inert), false);
    await page.click('#desktop-plan-nav-toggle');
    await page.waitForFunction(() => document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForFunction(() => Math.round(document.querySelector<HTMLElement>('#plan-list-nav')!.getBoundingClientRect().width) <= 1);
    assert.equal(await page.locator('#plan-list-nav').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#plan-list-nav')!.inert), true);
    const frameWidthWithNavCollapsed = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')!.getBoundingClientRect().width);
    await page.click('#desktop-plan-nav-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForFunction(() => Math.round(document.querySelector<HTMLElement>('#plan-list-nav')!.getBoundingClientRect().width) >= 250);
    assert.equal(await page.locator('#desktop-plan-nav-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#plan-list-nav').getAttribute('aria-hidden'), 'false');
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#plan-list-nav')!.inert), false);
    assert.equal(await page.evaluate(widthBefore => document.querySelector<HTMLIFrameElement>('#plan-frame')!.getBoundingClientRect().width < widthBefore - 200, frameWidthWithNavCollapsed), true);
    assert.match(await page.locator('#plan-list-nav [aria-current="page"]').innerText(), /E2E Plan/);
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => document.body.classList.contains('comments-open'));
    await page.waitForFunction(() => Math.round(document.querySelector<HTMLElement>('#sidebar')!.getBoundingClientRect().width) >= 300);
    assert.equal(await page.evaluate(() => document.body.classList.contains('plan-nav-collapsed')), false);
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('comments-open'));
    assert.equal(await page.evaluate(() => document.body.classList.contains('plan-nav-collapsed')), false);
    await page.click('#desktop-plan-nav-toggle');
    await page.waitForFunction(() => document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForFunction(() => Math.round(document.querySelector<HTMLElement>('#plan-list-nav')!.getBoundingClientRect().width) <= 1);
    assert.equal(await page.locator('#desktop-plan-nav-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#plan-list-nav').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('#plan-list-nav')!.inert), true);
    assert.equal(await page.evaluate(() => {
      const navLink = document.querySelector<HTMLElement>('#plan-list-nav a');
      navLink?.focus();
      return document.activeElement === navLink;
    }), false);
    await page.click('#desktop-plan-nav-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForFunction(() => Math.round(document.querySelector<HTMLElement>('#plan-list-nav')!.getBoundingClientRect().width) >= 250);
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => document.body.classList.contains('comments-open'));
    await page.waitForFunction(() => Math.round(document.querySelector<HTMLElement>('#sidebar')!.getBoundingClientRect().width) >= 300);
    assert.equal(await page.locator('#desktop-comments-toggle').getAttribute('aria-expanded'), 'true');
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('comments-open'));
    assert.equal(await page.locator('#state-filter-control').inputValue(), 'active');
    assert.notEqual(await page.locator('#project-filter-control').inputValue(), '');
    assert.equal(await page.locator(`#plan-list-nav a[data-plan-id="${navSwitch.planId}"]`).count(), 0);
    await page.selectOption('#project-filter-control', '');
    await page.waitForFunction(() => window.location.search.includes('projectKey=&lifecycle=active'));
    await page.waitForFunction(id => document.querySelector(`#plan-list-nav a[data-plan-id="${id}"]`)?.getAttribute('href')?.includes('projectKey=&lifecycle=active'), navSwitch.planId);
    await page.click(`#plan-list-nav a[data-plan-id="${navSwitch.planId}"]`);
    await page.waitForURL(`${baseUrl}/p/${navSwitch.planId}?projectKey=&lifecycle=active`);
    assert.equal(await page.evaluate(() => document.body.classList.contains('plan-nav-collapsed')), false);
    assert.equal(await page.locator('#desktop-plan-nav-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#state-filter-control').inputValue(), 'active');
    assert.equal(await page.locator('#project-filter-control').inputValue(), '');
    assert.equal(await page.locator('#plan-list-nav [aria-current="page"]').getAttribute('data-plan-id'), navSwitch.planId);
    await page.goto(`${baseUrl}/p/${linkedPlan.planId}`);
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#linked-plan-link'));
    const modifiedPlanLinkDefaultPrevented = await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const link = iframe.contentDocument!.querySelector<HTMLElement>('#linked-plan-link')!;
      let defaultPrevented = true;
      link.addEventListener('click', event => { defaultPrevented = event.defaultPrevented; }, { once: true });
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, view: iframe.contentWindow ?? window }));
      return defaultPrevented;
    });
    assert.equal(modifiedPlanLinkDefaultPrevented, false);
    assert.equal(page.url(), `${baseUrl}/p/${linkedPlan.planId}`);
    assert.equal(await page.locator('#state-filter-control').inputValue(), 'active');
    assert.equal(await page.locator('#project-filter-control').inputValue(), 'e2e-linked-plan');
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.getAttribute('src')), `/render/${linkedPlan.planId}`);
    await page.frameLocator('#plan-frame').locator('#linked-plan-link').click();
    await page.waitForURL(`${baseUrl}/p/${navSwitch.planId}`);
    assert.equal(await page.locator('#state-filter-control').inputValue(), 'active');
    assert.equal(await page.locator('#project-filter-control').inputValue(), 'e2e-nav-switch');
    assert.equal(await page.locator('#plan-navbar').count(), 1);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#plan-navbar'))), false);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.getAttribute('src')), `/render/${navSwitch.planId}`);
    assert.equal(await page.evaluate(() => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#nav-switch'))), true);
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    assert.equal((await context.post(`/api/plans/${navSwitch.planId}/archive`)).ok(), true);
    let planListRequests = 0;
    let failNextPlanList = true;
    await page.route('**/api/plans/navigator?*', async route => {
      planListRequests += 1;
      if (failNextPlanList) {
        failNextPlanList = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'forced navigator failure' } }) });
        return;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#plan-list-error')?.hidden === false);
    assert.match(await page.locator('#plan-list-error').textContent() ?? '', /current plan remains reviewable/i);
    assert.equal(await page.locator('#plan-frame').count(), 1);
    await page.keyboard.press('Control+O');
    await page.waitForSelector('#quick-open-dialog:not([hidden])');
    await page.waitForSelector('#quick-open-error', { state: 'hidden' });
    await page.fill('#quick-open-input', 'E2E Plan');
    await page.waitForFunction(() => document.querySelector('#quick-open-results')?.textContent?.includes('E2E Plan'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#quick-open-dialog', { state: 'hidden' });
    if (await page.evaluate(() => document.body.classList.contains('plan-nav-collapsed'))) {
      await page.click('#desktop-plan-nav-toggle');
      await page.waitForFunction(() => !document.body.classList.contains('plan-nav-collapsed'));
    }
    await page.click('#plan-list-retry');
    await page.waitForSelector('#plan-list-error', { state: 'hidden' });
    assert.match(await page.locator('#plan-list-nav').textContent() ?? '', /E2E Plan/);
    await page.waitForTimeout(500);
    assert.equal(planListRequests <= 3, true, `navigator refresh made too many requests: ${planListRequests}`);
    await page.unroute('**/api/plans/navigator?*');
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
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const doc = iframe.contentDocument!;
      const wrapper = doc.querySelector<HTMLElement>('.plan-mermaid-rendered')!;
      const rect = doc.querySelector<SVGElement>('.plan-mermaid-rendered svg .node rect, .plan-mermaid-rendered svg rect')!;
      const wrapperStyle = doc.defaultView!.getComputedStyle(wrapper);
      return {
        styleCount: doc.querySelectorAll('.plan-mermaid-rendered svg style').length,
        rectFill: doc.defaultView!.getComputedStyle(rect).fill,
        wrapperBackground: wrapperStyle.backgroundImage,
        wrapperBorderColor: wrapperStyle.borderTopColor,
        wrapperBorderRadius: wrapperStyle.borderTopLeftRadius,
        shellBorderColor: getComputedStyle(document.querySelector<HTMLElement>('#sidebar')!).borderLeftColor
      };
    });
    assert.equal(mermaidVisual.styleCount > 0, true);
    assert.notEqual(mermaidVisual.rectFill, 'rgb(0, 0, 0)');
    assert.match(mermaidVisual.wrapperBackground, /rgba?\(17, 24, 39(?:, 0\.96)?\).*rgba?\(15, 23, 42(?:, 0\.96)?\)/);
    assert.equal(mermaidVisual.wrapperBorderColor, mermaidVisual.shellBorderColor);
    assert.equal(mermaidVisual.wrapperBorderRadius, '16px');
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
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      iframe.contentWindow?.history.replaceState(null, '', iframe.contentWindow.location.pathname);
    });
    await page.frameLocator('#plan-frame').locator('#plan-test-link').click();
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.location.hash === '#link-target');
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('#link-target')!;
      const navbarHeight = document.querySelector<HTMLElement>('#plan-navbar')!.getBoundingClientRect().height;
      return window.scrollY > 0
        && iframe.contentWindow?.scrollY === 0
        && Math.abs(target.getBoundingClientRect().top + iframe.getBoundingClientRect().top - navbarHeight) <= 2;
    });
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
    if (await page.evaluate(() => document.body.classList.contains('plan-nav-collapsed'))) {
      await page.click('#desktop-plan-nav-toggle');
      await page.waitForFunction(() => !document.body.classList.contains('plan-nav-collapsed'));
    }
    const frameWidthBeforePlanNavCollapse = await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')!.getBoundingClientRect().width);
    await page.click('#desktop-plan-nav-toggle');
    await page.waitForFunction(() => document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForFunction(widthBefore => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const box = document.querySelector<HTMLElement>('#active-selection-box')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('#dom-annotation')!;
      const frameRect = iframe.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return !box.hidden
        && iframe.getBoundingClientRect().width > widthBefore
        && Math.abs(boxRect.left - (frameRect.left + targetRect.left)) <= 1
        && Math.abs(boxRect.top - (frameRect.top + targetRect.top)) <= 1
        && Math.abs(boxRect.width - targetRect.width) <= 1
        && Math.abs(boxRect.height - targetRect.height) <= 1;
    }, frameWidthBeforePlanNavCollapse);
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => document.body.classList.contains('comments-open') && document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const box = document.querySelector<HTMLElement>('#active-selection-box')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('#dom-annotation')!;
      const frameRect = iframe.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return !box.hidden
        && Math.abs(boxRect.left - (frameRect.left + targetRect.left)) <= 1
        && Math.abs(boxRect.top - (frameRect.top + targetRect.top)) <= 1
        && Math.abs(boxRect.width - targetRect.width) <= 1
        && Math.abs(boxRect.height - targetRect.height) <= 1;
    });
    await page.click('#desktop-comments-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('comments-open'));
    await page.click('#desktop-plan-nav-toggle');
    await page.waitForFunction(() => !document.body.classList.contains('plan-nav-collapsed'));
    await page.waitForFunction(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const box = document.querySelector<HTMLElement>('#active-selection-box')!;
      const target = iframe.contentDocument!.querySelector<HTMLElement>('#dom-annotation')!;
      const frameRect = iframe.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return !box.hidden
        && Math.abs(boxRect.left - (frameRect.left + targetRect.left)) <= 1
        && Math.abs(boxRect.top - (frameRect.top + targetRect.top)) <= 1
        && Math.abs(boxRect.width - targetRect.width) <= 1
        && Math.abs(boxRect.height - targetRect.height) <= 1;
    });
    await page.evaluate(() => window.scrollTo(0, 120));
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
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY), 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.focus('#comment-body');
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
    const markerTopBeforeScroll = await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      const anchor = iframe.contentDocument?.querySelector('.comment-anchor');
      return iframe.getBoundingClientRect().top + (anchor?.getBoundingClientRect().top ?? 0);
    });
    await page.evaluate(() => window.scrollTo(0, 120));
    await page.waitForFunction(
      before => {
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        const anchor = iframe.contentDocument?.querySelector('.comment-anchor');
        return Math.abs((iframe.getBoundingClientRect().top + (anchor?.getBoundingClientRect().top ?? 0)) - before) > 20;
      },
      markerTopBeforeScroll
    );
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY), 0);
    await page.evaluate(() => window.scrollTo(0, 0));

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

    // Acknowledged fixture: create → claim → ack. resolveComment throws on a claimed
    // comment, so acknowledged status requires the explicit claim→ack chain.
    const acknowledgedComment = await context.post(`/api/plans/${registered.planId}/comments`, {
      data: {
        versionId: registered.versionId,
        body: 'Acknowledged DOM annotation green marker',
        anchorType: 'dom',
        anchor: { planNodeId: 'link-annotation', cssSelector: '#link-comment-target', textPreview: 'Commentable text before', rect: { x: 0, y: 0, width: 20, height: 20 } }
      }
    });
    assert.equal(acknowledgedComment.ok(), true);
    const acknowledged = (await acknowledgedComment.json()).data.comment as { id: string };
    const acknowledgedClaim = await context.post(`/api/plans/${registered.planId}/comments/claim`, { data: { mode: 'selected', commentIds: [acknowledged.id] } });
    assert.equal(acknowledgedClaim.ok(), true);
    const acknowledgedClaimId = (await acknowledgedClaim.json()).data.claimed[0].claim.id;
    const acknowledgedAck = await context.post(`/api/comments/${acknowledged.id}/ack`, {
      data: { claimId: acknowledgedClaimId }
    });
    assert.equal(acknowledgedAck.ok(), true);
    await page.waitForFunction(() => document.querySelector('#comments')?.textContent?.includes('Acknowledged DOM annotation green marker'));

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
      window.scrollTo(0, 120);
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
    assert.equal(await page.evaluate(() => window.scrollY), 120);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY), 0);
    await page.waitForFunction(
      commentId => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector(`.comment-anchor.resolved[data-comment-id="${commentId}"]`)),
      resolvedFallback.comment.id
    );
    await page.waitForFunction(commentId => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
      const anchor = doc?.querySelector<HTMLElement>(`.comment-anchor.resolved[data-comment-id="${commentId}"]`);
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
      const anchor = doc?.querySelector<HTMLElement>(`.comment-anchor.resolved[data-comment-id="${commentId}"]`);
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

    // Acknowledged marker renders the green class (BDD-ack).
    // The anchor can be cleared during marker reflow; retry until it is present.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const found = await page.evaluate(commentId => {
        const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
        const anchor = doc?.querySelector(`.comment-anchor.acknowledged[data-comment-id="${commentId}"]`);
        return anchor ? getComputedStyle(anchor).borderStyle : null;
      }, acknowledged.id);
      if (found) { assert.equal(found, 'dotted'); break; }
      if (attempt === 29) assert.fail('acknowledged anchor never appeared');
      await page.waitForTimeout(500);
    }

    // Counterexample: a claimed comment must not render as pending (BDD-counterexample).
    // Create a fresh claimed comment here (claims can expire mid-test and revert older
    // claimed comments to pending) so the counterexample sees a guaranteed claimed state.
    const counterClaimedComment = await context.post(`/api/plans/${registered.planId}/comments`, {
      data: {
        versionId: registered.versionId,
        body: 'Counterexample claimed marker not pending',
        anchorType: 'dom',
        anchor: { planNodeId: 'link-comment-target', cssSelector: '#link-comment-target', textPreview: 'Commentable text before', rect: { x: 0, y: 0, width: 20, height: 20 } }
      }
    });
    assert.equal(counterClaimedComment.ok(), true);
    const counterClaimed = (await counterClaimedComment.json()).data.comment as { id: string };
    const counterClaim = await context.post(`/api/plans/${registered.planId}/comments/claim`, { data: { mode: 'selected', commentIds: [counterClaimed.id] } });
    assert.equal(counterClaim.ok(), true);
    await page.waitForTimeout(100);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const isClaimed = await page.evaluate(commentId => {
        const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
        return Boolean(doc?.querySelector(`.comment-anchor.claimed[data-comment-id="${commentId}"]`));
      }, counterClaimed.id);
      if (isClaimed) break;
      if (attempt === 29) assert.fail('claimed anchor never appeared');
      await page.waitForTimeout(500);
    }
    assert.equal(await page.evaluate(commentId => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
      return Boolean(doc?.querySelector(`.comment-anchor.pending[data-comment-id="${commentId}"]`));
    }, counterClaimed.id), false);
    assert.equal(await page.evaluate(commentId => {
      const doc = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument;
      return Boolean(doc?.querySelector(`.comment-anchor.claimed[data-comment-id="${commentId}"]`));
    }, counterClaimed.id), true);

    // Top-of-plan status banner: with pending + claimed + acknowledged + resolved comments
    // present, an agent is working comments, so the banner is Yellow (BDD-banner-yellow).
    let yellowBanner: { cls: string; text: string | null } | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      yellowBanner = await page.evaluate(() => {
        const banner = document.querySelector<HTMLElement>('#comment-status-banner');
        return banner && !banner.hidden && banner.classList.contains('yellow')
          ? { cls: banner.className, text: banner.textContent }
          : null;
      });
      if (yellowBanner) break;
      if (attempt === 29) assert.fail('yellow banner never appeared');
      await page.waitForTimeout(500);
    }
    assert.ok(yellowBanner);
    assert.match(yellowBanner!.cls, /yellow/);
    assert.match(yellowBanner!.text!, /Agent working/);

    // Banner Red/Green/live-transition coverage (AC9, AC11, AC12) on an isolated plan
    // so the main scenario's comment state is not disturbed.
    const bannerHtml = '<!doctype html><html><head><title>Banner Plan</title></head><body><main><section id="banner-target"><h1>Banner target</h1><p id="banner-text">Banner scenario text.</p></section></main></body></html>';
    const bannerRegister = await context.post('/api/plans/register', {
      data: {
        repoName: 'e2e-repo', branch: 'banner-branch', commitSha: 'banner-commit',
        planPath: 'thoughts/plans/banner-plan.html', html: bannerHtml, fileHash: sha256(bannerHtml),
        publicationMetadata: { worktreePath: process.cwd(), branch: 'banner-branch', executionReady: false, executionReadyBasis: 'agent-review-results' }
      }
    });
    const bannerPlan = (await bannerRegister.json()).data as { planId: string; versionId: string };
    const bannerPage = await browser.newPage();
    await bannerPage.goto(`${baseUrl}/p/${bannerPlan.planId}`);
    await bannerPage.waitForFunction(() => Boolean(document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#banner-target')));
    const waitForBannerState = async (pg: typeof page, state: string, timeoutMs = 10000) => {
      for (let attempt = 0; attempt < Math.ceil(timeoutMs / 500); attempt += 1) {
        const ok = await pg.evaluate(st => {
          const b = document.querySelector<HTMLElement>('#comment-status-banner');
          return Boolean(b && !b.hidden && b.classList.contains(st));
        }, state);
        if (ok) return true;
        await pg.waitForTimeout(500);
      }
      return false;
    };

    // Green: no comments yet (empty plan).
    assert.ok(await waitForBannerState(bannerPage, 'green'));
    assert.match(String(await bannerPage.evaluate(() => document.querySelector<HTMLElement>('#comment-status-banner')!.textContent)), /No comments/);

    // Red: a single pending comment, none claimed/acknowledged.
    const bannerPending = await context.post(`/api/plans/${bannerPlan.planId}/comments`, {
      data: { versionId: bannerPlan.versionId, body: 'Banner pending only', anchorType: 'dom', anchor: { planNodeId: 'banner-target', cssSelector: '#banner-target', textPreview: 'Banner target', rect: { x: 0, y: 0, width: 20, height: 20 } } }
    });
    const bannerPendingComment = (await bannerPending.json()).data.comment as { id: string };
    assert.ok(await waitForBannerState(bannerPage, 'red'));
    assert.match(String(await bannerPage.evaluate(() => document.querySelector<HTMLElement>('#comment-status-banner')!.textContent)), /1 pending/);

    // Live transition Red -> Yellow: claim the pending comment.
    const bannerClaim = await context.post(`/api/plans/${bannerPlan.planId}/comments/claim`, { data: { mode: 'selected', commentIds: [bannerPendingComment.id] } });
    assert.equal(bannerClaim.ok(), true);
    assert.ok(await waitForBannerState(bannerPage, 'yellow'));

    // Live transition Yellow -> Green: ack then resolve the comment.
    const bannerClaimId = (await bannerClaim.json()).data.claimed[0].claim.id;
    await context.post(`/api/comments/${bannerPendingComment.id}/ack`, { data: { claimId: bannerClaimId } });
    await context.post(`/api/comments/${bannerPendingComment.id}/resolve`, { data: { resolutionNote: 'Banner resolved' } });
    assert.ok(await waitForBannerState(bannerPage, 'green'));
    assert.match(String(await bannerPage.evaluate(() => document.querySelector<HTMLElement>('#comment-status-banner')!.textContent)), /All resolved/);
    await bannerPage.close();
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

    const configuredMobileDefault = await context.put('/api/configuration', {
      data: {
        showPlanNavigatorByDefault: false,
        showCommentsByDefault: true,
        executionReadySkillName: 'plan-reviewer-execution-ready',
        buildPlanSkillName: 'plan-reviewer-build',
        kanbanEnabled: true
      }
    });
    assert.equal(configuredMobileDefault.ok(), true);
    const touchContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 486, height: 902 } });
    try {
      const touchPage = await touchContext.newPage();
      await installTouchListenerRecorder(touchPage);
      await touchPage.goto(`${baseUrl}/p/${registered.planId}`);
      await touchPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#plan-test-link'));
      await touchPage.waitForFunction(() => !document.body.classList.contains('comments-open'));
      assert.equal(await touchPage.locator('#mobile-comments-toggle').getAttribute('aria-expanded'), 'false');
      await touchPage.waitForFunction(() => {
        const sidebar = document.querySelector<HTMLElement>('#sidebar');
        return Boolean(sidebar && sidebar.getBoundingClientRect().top >= window.innerHeight - 1);
      });
      // Mobile native scroll requires the iframe to be laid out at its full
      // content height inside the scrollable #review container.
      await touchPage.waitForFunction(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#plan-frame');
        const review = document.querySelector<HTMLElement>('#review');
        if (!frame || !review || !frame.contentDocument) return false;
        const content = frame.contentDocument.documentElement.scrollHeight;
        return content > 0 && Math.abs(frame.offsetHeight - content) <= 2 && review.scrollHeight - review.clientHeight > 200;
      }, undefined, { timeout: 3000 });
      const frameBox = await touchPage.locator('#plan-frame').boundingBox();
      assert.ok(frameBox);
      const mobileSurface = await touchPage.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        const layer = document.querySelector<HTMLElement>('#plan-touch-layer')!;
        const review = document.querySelector<HTMLElement>('#review')!;
        const rect = frame.getBoundingClientRect();
        // The element under a tap point must be the parent overlay, never the
        // iframe: iOS Safari does not deliver iframe touches to parent listeners,
        // so the overlay is the only reliable tap surface across engines.
        const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(240, rect.height / 2));
        return {
          framePointerEvents: getComputedStyle(frame).pointerEvents,
          layerDisplay: getComputedStyle(layer).display,
          layerPointerEvents: getComputedStyle(layer).pointerEvents,
          layerTouchAction: getComputedStyle(layer).touchAction,
          reviewOverflowY: getComputedStyle(review).overflowY,
          reviewOverscrollBehaviorY: getComputedStyle(review).overscrollBehaviorY,
          reviewScrollable: review.scrollHeight - review.clientHeight > 200,
          topElementId: (topElement as HTMLElement | null)?.id ?? ''
        };
      });
      const records = await touchListenerRecords(touchPage);
      const nonPassiveScrollPathTouchListeners = records.filter(record =>
        (record.type === 'touchstart' || record.type === 'touchmove')
        && (record.target === '#plan-touch-layer' || record.target === '#plan-frame' || record.target === 'document')
        && !record.passive
      );
      assert.deepEqual(nonPassiveScrollPathTouchListeners, [], `non-passive scroll-path touch listeners: ${JSON.stringify(nonPassiveScrollPathTouchListeners)}`);
      const { reviewOverscrollBehaviorY, ...mobileSurfaceContract } = mobileSurface;
      assert.equal(reviewOverscrollBehaviorY, 'contain');
      assert.deepEqual(mobileSurfaceContract, {
        framePointerEvents: 'none',
        layerDisplay: 'block',
        layerPointerEvents: 'auto',
        layerTouchAction: 'pan-y',
        reviewOverflowY: 'auto',
        reviewScrollable: true,
        topElementId: 'plan-touch-layer'
      });
      // A real finger drag must scroll #review natively (momentum scroll), NOT
      // the iframe's internal scroll and NOT JS emulation, and must NOT open the
      // composer. Use trusted CDP touch events — mouse.wheel is unsupported in
      // mobile WebKit and would be a false-green.
      const cdp = await touchContext.newCDPSession(touchPage);
      const trustedTap = async (x: number, y: number) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await touchPage.waitForTimeout(40);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      // Wait for any momentum/fling scroll to settle, then pin #review to the top
      // so freshly measured tap targets do not drift out from under the touch.
      const settleScrollTop = async () => {
        await touchPage.evaluate(() => document.querySelector<HTMLElement>('#review')!.scrollTo(0, 0));
        await touchPage.waitForFunction(() => {
          const review = document.querySelector<HTMLElement>('#review')!;
          if (review.scrollTop !== 0) { review.scrollTo(0, 0); return false; }
          return true;
        }, undefined, { timeout: 3000 });
      };
      await settleScrollTop();
      await touchPage.evaluate(() => document.querySelector<HTMLIFrameElement>('#plan-frame')!.contentWindow?.scrollTo(0, 0));
      const dragX = frameBox.x + frameBox.width / 2;
      const dragStartY = frameBox.y + Math.min(560, Math.max(200, frameBox.height - 80));
      const dragEndY = frameBox.y + 120;
      const dragTouch = async (startY: number, endY: number) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: dragX, y: startY }] });
        const dragSteps = 14;
        for (let step = 1; step <= dragSteps; step += 1) {
          const y = startY + ((endY - startY) * step) / dragSteps;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: dragX, y }] });
          await touchPage.waitForTimeout(10);
        }
        // Hold the finger still before lifting so the gesture ends with ~zero
        // velocity (no fling), keeping the assertion deterministic.
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: dragX, y: endY }] });
        await touchPage.waitForTimeout(140);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      await dragTouch(dragStartY, dragEndY);
      await touchPage.waitForFunction(() => (document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0) > 0, undefined, { timeout: 3000 });
      const mobileDragState = await touchPage.evaluate(() => ({
        reviewScrollTop: document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0,
        frameInternalScrollY: document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY ?? 0,
        composerOpen: document.querySelector<HTMLElement>('#composer')?.hidden === false
      }));
      assert.equal(mobileDragState.reviewScrollTop > 0, true);
      assert.equal(mobileDragState.frameInternalScrollY, 0);
      assert.equal(mobileDragState.composerOpen, false);
      const reverseUpStart = mobileDragState.reviewScrollTop;
      await dragTouch(frameBox.y + 160, frameBox.y + 520);
      await touchPage.waitForFunction(start => (document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0) < Number(start) - 20, reverseUpStart, { timeout: 3000 });
      const reverseUpState = await touchPage.evaluate(() => ({
        reviewScrollTop: document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0,
        frameInternalScrollY: document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY ?? 0,
        windowScrollY: window.scrollY,
        composerOpen: document.querySelector<HTMLElement>('#composer')?.hidden === false
      }));
      assert.equal(reverseUpState.frameInternalScrollY, 0);
      assert.equal(reverseUpState.windowScrollY, 0);
      assert.equal(reverseUpState.composerOpen, false);
      await dragTouch(frameBox.y + 520, frameBox.y + 160);
      await touchPage.waitForFunction(start => (document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0) > Number(start) + 20, reverseUpState.reviewScrollTop, { timeout: 3000 });
      const reverseDownState = await touchPage.evaluate(() => ({
        reviewScrollTop: document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0,
        frameInternalScrollY: document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY ?? 0,
        windowScrollY: window.scrollY,
        composerOpen: document.querySelector<HTMLElement>('#composer')?.hidden === false
      }));
      assert.equal(reverseDownState.frameInternalScrollY, 0);
      assert.equal(reverseDownState.windowScrollY, 0);
      assert.equal(reverseDownState.composerOpen, false);
      await settleScrollTop();
      // A real tap on an in-plan link navigates the iframe, translates the
      // fragment target to #review scroll even after prior parent scrolling, and
      // does NOT comment.
      await touchPage.evaluate(() => document.querySelector<HTMLElement>('#review')!.scrollTo(0, 80));
      await touchPage.waitForFunction(() => document.querySelector<HTMLElement>('#review')!.scrollTop >= 80, undefined, { timeout: 3000 });
      const linkBox = await touchPage.frameLocator('#plan-frame').locator('#plan-test-link').boundingBox();
      assert.ok(linkBox);
      await trustedTap(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
      await touchPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.location.hash === '#link-target', undefined, { timeout: 3000 });
      await touchPage.waitForFunction(() => {
        const review = document.querySelector<HTMLElement>('#review')!;
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        const target = iframe.contentDocument!.querySelector<HTMLElement>('#link-target')!;
        return review.scrollTop > 80
          && iframe.contentWindow?.scrollY === 0
          && Math.abs(iframe.getBoundingClientRect().top + target.getBoundingClientRect().top - review.getBoundingClientRect().top) <= 2;
      }, undefined, { timeout: 3000 });
      await touchPage.waitForTimeout(180);
      assert.equal(await touchPage.evaluate(() => document.querySelector<HTMLElement>('#composer')?.hidden), true);
      await touchPage.evaluate(() => {
        const review = document.querySelector<HTMLElement>('#review')!;
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        const link = iframe.contentDocument!.querySelector<HTMLElement>('#empty-fragment-link')!;
        review.scrollTo(0, review.scrollTop + iframe.getBoundingClientRect().top - review.getBoundingClientRect().top + link.getBoundingClientRect().top - 120);
      });
      await touchPage.waitForFunction(() => {
        const review = document.querySelector<HTMLElement>('#review')!;
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        const link = iframe.contentDocument!.querySelector<HTMLElement>('#empty-fragment-link')!;
        const top = iframe.getBoundingClientRect().top + link.getBoundingClientRect().top;
        const reviewRect = review.getBoundingClientRect();
        return top > reviewRect.top + 40 && top < reviewRect.bottom - 40;
      }, undefined, { timeout: 3000 });
      const emptyFragmentBox = await touchPage.frameLocator('#plan-frame').locator('#empty-fragment-link').boundingBox();
      assert.ok(emptyFragmentBox);
      await trustedTap(emptyFragmentBox.x + emptyFragmentBox.width / 2, emptyFragmentBox.y + emptyFragmentBox.height / 2);
      await touchPage.waitForFunction(() => {
        const review = document.querySelector<HTMLElement>('#review')!;
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        return review.scrollTop === 0 && iframe.contentWindow?.scrollY === 0 && iframe.contentWindow.location.hash === '';
      }, undefined, { timeout: 3000 });
      assert.equal(await touchPage.evaluate(() => document.querySelector<HTMLElement>('#composer')?.hidden), true);
      await touchPage.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        iframe.contentWindow?.history.replaceState(null, '', iframe.contentWindow.location.pathname);
      });
      await settleScrollTop();
      // A real tap on plain plan text opens the composer anchored to that element.
      const adjacentBox = await touchPage.frameLocator('#plan-frame').locator('#link-adjacent-text').boundingBox();
      assert.ok(adjacentBox);
      await trustedTap(adjacentBox.x + adjacentBox.width / 2, adjacentBox.y + adjacentBox.height / 2);
      await touchPage.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false, undefined, { timeout: 3000 });
      const mobileTapState = await touchPage.evaluate(() => {
        const activeBox = document.querySelector<HTMLElement>('#active-selection-box')!;
        const target = document.querySelector<HTMLIFrameElement>('#plan-frame')!.contentDocument!.querySelector<HTMLElement>('#link-adjacent-text')!;
        const frameRect = document.querySelector<HTMLIFrameElement>('#plan-frame')!.getBoundingClientRect();
        const activeRect = activeBox.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        return {
          composerOpen: document.querySelector<HTMLElement>('#composer')?.hidden === false,
          activeSelectionVisible: !activeBox.hidden,
          leftDelta: Math.abs(activeRect.left - (frameRect.left + targetRect.left)),
          topDelta: Math.abs(activeRect.top - (frameRect.top + targetRect.top)),
          widthDelta: Math.abs(activeRect.width - targetRect.width),
          heightDelta: Math.abs(activeRect.height - targetRect.height)
        };
      });
      assert.equal(mobileTapState.composerOpen, true);
      assert.equal(mobileTapState.activeSelectionVisible, true);
      assert.equal(mobileTapState.leftDelta <= 1, true);
      assert.equal(mobileTapState.topDelta <= 1, true);
      assert.equal(mobileTapState.widthDelta <= 1, true);
      assert.equal(mobileTapState.heightDelta <= 1, true);
    } finally {
      await touchContext.close();
      const resetMobileDefault = await context.put('/api/configuration', {
        data: {
          showPlanNavigatorByDefault: false,
          showCommentsByDefault: false,
          executionReadySkillName: 'plan-reviewer-execution-ready',
          buildPlanSkillName: 'plan-reviewer-build',
          kanbanEnabled: true
        }
      });
      assert.equal(resetMobileDefault.ok(), true);
    }

    // iPad / phone landscape regression: the viewport is wider than 760px but the
    // pointer is coarse, so the CSS mobile layout (overlay + #review native scroll)
    // is active. The iframe must still be sized to its full content height so the
    // lower plan content is reachable — keying the JS off width alone left it
    // unsized and the bottom of the plan unscrollable.
    const tabletContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1194, height: 834 } });
    try {
      const tabletPage = await tabletContext.newPage();
      await tabletPage.goto(`${baseUrl}/p/${registered.planId}`);
      await tabletPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#plan-test-link'));
      await tabletPage.waitForFunction(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#plan-frame');
        const review = document.querySelector<HTMLElement>('#review');
        if (!frame || !review || !frame.contentDocument) return false;
        const content = frame.contentDocument.documentElement.scrollHeight;
        return content > 0 && Math.abs(frame.offsetHeight - content) <= 2 && review.scrollHeight - review.clientHeight > 200;
      }, undefined, { timeout: 3000 });
      const tabletSurface = await tabletPage.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
        const review = document.querySelector<HTMLElement>('#review')!;
        return {
          wideViewport: window.innerWidth > 760,
          coarsePointer: window.matchMedia('(pointer: coarse)').matches,
          mobileLayoutActive: getComputedStyle(document.querySelector<HTMLElement>('#plan-touch-layer')!).display === 'block',
          frameSizedToContent: Math.abs(frame.offsetHeight - frame.contentDocument!.documentElement.scrollHeight) <= 2,
          reviewScrollable: review.scrollHeight - review.clientHeight > 200
        };
      });
      assert.deepEqual(tabletSurface, {
        wideViewport: true,
        coarsePointer: true,
        mobileLayoutActive: true,
        frameSizedToContent: true,
        reviewScrollable: true
      });
      // A real finger drag must scroll the full content (reach the bottom region).
      const tabletCdp = await tabletContext.newCDPSession(tabletPage);
      await tabletPage.evaluate(() => document.querySelector<HTMLElement>('#review')!.scrollTo(0, 0));
      const tabletFrameBox = await tabletPage.locator('#plan-frame').boundingBox();
      assert.ok(tabletFrameBox);
      const tx = tabletFrameBox.x + tabletFrameBox.width / 2;
      const tStartY = tabletFrameBox.y + Math.min(560, Math.max(200, tabletFrameBox.height - 80));
      const tEndY = tabletFrameBox.y + 100;
      await tabletCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: tStartY }] });
      for (let step = 1; step <= 14; step += 1) {
        await tabletCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx, y: tStartY + ((tEndY - tStartY) * step) / 14 }] });
        await tabletPage.waitForTimeout(10);
      }
      await tabletCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx, y: tEndY }] });
      await tabletPage.waitForTimeout(140);
      await tabletCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await tabletPage.waitForFunction(() => (document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0) > 0, undefined, { timeout: 3000 });
      const tabletScroll = await tabletPage.evaluate(() => ({
        reviewScrollTop: document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0,
        frameInternalScrollY: document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY ?? 0
      }));
      assert.equal(tabletScroll.reviewScrollTop > 0, true);
      assert.equal(tabletScroll.frameInternalScrollY, 0);
      // Trackpad / wheel scroll must use the browser's NATIVE wheel scrolling so
      // iPadOS momentum (inertial gliding) is preserved. The app must therefore
      // NOT preventDefault the wheel and hand-roll scrollBy — that opts out of the
      // native scroller and makes trackpad scrolling stop abruptly. Assert the
      // wheel still scrolls #review (not the iframe) and is left un-cancelled.
      await tabletPage.evaluate(() => {
        (window as typeof window & { __wheelDefaultPrevented?: boolean | null }).__wheelDefaultPrevented = null;
        // Bubble-phase window listener runs after any app wheel handler, so it
        // observes whether the app cancelled the event.
        window.addEventListener('wheel', event => {
          (window as typeof window & { __wheelDefaultPrevented?: boolean | null }).__wheelDefaultPrevented = event.defaultPrevented;
        }, { once: true });
        document.querySelector<HTMLElement>('#review')!.scrollTo(0, 0);
      });
      await tabletPage.mouse.move(tabletFrameBox.x + tabletFrameBox.width / 2, tabletFrameBox.y + 200);
      await tabletPage.mouse.wheel(0, 320);
      await tabletPage.waitForFunction(() => (document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0) > 0, undefined, { timeout: 3000 });
      const tabletWheel = await tabletPage.evaluate(() => ({
        reviewScrollTop: document.querySelector<HTMLElement>('#review')?.scrollTop ?? 0,
        frameInternalScrollY: document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentWindow?.scrollY ?? 0,
        wheelDefaultPrevented: (window as typeof window & { __wheelDefaultPrevented?: boolean | null }).__wheelDefaultPrevented
      }));
      assert.equal(tabletWheel.reviewScrollTop > 0, true);
      assert.equal(tabletWheel.frameInternalScrollY, 0);
      assert.equal(tabletWheel.wheelDefaultPrevented, false);
    } finally {
      await tabletContext.close();
    }

    const mobilePlanNote = await context.post(`/api/plans/${registered.planId}/notes`, { data: { body: 'Mobile plan note remains visible.' } });
    assert.equal(mobilePlanNote.ok(), true);
    await page.setViewportSize({ width: 486, height: 902 });
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#text-target'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('#desktop-plan-nav-toggle')!).display), 'none');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('#plan-list-nav')!).display), 'none');
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

    const archiveDialogs: string[] = [];
    page.on('dialog', async dialog => {
      archiveDialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const waitForArchivedToolbarStatus = async () => {
      await page.waitForFunction(() => {
        const status = document.querySelector<HTMLElement>('#archive-status');
        return status?.hidden === false
          && status.textContent === '🗄'
          && status.getAttribute('role') === 'status'
          && status.getAttribute('aria-label') === 'Archived'
          && status.getAttribute('title') === 'Archived';
      });
    };
    const assertArchivedToolbarStatus = async () => {
      await waitForArchivedToolbarStatus();
      const status = page.locator('#archive-status');
      assert.equal(await status.textContent(), '🗄');
      assert.equal(await status.getAttribute('role'), 'status');
      assert.equal(await status.getAttribute('aria-label'), 'Archived');
      assert.equal(await status.getAttribute('title'), 'Archived');
    };

    await page.goto(`${baseUrl}/?view=all`);
    await page.route(`**/api/plans/${registered.planId}/archive`, route => route.abort('failed'));
    await page.click(`[data-archive-plan="${registered.planId}"]`);
    await page.waitForSelector('.archive-toast.error');
    assert.equal(await page.locator(`[data-plan-id="${registered.planId}"]`).count(), 1);
    await page.unroute(`**/api/plans/${registered.planId}/archive`);
    await page.click(`[data-archive-plan="${registered.planId}"]`);
    await page.waitForFunction(planId => !document.querySelector(`[data-plan-id="${planId}"]`), registered.planId);
    await page.waitForSelector('.archive-toast:not(.error)');
    const activeToastBox = await page.locator('.archive-toast').boundingBox();
    assert.ok(activeToastBox);
    assert.equal(activeToastBox.y < 80, true);
    const activeUndoBox = await page.locator('.archive-toast button').boundingBox();
    assert.ok(activeUndoBox);
    assert.equal(activeUndoBox.width >= 70, true);
    assert.match(await page.locator('.archive-toast').innerText(), /Undo/);
    await page.waitForFunction(() => !document.querySelector('.archive-toast'), undefined, { timeout: 12_000 });
    assert.equal(await page.locator(`[data-plan-id="${registered.planId}"]`).count(), 0);
    await context.post(`/api/plans/${registered.planId}/unarchive`, { data: {} });
    await page.reload();
    await page.waitForSelector(`[data-plan-id="${registered.planId}"]`);
    await page.click(`[data-archive-plan="${registered.planId}"]`);
    await page.waitForSelector('.archive-toast:not(.error)');
    await page.route(`**/api/plans/${registered.planId}/unarchive`, route => route.abort('failed'));
    await page.click('.archive-toast button');
    await page.waitForFunction(() => document.querySelector('.archive-toast')?.textContent?.includes('Undo failed. The plan remains archived'));
    assert.equal(await page.locator(`[data-plan-id="${registered.planId}"]`).count(), 0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.archive-toast'));
    await page.unroute(`**/api/plans/${registered.planId}/unarchive`);
    await context.post(`/api/plans/${registered.planId}/unarchive`, { data: {} });
    await page.reload();
    await page.waitForSelector(`[data-plan-id="${registered.planId}"]`);
    await page.click(`[data-archive-plan="${registered.planId}"]`);
    await page.waitForSelector('.archive-toast:not(.error)');
    await page.click('#q');
    await page.waitForFunction(() => !document.querySelector('.archive-toast'));
    assert.equal(await page.locator(`[data-plan-id="${registered.planId}"]`).count(), 0);
    await context.post(`/api/plans/${registered.planId}/unarchive`, { data: {} });
    await page.reload();
    await page.waitForSelector(`[data-plan-id="${registered.planId}"]`);
    await page.click(`[data-archive-plan="${registered.planId}"]`);
    await page.waitForSelector('.archive-toast:not(.error)');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('.archive-toast button')), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.archive-toast').count(), 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.archive-toast'));
    assert.equal(await page.locator(`[data-plan-id="${registered.planId}"]`).count(), 0);
    await context.post(`/api/plans/${registered.planId}/unarchive`, { data: {} });
    assert.deepEqual(archiveDialogs, []);

    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.waitForSelector('#archive-plan');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+O' : 'Control+O');
    await page.waitForSelector('#quick-open-backdrop:not([hidden])');
    assert.equal(await page.locator(`[data-quick-open-result][data-plan-id="${registered.planId}"]`).count(), 1);
    await page.keyboard.press('Escape');
    let releaseStaleNavigator: (() => void) | undefined;
    let heldNavigator = true;
    await page.route('**/api/plans/navigator?**', async route => {
      if (!heldNavigator) {
        await route.continue();
        return;
      }
      heldNavigator = false;
      const response = await route.fetch();
      await new Promise<void>(resolve => { releaseStaleNavigator = resolve; });
      await route.fulfill({ response });
    });
    await page.reload();
    await page.waitForSelector('#archive-plan');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+O' : 'Control+O');
    await page.waitForSelector('#quick-open-backdrop:not([hidden])');
    for (let attempt = 0; attempt < 50 && !releaseStaleNavigator; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!releaseStaleNavigator) throw new Error('Navigator request was not held before archive');
    await page.keyboard.press('Escape');
    await page.click('#archive-plan');
    await page.waitForSelector('#archive-toast:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'archive-toast-undo');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#archive-toast:not([hidden])').count(), 1);
    assert.match(page.url(), new RegExp(`/p/${registered.planId}$`));
    await assertArchivedToolbarStatus();
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#restore-plan')?.hidden === false);
    assert.equal(await page.locator(`[data-plan-nav-item][data-plan-id="${registered.planId}"]`).count(), 0);
    const staleNavigatorResponse = page.waitForResponse(response => response.url().includes('/api/plans/navigator') && response.status() === 200);
    releaseStaleNavigator();
    await staleNavigatorResponse;
    await page.unroute('**/api/plans/navigator?**');
    await page.waitForFunction(planId => !document.querySelector(`[data-plan-nav-item][data-plan-id="${planId}"]`), registered.planId);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+O' : 'Control+O');
    await page.waitForSelector('#quick-open-backdrop:not([hidden])');
    assert.equal(await page.locator(`[data-quick-open-result][data-plan-id="${registered.planId}"]`).count(), 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame')!;
      iframe.contentDocument!.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe.contentWindow ?? window }));
    });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#archive-toast')?.hidden === true);
    await assertArchivedToolbarStatus();
    await page.reload();
    await assertArchivedToolbarStatus();
    assert.equal(await page.locator(`[data-plan-nav-item][data-plan-id="${registered.planId}"]`).count(), 1);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+O' : 'Control+O');
    await page.waitForSelector('#quick-open-backdrop:not([hidden])');
    assert.equal(await page.locator(`[data-quick-open-result][data-plan-id="${registered.planId}"]`).count(), 1);
    await page.keyboard.press('Escape');
    await context.post(`/api/plans/${registered.planId}/unarchive`, { data: {} });
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.setViewportSize({ width: 390, height: 760 });
    await page.waitForSelector('#archive-plan');
    await page.click('#archive-plan');
    await page.waitForSelector('#archive-toast:not([hidden])');
    await page.dispatchEvent('#plan-touch-layer', 'touchstart');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#archive-toast')?.hidden === true);
    await assertArchivedToolbarStatus();
    await context.post(`/api/plans/${registered.planId}/unarchive`, { data: {} });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.waitForSelector('#archive-plan');
    await page.click('#archive-plan');
    await page.waitForSelector('#archive-toast:not([hidden])');
    await page.route(`**/api/plans/${registered.planId}/unarchive`, route => route.abort('failed'));
    await page.click('#archive-toast-undo');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#archive-toast-message')?.textContent?.includes('Undo failed. The plan remains archived'));
    await assertArchivedToolbarStatus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#archive-toast')?.hidden === true);
    await page.unroute(`**/api/plans/${registered.planId}/unarchive`);
    await context.post(`/api/plans/${registered.planId}/unarchive`, { data: {} });
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.waitForSelector('#archive-plan');
    await page.click('#archive-plan');
    await page.waitForSelector('#archive-toast:not([hidden])');
    await page.click('#archive-toast-undo');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#archive-status')?.hidden === true);
    await page.waitForFunction(planId => Boolean(document.querySelector(`[data-plan-nav-item][data-plan-id="${planId}"]`)), registered.planId);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+O' : 'Control+O');
    await page.waitForSelector('#quick-open-backdrop:not([hidden])');
    assert.equal(await page.locator(`[data-quick-open-result][data-plan-id="${registered.planId}"]`).count(), 1);
    await page.keyboard.press('Escape');
    await page.route(`**/api/plans/${registered.planId}/archive`, route => route.abort('failed'));
    await page.click('#archive-plan');
    await page.waitForSelector('#archive-toast.error:not([hidden])');
    assert.equal(await page.locator('#archive-plan').evaluate((button: HTMLButtonElement) => button.disabled), false);
    assert.equal(await page.locator('#archive-status').evaluate((status: HTMLElement) => status.hidden), true);
    await page.unroute(`**/api/plans/${registered.planId}/archive`);

    await page.goto(`${baseUrl}/p/${deferredRegistered.planId}`);
    await page.waitForSelector('#resume-plan');
    await page.click('#archive-plan');
    await page.waitForSelector('#archive-toast:not([hidden])');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#resume-plan')?.hidden === true && document.querySelector<HTMLElement>('#restore-plan')?.hidden === false);
    await assertArchivedToolbarStatus();
    await page.click('#archive-toast-undo');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#archive-status')?.hidden === true);
    await page.waitForSelector('#archive-plan');
    assert.equal(await page.locator('#resume-plan').count(), 0);
    await context.post(`/api/plans/${deferredRegistered.planId}/defer`, { data: { note: 'Paused for deferred archive undo e2e' } });

    await page.goto(`${baseUrl}/deferred`);
    await page.waitForSelector(`[data-plan-id="${deferredRegistered.planId}"]`);
    await page.route(`**/api/plans/${deferredRegistered.planId}/archive`, route => route.abort('failed'));
    await page.click(`[data-archive-plan="${deferredRegistered.planId}"]`);
    await page.waitForSelector('.archive-toast.error');
    assert.equal(await page.locator(`[data-plan-id="${deferredRegistered.planId}"]`).count(), 1);
    await page.unroute(`**/api/plans/${deferredRegistered.planId}/archive`);
    await page.click(`[data-archive-plan="${deferredRegistered.planId}"]`);
    await page.waitForFunction(planId => !document.querySelector(`[data-plan-id="${planId}"]`), deferredRegistered.planId);
    await page.waitForSelector('.archive-toast:not(.error)');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('.archive-toast button')), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.archive-toast').count(), 1);
    await page.route(`**/api/plans/${deferredRegistered.planId}/unarchive`, route => route.abort('failed'));
    await page.click('.archive-toast button');
    await page.waitForFunction(() => document.querySelector('.archive-toast')?.textContent?.includes('Undo failed. The plan remains archived'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.archive-toast'));
    assert.equal(await page.locator(`[data-plan-id="${deferredRegistered.planId}"]`).count(), 0);
    await page.unroute(`**/api/plans/${deferredRegistered.planId}/unarchive`);
    await context.post(`/api/plans/${deferredRegistered.planId}/unarchive`, { data: {} });
    await context.post(`/api/plans/${deferredRegistered.planId}/defer`, { data: { note: 'Paused again for deferred archive undo e2e' } });
    await page.goto(`${baseUrl}/deferred`);
    await page.waitForSelector(`[data-plan-id="${deferredRegistered.planId}"]`);
    await page.click(`[data-archive-plan="${deferredRegistered.planId}"]`);
    await page.waitForFunction(planId => !document.querySelector(`[data-plan-id="${planId}"]`), deferredRegistered.planId);
    await page.waitForSelector('.archive-toast:not(.error)');
    await page.click('.archive-toast button');
    await page.waitForURL(`${baseUrl}/`);
    await page.waitForSelector(`[data-plan-id="${deferredRegistered.planId}"]`);
    assert.deepEqual(archiveDialogs, []);

    await context.post(`/api/plans/${registered.planId}/archive`, { data: {} });
    await page.goto(`${baseUrl}/archive`);
    await page.waitForSelector(`[data-plan-id="${registered.planId}"]`);
    await page.click(`[data-plan-id="${registered.planId}"] a[href="/p/${registered.planId}"]`);
    await page.waitForSelector('#restore-plan');
    assert.equal(await page.locator('#archive-plan').count(), 0);
    await assertArchivedToolbarStatus();

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
    assert.equal(await syncPage.locator('#plan-navbar .doc-kind-seg.active').count(), 0);
    assert.deepEqual(await syncPage.locator('#plan-navbar .doc-kind-seg').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['/', '/?view=all']);
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
