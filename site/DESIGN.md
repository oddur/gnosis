---
name: Gnosis website
description: Website for the open-source Gnosis code review app.
colors:
  canvas: "#e8edf9"
  surface: "#f7f9ff"
  paper: "#fff"
  ink: "#1e2537"
  muted: "#52617e"
  blue: "#213b8e"
  blue-hover: "#172e75"
  line: "#bdc9e1"
  selected: "#d8e3ff"
  focus: "#3865df"
  layer-border: "#a9b7d8"
  layer-hover: "#edf2ff"
  source-divider: "#d3dced"
  removed-bg: "#f9e4e6"
  removed-ink: "#852e36"
  added-bg: "#e0f0e7"
  added-ink: "#225c3b"
  before-current: "#9b3038"
  after-current: "#297048"
  control-border: "#aebddc"
  control-hover: "#dce7ff"
typography:
  display:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 4.4vw, 4rem)"
    fontWeight: 600
    lineHeight: 1.06
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.75rem, 2.7vw, 2.3rem)"
    fontWeight: 550
    lineHeight: 1.18
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "23px"
    fontWeight: 550
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  source:
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 2
  feature-title:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 550
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  daily-title:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 550
    lineHeight: 1.55
    letterSpacing: "-0.02em"
rounded:
  inline-code: "3px"
  tag: "4px"
  control: "6px"
  layer: "7px"
  default: "8px"
  assembly-mobile: "10px"
  container: "12px"
spacing:
  4: "4px"
  8: "8px"
  12: "12px"
  16: "16px"
  20: "20px"
  24: "24px"
  32: "32px"
  48: "48px"
  56: "56px"
  72: "72px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.paper}"
    rounded: "{rounded.default}"
    padding: "13px 20px"
  button-primary-hover:
    backgroundColor: "{colors.blue-hover}"
  button-large:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.paper}"
    rounded: "{rounded.default}"
    padding: "17px 24px"
  button-play:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.blue}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.blue}"
    rounded: "{rounded.control}"
  navigation:
    textColor: "{colors.ink}"
  project-resources:
    textColor: "{colors.blue}"
    padding: "22px 0 32px"
  setup-section:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "48px 0"
  tag-preview:
    rounded: "{rounded.tag}"
    padding: "2px 7px"
  layer:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.layer}"
    padding: "10px 22px"
  layer-open:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.paper}"
  source-pane:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.default}"
  source-removed:
    backgroundColor: "{colors.removed-bg}"
    textColor: "{colors.removed-ink}"
  source-added:
    backgroundColor: "{colors.added-bg}"
    textColor: "{colors.added-ink}"
  command-copy:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.default}"
    padding: "14px 14px 14px 18px"
  feature-tab:
    textColor: "{colors.muted}"
    padding: "14px 6px"
  feature-tab-hover:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.blue}"
  feature-tab-selected:
    textColor: "{colors.blue}"
  daily-feature:
    padding: "24px 0"
---

# Design System: Gnosis website

## Overview

**Creative North Star: "Change, unpacked"**

The website presents Gnosis as an open-source tool, with a developer explaining its behavior to another developer. Feature names, factual captions, and plain installation instructions carry the content. Cool lavender surfaces, cobalt actions, and Onest type keep the presentation calm and technical.

Compact sections give real screenshots and an interactive code example most of the space. Fine lines explain relationships. Motion shows a mechanism, while text and manual controls preserve its meaning without movement. Source, setup, and issue links make the project directly accessible.

This system covers the website in `site/`. The repository root design files describe the desktop application. The source of visual values is `src/styles/global.css`, with behavior in `src/components/` and `src/scripts/`.

**Key Characteristics:**

- Cool lavender canvas, cobalt emphasis, and graphite text.
- Moderate, close-set headings that name features and actions.
- Connected layers that preserve context around the selected contribution.
- Synchronized before/after mechanisms with visible counts and corresponding source changes.
- Real screenshots with captions and explicit sample context.
- Flat surfaces, fine borders, and purposeful motion.
- Factual descriptions, visible project links, and plain installation instructions.

## Colors

The palette combines pale lavender neutrals with a deep cobalt accent. Frontmatter contains the normative color values.

### Primary

- **Cobalt** (`blue`) marks primary actions, links, open PR layers, and selected feature tabs.
- **Deep cobalt** (`blue-hover`) gives primary buttons a darker hover state.
- **Focus blue** (`focus`) identifies keyboard focus independently of hover.
- **Pale selection blue** (`selected`) gives screenshot enlargement controls their hover fill.

### Secondary

- **Removed source** (`removed-bg`, `removed-ink`) pairs a pale red fill with dark red text and a minus marker.
- **Added source** (`added-bg`, `added-ink`) pairs a pale green fill with dark green text and a plus marker.
- **Before execution** (`before-current`) outlines the current Before line and marks an exceeded concurrency limit.
- **After execution** (`after-current`) outlines the current After line. Text markers distinguish both execution paths.

These colors explain code changes and execution state. They do not replace cobalt for navigation or primary actions.

### Neutral

- **Lavender canvas** (`canvas`) fills the page and source panes.
- **Technical surface** (`surface`) separates the assembly, feature tour, setup section, and release fallback from the canvas.
- **White paper** (`paper`) fills closed PR layers, controls, screenshot surrounds, and the queue section.
- **Graphite** (`ink`) carries primary text. **Slate** (`muted`) carries supporting text and metadata.
- **Lavender rule** (`line`) separates footer content and outlines small controls.
- **Layer border** and **layer hover** distinguish closed disclosures without suggesting selection.
- **Source divider** separates code from its filename and workspace link.
- **Control border** and **control hover** keep playback controls visible against pale surfaces.

**The State Evidence Rule.** Pair selected colors with structural changes, text, or symbols that explain the state.

The sidecar includes derived OKLCH ramps for color inspection. These ramps are previews, not additional implementation tokens.

## Typography

**Display and body font:** Onest, with UI sans-serif and system fallbacks. The website serves the variable font locally with weights from 100 to 900. A preloaded WOFF2 subset contains Latin and common UI symbols; a second subset loads only for extended characters. Both preserve the original font metrics and glyph coverage.

**Source font:** SFMono-Regular, Consolas, Liberation Mono, then monospace. File labels use the generic monospace family.

Headings use balanced wrapping, moderate weight, and negative tracking. Section headings stay compact enough to read as feature labels. The hierarchy in frontmatter maps the implemented roles, without a fixed scale ratio.

- **Display:** page headlines. At widths up to 390px, the size becomes 2.5rem.
- **Headline:** section headings. Assembly titles use a smaller size (24px), line height (1.3), and tracking (-0.025em).
- **Title:** the explanation within an open PR layer. PR summary titles use 18px and weight 550.
- **Body:** the default document text. Section introductions use 17px with line height 1.65.
- **Label:** supporting metadata. Navigation uses 14px, and source controls use 12px.
- **Source:** code in the demonstration. PR numbers and step counts use tabular numerals.

Release text uses 16px with line height 1.7 and a maximum width of 75ch. Explanation text uses 14px and a maximum width of 54ch.

Feature titles use the `feature-title` role and become 23px on mobile. Feature descriptions use line height 1.65 and a maximum width of 66ch. Daily feature terms use `daily-title`. Their descriptions use 15px with line height 1.65 and a maximum width of 58ch.

**The Source Type Rule.** Reserve monospace for code, commands, and file labels.

**The Plain Feature Names Rule.** Name the feature or action directly. Use captions to describe what the screenshot shows.

## Layout

The shared frame has a maximum width of 1440px and horizontal padding of 56px. The stylesheet uses contextual spacing, not a universal spacing multiplier. Frontmatter records the recurring steps.

Wide layouts pair explanatory text with evidence. Section introductions use columns of `1fr 0.8fr` with a 70px gap. Open PR content uses `1.12fr 1fr` with a 34px column gap. The setup section uses equal columns with a 96px gap.

Comparison playback spans both columns before the illustration and diff. Its minimum height is 90px on desktop and 150px on mobile. Reserved caption space keeps the diagram stable between steps. Before and After lanes remain vertically stacked at every width.

Release entries separate metadata from prose with a 220px first column and a 55px gap. Horizontal rules define the entries. Screenshots span the content frame. Standalone screenshots retain their original aspect ratio.

The feature tour uses a pale surface with 48px vertical padding. Descriptions pair columns of `1fr 0.6fr` with a 48px gap and a minimum height of 156px. Enhanced screenshot frames retain an 8:5 aspect ratio across viewport sizes. Images use `object-fit: contain`, which preserves the full capture without cropping.

Daily features form a two-column definition list with a 72px column gap. Each entry has a top rule and 24px vertical padding. This section uses 48px vertical padding.

Queue, setup, and install sections also use 48px vertical padding on desktop. The guided review section uses 56px. The introduction pairs its heading with a factual description (17px), limited to 40ch.

| Viewport | Implemented response |
| --- | --- |
| At least 1600px | Hero vertical padding increases to 42px above and 52px below. |
| Up to 1100px | Frame padding becomes 32px. Column gaps and demonstration type become more compact. Release metadata uses 160px. |
| Up to 760px | Frame padding becomes 20px. Main grids become single columns. Playback precedes the illustration and source. Navigation retains essential actions. |
| Up to 390px | Frame padding becomes 18px. The GitHub header link disappears. The headline uses its compact size. |

Mobile keeps PR dependency order, explanation text, playback controls, and source. Long code scrolls within its pane. Release tables also scroll within their own region.

At widths up to 760px, feature tabs form three equal columns. Feature descriptions and daily features become single columns. Both showcase sections use 48px vertical padding. Feature descriptions remove their minimum height and reduce their gap to 16px.

## Elevation & Depth

The website has no box shadows. Pale fills, one-pixel borders, and connected rows establish depth. The selected PR uses cobalt fill and white text. Screenshot frames use a fine border without fabricated application chrome.

**The Flat Evidence Rule.** Use tone, borders, and spacing to separate evidence from its explanation.

## Shapes

Corners stay gently rounded. Primary buttons, source panes, and command containers use the default radius. Assembly and screenshot containers use the larger container radius. PR rows use the layer radius, while playback and enlargement controls use the control radius.

Mobile assembly corners use the mobile radius. Mobile screenshots use the layer radius. The only recurring circles are the wordmark dot and small feature separators. Inline SVG icons use rounded strokes with width 1.7 and a default size of 20px.

## Components

### Buttons and links

Primary buttons are compact cobalt anchors with white text, weight 550, and a minimum height of 46px. The large download variant uses 18px text. Header download controls become smaller on mobile, with a minimum height of 40px.

Primary hover uses deep cobalt over 150ms. Text links use cobalt and gain an underline on hover. Keyboard focus uses a solid focus-blue outline (3px) with an offset (5px). Disabled buttons use opacity 0.4 and a default cursor.

### Navigation

The header pairs a bold wordmark with Features, Changelog, GitHub, and the download action. Current-page links remain underlined. Mobile removes the Features link and secondary GitHub text, then removes the GitHub icon at the narrowest breakpoint.

Project resource links sit beside license information near the opening. Source, setup, and issue links use cobalt text with hover underlines. The row wraps with gaps of 12px by 28px. Mobile uses 13px text and places license information on its own row.

The footer uses the same wordmark, a factual product description, a fine top border, and small text links. Links wrap onto a separate row on mobile. A keyboard-visible skip link precedes the header.

### Connected PR layers

Native disclosures keep each contribution inspectable without JavaScript. Fine vertical connectors join adjacent rows. An open row reverses to cobalt and rotates its chevron. A hover changes only the closed row fill.

The example has three contributions: a concurrency slot, a missing-await fix, and a regression test. The foundation and test show static explanations and source. The fix starts open and pairs synchronized Before/After lanes with the actual removed and added lines.

Each lane keeps Waiting, Running, and Done at fixed positions. Commands A and B retain their identities across both versions. Text reports the slot owner, active count, and peak count. The Before lane marks an exceeded limit in red and explicitly names the failure.

Five frames show A starting, early cleanup, overlapping commands, A completing, and both commands completing. Both versions finish with the same results. Their peaks remain visible: two active commands before the fix and one after it.

The diff preserves red removed and green added lines throughout playback. Thin colored outlines track each execution path independently, with Before and After text markers. A focusable source region supports horizontal keyboard scrolling and uses the shared focus outline. The source explanation states why the missing await lets `finally` run early.

Playback starts only after activation. Play, Pause, Replay, Previous step, Next step, and Restart precede the illustration. Previous and Next disable at their respective boundaries. Manual navigation stops playback. Playback also stops when the panel closes, becomes hidden, or leaves the viewport.

Command transforms take 650ms with `cubic-bezier(0.16, 1, 0.3, 1)`. Playback waits 2400ms before its first step, then 4200ms between steps. Reduced motion removes transitions and smooth scrolling. Manual steps remain available, and timed playback remains user-initiated.

Each SVG has a changing title and description that report command locations, the slot state, and counts. Step text uses a polite live region. Without JavaScript, the initial comparison, source diff, static disclosures, and a textual explanation remain available.

**The Stable Comparison Rule.** Preserve object identity and lane positions across steps. Show the cause, intermediate state, and measured result together.

### Screenshots

Real application captures provide the product evidence. Each image has descriptive alternative text, a caption, and an explicit sample-repository label. The enlargement link opens the full image in a new tab and names that behavior. Image borders, rounded clipping, and a small enlargement control frame the capture.

### Feature tour

Six labeled tabs cover stacks, diffs and commits, Markdown, questions, checks, and conflict resolution. Each panel pairs a short explanation and a detail list with a real application screenshot. The description precedes the image, so the reader knows what to inspect.

Tabs use muted text (15px), a transparent bottom border (2px), and the padding in frontmatter. Hover uses cobalt text on the canvas fill. Selection adds a cobalt underline and weight 600. The shared keyboard focus outline remains visible independently of selection.

Mobile tabs use centered text (12px), padding (12px 2px), and a minimum height (44px). All six labels remain visible in the grid.

Without JavaScript, the labels link to stacked sections and every screenshot remains available. Enhancement adds tab and panel semantics, selects one panel, and gives only the selected tab a place in the Tab order. Left and Right wrap through tabs. Home and End select the first and last tabs. Space selects the focused tab. Panels accept keyboard focus.

Feature fragments select the matching panel on initial load and hash changes. Modified clicks retain normal link behavior. Ordinary tab activation changes the panel without adding a history entry.

### Daily features

The definition list presents compact capabilities as text, without card backgrounds or shadows. Each term has a clear description beneath it. Fine horizontal rules define the rows. Code examples retain monospace styling at 0.9em.

### Commands and release metadata

The Homebrew command appears in a white bordered container with selectable source text. Its copy control uses the icon-button treatment. A polite status region reports success or gives a manual-copy fallback.

Setup instructions use the pale technical surface, normal graphite headings, muted body text, and a fine top rule. They explain the local coding agent, existing subscription or API billing, and provider data flow. Setup links remain cobalt and underlined. Installation headings name the action directly.

Preview release tags use small text, a fine border, and modest corners. These tags communicate status and are not interactive filters. Release failures retain a visible route to GitHub notes and downloads.

No website input fields or dialogs exist in this system. The sidecar demonstrates existing components without introducing new field patterns.

## Do's and Don'ts

### Do:

- **Do** use the website tokens for new website surfaces.
- **Do** connect explanations to visible source evidence.
- **Do** keep screenshot captions and sample context explicit.
- **Do** preserve keyboard focus, meaningful text labels, and manual playback controls.
- **Do** keep installation and release fallbacks actionable.
- **Do** keep feature content accessible without JavaScript.
- **Do** preserve full screenshots inside the stable feature frame.
- **Do** use factual feature names, screenshot captions, and setup instructions.
- **Do** keep source, setup, and issue links easy to find.
- **Do** pair before/after diagrams with source changes, explicit counts, and stable object identities.

### Don't:

- **Don't** import desktop application styling into website controls.
- **Don't** replace real product evidence with fabricated application screenshots.
- **Don't** start explanatory animation automatically.
- **Don't** communicate state through color alone.
- **Don't** add shadows to the flat surface hierarchy.
- **Don't** use paired slogans, generic benefit claims, or corporate sales language.
- **Don't** turn setup instructions into a large promotional color band.
