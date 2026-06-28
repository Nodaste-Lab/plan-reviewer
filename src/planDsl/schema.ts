import Markdoc from '@markdoc/markdoc';

type MarkdocNode = { attributes?: Record<string, any>; transformAttributes(config: unknown): Record<string, any>; transformChildren(config: unknown): any[] };
type MarkdocConfig = unknown;

export const approvedRawHtmlReasons = new Set([
  'ui-mock',
  'legacy-fragment',
  'unsupported-markdoc-shape'
]);

const commonAttributes = {
  id: { type: String },
  class: { type: String },
  role: { type: String },
  title: { type: String },
  'aria-label': { type: String }
};

function attrs(node: MarkdocNode, config: MarkdocConfig): Record<string, any> {
  return { ...(node.attributes ?? {}), ...node.transformAttributes(config) };
}

function passthrough(nodeAttrs: Record<string, any>, exclude: string[] = []): Record<string, any> {
  const excluded = new Set(exclude);
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(nodeAttrs)) {
    if (excluded.has(key) || value === undefined || value === '') continue;
    const normalizedKey = key.toLowerCase();
    if (['id', 'class', 'role', 'title'].includes(key)) output[key] = value;
    else if (normalizedKey.startsWith('data-') || normalizedKey.startsWith('aria-')) output[normalizedKey] = value;
  }
  return output;
}

function children(node: MarkdocNode, config: MarkdocConfig): any[] {
  return node.transformChildren(config);
}

function clean(input: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ''));
}

function headingBlock(title: string, body: any[]) {
  return [new Markdoc.Tag('h4', {}, [title]), ...body];
}

function phaseSubblock(title: string) {
  return {
    transform(node: MarkdocNode, config: MarkdocConfig) {
      return headingBlock(title, children(node, config));
    }
  };
}

export const markdocConfig: any = {
  tags: {
    plan: {
      attributes: commonAttributes,
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('div', clean({ ...passthrough(nodeAttrs), id: nodeAttrs.id, class: ['plan-body', nodeAttrs.class].filter(Boolean).join(' ') }), children(node, config));
      }
    },
    section: {
      attributes: { ...commonAttributes, id: { type: String, required: true }, title: { type: String, required: true } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('section', clean(passthrough(nodeAttrs, ['title'])), [new Markdoc.Tag('h2', {}, [nodeAttrs.title]), ...children(node, config)]);
      }
    },
    progress: {
      attributes: { ...commonAttributes, id: { type: String } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('section', clean({ ...passthrough(nodeAttrs), id: nodeAttrs.id ?? 'progress' }), [new Markdoc.Tag('h2', {}, ['Progress']), new Markdoc.Tag('ul', { class: 'progress-list' }, children(node, config))]);
      }
    },
    task: {
      attributes: { ...commonAttributes, id: { type: String, required: true }, checked: { type: Boolean }, phase: { type: String } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        const inputAttrs: Record<string, string> = { type: 'checkbox', disabled: '' };
        if (nodeAttrs.checked) inputAttrs.checked = '';
        return new Markdoc.Tag('li', clean({ ...passthrough(nodeAttrs, ['checked', 'phase']), id: nodeAttrs.id, 'data-phase-id': nodeAttrs.phase }), [new Markdoc.Tag('input', inputAttrs), new Markdoc.Tag('span', {}, children(node, config))]);
      }
    },
    phase: {
      attributes: { ...commonAttributes, id: { type: String, required: true }, title: { type: String, required: true }, mapsTo: { type: String } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('article', clean({ ...passthrough(nodeAttrs, ['title', 'mapsTo']), id: nodeAttrs.id, class: ['phase', nodeAttrs.class].filter(Boolean).join(' '), 'data-progress-task': nodeAttrs.mapsTo }), [new Markdoc.Tag('h3', {}, [nodeAttrs.title]), ...children(node, config)]);
      }
    },
    endState: phaseSubblock('End State'),
    testsFirst: phaseSubblock('Tests first'),
    expectedFiles: phaseSubblock('Expected files'),
    work: phaseSubblock('Work'),
    openQuestions: phaseSubblock('Open questions / decision dependencies'),
    verify: phaseSubblock('Verify'),
    decision: {
      attributes: { ...commonAttributes, id: { type: String, required: true } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('article', clean({ ...passthrough(nodeAttrs), id: nodeAttrs.id, class: ['decision', nodeAttrs.class].filter(Boolean).join(' ') }), children(node, config));
      }
    },
    acceptance: {
      attributes: { ...commonAttributes, id: { type: String, required: true } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('li', clean(passthrough(nodeAttrs)), children(node, config));
      }
    },
    bdd: {
      attributes: { ...commonAttributes, id: { type: String, required: true }, title: { type: String } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('article', clean(passthrough(nodeAttrs, ['title'])), [nodeAttrs.title ? new Markdoc.Tag('h3', {}, [nodeAttrs.title]) : '', ...children(node, config)].filter(Boolean));
      }
    },
    matrix: {
      attributes: { ...commonAttributes, id: { type: String, required: true }, columns: { type: Array } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        const head = Array.isArray(nodeAttrs.columns) && nodeAttrs.columns.length
          ? [new Markdoc.Tag('thead', {}, [new Markdoc.Tag('tr', {}, nodeAttrs.columns.map((column: unknown) => new Markdoc.Tag('th', {}, [String(column)])))])]
          : [];
        return new Markdoc.Tag('table', clean(passthrough(nodeAttrs, ['columns'])), [...head, new Markdoc.Tag('tbody', {}, children(node, config))]);
      }
    },
    row: {
      attributes: commonAttributes,
      transform(node: MarkdocNode, config: MarkdocConfig) {
        return new Markdoc.Tag('tr', clean(passthrough(attrs(node, config))), children(node, config));
      }
    },
    cell: {
      attributes: commonAttributes,
      transform(node: MarkdocNode, config: MarkdocConfig) {
        return new Markdoc.Tag('td', clean(passthrough(attrs(node, config))), children(node, config));
      }
    },
    figure: {
      attributes: { ...commonAttributes, id: { type: String, required: true }, src: { type: String }, alt: { type: String }, title: { type: String } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        const body = [];
        if (nodeAttrs.title) body.push(new Markdoc.Tag('h3', {}, [nodeAttrs.title]));
        if (nodeAttrs.src) body.push(new Markdoc.Tag('img', { src: nodeAttrs.src, alt: nodeAttrs.alt ?? '' }));
        body.push(...children(node, config));
        return new Markdoc.Tag('figure', clean(passthrough(nodeAttrs, ['src', 'alt'])), body);
      }
    },
    caption: {
      attributes: commonAttributes,
      transform(node: MarkdocNode, config: MarkdocConfig) {
        return new Markdoc.Tag('figcaption', clean(passthrough(attrs(node, config))), children(node, config));
      }
    },
    mock: {
      attributes: { ...commonAttributes, kind: { type: String }, ariaLabel: { type: String } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        const passthroughAttrs = passthrough(nodeAttrs, ['kind', 'ariaLabel']);
        const ariaLabel = [nodeAttrs.ariaLabel, nodeAttrs['aria-label'], passthroughAttrs['aria-label']]
          .find(value => typeof value === 'string' && value.trim().length > 0);
        return new Markdoc.Tag('div', clean({ ...passthroughAttrs, class: ['mockup', nodeAttrs.kind ? `mock-${nodeAttrs.kind}` : '', nodeAttrs.class].filter(Boolean).join(' '), role: nodeAttrs.role ?? 'img', 'aria-label': ariaLabel }), children(node, config));
      }
    },
    command: {
      attributes: commonAttributes,
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('pre', clean({ ...passthrough(nodeAttrs), class: ['command', nodeAttrs.class].filter(Boolean).join(' ') }), [new Markdoc.Tag('code', {}, children(node, config))]);
      }
    },
    rawHtmlSlot: {
      selfClosing: true,
      attributes: { id: { type: String, required: true }, reason: { type: String, required: true } },
      transform(node: MarkdocNode, config: MarkdocConfig) {
        const nodeAttrs = attrs(node, config);
        return new Markdoc.Tag('div', { 'data-raw-html-slot': nodeAttrs.id, 'data-raw-html-reason': nodeAttrs.reason }, []);
      }
    }
  },
  nodes: {
    fence: {
      render: 'Fence',
      attributes: {
        content: { type: String, required: true },
        language: { type: String }
      },
      transform(node: MarkdocNode & { attributes?: Record<string, any> }) {
        const nodeAttrs = node.attributes ?? node.transformAttributes({});
        return new Markdoc.Tag('pre', {}, [new Markdoc.Tag('code', nodeAttrs.language ? { class: `language-${nodeAttrs.language}` } : {}, [nodeAttrs.content ?? ''])]);
      }
    }
  }
};
