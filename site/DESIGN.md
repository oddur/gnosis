---
name: Gnosis website
description: Clear explanations of connected changes, on a cool technical canvas.
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
  source-current: "#d6e1f8"
  control-border: "#aebddc"
  control-hover: "#dce7ff"
typography:
  display:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.7rem, 4.85vw, 4.5rem)"
    fontWeight: 600
    lineHeight: 1.06
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Onest, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 3.3rem)"
    fontWeight: 550
    lineHeight: 1.13
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
  80: "80px"
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
  command-copy:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.default}"
    padding: "14px 14px 14px 18px"
---

# Design System: Gnosis website

## Overview

**Creative North Star: "Change, unpacked"**

Gnosis makes connected code changes understandable through clear layers, concise explanations, and visible source evidence. Cool lavender surfaces and cobalt actions give the website a calm, technical character. Onest keeps both large headings and small controls direct and approachable.

The website uses generous space around compact demonstrations and real application screenshots. Fine lines explain relationships. Motion shows a mechanism, while text and manual controls preserve its meaning without movement.

This system covers the website in `site/`. The repository root design files describe the desktop application. The source of visual values is `src/styles/global.css`, with behavior in `src/components/` and `src/scripts/stack-demo.ts`.

**Key Characteristics:**

- Cool lavender canvas, cobalt emphasis, and graphite text.
- Large, close-set headings above precise technical content.
- Connected layers that preserve context around the selected contribution.
- Real screenshots with captions and explicit sample context.
- Flat surfaces, fine borders, and purposeful motion.

## Colors

The palette combines pale lavender neutrals with a deep cobalt accent. Frontmatter contains the normative color values.

### Primary

- **Cobalt** (`blue`) marks primary actions, links, open PR layers, and the setup section.
- **Deep cobalt** (`blue-hover`) gives primary buttons a darker hover state.
- **Focus blue** (`focus`) identifies keyboard focus independently of hover.
- **Pale selection blue** (`selected`) gives screenshot enlargement controls their hover fill.

### Neutral

- **Lavender canvas** (`canvas`) fills the page and source panes.
- **Technical surface** (`surface`) separates the assembly and release fallback from the canvas.
- **White paper** (`paper`) fills closed PR layers, controls, screenshot surrounds, and the queue section.
- **Graphite** (`ink`) carries primary text. **Slate** (`muted`) carries supporting text and metadata.
- **Lavender rule** (`line`) separates footer content and outlines small controls.
- **Layer border** and **layer hover** distinguish closed disclosures without suggesting selection.
- **Source divider** and **source current** separate code regions and identify the current source line.
- **Control border** and **control hover** keep playback controls visible against pale surfaces.

**The State Evidence Rule.** Pair selected colors with structural changes, text, or symbols that explain the state.

The sidecar includes derived OKLCH ramps for color inspection. These ramps are previews, not additional implementation tokens.

## Typography

**Display and body font:** Onest, with UI sans-serif and system fallbacks. The website serves the variable font locally with weights from 100 to 900.

**Source font:** SFMono-Regular, Consolas, Liberation Mono, then monospace. File labels use the generic monospace family.

Headings use balanced wrapping, moderate weight, and negative tracking. The hierarchy in frontmatter maps the implemented roles, without a fixed scale ratio.

- **Display:** page headlines. At widths up to 390px, the size becomes 2.5rem.
- **Headline:** section headings. Assembly titles use a smaller size (24px), line height (1.3), and tracking (-0.025em).
- **Title:** the explanation within an open PR layer. PR summary titles use 18px and weight 550.
- **Body:** the default document text. Section introductions use 17px with line height 1.65.
- **Label:** supporting metadata. Navigation uses 14px, and source controls use 12px.
- **Source:** code in the demonstration. PR numbers and step counts use tabular numerals.

Release text uses 16px with line height 1.7 and a maximum width of 75ch. Explanation text uses 14px and a maximum width of 54ch.

**The Source Type Rule.** Reserve monospace for code, commands, and file labels.

## Layout

The shared frame has a maximum width of 1440px and horizontal padding of 56px. The stylesheet uses contextual spacing, not a universal spacing multiplier. Frontmatter records the recurring steps.

Wide layouts pair explanatory text with evidence. Section introductions use columns of `1fr 0.8fr` with a 70px gap. Open PR content uses `1.12fr 1fr` with a 34px column gap. The setup section uses equal columns with a 96px gap.

Release entries separate metadata from prose with a 220px first column and a 55px gap. Horizontal rules define the entries. Screenshots span the content frame and retain their original aspect ratio.

| Viewport | Implemented response |
| --- | --- |
| At least 1600px | Hero vertical padding increases to 42px above and 52px below. |
| Up to 1100px | Frame padding becomes 32px. Column gaps and demonstration type become more compact. Release metadata uses 160px. |
| Up to 760px | Frame padding becomes 20px. Main grids become single columns. Playback precedes source code. Navigation retains essential actions. |
| Up to 390px | Frame padding becomes 18px. The GitHub header link disappears. The headline uses its compact size. |

Mobile keeps PR dependency order, explanation text, playback controls, and source. Long code scrolls within its pane. Release tables also scroll within their own region.

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

The header pairs a bold wordmark with compact links and the download action. Current-page links remain underlined. Mobile removes the exploration link and secondary GitHub text, then removes the GitHub icon at the narrowest breakpoint.

The footer uses the same wordmark, a fine top border, and small text links. Links wrap onto a separate row on mobile. A keyboard-visible skip link precedes the header.

### Connected PR layers

Native disclosures keep each contribution inspectable without JavaScript. Fine vertical connectors join adjacent rows. An open row reverses to cobalt and rotates its chevron. A hover changes only the closed row fill.

The open layer pairs explanatory text and an SVG mechanism with source code. The current line combines a pale fill with a cobalt left border. The illustration uses labeled commands, a fixed queue, and a worker. Its accessible title and description change with each step.

Playback starts only after activation. Play, Pause, Replay, Next step, and Restart preserve control over the explanation. Playback stops when its panel closes, the document becomes hidden, or the demonstration leaves the viewport.

Command transforms take 650ms with `cubic-bezier(0.16, 1, 0.3, 1)`. Playback waits 1600ms before its first step, then 2200ms between steps. Reduced motion removes transitions and smooth scrolling. Manual steps remain available, and timed playback remains user-initiated.

### Screenshots

Real application captures provide the product evidence. Each image has descriptive alternative text, a caption, and an explicit sample-repository label. The enlargement link opens the full image in a new tab and names that behavior. Image borders, rounded clipping, and a small enlargement control frame the capture.

### Commands and release metadata

The Homebrew command appears in a white bordered container with selectable source text. Its copy control uses the icon-button treatment. A polite status region reports success or gives a manual-copy fallback.

Preview release tags use small text, a fine border, and modest corners. These tags communicate status and are not interactive filters. Release failures retain a visible route to GitHub notes and downloads.

No website input fields or dialogs exist in this system. The sidecar demonstrates existing components without introducing new field patterns.

## Do's and Don'ts

### Do:

- **Do** use the website tokens for new website surfaces.
- **Do** connect explanations to visible source evidence.
- **Do** keep screenshot captions and sample context explicit.
- **Do** preserve keyboard focus, meaningful text labels, and manual playback controls.
- **Do** keep installation and release fallbacks actionable.

### Don't:

- **Don't** import desktop application styling into website controls.
- **Don't** replace real product evidence with fabricated application screenshots.
- **Don't** start explanatory animation automatically.
- **Don't** communicate state through color alone.
- **Don't** add shadows to the flat surface hierarchy.
