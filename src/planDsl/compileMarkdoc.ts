import Markdoc from '@markdoc/markdoc';
import fs from 'node:fs';
import path from 'node:path';
import { PlanReviewError, sha256 } from '../util.js';
import { approvedRawHtmlReasons, markdocConfig } from './schema.js';
import { renderPlanTemplate, type MarkdocFrontmatter, type TocEntry } from './template.js';

export interface MarkdocCompileResult {
  html: string;
  fileHash: string;
  warnings: Array<{ code: string; detail: string }>;
  sourcePath?: string;
  targetHtmlPath?: string;
}

interface RawHtmlSlot {
  id: string;
  reason: string;
  html: string;
}

const fencedMarkdocOpenPlaceholder = 'PLAN_REVIEW_MARKDOC_FENCE_OPEN_DELIMITER';
const fencedMarkdocClosePlaceholder = 'PLAN_REVIEW_MARKDOC_FENCE_CLOSE_DELIMITER';
const generatedHeaderPattern = /^<!doctype html>\s*\n<!-- Generated from ([^.]|\.(?! -->))*\.markdoc\. Do not hand-edit this HTML while the \.markdoc source exists\. -->/i;

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed);
  if (/^none$/i.test(trimmed)) return 'none';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

export function parseFrontmatter(source: string): { frontmatter: MarkdocFrontmatter; body: string } {
  if (!source.startsWith('---\n')) return { frontmatter: {}, body: source };
  const end = source.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: source };
  const raw = source.slice(4, end).split(/\r?\n/);
  const frontmatter: MarkdocFrontmatter = {};
  let currentArrayKey: string | undefined;
  for (const line of raw) {
    const arrayItem = /^\s*-\s+(.+)$/.exec(line);
    if (arrayItem && currentArrayKey) {
      const current = Array.isArray(frontmatter[currentArrayKey]) ? frontmatter[currentArrayKey] as unknown[] : [];
      current.push(parseScalar(arrayItem[1]));
      frontmatter[currentArrayKey] = current;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (value === '') {
      frontmatter[key] = [];
      currentArrayKey = key;
    } else {
      frontmatter[key] = parseScalar(value);
      currentArrayKey = undefined;
    }
  }
  const bodyStart = source.startsWith('\n', end + 4) ? end + 5 : end + 4;
  return { frontmatter, body: source.slice(bodyStart) };
}

function parseTagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z0-9_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s]+))/g)) {
    attrs[match[1]] = match[3] ?? match[4] ?? match[5] ?? '';
  }
  return attrs;
}

function splitFencedCodeSegments(source: string): Array<{ fenced: boolean; text: string }> {
  const segments: Array<{ fenced: boolean; text: string }> = [];
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(line => line.length > 0) ?? [];
  let current = '';
  let inFence = false;
  let fenceChar = '';
  let fenceLength = 0;

  const flush = (fenced: boolean) => {
    if (!current) return;
    segments.push({ fenced, text: current });
    current = '';
  };

  for (const line of lines) {
    if (!inFence) {
      const opener = /^( {0,3})(`{3,}|~{3,})/.exec(line);
      if (opener) {
        flush(false);
        inFence = true;
        fenceChar = opener[2][0];
        fenceLength = opener[2].length;
        current += line;
        continue;
      }
      current += line;
      continue;
    }

    current += line;
    const closingPattern = fenceChar === '`'
      ? new RegExp('^ {0,3}`{' + fenceLength + ',}[ \\t]*(?:\\r?\\n)?$')
      : new RegExp('^ {0,3}~{' + fenceLength + ',}[ \\t]*(?:\\r?\\n)?$');
    if (closingPattern.test(line)) {
      flush(true);
      inFence = false;
      fenceChar = '';
      fenceLength = 0;
    }
  }
  flush(inFence);
  return segments;
}

function protectRawHtmlBlocks(body: string): { body: string; slots: RawHtmlSlot[]; warnings: MarkdocCompileResult['warnings'] } {
  const slots: RawHtmlSlot[] = [];
  const warnings: MarkdocCompileResult['warnings'] = [];
  const replaceRawHtmlBlocks = (text: string) => text.replace(/{%\s*html\s*([^%]*)%}([\s\S]*?){%\s*\/html\s*%}/g, (_match, attrText: string, html: string) => {
    const attrs = parseTagAttributes(attrText);
    if (!attrs.reason) {
      throw new PlanReviewError('markdoc_validation_failed', 'Raw HTML escape hatch requires reason="..."', 1, { tag: 'html' }, 'Use {% html reason="ui-mock" %}, reason="legacy-fragment", or reason="unsupported-markdoc-shape".');
    }
    if (!approvedRawHtmlReasons.has(attrs.reason)) {
      throw new PlanReviewError('markdoc_validation_failed', `Unsupported raw HTML escape hatch reason: ${attrs.reason}`, 1, { reason: attrs.reason }, `Use one of: ${[...approvedRawHtmlReasons].join(', ')}.`);
    }
    const id = `raw-html-slot-${slots.length}`;
    slots.push({ id, reason: attrs.reason, html: html.trim() });
    warnings.push({ code: 'raw_html_escape_hatch', detail: `Raw HTML block ${id} used approved reason '${attrs.reason}' and will be sanitized during plan rendering.` });
    return `{% rawHtmlSlot id="${id}" reason="${attrs.reason}" /%}`;
  });
  const protectedBody = splitFencedCodeSegments(body)
    .map(segment => segment.fenced ? segment.text.replaceAll('{%', fencedMarkdocOpenPlaceholder).replaceAll('%}', fencedMarkdocClosePlaceholder) : replaceRawHtmlBlocks(segment.text))
    .join('');
  return { body: protectedBody, slots, warnings };
}

function isMarkdocNode(value: unknown): value is { type: string; tag?: string; attributes?: Record<string, unknown>; children?: unknown[]; location?: { start?: { line?: number } } } {
  return Boolean(value && typeof value === 'object' && 'type' in value);
}

function walkMarkdoc(node: unknown, visitor: (node: ReturnType<typeof assertNode>) => void): void {
  if (!isMarkdocNode(node)) return;
  visitor(assertNode(node));
  for (const child of node.children ?? []) walkMarkdoc(child, visitor);
}

function assertNode(node: { type: string; tag?: string; attributes?: Record<string, unknown>; children?: unknown[]; location?: { start?: { line?: number } } }) {
  return node;
}

const tagAttributeAllowlist: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  plan: ['id', 'class', 'role', 'title', 'aria-label'],
  section: ['id', 'class', 'role', 'title', 'aria-label'],
  progress: ['id', 'class', 'role', 'title', 'aria-label'],
  task: ['id', 'class', 'role', 'title', 'aria-label', 'checked', 'phase'],
  phase: ['id', 'class', 'role', 'title', 'aria-label', 'mapsTo'],
  endState: [],
  testsFirst: [],
  expectedFiles: [],
  work: [],
  openQuestions: [],
  verify: [],
  decision: ['id', 'class', 'role', 'title', 'aria-label'],
  acceptance: ['id', 'class', 'role', 'title', 'aria-label'],
  bdd: ['id', 'class', 'role', 'title', 'aria-label'],
  matrix: ['id', 'class', 'role', 'title', 'aria-label', 'columns'],
  row: ['id', 'class', 'role', 'title', 'aria-label'],
  cell: ['id', 'class', 'role', 'title', 'aria-label'],
  figure: ['id', 'class', 'role', 'title', 'aria-label', 'src', 'alt'],
  caption: ['id', 'class', 'role', 'title', 'aria-label'],
  mock: ['id', 'class', 'role', 'title', 'aria-label', 'kind', 'ariaLabel'],
  command: ['id', 'class', 'role', 'title', 'aria-label'],
  rawHtmlSlot: ['id', 'reason']
}).map(([tag, attrs]) => [tag, new Set(attrs)]));

function isAllowedTagAttribute(tag: string, attribute: string): boolean {
  return Boolean(tagAttributeAllowlist[tag]?.has(attribute) || attribute.startsWith('data-') || attribute.startsWith('aria-'));
}

function validatePlanAst(ast: unknown): TocEntry[] {
  const ids = new Map<string, number>();
  const taskIds = new Set<string>();
  const taskPhaseIds = new Set<string>();
  const phaseIds = new Set<string>();
  const phaseTaskIds = new Set<string>();
  const toc: TocEntry[] = [];
  const phaseRequired = ['endState', 'testsFirst', 'expectedFiles', 'work', 'verify'];
  const errors: string[] = [];

  walkMarkdoc(ast, node => {
    if (node.type !== 'tag') return;
    const attrs = node.attributes ?? {};
    if (!node.tag || !tagAttributeAllowlist[node.tag]) {
      errors.push(`unsupported tag '${String(node.tag ?? '(unknown)')}'`);
      return;
    }
    for (const attribute of Object.keys(attrs)) {
      if (!isAllowedTagAttribute(node.tag, attribute)) errors.push(`unsupported attribute '${attribute}' on ${node.tag}`);
    }
    if (typeof attrs.id === 'string') ids.set(attrs.id, (ids.get(attrs.id) ?? 0) + 1);
    if (node.tag === 'section') {
      if (typeof attrs.id !== 'string') errors.push('section is missing required id');
      if (typeof attrs.title !== 'string') errors.push(`section ${String(attrs.id ?? '(unknown)')} is missing required title`);
      if (typeof attrs.id === 'string' && typeof attrs.title === 'string') toc.push({ id: attrs.id, title: attrs.title });
    }
    if (node.tag === 'task') {
      if (typeof attrs.id === 'string') taskIds.add(attrs.id);
      if (typeof attrs.phase === 'string') taskPhaseIds.add(attrs.phase);
    }
    if (node.tag === 'phase') {
      if (typeof attrs.id === 'string') {
        phaseIds.add(attrs.id);
        toc.push({ id: attrs.id, title: String(attrs.title ?? attrs.id) });
      }
      if (typeof attrs.mapsTo === 'string') phaseTaskIds.add(attrs.mapsTo);
      for (const required of phaseRequired) {
        let found = false;
        walkMarkdoc(node, child => { if (child.type === 'tag' && child.tag === required) found = true; });
        if (!found) errors.push(`phase ${String(attrs.id ?? '(unknown)')} is missing ${required}`);
      }
    }
  });

  for (const [id, count] of ids) if (count > 1) errors.push(`duplicate id '${id}'`);
  for (const phaseId of taskPhaseIds) if (!phaseIds.has(phaseId)) errors.push(`task references unknown phase '${phaseId}'`);
  for (const taskId of phaseTaskIds) if (!taskIds.has(taskId)) errors.push(`phase mapsTo references unknown task '${taskId}'`);

  if (errors.length) {
    throw new PlanReviewError('markdoc_validation_failed', `Markdoc plan failed validation: ${errors[0]}`, 1, { errors }, 'Fix the Markdoc source structure and retry.');
  }
  return toc;
}

function replaceRawHtmlSlots(rendered: string, slots: RawHtmlSlot[]): string {
  let html = rendered
    .replaceAll(fencedMarkdocOpenPlaceholder, '{%')
    .replaceAll(fencedMarkdocClosePlaceholder, '%}');
  for (const slot of slots) {
    const pattern = new RegExp(`<div\\s+data-raw-html-slot="${slot.id}"\\s+data-raw-html-reason="${slot.reason}"></div>`);
    html = html.replace(pattern, `<div data-raw-html-reason="${slot.reason}">${slot.html}</div>`);
  }
  return html;
}

export function compileMarkdoc(source: string, options: { sourcePath?: string } = {}): MarkdocCompileResult {
  const { frontmatter, body } = parseFrontmatter(source);
  const protectedSource = protectRawHtmlBlocks(body);
  const ast = Markdoc.parse(protectedSource.body);
  const toc = validatePlanAst(ast);
  const transformed = Markdoc.transform(ast, markdocConfig);
  const renderedBody = replaceRawHtmlSlots(Markdoc.renderers.html(transformed), protectedSource.slots);
  const html = renderPlanTemplate(frontmatter, renderedBody, toc, options.sourcePath);
  return {
    html,
    fileHash: sha256(source),
    warnings: protectedSource.warnings,
    sourcePath: options.sourcePath
  };
}

export function generatedHtmlPathFor(markdocPath: string): string {
  return markdocPath.replace(/\.markdoc$/i, '.html');
}

export function assertCanWriteGeneratedHtml(targetHtmlPath: string, sourcePath: string, force = false): void {
  if (force || !fs.existsSync(targetHtmlPath)) return;
  const existing = fs.readFileSync(targetHtmlPath, 'utf8');
  if (generatedHeaderPattern.test(existing) && existing.includes(path.basename(sourcePath))) return;
  throw new PlanReviewError(
    'markdoc_generated_html_conflict',
    `Refusing to overwrite existing non-generated HTML plan: ${targetHtmlPath}`,
    1,
    { targetHtmlPath, sourcePath },
    'Choose a different Markdoc slug, keep the existing HTML plan authoritative, or retry the compile/register command with --force only for an intentional migration.'
  );
}

export function compileMarkdocFile(markdocPath: string, options: { write?: boolean; force?: boolean } = {}): MarkdocCompileResult {
  if (!/\.markdoc$/i.test(markdocPath)) {
    throw new PlanReviewError('unsupported_plan_source', 'compile requires a .markdoc source file', 1, { markdocPath }, 'Pass thoughts/plans/<slug>.markdoc, or use register directly for legacy .html plans.');
  }
  const absolute = path.resolve(markdocPath);
  const source = fs.readFileSync(absolute, 'utf8');
  const targetHtmlPath = generatedHtmlPathFor(absolute);
  const result = compileMarkdoc(source, { sourcePath: path.relative(process.cwd(), absolute) || absolute });
  if (options.write) {
    assertCanWriteGeneratedHtml(targetHtmlPath, absolute, options.force);
    fs.writeFileSync(targetHtmlPath, result.html);
  }
  return { ...result, targetHtmlPath };
}
