---
version: 1
slug: "components-prsummary-tsx"
primary_target: "components/PrSummary.tsx"
related_targets: ["src/pages/HomePage.tsx","lib/stack-workspace.ts","components/StackOverview.tsx","components/StackBriefing.tsx"]
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

## Stack summary behavior

The scope switcher precedes the tabs and moves above them in narrow windows. Compact rows pair the PR number and title above dependency, status, checks, and file progress. A shared repository appears once in the heading. Mixed-repository stacks show the repository in each row.

The briefing area identifies missing, queued, generating, paused, failed, cancelled, and disconnected states. Generation requires an explicit action here. Running and queued briefings link to Activity. Failed and cancelled briefings offer retry when available. Paused briefings expose Activity and available generation actions. Detailed errors remain collapsed.

The heading and member rows share one clock for saved status freshness. The whole-stack header counts confirmed blocked PRs even when another PR is ready. This summary presents merge evidence; it does not authorize merge actions. A separate “Reviews” row counts review states with explicit PR units. Expired status says “Status needs refresh” and exposes a refresh action. Check outcomes distinguish passed, skipped, neutral, running, and attention states. The next PR action reads “Open PR #number.”

The main column shows ordered PR rows first, then the stack briefing. At container widths of at least 960px, merge status occupies a 320px rail on the right; below that width, it follows the main column. Without status details, the main column uses the full width.

The rail groups cached evidence under “Blocking merge,” “Waiting on GitHub,” “Not yet confirmed,” and “Checks that do not block merging.” Each group shows its PR count and first three PRs, with additional PRs behind “Show more.” Stale reasons describe what was last reported; unconfirmed status offers “Refresh status.” Fresh check evidence for the current revision shows up to two check names on separate lines, with outcomes and required or optional labels when known. PR numbers open the corresponding workspace; check actions open that PR's Checks tab; GitHub links open the exact PR. Displaying this evidence adds no requests and does not change merge eligibility.
