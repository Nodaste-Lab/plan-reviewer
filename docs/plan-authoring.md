# Plan authoring sources

`plan-reviewer` supports two source modes for reviewable plans:

- `thoughts/plans/<slug>.markdoc` is the compact authoring source for new plans.
- `thoughts/plans/<slug>.html` is the generated and registered browser-review artifact.

Legacy HTML-only plans still work and remain source-authoritative when no sibling `.markdoc` file exists.

## Compile Markdoc

```bash
plan-review compile thoughts/plans/my-plan.markdoc
```

This writes `thoughts/plans/my-plan.html` with a generated-header comment. The compiler refuses to overwrite an existing non-generated HTML file. Use `--force` only for an intentional migration after confirming the legacy HTML should be replaced.

## Register Markdoc

```bash
plan-review register thoughts/plans/my-plan.markdoc --repo auto --branch auto --commit auto --execution-ready false
```

Registration compiles the Markdoc source, registers the generated HTML, and keeps filesystem source sync pointed at the `.markdoc` file. If later compilation fails, source sync keeps serving the last good generated HTML and reports an actionable sync error.

## Escape hatches and MDX

Use Markdoc tags for normal sections, phases, progress, tables, figures, and mocks. Raw HTML is available only through an explicit reasoned block:

```markdoc
{% html reason="ui-mock" %}
<nav aria-label="Mock navigation"><button>Open</button></nav>
{% /html %}
```

Approved reasons are `ui-mock`, `legacy-fragment`, and `unsupported-markdoc-shape`. Output still passes through the existing sanitizer/render path.

`.mdx` is intentionally rejected in this safe default mode. MDX remains a future trusted-component lane because it compiles Markdown/JSX into executable JavaScript and needs a separate trust boundary.
