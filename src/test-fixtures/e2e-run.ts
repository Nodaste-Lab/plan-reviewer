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
  const html = '<!doctype html><html><body><main><div style="height:240px"></div><section id="dom-annotation"><h1>DOM annotation</h1><p>Plan index target.</p></section><section id="text-annotation"><h2>Text annotation</h2><p id="text-target">Text range context target for reviewer selection.</p></section><figure><img src="./diagram.png" alt="image annotation" width="120" height="90"></figure><div style="height:1200px"></div></main></body></html>';
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
  assert.match(await shellResponse.text(), /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
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

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('[data-attention-filter]');
    assert.equal(await page.locator('.plan-card').count(), 2);
    await page.fill('#q', 'e2e');
    await page.click('[data-attention-filter]');
    await page.waitForFunction(() => document.querySelectorAll('.plan-card:not([hidden])').length === 1);
    assert.match(await page.locator('.plan-card:not([hidden])').innerText(), /Source missing/);
    assert.match(await page.locator('.plan-card:not([hidden])').innerText(), /Showing cached copy/);
    await page.goto(`${baseUrl}/p/${registered.planId}`);
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
    const openDomComposer = async () => {
      await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('#plan-frame');
        const target = iframe?.contentDocument?.querySelector('#dom-annotation');
        target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe?.contentWindow ?? window }));
      });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('#composer')?.hidden === false);
    };
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#dom-annotation'));
    await openDomComposer();
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
    assert.equal(await commentAnchorCount(), 1);
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
    assert.equal(await page.evaluate(() => (window as typeof window & { __html2canvasCalls?: number }).__html2canvasCalls), 3);

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
    assert.equal(await page.evaluate(() => (window as typeof window & { __html2canvasCalls?: number }).__html2canvasCalls), 4);
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
    const staleRaceHtml = html.replace('Plan index target.', 'Race stale target.');
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
    const newestRaceHtml = html.replace('Plan index target.', 'Race newest target.');
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
    const resumeRender = resumeDelayedRender as (() => void) | null;
    assert.ok(resumeRender);
    resumeRender();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => {
      const text = document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.body.textContent ?? '';
      return text.includes('Race newest target') && !text.includes('Race stale target');
    }), true);
    await page.unroute(`**/render/${registered.planId}*`);

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

    await page.setViewportSize({ width: 486, height: 902 });
    await page.goto(`${baseUrl}/p/${registered.planId}`);
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#plan-frame')?.contentDocument?.querySelector('#text-target'));
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
  } finally {
    await syncBrowser.close();
    fs.rmSync(syncDir, { recursive: true, force: true });
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
  console.log('e2e scenarios passed: plan index, dom annotation, image annotation, plan sync');
} finally {
  await app.close();
}
