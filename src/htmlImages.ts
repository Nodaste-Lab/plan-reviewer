import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

export interface ImageTagMatch {
  tag: string;
  src: string;
  srcAttribute: string;
  srcAttributeStart: number;
  srcAttributeEnd: number;
}

type Node = DefaultTreeAdapterMap['node'];
type ElementNode = DefaultTreeAdapterMap['element'];
type ImageTagLocation = ImageTagMatch & { tagStart: number; tagEnd: number };

function isElement(node: Node): node is ElementNode {
  return 'tagName' in node && typeof node.tagName === 'string';
}

function imageMatches(html: string): ImageTagLocation[] {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true }) as DefaultTreeAdapterMap['documentFragment'];
  const matches: ImageTagLocation[] = [];
  const walk = (node: Node): void => {
    if (isElement(node) && node.tagName.toLowerCase() === 'img') {
      const src = node.attrs.find(attr => attr.name.toLowerCase() === 'src')?.value;
      const location = node.sourceCodeLocation;
      const srcLocation = location?.attrs?.src;
      const startTag = location?.startTag;
      if (src !== undefined && srcLocation && startTag) {
        const tagStart = startTag.startOffset;
        const tagEnd = startTag.endOffset;
        matches.push({
          tag: html.slice(tagStart, tagEnd),
          tagStart,
          tagEnd,
          src,
          srcAttribute: html.slice(srcLocation.startOffset, srcLocation.endOffset),
          srcAttributeStart: srcLocation.startOffset - tagStart,
          srcAttributeEnd: srcLocation.endOffset - tagStart
        });
      }
    }
    if ('childNodes' in node && Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) walk(child as Node);
    }
  };
  for (const child of fragment.childNodes) walk(child as Node);
  return matches;
}

export function findImageSources(html: string): string[] {
  return imageMatches(html).map(match => match.src);
}

export function replaceImageTags(html: string, visitor: (match: ImageTagMatch) => string): string {
  let output = html;
  for (const match of imageMatches(html).reverse()) {
    output = `${output.slice(0, match.tagStart)}${visitor(match)}${output.slice(match.tagEnd)}`;
  }
  return output;
}
