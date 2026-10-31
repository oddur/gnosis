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

A stack summary has one merge verdict above a full-width dependency list. Review status, Checks, and Branch are independent columns. Branch metadata and viewed-file progress share the secondary line. Confirmed blockers use red; non-blocking check problems use amber. Optional updates and skipped checks use muted text.

Checks follow new attempts on the displayed commit automatically. A new commit requires an explicit switch. After a rerun request, label old output as the previous attempt until GitHub reports new results. Background allowance pauses are informational and show the automatic retry time. Refreshing one PR must not refresh the full stack.

A compact “To merge this stack” list groups required actions and links to the affected PR overviews, ordered base first within each group. Drafts have a one-click “Mark all ready” action with inline progress and partial-failure recovery. It changes only draft status, and retains the existing permission and revision guards. Show each blocker and its remedy in the PR row without expansion. Name required check failures; separate running checks as waiting. Keep optional check results outside the required-action list. Expand a row for supporting check details. Show separate timestamps for merge requirements and check results, including missing or delayed results. Permission reads start on action, with the existing confirmation and revision checks. Ready rows omit redundant details. Below 760px of content width, status columns move under the PR and retain visible labels.

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
