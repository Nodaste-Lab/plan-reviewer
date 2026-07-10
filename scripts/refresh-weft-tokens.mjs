#!/usr/bin/env node
// Refresh the vendored Weft design-system token layer (assets/weft-tokens.css)
// from the published @nodaste-lab/weft package on GitHub Packages.
//
// plan-reviewer is a public repo, so it must never need registry auth at
// build/install/runtime — the tokens are committed. This script is the
// maintainer-run path to pull a newer version:
//
//   NODE_AUTH_TOKEN=$(gh auth token) node scripts/refresh-weft-tokens.mjs [version]
//
// The token needs the read:packages scope (gh auth refresh -s read:packages).
// [version] defaults to latest.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'weft-tokens.css');
const version = process.argv[2] ?? 'latest';

if (!process.env.NODE_AUTH_TOKEN) {
  console.error('NODE_AUTH_TOKEN is required (a GitHub token with read:packages).');
  console.error('  NODE_AUTH_TOKEN=$(gh auth token) node scripts/refresh-weft-tokens.mjs');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'weft-tokens-'));
try {
  writeFileSync(join(work, '.npmrc'), [
    '@nodaste-lab:registry=https://npm.pkg.github.com',
    // eslint-disable-next-line no-template-curly-in-string
    '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}',
    '',
  ].join('\n'));

  execFileSync('npm', ['pack', `@nodaste-lab/weft@${version}`, '--silent'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['-xzf', tarball, 'package/css/weft.css', 'package/package.json'], { cwd: work });

  const css = readFileSync(join(work, 'package', 'css', 'weft.css'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(work, 'package', 'package.json'), 'utf8'));
  const header = [
    '/*',
    ` * Vendored from @nodaste-lab/weft@${pkg.version} (css/weft.css) — DO NOT EDIT.`,
    ' * Refresh: NODE_AUTH_TOKEN=$(gh auth token) node scripts/refresh-weft-tokens.mjs',
    ' * Pure token file: --weft-* custom properties + palette/theme/density axes.',
    ' */',
    '',
  ].join('\n');
  writeFileSync(OUT, header + css);
  console.log(`Wrote ${OUT} from @nodaste-lab/weft@${pkg.version} (${css.length} bytes of CSS).`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
