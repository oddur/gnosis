---
version: 1
slug: "site-src-pages-index-astro"
primary_target: "site/src/pages/index.astro"
related_targets: ["site/src/pages/changelog.astro","site/src/layouts/Base.astro","site/src/styles/global.css"]
---

# Gnosis website — Product first

Mode: Persuade. Scope: homepage, shared navigation/footer, changelog, current product captures. Audience: engineers handling many PRs on laptops. Primary action: download Gnosis for macOS. Proof: actual app screenshots followed by an explicitly illustrative, interactive three-PR example. Preserve release links, Homebrew install, source links and build-time changelog fetching. No app UI changes or deployment in this task.

## Direction contract

THESIS: Explain what Gnosis does before asking the visitor to understand a code example. Lead with the actual desktop app and plain product copy.

OWN-WORLD: Cool lavender ground, cobalt active layers, graphite text and pale technical surfaces. Onest headings and body, monospace only for source. Fine connecting lines carry dependency context. Light comes from an engineer opening a shared link during the workday.

STORY: Understand the tool, inspect its review workflows, then explore illustrated explanations. Follow with daily-use tools, local agent setup, and installation. Keep provider data flow accurate; no invented claims.

FIRST VIEWPORT: A short product summary beside an actual Review Queue screenshot: GitHub PRs, stacks, diffs, and checks, with optional explanations through the user’s local Claude Code or Codex. Include download and feature links, existing subscription/API billing, and open-source status. No algorithm example in the opening. Stack copy and image below 900px.

FORM: Preserve lavender/cobalt surfaces, Onest typography, actual app captures, and flat borders. Use a compact two-column product introduction. Put the interactive three-PR example in the separate Illustrated explanations section after the feature tour.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Behavior and boundaries

The sample is curated demonstration data, not a live GitHub connection or a browser AI service. It must have usable initial content without JavaScript. No autoplay; pause on leaving the page and respect reduced motion. A small diagram renderer is sufficient for the demonstration; do not bundle Electron or the full application. Download offers verified release assets with an all-downloads fallback. Screenshot enlargement is optional and must preserve focus. Changelog retains release-source attribution and an actionable failure state. Mobile keeps dependency order with single-column explanations and code. Website tokens live in site/DESIGN.md and site/.impeccable/design.json; the app's root DESIGN.md stays unchanged.

## Feature coverage expansion

User requested broader feature coverage after inspecting the first build. Preserve the visual direction; the product-first opening supersedes the earlier example-led opening. Add a six-workflow feature tour with actual test-fixture screenshots and concise outcome-led descriptions. Tabs keep the page browsable; all sections remain available without JavaScript. Show daily-use capabilities as a compact typographic list: saved filters, mute/star/repository rules, local search, GitHub review comments, image/SVG/LFS previews, and persistent progress/background preloading. Do not present unmerged review-evidence work as a released feature.

## Voice refinement

The user explicitly rejected a corporate/SaaS sales tone. Keep the existing lavender/cobalt palette, typeface, interactive code example, and real product evidence. Use direct feature names, factual captions, and plain setup/install instructions. Remove paired slogans, generic benefit claims, and the large promotional setup band. Reduce section heading sizes and spacing. Put source, setup, and issue links near the opening. Explain use of the local agent and existing subscription/API billing, and retain the provider-data disclosure. The website should read like a developer explaining an open-source tool to another developer.

## Interactive example refinement

User approved replacing the simple queue example with a subtle review issue: `return worker.run()` inside try/finally releases a semaphore slot before the returned promise settles. The fix is `return await worker.run()`. Preserve the three-PR hierarchy with static foundation and regression-test context around the interactive fix. Show Before/After together, retain command identity A/B, and use five synchronized stages with explicit slot ownership, active-worker count, and peak count. Put playback before the illustration so controls are visible on laptops. Show a real red/green code diff with execution markers. Browser tests must reproduce the JavaScript semantics independently of the frame data.

## Performance refinement

Measured optimization preserves the visual design and interaction model. Serve Onest as a preloaded Latin/common-symbol WOFF2 subset with extended glyphs on demand. Preserve all original glyph mappings, metrics, and variable weights; keep source and regeneration instructions. Record repeatable cold-cache measurements in docs/audits/website-performance-2026-11-02.md. Do not add speculative rendering or image optimizations when the measurements show existing behavior is adequate.
