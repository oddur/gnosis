# Copilot Instructions — Gnosis

## Design Context

### Users

Senior software engineers reviewing complex pull requests on their own machine. They are experienced, opinionated, and want depth — not hand-holding. They open Gnosis to *understand* a change, not to skim it. The app should feel like a quiet reading room: a place to settle in and think, not a dashboard to triage.

The job-to-be-done is **comprehension**: walk me through this PR the way the author understands it, in the right order, with the right context, so I can review it with confidence and not miss anything important.

### Brand Personality

Calm, intellectual, considered. Three words: **scholarly, deliberate, lucid.**

The name *Gnosis* points at deep, direct understanding — the interface should embody that. Quiet confidence over flash. Editorial pacing over dense chrome. The voice is that of a thoughtful colleague explaining a change over coffee, not a notification-spamming SaaS app.

Emotional goals: **focus, trust, intellectual calm.** The reviewer should feel that the tool respects their attention.

### Aesthetic Direction

**Reference feel:** Stripe docs and Notion docs for pacing and restraint — *plus* a primary anchor reference: a PR-walkthrough tool with a serif-titled, monograph-like layout. Treat that screenshot reference as the primary visual touchstone. Key qualities to inherit:

- **Serif display type for slide titles.** A high-quality editorial serif is the single most important typographic move. Body and UI stay sans (Inter); code stays mono (JetBrains Mono).
- **Numbered, book-like table of contents.** Sections numbered `01`, `02`, `03`…, with optional time-to-read estimates and completion checkmarks. No icons, no card backgrounds, no borders — just type on the page.
- **Near-zero chrome.** Sidebars have no dividers or fills. Bottom bars are thin rows of low-contrast text controls. Buttons and badges are small, quiet, and use type rather than color.
- **Color as punctuation.** On any given slide the *only* color present should be (1) diff red/green, (2) at most one editorial callout, (3) one small status badge if needed. Everything else is ink-on-paper neutrals.
- **Editorial callouts with inline labels.** Soft tinted block with a **bold inline label** followed by prose on the same line — not a titled card with an icon.
- **Generous reading column.** ~65–75ch, 1.6+ line-height, real paragraph spacing. Whitespace around the title is luxurious, not efficient.
- **Quiet metadata in mono.** Small, low-contrast monospace for file counts, age, branches, progress strings.
- **Diffs are allowed to be loud.** Tone down everything *around* the diff, never the diff itself.

**Palette:** Warmer, more editorial than the current cool cyan. Ink-on-paper foreground/background; warm off-white in light, deep warm charcoal in dark. A single restrained accent — muted amber, ochre, or burnt sienna — used sparingly so it actually means something.

**Typography:** Inter (UI), an editorial serif (slide titles — currently Sora is in tokens but the target is a true serif), JetBrains Mono (code). Strong hierarchy, comfortable line-height for prose, tighter for UI.

**Theme:** Both light and dark are first-class. Light feels like a printed page; dark feels like a well-lit study at night, not a black void.

**Density:** Generous. Whitespace is content.

**Motion:** Subtle and purposeful. Always honor `prefers-reduced-motion`.

### Anti-references — what Gnosis must NOT look like

- **Generic AI chatbot UI** — no message bubbles, no purple gradients, no "AI sparkle" tropes.
- **Heavy enterprise / Jira** — no dense toolbars, no busy chrome.
- **Marketing-y / over-designed** — no landing-page gradients, hero illustrations, decorative flourishes.
- **Unmodified shadcn defaults** — primitives are a starting point, not the destination.

### Accessibility & Inclusion

- **WCAG AA contrast** for all text and meaningful UI.
- **Full keyboard navigation** with visible, well-styled focus rings.
- **Color-blind safe** — never rely on color alone for diff add/remove, risk, or status.
- **Respect `prefers-reduced-motion`** on every transition.

### Design Principles

1. **Comprehension over decoration.** Every visual choice should make the PR easier to understand. If it doesn't, cut it.
2. **Editorial, not dashboard.** Treat slides like pages, not panels.
3. **Restraint is the accent.** Color, motion, and ornament are scarce on purpose.
4. **Respect the reviewer's attention.** No interruptions, no chrome competing with content.
5. **Distinctive but quiet.** Recognizable in a screenshot, but never loud.
6. **The serif title carries the brand.** A well-chosen editorial serif on slide titles is non-negotiable — every other typographic decision defers to making it feel inevitable.
