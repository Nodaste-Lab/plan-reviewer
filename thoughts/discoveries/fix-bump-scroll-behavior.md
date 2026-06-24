# Fix bump scroll behavior discoveries

## 2026-06-24 — Out-of-scope sibling touch listeners

During scoped GLM implementation review, two sibling non-passive `touchstart` archive-toast dismiss listeners were identified outside the plan scope:

- `src/server/app.ts:408` — organizer / kanban page script.
- `src/server/app.ts:486` — deferred plans page script.

Classification: `OUT_OF_SCOPE_FOLLOW_UP`.

Why out of scope: the execution-ready plan is explicitly limited to the `/p/:planId` review-shell scroll surface (`#review`, `#plan-frame`, `#plan-touch-layer`) and excludes navigator/comment lifecycle/source-sync/storage changes. These sibling listeners are on separate index/deferred surfaces, predate this branch, and are not routed to or exercised by the review-shell diff.

Evidence: the scoped implementation changes only the review-shell `clientJs` and mobile/coarse `#review` CSS. The new e2e regression asserts passive touch listeners and first reverse-direction scrolling on the `/p/:planId` review shell and passes. Full gates also pass: `bun run test` and `bun run test:e2e`.

Tracking destination: future follow-up plan for index/organizer/deferred surface scroll-blocking touch listeners if those surfaces show the same pull/bump behavior.
