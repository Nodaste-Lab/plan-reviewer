import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { sha256 } from '../util.js';

export function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `plan-reviewer-${process.pid}-${name}-${Date.now()}.sqlite`);
}

export function sampleHtml(): string {
  return `<!doctype html>
  <html>
    <head><title>Sample Plan</title><style>body{color:white}</style><script>window.bad = true</script></head>
    <body>
      <main id="sample-plan">
        <section id="phase-p1"><h2>Phase 1</h2><p>Register the plan.</p></section>
        <section><h2>Phase 2</h2><p>Reviewers can select this section.</p><img src="./diagram.png" alt="Diagram"></section>
      </main>
    </body>
  </html>`;
}

export function sampleRegisterPayload(overrides: Record<string, unknown> = {}) {
  const html = sampleHtml();
  return {
    repoKey: 'git@example.com:demo/sample.git',
    repoName: 'sample',
    remoteUrl: 'git@example.com:demo/sample.git',
    rootPath: '/tmp/sample',
    branch: 'main',
    commitSha: 'abc123',
    planPath: 'thoughts/plans/sample-plan.html',
    slug: 'sample-plan',
    html,
    fileHash: sha256(html),
    watchMode: 'snapshot' as const,
    assets: [
      {
        sourceUrl: './diagram.png',
        absolutePath: '/tmp/sample/thoughts/plans/diagram.png',
        bytesBase64: Buffer.from('png-data').toString('base64')
      }
    ],
    updateMode: 'upsert' as const,
    ...overrides
  };
}

export async function registeredApp(name = 'default') {
  const app = createApp({ dbPath: tempDbPath(name) });
  const register = await app.inject({
    method: 'POST',
    url: '/api/plans/register',
    payload: sampleRegisterPayload()
  });
  if (register.statusCode !== 200) {
    throw new Error(`registration failed: ${register.statusCode} ${register.body}`);
  }
  const data = register.json().data as { planId: string; versionId: string };
  return { app, planId: data.planId, versionId: data.versionId };
}

export function domAnchor() {
  return {
    planNodeId: 'phase-p1',
    cssSelector: '#phase-p1',
    domPath: 'html/body/main/section[1]',
    textQuote: { exact: 'Register the plan.', prefix: 'Phase 1', suffix: '' },
    headingPath: ['Phase 1'],
    rect: { x: 10, y: 20, width: 300, height: 80 },
    viewport: { width: 1280, height: 800 },
    textPreview: 'Phase 1 Register the plan.',
    outerHtmlPreview: '<section id="phase-p1"><h2>Phase 1</h2></section>'
  };
}
