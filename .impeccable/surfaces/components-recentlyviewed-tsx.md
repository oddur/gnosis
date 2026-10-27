---
version: 1
slug: "components-recentlyviewed-tsx"
primary_target: "components/RecentlyViewed.tsx"
related_targets: ["lib/recently-viewed.ts","src/App.tsx","src/globals.css"]
---

# Recently viewed

Mode: Operate. Extend the existing application header with a compact history menu, using the supplied Linear screenshot as the interaction reference. Preserve the Gnosis design system.

## Direction contract

THESIS: Return to previously visited work with one compact list. Each PR or stack appears once, most recent first.

OWN-WORLD: Existing popover, muted metadata, semantic PR status icons, and highlighted keyboard selection. No new palette or typography.

STORY: Open the clock button, identify a PR by repository, number, status and title, then return to its last tab. Saved views and local reviews remain identifiable.

FIRST VIEWPORT: A small clock button beside the brand. A roughly 480px-wide menu aligns below it. Rows have an identifier column, status icon, truncated title, and quiet repository text. Long titles remain available in tooltips. Keyboard navigation, Escape, and empty history work immediately.

FORM: Local extension based on the user's Linear reference; no concept roll. History is local and account-specific, with no GitHub requests to populate the menu.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implemented extension

The clock control opens a Radix dropdown beside the application identity. The menu uses the existing popover, border, radius, control text, and caption tokens. Highlighted rows use the existing accent pair. PR state icons preserve the queue's semantic status treatment; stacks, reviews, and views have distinct icons and text labels.

The finished menu is 540px wide, bounded by the viewport with 12px clearance on each side. This adapts the contract's approximate 480px width to accommodate the repository column. Rows retain the identifier, icon, title, and repository order. Their minimum height is 34px. The list scrolls within 440px or the available viewport height. At widths of 620px or less, the repository column is hidden while the title remains available. Full row details remain in the native title tooltip.

Interface text inherits Plus Jakarta Sans. Names use the existing control size; identifiers, repository details, heading, and actions use the caption size. The thin border and popover fill preserve the workbench's restrained material. No new palette, typeface, global token, or shipping raster was introduced.

## Behavior and states

History stores up to 24 distinct destinations, most recent first. Returning to a destination updates its existing entry. Account-specific storage uses the existing SQLite review-state IPC. Menu metadata comes from recorded visits without a GitHub request to populate the list.

PRs and stacks restore the recorded home location, including the last tab. Saved views, queue views, and saved local reviews retain their own labels and destinations. Muted PR URLs are excluded from the visible history. History remains separate from Back and Forward navigation.

The dropdown supports keyboard selection, typeahead, and Escape through the existing Radix menu primitive. Empty history explains what will appear. Clear recently viewed removes the entries. Save failures retain session history and expose Retry saving history. Destination failures appear as an alert within the open menu.

## Finish evidence

Finish reviewer disposition: **SHIP**, with no material fixes. The reviewer found the typography, material, and row structure consistent with the established workbench. The 540px width is an accepted local adaptation for repository metadata.

Reviewed screenshots:

- [Desktop, light theme, 1280 × 800](../review/recently-viewed/desktop-light.png)
- [Laptop, dark theme, 900 × 760](../review/recently-viewed/laptop-dark.png)

These screenshots are review evidence, not shipping raster assets.

The implementation pass confirmed final verification:

- All 414 unit tests pass (`/tmp/gnosis-recent-all-tests.log`).
- TypeScript and targeted lint checks pass (`/tmp/gnosis-recent-types.log`, `/tmp/gnosis-recent-lint.log`).
- The navigation browser suite passes, including history deduplication, keyboard Enter selection, last-tab restoration, reload persistence, and clearing history (`/tmp/gnosis-recent-browser.log`).
- The Markdown review browser regression passes with the actual worker (`/tmp/gnosis-md-review-fixes-browser.log`).

The detector report at `/tmp/gnosis-recent-detect.json` contains pre-existing advisories outside the new history styles. They are not promoted into design rules or repaired by this extension. [DESIGN.md](../../DESIGN.md), [PRODUCT.md](../../PRODUCT.md), and the global design sidecar remain authoritative and unchanged by this documentation pass.
