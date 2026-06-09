import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type HtmlElement = DefaultTreeAdapterMap['element'];
type HtmlNode = DefaultTreeAdapterMap['node'];

export interface PlanTitleMetadata {
  id: unknown;
  repoName: unknown;
  slug: unknown;
}

export function normalizePlanTitle(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function htmlTextContent(node: HtmlNode): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('childNodes' in node && Array.isArray(node.childNodes)) return node.childNodes.map(htmlTextContent).join('');
  return '';
}

function childElement(node: HtmlNode, tagName: string): HtmlElement | undefined {
  if ('childNodes' in node && Array.isArray(node.childNodes)) {
    return node.childNodes.find((child): child is HtmlElement => 'tagName' in child && child.tagName === tagName);
  }
  return undefined;
}

export function renderedHtmlTitle(renderedHtml: string): string | undefined {
  const document = parse(renderedHtml) as DefaultTreeAdapterMap['document'];
  const htmlElement = childElement(document as unknown as HtmlNode, 'html');
  const headElement = childElement(htmlElement ?? (document as unknown as HtmlNode), 'head');
  const titleElement = headElement ? childElement(headElement, 'title') : undefined;
  const normalized = normalizePlanTitle(titleElement ? htmlTextContent(titleElement) : '');
  return normalized || undefined;
}

export function planTitleFallback(plan: PlanTitleMetadata): string {
  return normalizePlanTitle(`${plan.repoName} / ${plan.slug}`) || `Plan ${plan.id}`;
}

export function reviewShellTitle(title: string): string {
  const normalized = normalizePlanTitle(title);
  return /(?:^|\s)Plan Review$/i.test(normalized) ? normalized : `${normalized} · Plan Review`;
}
