import assert from 'node:assert/strict';
import test from 'node:test';

test('locked third-party primitives import successfully', async () => {
  const [fastify, commander, sqlite, finder, html2canvas, playwright] = await Promise.all([
    import('fastify'),
    import('commander'),
    import('better-sqlite3'),
    import('@medv/finder'),
    import('html2canvas'),
    import('playwright')
  ]);

  assert.equal(typeof fastify.default, 'function');
  assert.equal(typeof commander.Command, 'function');
  assert.equal(typeof sqlite.default, 'function');
  assert.equal(typeof finder.finder, 'function');
  assert.equal(typeof html2canvas.default, 'function');
  assert.equal(typeof playwright.request.newContext, 'function');
});
