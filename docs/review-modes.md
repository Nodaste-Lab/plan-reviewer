# Review Modes

`plan-reviewer` supports two explicit modes on the existing plan/document record:

- `planning`: reviewed implementation plans. Requires publication metadata and `--execution-ready true|false`; shows execution-readiness and planning actions.
- `collaboration`: general HTML documents. May omit publication metadata; hides planning-only chrome while keeping selection, comments, source sync, queue claims, and visible thread replies.

Mode inference is server-side when `reviewMode` is omitted: execution-readiness metadata or `thoughts/plans/` paths infer `planning`; general HTML without planning metadata infers `collaboration`. Explicit API `reviewMode` or CLI `--review-mode` wins. Change mode without editing source HTML:

```bash
plan-review mode plan_123 collaboration --json
```

Visible conversation replies are separate from ack/resolve lifecycle metadata:

```bash
plan-review reply cmt_123 --body "Updated the document." --claim claim_123 --adapter hermes --json
plan-review ack cmt_123 --claim claim_123 --summary "Updated the document" --json
```

Hermes can claim across active documents only when the matching adapter target is enabled and routable:

```bash
plan-review delivery target set plan_123 --adapter hermes --thread http://127.0.0.1:8787/plan-review --mode webhook --json
plan-review agent next --all --adapter hermes --json
```

The service remains an unauthenticated trusted-local/trusted-network tool. Anyone who can reach it can read documents, create comments, claim queue work, append replies, and change modes.
