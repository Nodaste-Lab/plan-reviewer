import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { findImageSources, replaceImageTags } from './htmlImages.js';
import { PlanReviewError, slugify } from './util.js';

export interface ExportPlanAsset {
  id: string;
  sourceUrl: string;
  assetHash?: string;
  contentType?: string;
  status: string;
  blobPath?: string;
}

export interface BuiltPlanExport {
  kind: 'html' | 'zip';
  filename: string;
  contentType: string;
  buffer: Buffer;
}

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlElement = DefaultTreeAdapterMap['element'];

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node && typeof node.tagName === 'string';
}

function attr(node: HtmlElement, name: string): string | undefined {
  return node.attrs.find(item => item.name.toLowerCase() === name.toLowerCase())?.value;
}

function elementText(node: HtmlNode): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if (!('childNodes' in node) || !Array.isArray(node.childNodes)) return '';
  return node.childNodes.map(child => elementText(child as HtmlNode)).join('');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(Boolean))].sort();
}

function utcStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function buildDatedExportName(slug: string, date: Date, extension: 'html' | 'zip'): string {
  return `${slugify(slug.replace(/\0/g, ' '))}-${utcStamp(date)}.${extension}`;
}

function stripUrlDecorations(sourceUrl: string): string {
  return sourceUrl.split(/[?#]/, 1)[0] || sourceUrl;
}

function urlSuffix(sourceUrl: string): string {
  const queryIndex = sourceUrl.indexOf('?');
  const fragmentIndex = sourceUrl.indexOf('#');
  const suffixIndex = [queryIndex, fragmentIndex].filter(index => index >= 0).sort((a, b) => a - b)[0];
  return suffixIndex === undefined ? '' : sourceUrl.slice(suffixIndex);
}

function sanitizeBasename(sourceUrl: string): { stem: string; ext: string } {
  const rawBase = path.posix.basename(stripUrlDecorations(sourceUrl).replace(/\\/g, '/')).replace(/\0/g, '');
  const parsed = path.parse(rawBase || 'asset');
  const stem = slugify(parsed.name || 'asset');
  const ext = parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, '');
  return { stem, ext };
}

export function safeZipAssetName(sourceUrl: string, assetHash: string | undefined, usedNames: Set<string>): string {
  const { stem, ext } = sanitizeBasename(sourceUrl);
  const hash = (assetHash || slugify(sourceUrl)).replace(/[^a-fA-F0-9]/g, '').slice(0, 8) || 'asset';
  const base = `${stem}-${hash.toLowerCase()}`;
  let candidate = `${base}${ext}`;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function classifySource(source: string, local: (value: string) => void, external: Set<string>, nonPortable: Set<string>): void {
  const value = source.trim();
  if (!value || value.startsWith('#') || /^data:/i.test(value) || value.toLowerCase() === 'about:blank') return;
  if (/^(https?:)?\/\//i.test(value)) {
    external.add(value);
    return;
  }
  if (/^blob:/i.test(value) || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    nonPortable.add(value);
    return;
  }
  local(value);
}

function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (value[index] === ',' || /\s/.test(value[index]))) index += 1;
    if (index >= value.length) break;
    if (/^data:/i.test(value.slice(index))) {
      const start = index;
      const payloadStart = value.indexOf(',', index);
      index = payloadStart >= 0 ? payloadStart + 1 : index;
      while (index < value.length && value[index] !== ',' && !/\s/.test(value[index])) index += 1;
      urls.push(value.slice(start, index));
      while (index < value.length && value[index] !== ',') index += 1;
      if (value[index] === ',') index += 1;
      continue;
    }
    const start = index;
    while (index < value.length && value[index] !== ',') index += 1;
    const url = value.slice(start, index).trim().split(/\s+/, 1)[0];
    if (url) urls.push(url);
    if (value[index] === ',') index += 1;
  }
  return urls;
}

function sourceUrlMatches(assetSource: string, htmlSource: string): boolean {
  return assetSource === htmlSource || assetSource === htmlSource.replace(/^\.\//, '') || assetSource.replace(/^\.\//, '') === htmlSource;
}

function cssUrls(value: string): string[] {
  const urls: string[] = [];
  const urlPattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s][^)]*?))\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(value))) {
    urls.push((match[1] ?? match[2] ?? match[3] ?? '').trim());
  }
  const importPattern = /@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s][^)]*?))\s*\)|"([^"]+)"|'([^']+)')/gi;
  while ((match = importPattern.exec(value))) {
    urls.push((match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim());
  }
  return urls;
}

function collectBaseHrefs(html: string): string[] {
  const document = parse(html) as DefaultTreeAdapterMap['document'];
  const hrefs: string[] = [];
  const walk = (node: HtmlNode): void => {
    if (isElement(node) && node.tagName.toLowerCase() === 'base') {
      const href = attr(node, 'href')?.trim();
      if (href) hrefs.push(href);
    }
    if ('childNodes' in node && Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) walk(child as HtmlNode);
    }
  };
  for (const child of document.childNodes) walk(child as HtmlNode);
  return hrefs;
}

function collectUnsupportedSources(html: string, unsupportedLocal: Set<string>, external: Set<string>, nonPortable: Set<string>, options: { scanImages?: boolean } = {}): void {
  const document = parse(html) as DefaultTreeAdapterMap['document'];
  const scan = (value: string | undefined) => {
    if (!value) return;
    classifySource(value, source => unsupportedLocal.add(source), external, nonPortable);
  };
  const scanSrcset = (value: string | undefined) => {
    if (!value) return;
    for (const source of srcsetUrls(value)) scan(source);
  };
  const walk = (node: HtmlNode): void => {
    if (isElement(node)) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'img') {
        if (options.scanImages) scan(attr(node, 'src'));
        scanSrcset(attr(node, 'srcset'));
      }
      if (tag === 'source') {
        scan(attr(node, 'src'));
        scanSrcset(attr(node, 'srcset'));
      }
      if (tag === 'video') {
        scan(attr(node, 'src'));
        scan(attr(node, 'poster'));
      }
      if (tag === 'audio' || tag === 'embed' || tag === 'iframe' || tag === 'track' || tag === 'script') scan(attr(node, 'src'));
      if (tag === 'iframe') {
        const srcdoc = attr(node, 'srcdoc');
        if (srcdoc) collectUnsupportedSources(srcdoc, unsupportedLocal, external, nonPortable, { scanImages: true });
      }
      if (tag === 'input' && (attr(node, 'type') || '').toLowerCase() === 'image') scan(attr(node, 'src'));
      if (tag === 'object') scan(attr(node, 'data'));
      if (tag === 'feimage' || tag === 'image' || tag === 'use') {
        scan(attr(node, 'href'));
        scan(attr(node, 'xlink:href'));
      }
      if (tag === 'meta') {
        const name = (attr(node, 'name') || attr(node, 'property') || '').toLowerCase();
        if (['og:image', 'twitter:image', 'twitter:image:src'].includes(name)) scan(attr(node, 'content'));
      }
      if (tag === 'link') {
        const rel = (attr(node, 'rel') || '').toLowerCase().split(/\s+/);
        if (rel.some(item => ['apple-touch-icon', 'icon', 'manifest', 'mask-icon', 'modulepreload', 'preload', 'stylesheet'].includes(item))) {
          scan(attr(node, 'href'));
          scanSrcset(attr(node, 'imagesrcset'));
        }
      }
      const style = attr(node, 'style');
      if (style) for (const source of cssUrls(style)) scan(source);
      if (tag === 'style') for (const source of cssUrls(elementText(node))) scan(source);
    }
    if ('childNodes' in node && Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) walk(child as HtmlNode);
    }
  };
  for (const child of document.childNodes) walk(child as HtmlNode);
}

function throwIfNotPortable(details: { missingSources: Set<string>; unsupportedLocalSources: Set<string>; externalSources: Set<string>; nonPortableSources: Set<string> }): void {
  const payload = {
    missingSources: unique(details.missingSources),
    unsupportedLocalSources: unique(details.unsupportedLocalSources),
    externalSources: unique(details.externalSources),
    nonPortableSources: unique(details.nonPortableSources)
  };
  if (Object.values(payload).every(list => list.length === 0)) return;
  throw new PlanReviewError(
    'export_not_portable',
    'Plan export is not portable because one or more referenced assets cannot be packaged.',
    409,
    payload,
    'Restore missing local plan assets and re-register, or inline/remove unsupported, external, absolute, or blob asset references before downloading again.'
  );
}

export function buildPlanExport(input: { slug: string; html: string; assets: ExportPlanAsset[]; now?: Date }): BuiltPlanExport {
  const copiedAssets = input.assets.filter(asset => asset.status === 'copied' && asset.blobPath);
  const copiedBySource = new Map(copiedAssets.map(asset => [asset.sourceUrl, asset]));
  const missingSources = new Set<string>();
  const unsupportedLocalSources = new Set<string>();
  const externalSources = new Set<string>();
  const nonPortableSources = new Set<string>();
  const packagedAssets = new Map<string, { asset: ExportPlanAsset; packagedPath: string }>();
  const usedNames = new Set<string>();

  for (const source of findImageSources(input.html)) {
    classifySource(source, localSource => {
      const asset = copiedBySource.get(localSource) ?? copiedAssets.find(candidate => sourceUrlMatches(candidate.sourceUrl, localSource));
      if (!asset?.blobPath || !fs.existsSync(asset.blobPath)) {
        missingSources.add(localSource);
        return;
      }
      if (!packagedAssets.has(localSource)) {
        packagedAssets.set(localSource, {
          asset,
          packagedPath: `assets/${safeZipAssetName(localSource, asset.assetHash, usedNames)}`
        });
      }
    }, externalSources, nonPortableSources);
  }

  collectUnsupportedSources(input.html, unsupportedLocalSources, externalSources, nonPortableSources);
  if (packagedAssets.size > 0) {
    for (const href of collectBaseHrefs(input.html)) nonPortableSources.add(href);
  }
  throwIfNotPortable({ missingSources, unsupportedLocalSources, externalSources, nonPortableSources });

  if (packagedAssets.size === 0) {
    return {
      kind: 'html',
      filename: buildDatedExportName(input.slug, input.now ?? new Date(), 'html'),
      contentType: 'text/html; charset=utf-8',
      buffer: Buffer.from(input.html, 'utf8')
    };
  }

  const root = buildDatedExportName(input.slug, input.now ?? new Date(), 'zip').replace(/\.zip$/, '');
  const rewrittenHtml = replaceImageTags(input.html, match => {
    const packaged = packagedAssets.get(match.src)?.packagedPath;
    if (!packaged) return match.tag;
    return `${match.tag.slice(0, match.srcAttributeStart)}src="${escapeAttribute(`${packaged}${urlSuffix(match.src)}`)}"${match.tag.slice(match.srcAttributeEnd)}`;
  });
  const zippable: Record<string, Uint8Array> = {
    [`${root}/${root}.html`]: strToU8(rewrittenHtml)
  };
  for (const { asset, packagedPath } of packagedAssets.values()) {
    zippable[`${root}/${packagedPath}`] = new Uint8Array(fs.readFileSync(asset.blobPath!));
  }
  return {
    kind: 'zip',
    filename: `${root}.zip`,
    contentType: 'application/zip',
    buffer: Buffer.from(zipSync(zippable, { level: 6, mtime: new Date(1980, 0, 1, 12, 0, 0) }))
  };
}

export function contentDispositionAttachment(filename: string): string {
  const safeAscii = filename.replace(/["\\\r\n]/g, '_');
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
