---
version: 1
slug: "components-prsummary-tsx"
primary_target: "components/PrSummary.tsx"
related_targets: ["src/pages/HomePage.tsx","lib/stack-workspace.ts","components/StackOverview.tsx"]
---

Mode: Operate. Extend the existing PR workspace and visual system.

## Direction contract

THESIS: Review queue → Stack → PR → tab. One explicit scope owns all tabs and actions; a stack overview never doubles as a selected PR description.

OWN-WORLD: Preserve Gnosis's cool neutral surfaces, blue selection, existing typography, status colors, compact dividers, shadcn controls, and both themes.

STORY: Understand the stack's intent and dependency order, find the PR needing attention, enter its complete workspace, and return without losing place. Names are local; comments and Viewed progress remain tied to PR revisions.

FIRST VIEWPORT: Compact breadcrumb, scoped heading/status and existing tabs. The stack summary shows briefing plus ordered PR rows with status, checks and cached file progress. A searchable scope switcher persists across tabs without adding a second full sidebar.

FORM: User-approved extension of the existing tabbed workspace. Stack identity survives completed members; filters identify matches without removing context. No alternate visual world. seed: none (user-pinned direction)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Acceptance

Separate stack and PR explanations, explicit generation only. Direct PR links retain parent context. Scope changes preserve tabs and per-scope positions. Opening the stack overview does not mark all members read. Local renaming must survive restart and not invalidate explanations. Completed stacks stay accessible through saved work, history and stars. Shared cached inventories supply progress without new GitHub calls. Verify laptop widths, keyboard, light/dark, empty and failed persistence states.
