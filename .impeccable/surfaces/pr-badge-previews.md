# PR badge previews

Mode: Operate. Narrow extension of copyable entity badges in the existing workbench.

## Direction contract

THESIS: Identify a PR and understand its saved status without leaving the code or starting a GitHub refresh.

OWN-WORLD: Existing neutral popover surfaces, compact typography, status badges and Lucide icons. Preserve both themes and badge copy behavior.

STORY: Hover or focus a PR badge to read title, status, checks, branches and briefing. Stale status stays explicit; stack briefings name their scope. Click still copies.

FIRST VIEWPORT: A compact tooltip with PR identity, title, status row, small metadata, and a brief summary. The full cached response is shown together, without a loading skeleton or growing content. Missing details use concise empty copy.

FORM: Code-led incumbent extension; no concept seed or comp required. No new visual system, raster assets or navigation behavior.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implemented behavior

Every `PrBadge` shows saved details on hover or keyboard focus. The tooltip includes the title, review status, merge readiness, checks, comments, branches, and briefing when available. Stack briefings identify their scope and PR count. Missing details and cache failures use explicit fallback text. Status from a different revision is withheld; stale status and saved review snapshots remain labeled.

The badge reads the local cache through IPC. Opening a preview starts no network request or briefing generation. The tooltip appears after the complete response arrives, without a loading skeleton or later expansion. Titles occupy at most two lines and briefing summaries three. The existing popover surface fits within the viewport; branch names truncate. Click, keyboard copy, and context-menu actions retain their behavior.

Implementation: [EntityBadge](../../components/EntityBadge.tsx), [PrBadgeTooltip](../../components/PrBadgeTooltip.tsx), [preview data](../../lib/pr-badge-preview.ts), and [global styles](../../src/globals.css). This extension uses the incumbent tokens and components. [DESIGN.md](../../DESIGN.md) and the [design sidecar](../design.json) remain the global visual authority; no global design changes were needed.

## Evidence and completion

Finish review: **SHIP**, with no findings. The fresh reviewer accepted all eight captures. Documentation is complete for this surface.

Validation passed: 390 unit tests, the [PR preview browser suite](../../tests/pr-badge-previews-browser.ts), the [entity badge browser suite](../../tests/entity-badges-browser.ts), TypeScript, and targeted ESLint. Browser checks cover delayed responses, stable tooltip size, copying, missing details, cache failures, revision mismatch, stale status, stack scope, and viewport bounds.

Capture provenance: Electron rendered the application with the browser suite's local fixtures. These are review evidence, not shipping raster assets. No new raster assets were introduced.

| Evidence | Coverage |
| --- | --- |
| [Desktop](../review/pr-badge-previews/desktop.png), [Dark](../review/pr-badge-previews/dark.png) | Saved preview in both themes at 1280 × 800 |
| [Stale](../review/pr-badge-previews/stale.png) | Changes requested and out-of-date status |
| [Missing status](../review/pr-badge-previews/missing-status.png), [Missing details](../review/pr-badge-previews/missing.png) | Revision mismatch and empty cache |
| [Stack](../review/pr-badge-previews/stack.png) | Briefing scope for three PRs |
| [Laptop](../review/pr-badge-previews/laptop.png), [Narrow](../review/pr-badge-previews/narrow.png) | Long title, summary, and branch at 900 × 740 and 640 × 740 |
