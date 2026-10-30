---
version: 1
slug: "components-virtualreviewqueue-tsx"
primary_target: "components/VirtualReviewQueue.tsx"
related_targets: ["components/ChangesFileTree.tsx","components/TreeViewedMenu.tsx","components/EntryActions.tsx","src/pages/HomePage.tsx"]
---

Mode: Operate. Extend the existing review queue and Pierre file tree.

## Direction contract

THESIS: Select a range once and apply a clearly scoped action to it. Navigation and selection remain distinct; a modifier click never opens another workspace.

OWN-WORLD: Retain Gnosis's compact rows, blue selection tokens, visible focus, existing status icons, shadcn/Base UI menus, and light/dark themes.

STORY: Shift-click selects the displayed range. Command/Control-click toggles entries. Right-click within that selection keeps it; right-click elsewhere targets that entry alone. Menus identify the selected count before naming actions. Escape clears the selection.

FIRST VIEWPORT: Existing queue layout and file sidebar remain intact. A compact selected-count control and Clear action expose the current scope. Selected queue rows pair the blue background with a checkmark; file rows use Pierre's native selected state. No modal or floating action shelf.

FORM: Ordinary extension, code-led; seed: none (user-pinned direction). Queue stacks stay whole, while file/folder selection expands to matching files without duplicates. Filters and navigation cannot leave invisible action targets. Background refresh preserves surviving selections by ID.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Acceptance

Cover Review Queue and Changes/Commits trees. Support pointer, Shift+arrows, Command/Control+A, keyboard menus, Escape, filtered and virtualized lists. Batch read/unread, star/unstar, mute, status refresh, link copying, and generation where eligible. Generation uses existing Activity jobs. Bulk actions do not submit review decisions or merge PRs. File actions mark matching files viewed/unviewed once, preserving revision scopes and retries. Verify laptop and narrow windows, both themes, mixed states, partial failures, and menus without clipping.
