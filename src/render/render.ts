import sanitizeHtml from 'sanitize-html';
import { parse, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { RegisterPlanInput } from '../schemas.js';
import { PlanReviewError, sha256, shortHash, slugify } from '../util.js';
import { replaceImageTags } from '../htmlImages.js';

export interface RenderResult {
  renderedHtml: string;
  warnings: Array<{ code: string; detail: string }>;
}

type ElementNode = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];

const allowedTags = sanitizeHtml.defaults.allowedTags.concat([
  'html',
  'head',
  'meta',
  'title',
  'style',
  'body',
  'main',
  'section',
  'article',
  'aside',
  'figure',
  'figcaption',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'input',
  'label'
]);

const allowedAttributes: Record<string, sanitizeHtml.AllowedAttribute[]> = {
  ...sanitizeHtml.defaults.allowedAttributes,
  '*': ['id', 'class', 'style', 'title', 'aria-label', 'role', 'data-*'],
  meta: ['charset', 'name', 'content'],
  img: ['src', 'alt', 'width', 'height', 'title', 'data-*'],
  input: ['type', 'checked', 'disabled', 'readonly', 'aria-label', 'data-*'],
  a: ['href', 'name', 'target', 'rel', 'data-*']
};

function isElement(node: Node): node is ElementNode {
  return 'tagName' in node && typeof node.tagName === 'string';
}

function getAttr(node: ElementNode, name: string): string | undefined {
  return node.attrs.find(attr => attr.name === name)?.value;
}

function setAttr(node: ElementNode, name: string, value: string): void {
  const attr = node.attrs.find(item => item.name === name);
  if (attr) attr.value = value;
  else node.attrs.push({ name, value });
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
}

function textContent(node: Node): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('childNodes' in node && Array.isArray(node.childNodes)) {
    return node.childNodes.map(textContent).join('');
  }
  return '';
}

function walk(node: Node, visitor: (node: ElementNode, path: number[]) => void, path: number[] = []): void {
  if (isElement(node)) visitor(node, path);
  if ('childNodes' in node && Array.isArray(node.childNodes)) {
    node.childNodes.forEach((child, index) => walk(child, visitor, [...path, index + 1]));
  }
}

function rewriteImages(html: string, input: RegisterPlanInput, warnings: RenderResult['warnings']): string {
  return replaceImageTags(html, ({ tag, src, srcAttributeStart, srcAttributeEnd }) => {
    if (/^(https?:)?\/\//i.test(src)) {
      warnings.push({ code: 'blocked_external_image', detail: `External image '${src}' was blocked; upload a relative image asset instead.` });
      return `<span data-missing-image="${escapeAttr(src)}" style="display:inline-block;border:1px solid #fbbf24;padding:8px;color:#fbbf24">Blocked external image: ${escapeAttr(src)}</span>`;
    }
    if (/^(data:image\/|blob:|\/assets\/)/i.test(src)) {
      return tag;
    }
    const asset = input.assets?.find(item =>
      item.sourceUrl === src ||
      item.sourceUrl === src.replace(/^\.\//, '') ||
      item.sourceUrl.replace(/^\.\//, '') === src
    );
    if (!asset?.bytesBase64) {
      warnings.push({ code: 'missing_image_asset', detail: `Image asset '${src}' was not uploaded; leaving visible placeholder.` });
      return `<span data-missing-image="${escapeAttr(src)}" style="display:inline-block;border:1px solid #fbbf24;padding:8px;color:#fbbf24">Missing image: ${escapeAttr(src)}</span>`;
    }
    const assetHash = sha256(Buffer.from(asset.bytesBase64, 'base64'));
    const rewrittenSrc = `src="/assets/${assetHash}" data-plan-image-source="${escapeAttr(src)}" data-plan-image-hash="${assetHash}"`;
    return `${tag.slice(0, srcAttributeStart)}${rewrittenSrc}${tag.slice(srcAttributeEnd)}`;
  });
}

export function renderPlan(input: RegisterPlanInput): RenderResult {
  const parseErrors: Array<{ code?: string; startLine?: number; startCol?: number }> = [];
  parse(input.html, {
    onParseError(error) {
      parseErrors.push({ code: error.code, startLine: error.startLine, startCol: error.startCol });
    }
  });
  if (parseErrors.length > 0) {
    throw new PlanReviewError(
      'unsafe_or_invalid_html',
      'Plan HTML could not be parsed safely',
      422,
      { parseErrors },
      'Fix the HTML parse errors and register the plan again.'
    );
  }

  const warnings: RenderResult['warnings'] = [];
  let rewritten = rewriteImages(input.html, input, warnings);
  const blockedScriptCount = (rewritten.match(/<script\b/gi) ?? []).length;
  if (blockedScriptCount > 0) {
    warnings.push({ code: 'blocked_script', detail: `${blockedScriptCount} script tag(s) removed from review render.` });
  }
  const sanitized = sanitizeHtml(rewritten, {
    allowedTags,
    allowedAttributes,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    // Plans are rendered in a no-script iframe with a restrictive CSP; preserving
    // inline CSS is required for HTML plans to remain reviewable.
    allowVulnerableTags: true,
    allowedSchemesByTag: { img: ['data', 'blob'] },
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: { ...attribs, rel: 'noopener noreferrer' }
      })
    }
  });

  const document = parse(sanitized) as DefaultTreeAdapterMap['document'];
  const used = new Map<string, number>();
  walk(document as unknown as Node, (node, domPath) => {
    const text = textContent(node).trim().replace(/\s+/g, ' ').slice(0, 160);
    const existingId = getAttr(node, 'id');
    const base =
      existingId ||
      (['h1', 'h2', 'h3', 'h4', 'section', 'article'].includes(node.tagName)
        ? slugify(text || node.tagName)
        : `${node.tagName}-${domPath.join('-')}-${shortHash(text || serialize(node).slice(0, 160))}`);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    setAttr(node, 'data-plan-node-id', count === 0 ? base : `${base}-${count + 1}`);
  });

  return {
    renderedHtml: serialize(document),
    warnings
  };
}
