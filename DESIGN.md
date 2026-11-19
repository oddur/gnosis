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
  success: "#216e39"
  danger: "#b42336"
  warning: "#855900"
  info: "#6941a5"
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
  dark-success: "#85cf99"
  dark-danger: "#ff9ba5"
  dark-warning: "#e9c46a"
  dark-info: "#c7adf5"
typography:
  headline: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 30px, fontWeight: 650, lineHeight: 1.4, letterSpacing: "-0.02em"}
  title: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 24px, fontWeight: 650, lineHeight: 1.35, letterSpacing: "-0.025em"}
  title-compact: {fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif", fontSize: 20px, fontWeight: 650, lineHeight: 1.4, letterSpacing: "-0.02em"}
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

Status badges use opaque `--status-*-bg` surfaces paired with their semantic ink. Amber distinguishes waiting from red failures; purple remains merged. Active workspace tabs and selected check rows use blue. Selected secondary text uses `--selection-muted`, a blue-derived ink. Activity uses blue for running, green for completed, amber for warnings, and red for failures. Resolved feedback keeps its checkmark and green state label while the conversation title recedes. Keep headings, feature icons, and reading surfaces neutral.

**The Status Rule.** Pair status colors with text or icons. Color alone must not carry review state.

## Typography

Plus Jakarta Sans supplies interface text, headings, and explanations. Display and serif aliases also resolve to this sans-serif family.
JetBrains Mono is the default code family; settings offer other code fonts. Default variable fonts are bundled through [src/fonts.css](src/fonts.css). Optional code families load when selected.

- **Headline:** overview and explanation-slide titles use 30px.
- **Title:** page and queue titles use 24px with 1.35 line-height; inspection headers retain their compact treatment.
- **Panel title:** briefing, dialog, chat, and explainer headings use 20px with comfortable multiline leading.
- **Section title:** application sections use 18px, distinct from 15px row titles and 13px controls.
- **Body and prose:** interface text uses body; explanations use prose with a usual maximum width of 68ch.
- **Labels:** queue titles use label-row. Metadata uses 12px; compact controls use 13px.
- **Code:** preserve selectable monospace text. Code themes are independent of the interface theme.

Review narratives, PR descriptions, overview summaries, and chat messages use 16px text. Queue titles, briefing summaries, inline explanations, GitHub comment bodies, and file summaries use 15px. Controls remain 13px and metadata 12px; descriptions of settings use 13px with 1.6 line-height. Review narratives and chat keep bounded reading columns. Author PR descriptions fill their column beside People & branches; the shared page frame bounds the overall width. Queue summaries use at most 75ch.
Semantic `--type-*` tokens use rem units. Dense controls stay smaller than reading text to fit the laptop workspace. Keep badges in sentence case at 12px or above.
Shared reading roles use 1.65 line-height. Dark prose uses weight 425, slightly wider tracking, and 1.7 line-height across narratives, PR descriptions, chat, discussions, and inline notes. Use upright, full-contrast text for chat questions and answers; role labels identify the speaker.
Code uses the selected monospace family. Pierre diffs and Markdown blocks share a 13px size and 20px line-height through rem tokens, so text scaling works in both renderers. Fenced code remains a scrollable block even without a language label. Inline code follows its surrounding prose.

Rendered Markdown shares one heading system across explanations, descriptions, chat, GitHub comments, and Markdown diffs. At a 16px body size, H1–H6 use **28 / 24 / 21 / 19 / 17 / 16px**, weight 650, and 1.3 leading. Heading sizes scale with the reading container; 15px comments retain a proportional hierarchy. Give a new section more space above than below, while consecutive headings stay grouped. Scope author headings to the accessible page outline without flattening their source-level visual hierarchy, even when multiple levels map to H6. Keep authored heading text and nesting intact.

Use 16px full-contrast prose for narrative context and review guidance. Lists have consistent item spacing and a smaller gap around nested lists. Quotes retain readable foreground contrast. First and last content blocks do not add outer space. Tables use 15px text in a 16px reading context; code scrolls within its own block. Preserve the existing bundled font subsets and swap behavior; this pass adds no font assets.

**The Reading Rule.** Make titles, sections, subsections, and body text distinguishable before the user reads the words. Keep explanations within a 68ch column and preserve reflow at 200% zoom.

## Layout

Use a viewport workspace with scrolling appropriate to each surface. Explanation uses one scrolling document; Changes, Feedback, and other inspection workspaces retain their own pane layouts. The workspace reaches the bottom edge of the window; Activity lives in the title bar.
One quiet 38px title bar row replaces the native title bar, tab strip, and workspace header. From the start: window controls, the sidebar toggle (when the screen has a sidebar), Recently viewed, Back and Forward, the workspace tabs as low-contrast 26px pills, and New tab. At least 120px of empty row after New tab always moves the window; only buttons and tab pills opt out of dragging. The Activity capsule, Search, and the round account avatar sit at the end. The capsule appears only while work runs or a failure or result is unseen. The avatar menu holds the review queue, Activity (⌘⇧A), GitHub account, model and effort, Settings, and Help. Tabs narrow to 140px, then scroll with an open-tabs menu.

| Surface | Wide layout | Narrow behavior |
| --- | --- | --- |
| Queue sidebar | 232px; collapsible to a 52px icon rail | At ≤850px, use the rail with an expandable navigation popover |
| Briefing pane | 360px, maximum 44% | 320px at ≤1100px; maximum 50% at ≤850px; replaces the queue at ≤620px |
| Explanation reader | One scrolling document; each section pairs prose and code in 2:3 columns with a 32px gap | At ≤850px of reader width, including beside chat, stack prose then code with a 24px gap; no pane tabs |
| Overview | Maximum 1100px; 1.4fr/1fr columns; 32px gap | One column at ≤850px |
| Settings | Maximum 672px wide and 80dvh high; internal scrolling | Tabs form two columns at ≤620px |
| Summary | A band (briefing, merge readiness) that scrolls away; the timeline (description first) beside a 300px details column, 28px gap; the timeline's bar and the column stay pinned | At ≤1100px of workspace width, the details become a compact strip above the timeline; the bar wraps |
| Checks graph | Canvas with a 260px workflow sidebar; selected job opens the existing detail pane beside it | At ≤1000px viewport width, workflows use an overlay drawer; at ≤1050px workspace width, details overlay the right side, covering the canvas at ≤700px |

Explanation sections have 28px vertical and 24px horizontal padding, reduced to 24px and 20px in the stacked layout. Other review prose retains 20px vertical and 22px horizontal padding; code panes use 16px.
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
The Activity panel uses the drawer radius; its title bar capsule is fully rounded. The settings dialog retains square outer corners.

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
Briefing status chips sit in one quiet row below the queue toolbar: All, Generating, Ready, and Paused always; Queued and Failed only when present. They use the title bar pill treatment (24px, 6px radius, muted text, tonal hover and pressed fills) with a small semantic dot and a tabular count. Paused names its reason when there is one. Counts come from the loaded snapshot with every other filter applied; a chip sets the shared `briefing` queue filter, so saved views, Filters, and Clear filters include it. The row ends with the automatic budget and a Briefing settings button; narrow windows keep the chips on one fading, scrolling line and move the budget into the button tooltip. A row whose briefing is generating shows a 1px shimmer on its lower edge, static under reduced motion.

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

A stack summary has one merge verdict above the dependency list. The list is a table bounded at 80rem, so its columns stay near the titles on wide windows. Each row shares fixed Review / Checks / Branch tracks, named once in a column header, on the same line as the PR's state icon, number and title. A quiet second line carries the branch, the base only when the spine does not already show it (the bottom PR, or a non-adjacent parent), and viewed files as a small 40px bar with the count. Remedies follow under the row. Defaults stay quiet: no review decision and an up-to-date branch show a muted dash with accessible text, passing checks show the passed count without the skipped tally, and an optional update shows only "N behind". Words and color are reserved for states that need action. Merged and closed PRs recede: a muted title, one Merged or Closed label across the status columns, and no details disclosure. The list heading summarises merged PRs, PRs needing attention, and files viewed in open PRs. Below 760px of list width, the strip moves under the title in three equal tracks with visible labels. Confirmed blockers use red; non-blocking check problems use amber. Optional updates and skipped checks use muted text.

Checks follow new attempts on the displayed commit automatically. A new commit requires an explicit switch. After a rerun request, label old output as the previous attempt until GitHub reports new results. Background allowance pauses are informational and show the automatic retry time. Refreshing one PR must not refresh the full stack.

A compact “To merge this stack” action panel groups required actions and links to the affected PR overviews, ordered base first within each group. Drafts have a one-click “Mark all ready” action with inline progress and partial-failure recovery. It changes only draft status, and retains the existing permission and revision guards. Show each blocker and its remedy in the PR row without expansion. Name required check failures; separate running checks as waiting. Keep optional check results outside the required-action list. Expand a row for supporting check details. Show separate timestamps for merge requirements and check results, including missing or delayed results; when both were read at the same time and neither is stale or delayed, the header says "Merge status checked …" once and its tooltip keeps both times. Remedy and plan links use primary ink without an underline at rest, underlined on hover. Permission reads start on action, with the existing confirmation and revision checks. Ready rows omit redundant details. Below 620px of content width, the status strip becomes a vertical label/value list. The compact stack-context sidebar keeps its separate navigation layout.

PR summaries keep the review decision and Review PR action in the persistent header. On Summary, show merge readiness once in a compact decision area, above a wrapping row of directly visible PR actions. Keep freshness and actionable blocker details visible; omit ready-state prose that only repeats the verdict. Keep Merge, auto-merge, both branch-update methods, draft conversion or Mark ready, and permission refresh directly visible, with their existing guards and confirmations. Resolve conflicts appears when applicable. Other tabs retain merge readiness in the header.

**The Stable Header Rule.** Every PR and stack tab renders the same header: breadcrumbs, the 24px title and its actions, the metadata row, the status row with Drafts and Review PR, and the tab bar. Switching tabs, loading a tab, or opening chat never moves, resizes, or hides any of it; only the active tab indicator and the content below the tabs change. No tab compacts the header. Tab labels reserve their semibold width so selection does not shift later tabs. On Changes, the header keeps the review-action space while the Changes toolbar shows the same controls for the loaded diff. On other tabs, Drafts and the review dialog open in a bounded panel directly below the tabs. At heights of 500px or less, every tab scrolls the whole page in the same way. `npm run test:browser:docker -- --header-stability` checks this.

Show check, review, and discussion summaries once below the merge decision. The checks summary opens Checks; the review and discussion summaries expand details and move focus to the evidence heading. Unknown checks use an uncertainty icon. Normal sync boilerplate stays quiet, but unavailable, stale, or delayed results remain explicit. Discussions load only on expansion. The icon refresh control has an accessible name.

Follow with the author description and a 260px metadata column. Put change size beside Author description as a link to Changes. Saved AI briefings are collapsed above the description and remain explicitly labelled. The stack-context disclosure lives in the metadata column, where expanding it does not displace the description. Below 850px of available content width, metadata follows the description. Keep the existing prose scale, semantic colors, and shared page frame. Stack summaries lead with the dependency list, which already shows review, check, and branch status for each PR. Detailed GitHub evidence follows that list, before the stack briefing. Use the existing 24px stack section gap without additional evidence margins. Expanding the disclosure must not shift the dependency rows above it.

### Workflow dependency graph

[WorkflowGraph](components/WorkflowGraph.tsx) extends Checks with a searchable workflow sidebar and an icon-labelled List/Graph segmented toggle whose shared bordered surface, blue selected accent, and ring border reinforce its `aria-pressed` state. Checks compresses the PR heading and supporting metadata to give evidence more room. Stacks add a source-PR selector with attention counts. One shared toolbar groups List/Graph, the source-PR selector, Workflows toggle, selected workflow name and GitHub link, View, highlight filters, Next issue when issues exist, freshness, bulk rerun, and refresh. Groups wrap as space requires and remain accessible above open details. At viewport widths ≤1450px, freshness uses a clock with its checked-time title and screen-reader text; wider layouts show the text inline. The View menu holds revision, job count, and workflow source details.

The left workflow sidebar is 260px wide on desktop. Its summary repeats the Checks tab outcome for the selected PR from the same check snapshot. It lists every source of checks, failures first and then by name, like List: Actions workflow runs, plus one entry per other app or status provider (for example a CI service reporting check runs) and one for Actions jobs whose run is not listed. Each entry shows a status icon and text. Selecting a provider shows its checks as standalone job cards, failures first, with an external link per check and no dependency arrows. While an Actions graph is shown, failures it does not draw stay named in a notice with a Show action, so the graph never looks green while the tab count is red. The toolbar and heading counts include these entries. Duplicate names include file/event context. Exact job totals come from cached API counts for that run attempt; matching revision/attempt check evidence supplies provisional N+ totals, and unknown totals read “Jobs: —”. Search matches names, paths, and events locally. Arrow keys, Home, and End move focus without selecting; Enter selects. Close or Escape returns focus to Workflows. With multiple workflows, desktop defaults open; at viewport widths ≤1000px it defaults closed and opens as an overlay drawer with the graph inert. The workflow session retains manual open/closed state. The source-PR dropdown remains in the toolbar. Cold workflow loads use a centered, padded canvas state with a small animated node-and-connection motif, a readable heading, and phase-specific supporting text. Show elapsed seconds after five seconds without live-region timer announcements. Respect reduced motion, keep navigation usable, and omit canvas zoom controls until jobs exist. Errors and empty workflows have distinct static states. Workflow selection retains the current graph until the target is prepared, with a spinner on the pending sidebar row. Swap the graph and its viewport together before paint. Restore each visited workflow’s pan and zoom for the same topology; late selection responses cannot replace a newer selection. Measure current canvas bounds when fitting so delayed resize notifications do not recenter the graph twice.

Opening Checks warms the first PR needing attention, falling back to the first PR, subject to the API reserve. Without a saved selection, Graph also prefers that PR and chooses a workflow needing attention before an active or completed healthy run. When no Actions run or job needs attention but another provider fails, Graph opens that provider. Leaving Checks drops queued preparation. Cold graph loads use interactive priority: jobs and workflow sources load concurrently, with at most three opted-in HTTP reads, paced request starts, and shared backoff. Writes and ordinary background reads remain serialized.

The backend reads workflow YAML at the run's immutable revision. Jobs flow left to right along declared prerequisites; matrix and reusable-workflow groups expand into their jobs. Show actual reported statuses with icons and text. A failed prerequisite is supporting context, not an inferred replacement for a downstream job's status. Missing mappings stay disconnected and carry an explicit notice whose summary names what is missing, such as jobs without dependency arrows or an unreadable workflow source.

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
Activity is a 24px capsule in the title bar, before Search: “◐ 2 running”, “✕ 1 failed”, “✓ 1 ready”. It shows only while work runs or a failure or result is unseen; opening Activity marks results seen. Preparing PRs and refreshing GitHub never bring it up on their own. The avatar menu and ⌘⇧A / Ctrl+Shift+A always open Activity.
The capsule opens a panel below the title bar, at most 440px wide and within the viewport with a 24px allowance. The panel lists every task as Task Rows with cancel, retry, open, and dismiss actions.

**Task Rows** ([TaskRows](components/TaskRows.tsx)) show a parent task with a status mark, title, and short facts, and its subtasks indented beside a thin rule. Marks differ in shape as well as color: hollow (waiting), turning half-filled ring (running), filled check (done), filled cross (failed), dashed (cancelled), and each carries a text label for assistive technology. Failures show their real error inline on the row that failed, on a danger surface. A finished group folds into one line with a toggle such as “6 topics”. The pattern follows “Task Rows” in Beautiful UI (MIT); the implementation is Gnosis's own.
Progress width changes use a 180ms ease-out transition; indeterminate progress uses a 1.5s cycle; the running mark turns once per 1.4s in rows and rests as ◐ in the quiet title bar capsule.
Reduced motion removes these transitions and stops the running mark as a still ◐, preserving progress and status information.

### Notifications and toasts

Unread is the durable record of what changed. A notification announces the actionable subset once: a review requested from you, changes requested on or approval of your PR, failing checks, ready to merge, and explanation ready. Each event gets exactly one surface: a toast when a Gnosis window has focus, a desktop notification when none does, nothing when the PR is already open in the focused window. Events for one PR settle for 20 seconds and coalesce; three or more after a launch, wake, gap or pause become one summary that opens the Unread view. At most three desktop notifications in five minutes; the rest wait as one digest.
Toasts use the Base UI toast only. A toast is `role="group"` with `aria-roledescription="notification"`, never a dialog; the viewport is the polite live region. Each notification toast shows a kind icon, a text title that states the status, an `owner/repo #123` line, the PR title, and one action that opens the right tab. A toast raised while the window is unfocused waits and gets 10 seconds once the user returns. Marking a PR read closes its toasts. Notifications never write to GitHub and carry no action buttons on the desktop. Nothing asks for permission on launch: the first PR-event toast offers **Turn on** and **Not now** for desktop delivery.

### Menu bar panel

On macOS a click on the menu bar icon opens a 360 pt panel that answers one question: is there something for me? It shows the current state of the same attention model notifications announce, one row per PR in fixed groups (To review, To fix, Ready, In progress), at most five rows a group. Rows are 42 pt, two lines: the title, then the reason in words, which leads and never truncates, then `repo #123`, the author for reviews, and the status age. A row does not repeat its group: no "Review requested" or eye icon under To review, no "Ready to merge" under Ready; other kinds keep their icon beside the words. Rows from one stack sit together under one muted line ("Stack · 9 PRs · ivar") and show only their number. A new row has a primary-coloured dot in the left gutter that reads "New". There is one selection: the pointer moves it as in a native menu, and the keyboard carries on from it; hover adds no second highlight. The header states the summary ("15 need you · 9 new · 20 ready"); "9 new" is the number on the icon, from the same count, with the same dot, and is left out when the icon shows every PR or nothing. Below it, muted, the data's age or the connection state ("Offline · last updated 14:02"). Left edges are 20 pt for the header, group labels, kind icons and footer, and 44 pt for titles, the stack line and "N more in Gnosis". The panel follows the system appearance, not the app theme, because its vibrancy does; it uses the shared tokens only, with a translucent `--popover` fill over the material and an opaque one under reduced transparency. It never writes to GitHub and has no avatars or remote images. A row opens the exact place in the main window; everything in the panel stays reachable from the main window.

### Overview

The Overview ([OverviewPage](components/OverviewPage.tsx)) is the default home tab, first in the sidebar's Reviews group. It is a front page, not a list: it answers what can be acted on now, across every repository. The header has one 12px muted status line, "Updated 9m ago · checking 28 PRs" ("N not checked" when no read is in flight; "Updating…" while a sync that is over 10 minutes behind runs), and the refresh button. When GitHub reads fail, the notice that the page shows saved data links to Activity; other failures stay in the title bar. Under the title, a briefing sentence in 16px foreground text counts from the sections below it, never apart from them: who is waiting on your reply (at most two people), reviews and re-reviews with their stacks spelled out, approved merges, merges without review, fixes by reason, and decisions: "7 re-reviews (6 in one stack) are waiting on you. 10 PRs can merge without review, 14 have failing checks, 4 have conflicts, and 1 needs rebasing. 7 PRs need a decision." Each number is an underlined text link that opens the groups holding its rows, marks them with the accent surface for a moment and focuses the first. With nothing to do it says "Nothing needs you right now.", and mentions Waiting on others. It is built with no model call; it is plain text, and count changes are announced once by a separate polite region.

Below the briefing, a 13px muted "Since yesterday" line says what changed since the last visit: merges, new review requests, who replied, and checks that turned red or green ("Since yesterday: 3 merged · 2 new review requests · owen and lena replied · checks failed on 1, passed on 2"); with nothing new it says "Nothing new since yesterday". The page is a morning page of headed lists, not cards: each section has an 18px semibold heading (the section-title step) with its muted count inline and a hairline under it, then single-line rows that fill with the secondary surface on hover. **Next up** leads, full width: at most five rows, by tier (people blocked on you, then approved and passing merges, then fixes on your PRs) and, within a tier, by an internal effort rank, what a step unblocks, then age. A merge nobody reviewed is never a row: a quiet line under the rows counts them ("10 ready to merge without review ›") and opens the queue at Merge. Each row has a muted one-line why and one visible action. The page shows no time estimates. **Waiting on you** and **Waiting on others** follow, full width: people and blockers as rows with a chevron that expands to their PRs ("lena · 2 PRs · oldest 4 d"); a requested reviewer has a Nudge button, and "You" links to Fix in the queue. Waiting on you points at the Next up rows that hold its PRs, as a link ("#377 and #37286’s stack (6 PRs) are in Next up ↑"). Stacks are one line each by default ("Launcher i18n · seed-launcher · 5 PRs · #379 has conflicts") with one action; Enter or a click expands the chain, and expanded stacks are remembered. A stack whose step is a Next up row says "next step in Next up ↑" instead of a second action; a base nobody reviewed, or without checks, opens rather than merges. Chain rows say `repo#number` when stacks from several repositories are on the page. **Needs a decision** comes last with a muted heading: PRs failing, never approved or idle for over a week, whose Close PR action appears on hover or focus (Snooze is in the row menu and on Z); it lists six, then "Show N more". Nudge and Close PR confirm in the merge dialog style; Close PR uses the destructive button, takes an optional comment and says the PR can be reopened. Each section is a labelled region with one roving tab stop: Tab moves between sections, j/k and the arrows within one; Enter opens a PR or expands a person or stack, A runs the row's action, Z snoozes and Shift+F10 opens the menu. The unread dot marks a PR whose own state changed since the last visit, never one that was only unopened or loaded late; titles stay at their weight. Sections come from [lib/morning.ts](lib/morning.ts) over the lanes of [lib/overview.ts](lib/overview.ts).

Every Overview row leads with what it is, in the queue's icons: a PR its `PrStateIcon` (draft and open differ), a row for several PRs of a stack and every stack header Layers, a person their avatar (You the signed-in account's), a team or unnamed reviewer the user icons, CI the Checks icon. The title takes the row's room; the repository and detail get what is left and truncate first. Right of the title, three fixed columns line up down the page: one compact status cell (the check state in the queue's check icons, then the queue row's comment badge above 0), a chain's status word, and the age ("4 d") with an Hourglass, whose tooltip names its source ("Waiting since your last review", from `OVERVIEW_SINCE_LABEL`); then a 7.25rem action column. Rows never say "green" beside a passing check, and a PR whose parent merged "needs rebasing after #N merged". Buttons that change something carry their icon (Merge, Rerun, Nudge, Close PR); buttons that only open a PR (Review, Re-review, Reply, Open) carry none. Conflicts use the conflict icon wherever they appear. A stack's step says what its merge goes ahead without, as Next up does: "Merge #376 (not reviewed, no checks) to unblock 3 PRs", in the button's tooltip too. Status reads use visible priority while the Overview is the shown tab of a visible window, and background priority otherwise.

Overview type steps down in one ramp: the 24px page title; the 16px briefing in regular weight with 1.6 leading, a 64ch measure and pretty wrapping, whose links rest as a faint dotted underline in the sentence's ink and take the link colour with a solid underline on hover; 18px semibold section titles with a regular count; 13px semibold group headers (a person, CI, the stacks, You), as the queue's group headings; 15px regular titles on every PR and stack line, unread or not; and one 12px muted caption for a line's number, repository, detail, check, comments and age, with tabular numerals. Chain titles stay 13px muted, the next one in ink at medium weight. Status words (Next, Waiting, Conflicts, Nudged) are 12px medium: muted, the next step in ink, conflicts in red with their icon. Every separator is " · " in the caption's colour. Titles and details truncate at a word, never inside a number.

The queue and saved views offer Group by beside the sort control: None (the default), Action and Repository. Action uses the Overview's lanes in its order, then Parked and Other; Repository goes alphabetically. Each group has a sticky, collapsible heading in the muted band of the queue's sections, with its count; collapse state is remembered per list on this computer, and the sort applies within each group. The grouping is saved with a view and travels in queue links as `group=action` or `group=repository`.

### Snooze and mute

Snooze means "not now"; mute means "not mine". Snooze sits directly above Mute in every PR menu, and Tools › Snoozed sits above Tools › Muted PRs. One picker serves the row menu, `Z`, the PR header, the bulk menu and the command palette: three times on the local calendar with their time on the right, then "Until new activity" and, for your own PRs, "Until checks finish", then Custom… with a date and a time. A muted footer says that timed snoozes also end on a new review or review request. After a snooze, focus moves to the next row and a toast names what was snoozed and until when, says what is still pending, and offers Undo; Mute offers the same Undo. A snoozed PR leaves every queue section, saved view, count, the menu bar, the badge and notifications. A snoozed PR inside a stack keeps the stack row, dimmed and labelled Snoozed. A PR that wakes returns unread with one plain caption line, "Back: new review from lena · snoozed 2 days", in foreground ink with a muted alarm clock, until it is read; the menu bar panel puts "Back" before its status and counts the snoozed PRs in its footer.

### Feedback

Pair concise errors with recovery actions. Put detailed diagnostics behind disclosure controls.
Show saved-summary freshness and fallback status explicitly. Preserve useful content while a background task runs.

### Workbench copy and density

Name the task or state directly: “Set up Gnosis,” “Queue filters,” “No explanation yet.”
Do not add a promotional introduction before a control or repeat what its label already says.
Keep visible PR actions, revision warnings, source identity, and recovery guidance.
Show one action for each destination; identify saved explanations as previous when they cover an older revision.
Omit empty generated sections. Keep model information below briefing content, separate from the review status.
Group settings by the decision: queue defaults, briefing defaults, and briefing model. State inheritance once per group.
Use spacing and headings to separate these groups, without nested cards or decorative status icons.
Healthy automatic refresh needs no persistent visible caption; refreshing, partial data, and errors do.

### Address Feedback

**Summary (#418).** Summary and Feedback are one page, the **Summary** tab (`summary`, LayoutList icon): the PR's description, its conversation in order, and its details. Top to bottom: the PR header as before; a band with the review drafts panel, warnings, merge readiness as one line (verdict, checked time, and its reasons, ellipsized; **Details and actions** opens the full reasons and the PR's merge actions, and a merge landing opens it), and the AI briefing collapsed to one line; then the timeline beside the details column. The PR description is its own section at the top of Summary's timeline column, above the timeline's bar and beside the details column: who opened the PR and when, the change stats as a button into Changes, **Edit on GitHub**, and the whole description at 16px prose, never cut off. It is not sticky; a long description would take the view. The timeline then opens with a one-line event, "lena opened this PR · date", on the PR-opened node, with no body. On a stack, each PR's description is one line (number, title, first words) that opens in place to the whole description, and the PR picker shows one PR's description in full. The details column holds a stack member's place in its stack, reviewers with their current verdict (icon and words: Approved, Changes requested, Commented, Review requested), the review evidence (checks, reviewed commit, discussions, **About these results**) with **Open Checks**, and branches, labels, assignees, commits, head revision and creation date. On a stack there is no details column: the band holds the stack overview (its merge plan and its PRs with their blockers, a wide table that decides where to read next), the evidence and the stack briefing, and the timeline below takes the full width; its PR picker filters by member. The page scrolls as one, so the band gives its space back; the timeline's bar and the details column stay pinned. At 1280×800 the band is one line; with a short description the first feedback starts above the fold, and a long description pushes the timeline down rather than being cut off. The first day needs no day marker; the bar's buttons are tight enough to stay one row beside a details column that narrows to 260px below 1400px. Opening a PR on Summary reads it, as before.

Feedback is no longer a tab. Every route into it opens Summary at the same thread or filter: the tab list and `1`–`9` keys skip it, `conversationTab` maps saved and restored tabs, history and the Overview, deep links keep `…/feedback?thread=` and route to Summary (`workspaceTab`), and notifications, Address feedback from Changes and the stack overview, review evidence and Needs my response land on their entry.


[PrFeedbackView](components/PrFeedbackView.tsx) shows a PR's or stack's feedback as **one timeline**, oldest first, across the full width of the workspace ([lib/feedback-timeline.ts](lib/feedback-timeline.ts)). It interleaves the PR description, PR comments, reviews with their verdicts (**Approved**, **Changes requested**, **Review**), code threads, pushes (consecutive commits by one author read as one row, "pushed 3 commits", with short SHAs and a copy button), force-pushes, review requests, and merge, close and reopen events. Each item sits where its conversation started; replies stay in their thread. Prose keeps its measure (`--measure-prose`); code runs as wide as the window and wraps. People's comments are cards; bots are quieter dashed cards with a **bot** tag, and consecutive comments from one bot collapse into one row ("github-actions · 3 comments: Static Data Validation Passed, …") that expands in place. Events and pushes are one-line rows. When GitHub has more than the latest 100 events, a row says earlier ones are on GitHub. **Big groups collapse** (`BIG_GROUP`, 8): a push of more than eight commits shows a deterministic summary ("31 refactor · 8 content · 6 fix · 3 docs · 1 test · 11 merges from local/cv2-scope": conventional prefixes counted, unprefixed commits as other, merges grouped by the branch they brought in), the first four meaningful subjects (no merges or fixups), and **Show all 60 commits**, a button with `aria-expanded`. Opened, the push lists its commits in order with each branch's merges as one line where the first merge was, which opens too; **Show less** collapses it. Runs of force-pushes or review requests by one person are one row ("oddur force-pushed 5 times") with four lines and **Show all**; a bot run's toggle reads **Show all 3 comments**. Open and closed state lasts the session. Each group is one row for `j`/`k`, and the virtualizer measures it as it opens, so the rail stays continuous. No AI summary.

**The rail.** Every row sits on a vertical rail ([components/ui/timeline.tsx](components/ui/timeline.tsx), adapted from ReUI's MIT-licensed Timeline). Its node, a 24px circle with a 14px Lucide icon tinted by the kind's semantic tone, names the kind in its accessible label and tooltip; the sentence beside it says the same in words, so meaning never rests on colour. Kinds: PR opened (pull request, neutral), comment (message, neutral), approved (circle check, success), changes requested (message warning, danger), review (messages, neutral), dismissed review (quiet), unresolved code thread (message dot, ring), resolved code thread (check, success), outdated code thread (history, warning), pushed commits (commit, quiet), force-push (compare arrows, quiet), review requested (eye, quiet), merged (merge, info), closed (closed PR, danger), reopened (pull request, success), bot (Bot, quiet), new since you last looked (bell dot, ring), day (calendar, quiet), earlier events (history, quiet). Unread rows add a small ring-coloured dot on the node's shoulder and a **New** badge; the keyboard cursor rings the node, and keyboard focus also outlines the sentence. The line runs behind the nodes, which keep a 3px background halo so it meets them cleanly. It is dimmer through history the reader has seen, ring-tinted from **New since you last looked**, and dashed where the conversation paused for two days or more, with the pause in words ("21 days later"). Each virtualized row draws its own full-height segment, so rows placed back to back draw one continuous line; the first and last rows trim it to their nodes.

**Type and rhythm.** Row title: 15px (`--type-body`), weight 450, actor 650, file and line in 13px mono on a muted chip. Quiet rows (bots, pushes, events, markers): 13px muted titles. Badges: 12px, weight 550, 20px pills, sentence case. Meta (PR, time): 12px muted, tabular. Comment bodies: 15px prose within `--measure-prose`. Code: the shared 13px code tier. Spacing: 8px from title to card, 24px between rows, 12px between card-less events, and 16px around day markers. Item actions (Mark unread, On GitHub, Show or Hide conversation) stay hidden until the row is hovered, focused or under the cursor; at narrow widths they always show. The bar is quieter than the content: unchosen filters use muted text.

A slim bar above the timeline never scrolls. It holds **All / Unresolved / Unread / Mentions** with their counts (filters hide other items and all events), **Next unresolved ↓**, Previous / Next item with the position ("12 of 40"), the stack's PR picker, Hide GitHub Actions, Review requests, Refresh, and the sync status. Hide GitHub Actions defaults on and persists per account; it filters automation-only conversations locally before counting and keeps threads with human or unknown-author replies. In stacks, the PR picker scopes the timeline, counts and review requests together. A **New since you last looked** divider, a ring-coloured rule with its label, sits before the first conversation with unread comments when something before it was already read; it stays put for the visit and the timeline opens there. Unread items carry the existing dot with its accessible label; **Mentions you** marks items where someone else @-mentions the reader.

Rows are virtualized (`@tanstack/react-virtual`), so code excerpts mount only near the view; a 500-item PR mounts under 40 rows. Each row is a keyboard stop with a visible ring; the cursor (`aria-current`) shows a thinner ring. Keys, which run before the PR-level `j`/`k` while Feedback is visible: `j`/`k` next and previous item, `n` next unresolved thread, `r` reply, `e` resolve, `u` mark unread. They press the item's own buttons and never fire while typing.

Keep Review requests in a bounded, scrolling popover (maximum 640px, with 16px viewport clearance). Each reviewer row identifies its source PR, remaining unresolved threads, and explicit Re-request review action. Show pending and sent states in place. Re-requesting never closes threads or implies approval. Use existing popover surfaces, buttons, semantic colors, and typography; this extension adds no design tokens or shipping raster assets.

An item becomes read after it stays mostly on screen for about a second while the window is visible; opening the tab reads nothing by itself. **Mark unread** keeps the item unread while it stays on screen. Filters keep the cursor's item visible when reading changes its membership. Read state is independent of resolution. A resolved thread collapses to one line ("Resolved · maya on `worker.ts:34` · 2 comments · resolved by oddur") that expands in place; a thread resolved during the visit stays open. Resolved discussion cards use muted text, a subdued surface and border, and a checkmarked Resolved label; keep actions legible and never strike through comment prose. File trees omit comment decorations for confirmed zero counts.

A code thread reads inside its code, as on GitHub's Files view. [FeedbackCodeThread](components/FeedbackCodeThread.tsx) renders GitHub's saved hunk through the shared diff (ReviewDiff over ChangesDiff and useDiffFileModel), framed as an Explanation topic's file: one code-tier file header with the path, the anchor (**Line 36**, **Line 42 when commented**, or **Earlier revision · line 9 when commented**), the thread's state, read and mention marks, and its actions (Collapse, Mark unread, Open in Changes, Show full file); hunk headers with breadcrumbs; gap bars that name only their hidden lines (`plainGaps`, never the Explanation wording); and the reader's code theme. The diff is always unified and wraps long lines, so a thread never scrolls sideways. In the timeline, file and hunk headers stay in place rather than sticking. GitHub saves each hunk up to the commented line, so the thread card sits under the hunk's last line. Only when GitHub's current line still matches that line do the gaps and breadcrumbs read the PR head; otherwise the code is shown as it was, and earlier revisions add a one-line note. The thread reads oldest first: the opening comment, then replies indented on a 1px rail. Thread actions (Reply, Resolve thread, Resolve & next, Reopen) sit under the thread card; the reply composer opens inside the thread only after Reply. **Show full file** (or **View current file** for earlier revisions) opens the shared Changes file below the thread without repeating conversations, and reuses the shared Changes cache on demand. Keep the inspected revision pinned. Missing files and failed reads retain the conversation and original hunk. Older threads may compare a current file, but their old coordinates never attach to that code. **Open in Changes** is optional navigation for broader inspection; only matching head/base revisions receive a line jump. PR comments and review summaries render GitHub Markdown and sanitized HTML (rehype-raw and rehype-sanitize, as PR descriptions do), so bot comments such as Linear's `<details>` link-back read as a disclosure, never as raw tags. Review summaries show their verdict beside the author and link to their code threads. General comments and review summaries use an explicit reply hint: posting creates a PR comment linked to the source feedback. Only code threads expose resolve or reopen actions.

Preserve saved conversations during refresh. Use one compact saved-feedback error with Details and Retry; distinguish partial loading and unavailable feedback from a true empty result. Write errors identify the failed action, preserve reply/edit drafts, move focus to the error, and keep diagnostics disclosed. A successful write followed by a refresh failure must say the write was sent. Reuse the shared discussion cache and sync service so feedback, evidence, and thread views reflect the same updates; account-scoped read markers persist in the existing SQLite review-state store.

Stack review blockers use **Address feedback** to open the source PR’s review summary in Feedback. **Address code threads** selects its first unresolved thread in the same workspace. Feedback owns the timeline, code context, item navigation, Resolve & next, and review requests. Changes retains its file tree and inline discussions; toolbar and per-thread **Address feedback** actions open Feedback, with exact-thread links retaining source PR identity. There is no Files / Code threads mode. Returning to Changes restores its file and position unless the user explicitly opens a different file.

Feedback uses the same shared header as every other tab, with PR actions visible. Every action sits on its item. Resolve & next scrolls to the next unresolved thread after the resolved one, across PRs. A resolution confirmation under the bar names the PR and file; Undo reopens and moves the cursor back to that thread. Navigation preserves account-scoped reply drafts across Feedback and Changes. Failed writes retain the thread and never advance. Narrow windows keep the same single column; the bar wraps. Completion distinguishes unresolved threads from approval, accounts for incomplete or failed refreshes, and offers explicit reviewer requests. All surfaces share cached discussions and account-scoped read state; opening the timeline does not mark every item read.

**Needs my response** is a first-class queue destination and command-palette action for authored PRs with external unresolved threads or changes requested. Keep stacks grouped; separate reason links open the source PR’s matching review or unresolved thread. Preserve cached matches while shared sync is paused, name the affected PRs, show the retry time and offer recovery when eligible. Empty states distinguish confirmed completion from incomplete feedback. Thread completion never implies approval; offer an explicit review request when a changes-requested decision remains.

### Explanation reader

Generate opens a compact explanation setup dialog before starting the model. Styles and independent generated/test exclusions are visible first; file and folder choices, search, and hidden-extension tags are disclosed on demand. Explicit file choices override rules. Remember repository defaults only on explicit opt-in at generation; regeneration restores choices from the displayed explanation. Keep setup, loading, and error states keyboard accessible with a stable footer and a scrollable body. Bulk starts share one setup dialog and retry only unfinished targets.

While an explanation is being generated, show its stages as Task Rows in an empty pane: read PR and context, plan topics, write topics (each planned topic with its own status), check text, write overview, render code, with elapsed time in the header. A finished topic offers Read, which opens it in the reader while the rest are written; unwritten topics show placeholders and the explanation updates in place when it is saved. A failed build keeps its rows with each error inline. A screen reader hears phase changes and the outcome, not each tick. Regeneration keeps the saved explanation visible with a compact status above it and a Show progress disclosure for the rows. Coalesce activity notifications into one in-flight read plus a catch-up read, suspend reads in hidden tabs, and recover with Retry progress when local activity is unavailable. A generated result with no sections retains its overview and offers Generate again and Changes.

[ExplanationReader](components/ExplanationReader.tsx) presents the overview, paired sections, and ending in one vertical scroll surface. Keep the compact section picker, Previous/Next section controls, shared Viewed count, and review actions above it. Inline explanations, Diff appearance, and Ask a question are global toolbar controls; do not repeat them in each section. Keep navigation and actions on one row when space allows, wrapping only in narrower containers. Next section stops at the last section and never changes Viewed state or submits a review. Explicit section jumps scroll smoothly unless reduced motion is enabled; restoring a saved position remains immediate. Code is directly available beside its explanation, without an Inspect code gate. Each section owns its prose and evidence; file and line links target that section even when a path recurs elsewhere.

Within a wide section, the shorter column remains visible while its companion continues scrolling. Sticky positioning ends at the section boundary. A column taller than the reader uses a negative top offset so its lower content remains reachable. Disable column stickiness when the reader stacks prose above code. Use the reader's available width for this transition, including when chat is open.

Retain one saved reading position per explanation and revision. Section navigation moves the complete pair. Code mounts before entering view and remains mounted to preserve draft comments and context expansion. Track the current section with logarithmic layout reads and batch sticky-column measurements before style writes. Explicit navigation cannot steal focus from a newly opened control. Optional How to use this explanation guidance lives in the overview, not in a blocking tour. Viewed progress is shared with the existing review workspace and is independent of reading position; neither reading nor marking Viewed submits a review. Keep source PR attribution distinct from the submission destination. The ending identifies files outside the explanation and provides explicit Changes and review actions.

**The Shared Diff Rule.** Diff presentation is shared: Changes ([PrFileInspection](components/PrFileInspection.tsx), [ChangesDiff](components/ChangesDiff.tsx)) and Explanation topics ([SlideView](components/SlideView.tsx), [ReviewDiff](components/ReviewDiff.tsx)) render diffs through the same components. A topic's file uses the code-tier [DiffFileHeader](components/DiffFileHeader.tsx), ChangesDiff for its hunks, and [useDiffFileModel](components/useDiffFileModel.tsx) for gaps, reveals, tree-sitter breadcrumbs, Show whole function and structure loading, so a change to diff presentation lands in both at once. Topics add only what Changes has no use for: the topic's subset of hunks, inline explanations, review-check pins, the expand button, and the file summary below the header. A gap between a topic's hunks that holds changes the topic left out reads "Other changes, not in this topic" and reveals only the unchanged lines next to its hunks. The file header and the hunk headers pin inside the scroller the topic's code is in: the Explanation document, or the code pane in the split and focus layouts. Check both surfaces in screenshots and tests; `npm run test:browser:docker -- --explanation-parity` fails when a topic stops rendering through the shared components.

**Code structure in diffs.** Three parts of the shared diff follow the code's structure, in Changes and topics alike. *You are here* ([lib/diff-here.ts](lib/diff-here.ts)): the line a pinned crumb, an outline symbol or a review check takes the reader to gets a band of a deep code-tier blue under its text and a solid `--code-ring` bar on its gutter's edge; it pours out from the bar, blooms, settles and fades over 2 s, and stays still under reduced motion. It is the app's one "here" signal; the band keeps at least 80% of the line's text contrast on every code theme and on added and deleted lines. *Show scope* ([lib/show-scope.ts](lib/show-scope.ts)): the definition around a change shows whole when that costs at most 10 lines above and 10 below what the hunk shows, joins two of its hunks across 20 lines or fewer, and walks out to the next definition while it still fits; a quiet bracket rail beside the line numbers marks it, and its hunk header offers Collapse. Settings › Appearance › Code intelligence turns it off. *The outline* ([DiffOutline](components/DiffOutline.tsx)): one code line under the file header names the symbols the changes touch, each marked added, modified or removed by icon and colour; choosing one goes there as a pinned crumb does; expanded, each has a Viewed tick kept beside the file's own, and ticking them all offers Mark file viewed rather than collapsing the file by itself. `npm run test:browser:docker -- --breadcrumb-nav` checks all three with breadcrumb navigation.

Draft comments within the Explanation document use opaque `card` surfaces and `card-foreground` text with existing borders, preserving contrast in both themes. This treatment is scoped to the reader and adds no palette tokens. Chat retains the shared dock, and an interactive explanation temporarily occupies its section's code column while the underlying code remains mounted.

### Explanation diagrams

D2 diagrams use a fitted, bordered preview within their explanation section. Named navigation and the active explanation support manual inspection. The existing dialog expands the diagram into the shared pan-and-zoom viewer. Its active explanation sits beside the canvas and moves below it at narrow widths. Additional notes start collapsed. Focus changes highlight exact entities on a stable board while preserving layout and zoom. Explicit walkthroughs offer optional auto-play. Maps, comparisons, and older diagrams without a declared kind use named views without auto-play. Surrounding controls, surfaces, and text use the workbench system. SVG typography and diagram colors stay scoped to the diagram. Reduced motion removes animation and transitions. Source disclosure and a local retry keep errors recoverable. Saved Mermaid diagrams retain their renderer and share the inspection viewer. See [D2 explanation behavior](docs/d2-explanations.md).

Implementation references: [global styles](src/globals.css), [Explanation reader](components/ExplanationReader.tsx), [shared narrative and code](components/SlideView.tsx), and [code highlighting](lib/highlight.ts).
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
- Don't use the Sparkles icon, or any sparkle variant (WandSparkles, Sparkle). It is banned: tests/banned-icons.test.ts and the lint rule enforce it ([lib/banned-icons.mjs](lib/banned-icons.mjs)). AI actions use Lucide Bot. Asking about a file or selection opens chat from a Bot icon button labelled "Ask about this", with no visible text in the file header.

Bulk check reruns are available in the stack overview and Checks toolbar. Group by workflow run; failed workflows rerun failed jobs and dependents, while any cancelled job makes the run use all jobs. Confirm the affected PRs and workflow scope. Exclude running workflows and external providers; retain accepted requests after partial failure so Retry only submits remaining workflows.

Stack and PR names carry a leading identity icon in headings, navigation, selectors, and saved history: Lucide BookMarked for repositories, Layers for stacks, and the PR's GitHub state for PRs. Repository names in selectors and setup reuse RepositoryMark so configured repository icons and colors remain consistent. Every PR name uses the shared [PrStateIcon](components/PrStateIcon.tsx), directly or through `SubjectIcon` with `pr`: GitPullRequest in success green for open, GitPullRequestDraft in muted gray for draft, GitMerge in info purple for merged, and GitPullRequestClosed in danger red for closed. While the state loads, the neutral GitPullRequest holds the same slot. The icon is labelled "PR state: Open" and so on, and is decorative where the state is written beside it. Icons for the same PR follow the freshest copy shown in the window, so a merge updates tabs, breadcrumbs and recent entries in place. Do not duplicate an icon when the adjacent PR badge already identifies the same row. Keep icons decorative, text searchable, and long option labels wrapping; local repository reviews are not labelled as PRs.

Commit breadcrumbs show the first line of the commit message with GitCommitHorizontal, retaining the hash in the searchable picker. File breadcrumbs and picker options use the shared FileTypeIcon for the path, including light/dark variants. Long breadcrumb labels truncate; picker labels wrap.

Workspace section icons use the shared WorkspaceIcon mapping in tabs, breadcrumbs, selectors, and related navigation: Summary = LayoutList, Changes = FileDiff, Commits = GitCommitHorizontal, Checks = ListChecks, Explanation = BookOpen, Local notes = NotebookPen. Keep visible text labels; icons are decorative and inherit text color. Check status icons continue to represent status rather than section identity.

The shared [interface icon catalog](lib/interface-icons.ts) owns entity, workspace, feature, and check-summary choices. Use Briefing = FileText, Chat/comment = MessageSquare, Submit review = MessageSquarePlus, Saved view = Bookmark, History/saved reviews = History, Settings = Settings, Insight = Lightbulb, and Interactive diagram = Network. A PR with merge conflicts is GitMergeConflict in the danger tone everywhere: the attention catalog (menu bar, Overview), Resolve conflicts… actions, the readiness line, stack branch status and the queue's conflicts filter. A conflicted file inside the resolver keeps CircleAlert, because it is one file, not the PR's state. A waiting time is Hourglass; Clock3 stays the icon for running checks. Command results and actions reuse these choices; file results use FileTypeIcon when their path is known. Keep configured repository icons and status-aware PR icons.

Use 16px icons for actions and menu rows, 12–14px for dense metadata, and 1em for entity headings. Menu icons occupy a fixed 16px slot and never shrink. Lucide keeps its standard stroke weight. Hide decorative icons from assistive technology; icon-only controls retain an accessible name. Use drawn arrows and checks for UI controls, preserving text arrows in branch/revision data and keyboard hints.

Check summaries use CircleAlert for failure, Clock3 for pending, CircleCheck for success, CircleMinus for neutral, and CircleHelp for unknown. A neutral or unknown result must not show a success checkmark. Actively running job steps may use LoaderCircle; queued steps keep their pending symbol. Color and text continue to distinguish all states.


### Workflow job steps

Individual Checks graph nodes show a compact step list with status icons, names, and durations. Preview three ordered steps around the running step, then a failure, then the latest completed step. Show all steps expands the full list; grouped nodes keep their job summary until expanded. Keep dependency routing outside the card, preserve the existing header action for details, and expose full truncated step names and status in tooltips. Expansion uses cached workflow data and backend layout. Remember it within the current workflow session. Timestamp-less steps show no invented duration.


Stack merge guidance separates confirmed blockers from missing or stale merge status. Its heading names the number of blocking PRs, or uses a neutral question icon for unconfirmed status. Show a confirmed-ready count, concrete reasons beside titled PR links, and a Refresh merge status action for incomplete evidence. List known blockers before uncertain information. If all unknown PRs share the same reason, state it once. Never present missing merge information as a confirmed blocker.

### Step cards

[StepCard](components/StepCard.tsx) shows the plan for a PR action with several consequential steps before anything runs: stack merges, conflict resolution, and restacks. A single PR merge, branch update, or draft change keeps its one confirmation. The title sits beside a quiet `n / N` pill; each step has a status icon, a label, and one muted detail line, and the current step uses the `secondary` surface. Status is also given as text. Errors appear in the failing step with a retry that only reads again; writes are never resent. Skip appears only on optional steps, such as restacking dependents before it starts. Enter continues ordinary steps; a push or merge needs its own button. Step changes move focus to the step and are announced politely. Resolve conflicts shows its plan once, as a compact step rail that keeps the same steps from start to end; its confirmation card hides its own list and pill. The shape follows Beautiful UI's Approval Card (MIT); no code is copied.

### Loading feedback

Use `LoadingState` for an empty pane and its compact variant for file previews or small panels. The shared three-node signal comes from the Checks graph. Use `LoadingIndicator` for inline work and refreshes; keep cached content visible. Show the actual operation in plain text. Do not simulate completion percentages or cycle through invented phases.

Motion stops for reduced-motion preferences, hidden windows, and offscreen indicators. One shared intersection observer handles visibility. Optional elapsed time appears after five seconds and is excluded from live announcements. Announce the operation once through its status region; use `announce={false}` inside an existing status region. Loading does not delay completion or trigger additional requests.

Commit inspection shows the selected commit title, author, hash, and full message before its file diffs in one scroll surface. Preserve authored whitespace and plain text. Ranges show each message in chronological order; only secondary commit metadata is collapsed. The sidebar keeps compact commit titles and aligned metadata, exposes the full selected title, and fills the sidebar when Changed files is collapsed. File jumps and restored positions account for the measured message height.

Queue navigation groups Reviews, Saved views, and Tools with independent disclosure controls. Remember section and desktop collapse preferences locally. A folded group retains the current destination label. The icon rail keeps direct review/tool destinations with hover and focus labels; saved views open one named list. One scroll surface accommodates long view lists, with tools at the bottom when space permits. Narrow windows use an anchored navigation panel with Escape dismissal and focus restoration. Folding never refreshes GitHub data.

The queue sidebar toggles with Command+Backslash on macOS and Control+Backslash elsewhere. Show this in the toggle tooltip and Help. Use a short fade, resize, and reveal transition; keep reduced-motion toggles instant and cancel interrupted motion. On narrow windows, the shortcut opens or closes the navigation panel.

Model and reasoning effort share one trigger. Show the selected model and a quiet effort badge; opening the popover exposes model search and native radio choices for supported effort levels. Changes use the existing preference actions. GitHub sync status belongs in Activity, with its checked time, pause/error detail, and refresh action, using the queue's existing snapshot rather than a second fetch loop.
