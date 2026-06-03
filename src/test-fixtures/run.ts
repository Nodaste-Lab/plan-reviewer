import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { sha256 } from '../util.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function withServer<T>(scenario: string, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp({ dbPath: `/tmp/plan-reviewer-fixture-${process.pid}-${scenario}.sqlite` });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await app.close();
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`${url} failed: ${response.status} ${JSON.stringify(body)}`);
  return body.data as T;
}

async function register(baseUrl: string) {
  const html = '<!doctype html><html><body><section id="fixture"><h1>Fixture plan</h1><p>Queue me.</p></section></body></html>';
  return requestJson<{ planId: string; versionId: string }>(`${baseUrl}/api/plans/register`, {
    method: 'POST',
    body: JSON.stringify({
      repoKey: 'fixture-repo',
      repoName: 'fixture',
      rootPath: '/tmp/fixture',
      branch: 'main',
      commitSha: 'fixture',
      planPath: 'thoughts/plans/fixture.html',
      slug: 'fixture',
      html,
      fileHash: sha256(html),
      updateMode: 'upsert'
    })
  });
}

async function createComment(baseUrl: string, planId: string, versionId: string) {
  return requestJson<{ comment: { id: string; status: string } }>(`${baseUrl}/api/plans/${planId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      versionId,
      body: 'Fixture comment',
      anchorType: 'dom',
      anchor: {
        planNodeId: 'fixture',
        cssSelector: '#fixture',
        textPreview: 'Fixture plan',
        rect: { x: 0, y: 0, width: 100, height: 50 },
        viewport: { width: 800, height: 600 }
      }
    })
  });
}

async function seededCommentStream(): Promise<void> {
  await withServer('seeded-comment-stream', async baseUrl => {
    const { planId, versionId } = await register(baseUrl);
    const { comment } = await createComment(baseUrl, planId, versionId);
    assert.equal(comment.status, 'pending');

    const poll = await requestJson<{ events: Array<{ eventType: string; payload: { commentId: string } }> }>(
      `${baseUrl}/api/plans/${planId}/events/poll?afterSequence=0&mode=queue`
    );
    assert.equal(poll.events[0].eventType, 'comment.created');
    assert.equal(poll.events[0].payload.commentId, comment.id);
  });
}

async function sseLatency(): Promise<void> {
  await withServer('sse-latency', async baseUrl => {
    const samples = Number(argValue('--samples') ?? 50);
    const p95Ms = Number(argValue('--p95-ms') ?? 1000);
    const { planId, versionId } = await register(baseUrl);
    const response = await fetch(`${baseUrl}/api/plans/${planId}/events?mode=queue`, {
      headers: { accept: 'text/event-stream' }
    });
    assert.equal(response.ok, true, `SSE subscribe failed: ${response.status}`);
    if (!response.body) throw new Error('SSE response did not include a body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntilComment = async (commentId: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const read = await Promise.race([
          reader.read(),
          new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`SSE timed out waiting for ${commentId}`)), remainingMs)
          )
        ]);
        if (read.done) break;
        buffer += decoder.decode(read.value);
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const dataLine = raw.split('\n').find(line => line.startsWith('data:'));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(5).trim());
          if (data.commentId === commentId || data.comment?.id === commentId) return;
        }
      }
      throw new Error(`SSE timed out waiting for ${commentId}`);
    };
    const latencies: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const { comment } = await createComment(baseUrl, planId, versionId);
      const started = Date.now();
      await readUntilComment(comment.id, p95Ms);
      latencies.push(Date.now() - started);
    }
    await reader.cancel();
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    assert.equal(p95 <= p95Ms, true, `p95 ${p95}ms exceeded ${p95Ms}ms across ${samples} samples`);
  });
}

async function queueClaimAck(): Promise<void> {
  await withServer('queue-claim-ack', async baseUrl => {
    const { planId, versionId } = await register(baseUrl);
    const { comment } = await createComment(baseUrl, planId, versionId);
    const claim = await requestJson<{ claimed: Array<{ id: string; claim: { id: string } }> }>(`${baseUrl}/api/plans/${planId}/comments/claim`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'one' })
    });
    assert.equal(claim.claimed[0].id, comment.id);
    const ack = await requestJson<{ comment: { status: string } }>(`${baseUrl}/api/comments/${comment.id}/ack`, {
      method: 'POST',
      body: JSON.stringify({ claimId: claim.claimed[0].claim.id, action: { responseSummary: 'acked' } })
    });
    assert.equal(ack.comment.status, 'acknowledged');
  });
}

const scenario = argValue('--scenario') ?? 'all';
if (scenario === 'seeded-comment-stream' || scenario === 'all') await seededCommentStream();
if (scenario === 'sse-latency' || scenario === 'all') await sseLatency();
if (scenario === 'queue-claim-ack' || scenario === 'all') await queueClaimAck();
console.log(`fixture scenario passed: ${scenario}`);
