---
name: Gnosis
description: A compact review workbench for understanding incoming code.
colors:
  primary: "#284eaf"
  primary-foreground: "#fff"
  background: "#fcfcfd"
  foreground: "#242a35"
  card: "#fff"
  popover: "#fff"
  secondary: "#f0f2f6"
  muted-foreground: "#626b7b"
  accent: "#eaf0ff"
  accent-foreground: "#24469c"
  border: "#e1e5ec"
  input: "#d5dbe5"
  ring: "#345fc1"
  sidebar: "#f4f5f8"
  destructive: oklch(0.55 0.16 25)
  success: oklch(0.42 0.11 145)
  danger: oklch(0.45 0.18 22)
  warning: oklch(0.45 0.14 55)
  info: oklch(0.45 0.1 300)
  dark-primary: "#a6bfff"
  dark-primary-foreground: "#15244a"
  dark-background: "#171a20"
  dark-foreground: "#e3e7ef"
  dark-card: "#1d2129"
  dark-popover: "#222731"
  dark-secondary: "#242a34"
  dark-muted-foreground: "#a2adbf"
  dark-accent: "#273957"
  dark-accent-foreground: "#c5d7ff"
  dark-border: "#343b48"
  dark-input: "#424b5c"
  dark-ring: "#9bb8ff"
  dark-sidebar: "#1c2028"
  dark-destructive: oklch(0.66 0.16 25)
  dark-success: oklch(0.72 0.1 145)
  dark-danger: oklch(0.68 0.16 22)
  dark-warning: oklch(0.72 0.12 55)
  dark-info: oklch(0.65 0.1 300)
typography:
  headline: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 25px, fontWeight: 650, lineHeight: 1.4, letterSpacing: "-0.02em"}
  title: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 22px, fontWeight: 650, lineHeight: 1.35, letterSpacing: "-0.025em"}
  title-compact: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 18px, fontWeight: 650, lineHeight: 1.4, letterSpacing: "-0.02em"}
  body: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 15px, fontWeight: 400, lineHeight: 1.55}
  prose: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 16px, fontWeight: 400, lineHeight: 1.65}
  label-row: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 15px, fontWeight: 600, lineHeight: 1.5}
  label-button: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 14px, fontWeight: 500, lineHeight: 20px}
  entity-label: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: .75rem, fontWeight: 500, lineHeight: 1.4}
  entity-code: {fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Code', 'Fira Code', monospace", fontSize: .75rem, fontWeight: 500, lineHeight: 1.4}
  mono: {fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Code', 'Fira Code', monospace"}
rounded:
  base: .4rem
  button: 4.4px
  control: 4px
  entity: "calc(.4rem - 4px)"
  field: 5px
  drawer: 8px
  card: 10.4px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
components:
  button-primary: {backgroundColor: "{colors.primary}", textColor: "{colors.primary-foreground}", typography: "{typography.label-button}", rounded: "{rounded.button}", padding: 8px 16px, height: 36px}
  button-outline: {backgroundColor: "{colors.background}", textColor: "{colors.foreground}", typography: "{typography.label-button}", rounded: "{rounded.button}", padding: 8px 16px, height: 36px}
  button-secondary: {backgroundColor: "{colors.secondary}", textColor: "{colors.foreground}", typography: "{typography.label-button}", rounded: "{rounded.button}", padding: 8px 16px, height: 36px}
  button-ghost: {textColor: "{colors.foreground}", typography: "{typography.label-button}", rounded: "{rounded.button}", padding: 8px 16px, height: 36px}
  button-destructive: {backgroundColor: "{colors.destructive}", textColor: "#fff", typography: "{typography.label-button}", rounded: "{rounded.button}", padding: 8px 16px, height: 36px}
  button-link: {textColor: "{colors.primary}", typography: "{typography.label-button}", rounded: "{rounded.button}", padding: 8px 16px, height: 36px}
  search-field: {backgroundColor: "{colors.card}", textColor: "{colors.foreground}", rounded: "{rounded.field}", padding: 6px 10px}
  navigation-active: {backgroundColor: "{colors.accent}", textColor: "{colors.accent-foreground}", rounded: "{rounded.field}", padding: 9px 10px}
  entity-badge: {backgroundColor: "{colors.secondary}", textColor: "{colors.foreground}", typography: "{typography.entity-label}", rounded: "{rounded.entity}", padding: 2px 5px}
  entity-badge-code: {backgroundColor: "{colors.accent}", textColor: "{colors.accent-foreground}", typography: "{typography.entity-code}", rounded: "{rounded.entity}", padding: 2px 5px}
  entity-badge-hover: {backgroundColor: "{colors.accent}", textColor: "{colors.accent-foreground}"}
  briefing-tag: {textColor: "{colors.foreground}", rounded: "{rounded.control}", padding: 3px 7px}
  card: {backgroundColor: "{colors.card}", textColor: "{colors.foreground}", rounded: "{rounded.card}", padding: 24px}
---

# Design System: Gnosis

## Overview

**Creative North Star: "Review workbench"**

Gnosis is a compact, calm desktop workspace for understanding incoming code. Clear hierarchy and restrained controls help reviewers scan quickly and keep context.

The visual system uses cool neutrals, a blue action accent, and subtle surface layers. Light and dark themes receive equal attention. The newspaper aesthetic, editorial mastheads, and oversized margins are rejected.

**Key Characteristics:**

- Compact layouts that fit a laptop window.
- Sans-serif hierarchy with readable code and prose.
- Subtle layers, visible focus, and explicit status text.
- Consistent treatment of stacks and standalone PRs.

This document captures the workbench at commit `082617e`. [PRODUCT.md](PRODUCT.md) owns product behavior.
The final workbench blocks in [globals.css](src/globals.css) override earlier newspaper-era palette declarations.
The frontmatter records active values; implementations should use the corresponding CSS variables.
Refresh this file and [.impeccable/design.json](.impeccable/design.json) together when the system changes.

## Colors

Cool neutrals support a blue action accent and distinct semantic status colors.

- **Primary — Workbench blue:** `primary` identifies filled actions; `ring` marks focus and interactive details.
- **Neutral — Canvas, panel, and sidebar:** `background`, `card`, `popover`, and `sidebar` separate workspace layers.
- **Neutral — Text and dividers:** `foreground`, `muted-foreground`, `border`, and `input` establish readable hierarchy.
- **Selection:** `accent` and `accent-foreground` identify selected rows and navigation. `secondary` also supplies the muted surface.
- **Status:** success green, danger red, warning amber, and info purple retain their semantic roles. Destructive actions use `destructive`.

Unprefixed tokens describe Light. Their `dark-` counterparts describe Dark, mapped to the same runtime CSS variable names.
Status tokens map to `--color-success`, `--color-danger`, `--color-warning`, and `--color-info`.
Paired foreground variables remain authoritative for contrast. Card, secondary, and popover text use the theme foreground.
Sidecar tonal ramps are derived preview aids; they are not additional implementation tokens.

**The Status Rule.** Pair status colors with text or icons. Color alone must not carry review state.

## Typography

Plus Jakarta Sans supplies interface text, headings, and explanations. Display and serif aliases also resolve to this sans-serif family.
JetBrains Mono is the default code family; settings offer other code fonts. Default variable fonts are bundled through [src/fonts.css](src/fonts.css). Optional code families load when selected.

- **Headline:** overview titles use the headline role.
- **Title:** review and queue titles use the title role at 22px with 1.35 line-height.
- **Compact title:** briefing, dialog, chat, and explainer headings use the 18px compact title role with comfortable multiline leading.
- **Body and prose:** interface text uses body; explanations use prose with a usual maximum width of 68ch.
- **Labels:** queue titles use label-row. Metadata uses 12px; compact controls use 13px.
- **Code:** preserve selectable monospace text. Code themes are independent of the interface theme.

Review narratives, PR descriptions, overview summaries, and chat messages use 16px text. Queue titles, briefing summaries, inline explanations, GitHub comment bodies, and file summaries use 15px. Controls remain 13px and metadata 12px; descriptions of settings use 13px with 1.6 line-height. Review narratives and chat keep bounded reading columns. Author PR descriptions fill their column beside People & branches; the shared page frame bounds the overall width. Queue summaries use at most 75ch.
Semantic `--type-*` tokens use rem units. Dense controls stay smaller than reading text to fit the laptop workspace. Keep badges in sentence case at 12px or above.
Shared reading roles use 1.65 line-height. Dark prose uses weight 425, slightly wider tracking, and 1.7 line-height across narratives, PR descriptions, chat, discussions, and inline notes. Use upright, full-contrast text for chat questions and answers; role labels identify the speaker.
Code uses the selected monospace family. Pierre diffs and Markdown blocks share a 13px size and 20px line-height through rem tokens, so text scaling works in both renderers. Fenced code remains a scrollable block even without a language label. Inline code follows its surrounding prose.

**The Reading Rule.** Keep explanations readable within their pane. Use restrained headings and bounded prose widths.

## Layout

Use a viewport workspace with separately scrolling content panes. Reserve 34px at the bottom for Activity.
The shared header has a minimum height of 56px with 10px vertical and 20px horizontal padding.

| Surface | Wide layout | Narrow behavior |
| --- | --- | --- |
| Queue sidebar | 190px | 160px at ≤1100px; 52px icon rail at ≤850px |
| Briefing pane | 360px, maximum 44% | 320px at ≤1100px; maximum 50% at ≤850px; replaces the queue at ≤620px |
| Review panes | Resizable 40/60 split, minimums 25/30 | Explicit pane tabs at ≤1000px |
| Overview | Maximum 1100px; 1.4fr/1fr columns; 32px gap | One column at ≤850px |
| Settings | Maximum 672px wide and 80dvh high; internal scrolling | Tabs form two columns at ≤620px |
| Address Feedback | Independently scrolling conversation list (32%, minimum 260px) and detail pane | At ≤760px of available content width, show list or detail with a Conversations return action |
| Checks graph | Canvas with a 260px workflow sidebar; selected job opens the existing detail pane beside it | At ≤1000px viewport width, workflows use an overlay drawer; at ≤1050px workspace width, details overlay the right side, covering the canvas at ≤700px |

Review prose has 20px vertical and 22px horizontal padding; code panes use 16px.
Queue rows use 13px vertical padding, 14px on the left, and 20px on the right.
The spacing tokens cover common intervals. Existing optical adjustments mean this is not a strict grid.

## Elevation & Depth

Borders and tonal surfaces define the workspace. The Activity drawer and sticky source headers have no shadow.
Library outline buttons retain a small shadow; auxiliary cards retain the library card shadow.
Exact shadow values are recorded in the sidecar. Dialogs use a translucent background overlay with a 2px blur.

**The Surface Rule.** Use borders and tonal layers for the main workspace. Reserve existing shadows for the primitives that already use them.

## Shapes

Use subtly curved rectangular controls and thin borders. The base radius supplies derived library button and card radii.
Recorded pixel derivatives assume a 16px root font size; runtime components retain their CSS calculations.
Custom controls use the control radius; fields and navigation use the field radius.
Activity uses the drawer radius on its upper corners. The settings dialog retains square outer corners.

## Components

### Buttons

Compact and restrained. [Button](components/ui/button.tsx) owns primary, outline, secondary, ghost, destructive, and link variants.
Default buttons are 36px high; small buttons are 32px. Icon presence reduces horizontal padding.
Primary and secondary fills soften on hover. Outline and ghost actions use accent hover surfaces.
Dark outline buttons use translucent input surfaces; destructive buttons also adjust their fill in Dark.
Keep the visible focus outline and library focus ring. Disabled buttons use half opacity.

### Chips and fields

Briefing tags have thin borders and compact padding. Settings option chips distinguish selection with an underline and ring.
The queue search field uses a panel surface, muted icon, and 12px input text.
Focus outlines the search container. Keep an accessible input label even when placeholder text is present.

### Copyable entity badges

[EntityBadge](components/EntityBadge.tsx) supplies compact, lightly tinted rectangular controls for app-owned metadata.
User, repository, and PR badges use the entity-label role. Branch and commit badges use the entity-code role and accent colors.
The badge radius derives from the runtime small radius. Each badge has a minimum height of 24px and a 4px internal gap.
Small icons identify entity kinds. [GitHubAuthor](components/GitHubAuthor.tsx) supplies user avatars and loads profile details after deliberate hover or focus.

| Entity | Display | Primary copy value |
| --- | --- | --- |
| User | GitHub login | Exact login without an added `@` |
| Repository | Owner and repository | `owner/repo` |
| PR | `#number` | Full PR URL |
| Branch | Branch name | Exact branch name |
| Commit | First seven SHA characters | Full SHA |

Click, Enter, and Space copy the primary value. Titles, rows, and breadcrumbs retain their navigation behavior.
Right-click, the context-menu key, or Shift+F10 opens entity actions. PR actions include the number and, when available, the title.
The menu offers Open on GitHub when the destination is known. Menu dismissal returns focus to the badge.

Hover and focus replace the leading entity icon or avatar with the copy icon. Success shows a checkmark there for 1500ms.
Both icons share one grid cell, so feedback preserves the original icon's dimensions without trailing blank space.
Failure shows an error icon, destructive text, and a retry instruction for the same duration. A polite live region announces the result.
These states preserve badge dimensions. Keyboard focus uses a 2px ring with a 2px offset.

Badge groups wrap with a 4px gap. Badges normally fit within the smaller of their container width and 32ch.
Long labels retain their beginning and end through middle truncation. Tooltips show the full copy value and action after a 350ms delay.
Clipboard values remain complete. Profile tooltips wait for their details before they appear.

**The Entity Copy Rule.** Use badges for app-owned identifiers. Preserve navigation on titles, rows, and breadcrumbs, and preserve authored prose, generated prose, and code.

### Navigation and containers

Sidebar navigation uses 12px labels, muted resting text, and a filled accent selection with semibold text.
Hover adds a neutral surface. Counts use tabular numerals.
Queue content uses rows and divided panes. The [Card](components/ui/card.tsx) primitive remains available for auxiliary content.
Cards retain their border, larger radius, small shadow, and 24px content inset.

### Stack status

The Pull requests heading shows the count and dependency direction. Group rerun and Continue review controls together on the right; wrap them together on smaller screens. Keep all actions directly visible. Ready stacks omit the merge-action panel. Standard healthy rows fit at least five complete groups at 1280×800 and two at 900×600 while retaining labels and readable type.

A stack summary has one merge verdict above a full-width dependency list. Each PR forms a compact reading group: identity and branches, then a labeled Review / Checks / Branch strip, then visible remedies. Keep status beside its own PR rather than in detached columns at the far edge. Branch metadata and viewed-file progress share the secondary line. Confirmed blockers use red; non-blocking check problems use amber. Optional updates and skipped checks use muted text.

Checks follow new attempts on the displayed commit automatically. A new commit requires an explicit switch. After a rerun request, label old output as the previous attempt until GitHub reports new results. Background allowance pauses are informational and show the automatic retry time. Refreshing one PR must not refresh the full stack.

A compact “To merge this stack” action panel groups required actions and links to the affected PR overviews, ordered base first within each group. Drafts have a one-click “Mark all ready” action with inline progress and partial-failure recovery. It changes only draft status, and retains the existing permission and revision guards. Show each blocker and its remedy in the PR row without expansion. Name required check failures; separate running checks as waiting. Keep optional check results outside the required-action list. Expand a row for supporting check details. Show separate timestamps for merge requirements and check results, including missing or delayed results. Permission reads start on action, with the existing confirmation and revision checks. Ready rows omit redundant details. Below 620px of content width, the status strip becomes a vertical label/value list. The compact stack-context sidebar keeps its separate navigation layout.

PR summaries keep the review decision and Review PR action in the persistent header. On Summary, show merge readiness once in a compact decision area, above a wrapping row of directly visible PR actions. Keep freshness and actionable blocker details visible; omit ready-state prose that only repeats the verdict. Keep Merge, auto-merge, both branch-update methods, draft conversion or Mark ready, and permission refresh directly visible, with their existing guards and confirmations. Resolve conflicts appears when applicable. Other tabs retain merge readiness in the header.

Show check, review, and discussion summaries once below the merge decision. The checks summary opens Checks; the review and discussion summaries expand details and move focus to the evidence heading. Unknown checks use an uncertainty icon. Normal sync boilerplate stays quiet, but unavailable, stale, or delayed results remain explicit. Discussions load only on expansion. The icon refresh control has an accessible name.

Follow with the author description and a 260px metadata column. Put change size beside Author description as a link to Changes. Saved AI briefings are collapsed above the description and remain explicitly labelled. The stack-context disclosure lives in the metadata column, where expanding it does not displace the description. Below 850px of available content width, metadata follows the description. Keep the existing prose scale, semantic colors, and shared page frame. Stack summaries lead with the dependency list, which already shows review, check, and branch status for each PR. Detailed GitHub evidence follows that list, before the stack briefing. Use the existing 24px stack section gap without additional evidence margins. Expanding the disclosure must not shift the dependency rows above it.

### Workflow dependency graph

[WorkflowGraph](components/WorkflowGraph.tsx) extends Checks with a searchable workflow sidebar and an icon-labelled List/Graph segmented toggle whose shared bordered surface, blue selected accent, and ring border reinforce its `aria-pressed` state. Checks compresses the PR heading and supporting metadata to give evidence more room. Stacks add a source-PR selector with attention counts. One shared toolbar groups List/Graph, the source-PR selector, Workflows toggle, selected workflow name and GitHub link, View, highlight filters, Next issue when issues exist, External checks, freshness, bulk rerun, and refresh. Groups wrap as space requires and remain accessible above open details. At viewport widths ≤1450px, freshness uses a clock with its checked-time title and screen-reader text; wider layouts show the text inline. The View menu holds revision, job count, and workflow source details. External checks opens the selected PR’s provider checks in List.

The left workflow sidebar is 260px wide on desktop and lists full wrapped names alphabetically, with a status icon and text. Duplicate names include file/event context. Exact job totals come from cached API counts for that run attempt; matching revision/attempt check evidence supplies provisional N+ totals, and unknown totals read “Jobs: —”. Search matches names, paths, and events locally. Arrow keys, Home, and End move focus without selecting; Enter selects. Close or Escape returns focus to Workflows. With multiple workflows, desktop defaults open; at viewport widths ≤1000px it defaults closed and opens as an overlay drawer with the graph inert. The workflow session retains manual open/closed state. The source-PR dropdown remains in the toolbar. Cold workflow loads use a centered, padded canvas state with a small animated node-and-connection motif, a readable heading, and phase-specific supporting text. Show elapsed seconds after five seconds without live-region timer announcements. Respect reduced motion, keep navigation usable, and omit canvas zoom controls until jobs exist. Errors and empty workflows have distinct static states. Workflow selection retains the current graph until the target is prepared, with a spinner on the pending sidebar row. Swap the graph and its viewport together before paint. Restore each visited workflow’s pan and zoom for the same topology; late selection responses cannot replace a newer selection. Measure current canvas bounds when fitting so delayed resize notifications do not recenter the graph twice.

Opening Checks warms the first PR needing attention, falling back to the first PR, subject to the API reserve. Without a saved selection, Graph also prefers that PR and chooses a workflow needing attention before an active or completed healthy run. Leaving Checks drops queued preparation. Cold graph loads use interactive priority: jobs and workflow sources load concurrently, with at most three opted-in HTTP reads, paced request starts, and shared backoff. Writes and ordinary background reads remain serialized.

The backend reads workflow YAML at the run's immutable revision. Jobs flow left to right along declared prerequisites; matrix and reusable-workflow groups expand into their jobs. Show actual reported statuses with icons and text. A failed prerequisite is supporting context, not an inferred replacement for a downstream job's status. Missing mappings stay disconnected and carry an explicit notice.

The last explicit List/Graph choice is a global user preference, restored before rendering across navigation and restarts. Direct links to a specific check or external provider can open List temporarily without replacing that preference.

Job nodes use panel surfaces, thin borders, compact 13px names, and 12px status, duration, and context text. Selection uses the existing accent surface; failed jobs and their outgoing dependency paths use the danger color. Filters emphasize matching surfaces while retaining the dependency structure and full-contrast job text. Hover or keyboard focus traces the job’s immediate incoming and outgoing connections and dims unrelated paths. Preserve the backend’s orthogonal routes and separate attachment points so edges avoid unrelated cards. Inputs stay on the left and outputs on the right; the layout engine orders ports to reduce crossings instead of following dependency declaration order. Show secondary text only for useful context, such as active steps, grouped jobs, and failed prerequisites; do not repeat job names. Reuse the workbench focus treatment and flat canvas controls; introduce no new palette or type tokens.

Individual failed-job cards reserve 232px before annotations arrive, keeping node positions stable. Show the failed step and selectable annotation title/message in the card body, separate from the header button that opens details. Short annotations need no extra action. Overflow exposes “Show full annotation”; multiple annotations expose “Show all N annotations.” Expansion increases the card from 232px to 440px, with full content scrolling inside for long output; “Show less” collapses it. Expansion reroutes edges through the Electron cache-only projection without GitHub calls and survives List detours. Notice annotations stay out of graph cards. Cached annotation evidence must match the exact job, run, attempt, and revision. The existing background details preloader prioritizes failures and starts when a snapshot is observed; the graph shares its cache without a separate network loop. Details read cached content first and retain it during refresh, with a small header spinner and accessible refresh status.

Right-click or Shift+F10 on a graph node opens the existing context-menu surface for details or group expansion, dependencies, and GitHub. Individual jobs also offer “Re-run failed jobs in workflow” and “Re-run entire workflow.” Disable reruns for running workflows, pending/requested reruns, and known read-only access; backend permission and revision guards remain authoritative. Keep requested/error feedback visible in the graph workspace.

The View menu offers Adaptive, Compact, and Off radio choices under Parallel jobs. Adaptive is the default: graphs with more than 16 nodes group eligible sets of at least six parallel nodes, largest first, until the planned count is 16 or fewer or no eligible sets remain. Smaller graphs stay open. Compact groups eligible sets of at least three; Off disables inferred stages. Eligible nodes have identical prerequisites and dependants and only finished successful, neutral, or skipped jobs. Active, failed, cancelled, unknown, and mixed groups stay separate; matrix and reusable-workflow groups retain their independent expansion. Plan stage selection before manual expansion, so opening one stage never collapses another. Grouping follows workflow complexity, not window size.

Put keyboard and graph help first in the View popover, followed by visibility, parallel grouping, and source metadata. Keep help wording aligned with the visible Show dependencies control. Save grouping in local preferences; a save error keeps the session choice and explains the failure. Mode changes project prepared workflow data without GitHub requests. Each job offers Show dependencies: ancestors and descendants, excluding unrelated siblings; Back to workflow restores the full scope. Retain names and reported statuses of direct prerequisites outside that scope. Failed outside prerequisites have a visible notice and a Reveal action that returns to the full cached workflow without a network request.

Show skipped and Show passed and neutral are independent checkboxes in View. Passed and neutral means successful or neutral jobs; failures, cancellations, running jobs, and unknown statuses remain visible. When a toggle is off, equivalent jobs collapse into short count summaries while retaining dependency arrows. Only jobs with identical prerequisites and dependants can share a summary. Clicking a summary restores that category. Both categories start visible. Jobs carrying outside-prerequisite evidence stay visible when these categories are compacted.

The shared toolbar’s highlight group shows All jobs, Needs attention, and Running; attention and running counts are scoped to the current graph. Needs attention brings the first issue into view; Next issue cycles through affected jobs and opens their details, expanding a group when needed. Filters and dependency tracing use surface and edge emphasis; keep whole-card opacity and text contrast intact. Running brings the first active job into view.

Selecting a job opens and focuses the existing output, steps, annotations, logs, and rerun tools. Details sit beside the canvas in wide workspaces, overlay its right side at ≤1050px of workspace width, and cover it at ≤700px. At either overlay width, the underlying graph is inert. A sticky detail toolbar keeps Close, Previous, Issue n of m, and Next available while output scrolls. An expandable Needs/Feeds summary lists mapped prerequisites and dependants with reported status and outside-view Reveal actions. Close or Escape, including from issue-navigation controls, returns focus to the currently selected graph job, then the originating control or Graph as fallback. Start graphs at readable 1:1 scale. Center each axis that fits; otherwise show the top of the overview or anchor the focused/selected job. Pan or use the draggable map to explore larger graphs. The map uses danger for attention and warning for running jobs; graph nodes retain status text and icons. Accessible edge names state “target requires source.” Canvas controls provide zoom, Fit entire workflow, and Readable size; the latter restores full-size text. Reframe when the canvas resizes, topology changes, or the focused job changes, including opening and closing details. Status-only updates preserve pan and zoom. Keep the graph mounted during List detours, including External checks, and restore its selected job on return. Account/revision-scoped session state preserves source PR, run, group expansion, visibility, dependency focus, and viewport. Preserve a saved graph after refresh failure, explain its freshness, and offer Retry workflow.

### Source identity and Activity

A sticky header identifies the source PR and file in each code group. It uses a panel surface and 9px by 12px padding.
Keep source attribution distinct from the destination for submitting a review.
Activity anchors background work below the workspace; its drawer shows task names, progress, status, and actions.
The drawer is at most 430px wide and stays within the viewport with a 24px width allowance.
Progress width changes use a 180ms ease-out transition; indeterminate progress uses a 1.5s cycle.
Reduced motion removes these transitions while preserving progress and status information.

### Feedback

Pair concise errors with recovery actions. Put detailed diagnostics behind disclosure controls.
Show saved-summary freshness and fallback status explicitly. Preserve useful content while a background task runs.

### Address Feedback

[PrFeedbackView](components/PrFeedbackView.tsx) extends the existing PR and stack workspace. Keep the compact All / Unread / Unresolved toolbar above divided list and detail panes. Hide GitHub Actions defaults on and persists per account across PRs and restarts. Filter automation-only conversations locally before counting; preserve threads with human or unknown-author replies. In stacks, a searchable PR picker scopes the list, counts, and review-request actions together. Order conversations across the stack by latest activity, including edits. Rows retain the original excerpt and show the latest reply preview and comment count when replies exist. Pair unread emphasis with the existing dot and accessible label; distinguish unresolved code threads, resolved threads, PR comments, and review decisions with explicit text.

Keep Review requests in a bounded, scrolling popover (maximum 640px, with 16px viewport clearance). Each reviewer row identifies its source PR, remaining unresolved threads, and explicit Re-request review action. Show pending and sent states in place. Re-requesting never closes threads or implies approval. Use existing popover surfaces, buttons, semantic colors, and typography; this extension adds no design tokens or shipping raster assets.

Selecting a conversation focuses its heading and marks only that displayed conversation read. Mark unread returns to the list. In the narrow layout, hide list filters while detail is open and use Conversations to return focus to the originating row, with the list as fallback if the row no longer matches. Keep the selected conversation visible while reading changes its filter membership. Read state is independent of resolution. Resolved discussion cards use muted text, a subdued surface and border, and a checkmarked Resolved label; keep actions legible and never strike through comment prose. File trees omit comment decorations for confirmed zero counts.

Show original code context in a labelled disclosure, with saved or outdated context explicit. Start with the last eight hunk lines and offer the full context. Collapse the disclosure at viewport widths ≤760px or heights ≤700px to preserve conversation space. Offer Open in Changes only for a non-outdated thread whose saved revision matches the current PR. General comments and review summaries use an explicit reply hint: posting creates a PR comment linked to the source feedback. Only code threads expose resolve or reopen actions.

Preserve saved conversations during refresh. Use one compact saved-feedback error with Details and Retry; distinguish partial loading and unavailable feedback from a true empty result. Write errors identify the failed action, preserve reply/edit drafts, move focus to the error, and keep diagnostics disclosed. A successful write followed by a refresh failure must say the write was sent. Reuse the shared discussion cache and sync service so feedback, evidence, and thread views reflect the same updates; account-scoped read markers persist in the existing SQLite review-state store.

### Explanation diagrams

D2 diagrams use a fitted, bordered preview within the explanation pane. Named navigation and the active explanation support manual inspection. The existing dialog expands the diagram into the shared pan-and-zoom viewer. Its active explanation sits beside the canvas and moves below it at narrow widths. Additional notes start collapsed. Focus changes highlight exact entities on a stable board while preserving layout and zoom. Explicit walkthroughs offer optional auto-play. Maps, comparisons, and older diagrams without a declared kind use named views without auto-play. Surrounding controls, surfaces, and text use the workbench system. SVG typography and diagram colors stay scoped to the diagram. Reduced motion removes animation and transitions. Source disclosure and a local retry keep errors recoverable. Saved Mermaid diagrams retain their renderer and share the inspection viewer. See [D2 explanation behavior](docs/d2-explanations.md).

Implementation references: [global styles](src/globals.css), [review panes](components/SlideView.tsx), and [code highlighting](lib/highlight.ts).
Sidecar snippets illustrate the primitives without a React or Tailwind runtime; application components remain the implementation source.

## Do's and Don'ts

### Do

- Do check light and dark themes at laptop widths.
- Do preserve visible keyboard focus and clear selected states.
- Do keep source identity visible while code scrolls.
- Do keep progress and status available through Activity.
- Do use existing components and semantic CSS variables.

### Don't

- Don't restore newspaper mastheads, serif display headings, or oversized margins.
- Don't turn dense queue rows into a grid of large cards.
- Don't confuse source attribution with the review submission destination.
- Don't rely on animation or color alone to explain status.

Bulk check reruns are available in the stack overview and Checks toolbar. Group by workflow run; failed workflows rerun failed jobs and dependents, while any cancelled job makes the run use all jobs. Confirm the affected PRs and workflow scope. Exclude running workflows and external providers; retain accepted requests after partial failure so Retry only submits remaining workflows.

Stack and PR names carry a leading identity icon in headings, navigation, selectors, and saved history: Lucide BookMarked for repositories, Layers for stacks, and GitPullRequest for PRs. Repository names in selectors and setup reuse RepositoryMark so configured repository icons and colors remain consistent. Preserve the existing status-aware PR icons in queue rows. Do not duplicate an icon when the adjacent PR badge already identifies the same row. Keep icons decorative, text searchable, and long option labels wrapping; local repository reviews are not labelled as PRs.

Commit breadcrumbs show the first line of the commit message with GitCommitHorizontal, retaining the hash in the searchable picker. File breadcrumbs and picker options use the shared FileTypeIcon for the path, including light/dark variants. Long breadcrumb labels truncate; picker labels wrap.

Workspace section icons use the shared WorkspaceIcon mapping in tabs, breadcrumbs, selectors, and related navigation: Summary = LayoutList, Changes = FileDiff, Commits = GitCommitHorizontal, Checks = ListChecks, Explanation = BookOpen, Local notes = NotebookPen. Keep visible text labels; icons are decorative and inherit text color. Check status icons continue to represent status rather than section identity.
