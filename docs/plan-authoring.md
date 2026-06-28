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

## Register repo templates

Template registration is repo-local guidance, not a plan-review service record. To make structured Markdoc templates reusable in any repo:

1. Store templates under `thoughts/plans/templates/<template-name>.markdoc` unless the repo already declares another template directory.
2. Add a `Plan templates` section to `thoughts/plans/AGENTS.md` listing each template path, intended use, required placeholder substitutions, and any repo-specific rules.
3. When creating a plan, copy the chosen template to `thoughts/plans/<slug>.markdoc`, replace placeholders, then compile/register the copied plan.
4. Do not register template files themselves as review plans. Register only concrete copied plans with real slug/frontmatter/content.

Example registry entry:

```markdown
## Plan templates

- `thoughts/plans/templates/default.markdoc`: default feature plan. Replace `{{slug}}`, `{{title}}`, `{{status}}`, and phase placeholders before registration.
- `thoughts/plans/templates/ui-change.markdoc`: use for reviewer-facing UI or flow changes. Include current/target evidence and UI-impact verification.
```

Example use:

```bash
cp thoughts/plans/templates/default.markdoc thoughts/plans/my-plan.markdoc
$EDITOR thoughts/plans/my-plan.markdoc
plan-review register thoughts/plans/my-plan.markdoc --repo auto --branch auto --commit auto --execution-ready false
```

## Escape hatches and MDX

Use Markdoc tags for normal sections, phases, progress, tables, figures, and mocks. Raw HTML is available only through an explicit reasoned block:

```markdoc
{% html reason="ui-mock" %}
<nav aria-label="Mock navigation"><button>Open</button></nav>
{% /html %}
```

Approved reasons are `ui-mock`, `legacy-fragment`, and `unsupported-markdoc-shape`. Output still passes through the existing sanitizer/render path.

`.mdx` is intentionally rejected in this safe default mode. MDX remains a future trusted-component lane because it compiles Markdown/JSX into executable JavaScript and needs a separate trust boundary.
