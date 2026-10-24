---
version: 1
slug: "components-globalcommandpalette-tsx"
primary_target: "components/GlobalCommandPalette.tsx"
related_targets: ["lib/command-center.tsx","src/command-search-service.ts"]
---

# Global search and navigation

Mode: Operate. Extend the existing laptop review workbench. The user approved shadcn Command and Dialog, local search across queue filters, stacks as groups, direct content jumps, previews, recent destinations, contextual actions, and explicit GitHub search. Preserve review drafts and reading position. Opening or typing must not fetch from GitHub or start AI work.

## Direction contract

THESIS: Reach any locally available change or review context from one keyboard entry point. Make the reason for each match clear before navigation.

OWN-WORLD: Preserve the workbench's cool neutrals, semantic blue selection, Plus Jakarta Sans, compact controls, and Light/Dark themes.

STORY: Open with Command-K, scan recent work, type familiar words or a PR number, inspect the source and excerpt, then open the summary or exact topic/file. Greater-than limits results to commands.

FIRST VIEWPORT: A centered, stable two-column dialog, 900px maximum width. Search and scope above; ranked groups on the left, compact preview and visible actions on the right. At narrow widths, keep the results and keyboard flow usable without the preview.

FORM: User-confirmed extension of the incumbent command palette using shadcn primitives; no replacement visual world or generated assets. Concept process: not applicable — this user-specified local extension follows the explicit new-work.md exception, “Never run the script for a local extension or a precisely specified narrow request.” No roll was performed.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
