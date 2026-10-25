# Workbench final audit — 24 October 2026

Audited implementation `f5105b5`, after the colorize, harden, adapt, optimize, and polish passes in PRs #123–#127. This final layer contains the report and evidence only.

## Implementation integrity verdict

**Pass.** The compact workbench retains its review workflow, stack identity, saved views, source PR attribution, and background Activity. Changes improve reading and navigation without replacing the design. The sandboxed explainer now follows the workbench palette.

Impeccable’s rendered detector reports one font advisory. Plus Jakarta Sans is the project’s chosen face, so this is not a defect. The source detector reports 98 advisories: 81 color, 13 radius, and four font declarations. These include legacy styles, explicit syntax colors, and deliberate shared tokens; they are not 98 visible failures.

## Executive summary

**17/20 — Good**, up from **14/20** in the [baseline audit](app-quality-2026-10-24.md).

All six baseline issue groups are addressed. There is **one P2 semantic markup follow-up**, with **0 P0, 0 P1, and 0 P3 findings**. No blocking regression was found in the tested workflows. This is a scoped quality assessment, not WCAG certification.

| Dimension | Score /4 | Evidence and limits |
| --- | ---: | --- |
| Accessibility | 3 | Named progress and task boxes, readable navigation, ten verified code palettes. Generic file-header elements still carry unsupported ARIA names. No physical screen-reader test. |
| Performance | 3 | Large queues now mount nearby rows; the sampled long tasks disappear. Packaged startup, very large individual stacks, and long AI conversations were not benchmarked. |
| Theming | 4 | Light and Dark screens agree; explainer host colors match the app; code themes retain their identities. |
| Responsive design | 3 | Laptop, narrow-pane, zoom, and dialog checks pass. File targets meet the desktop minimum. No physical touch-device validation. |
| Implementation integrity | 4 | Shared controls and state vocabulary remain coherent; virtual rendering preserves the complete cached queue and briefing filters. |
| **Total** | **17/20** | **Good** |

## Baseline findings revisited

| Baseline | Result | Evidence |
| --- | --- | --- |
| A1: faint navigation | Addressed | Semantic secondary text replaces opacity-based topic and previous-topic labels. Light/Dark topics scans have no confirmed contrast violations; current and reviewed states have explicit semantics. |
| A2: diff contrast | Addressed | Whole-palette unit checks cover context, additions, deletions, and inline emphasis. Rendered TypeScript samples across all ten themes, including line numbers, measure at least **4.80:1**. Translucent token colors are included. |
| A3: unnamed states | Addressed | Progress announces review position; Markdown task boxes announce their own rich/nested task text and checked state. Account and compact filename names include visible text. |
| A4: small file links | Addressed | The same standalone narrative file link grows from **18px to 24px**. Coarse-pointer CSS provides 44px targets. Browser regressions verify the desktop target. |
| F1: entire queue rendered | Addressed | Queues over 80 items use measured virtual rows, preserving selected/focused rows, expanded stacks, filter results, and scroll restoration. |
| T1: warm explainer palette | Addressed | Host paper, ink, muted text, and accent now match the cool Light/Dark workbench. Artifact-specific drawing colors and sandbox boundaries remain intact. |

### Queue measurement

| Same 1,000-PR fixture | Before | After |
| --- | ---: | ---: |
| Mounted queue rows | 1,000 | 10 |
| DOM elements | 17,162 | 342 |
| Refresh to paint | 252ms | 104ms |
| Recorded long tasks | 95ms, 147ms | None |

These are single local Electron development runs at 1100×700. Timing includes a 100ms readiness poll and two animation frames; it is not a production latency guarantee. A separate regression exercises 25 keyboard moves across virtual boundaries, stack expansion, cache refresh, summary-return scroll restoration within 5px, resizing, and filtering. This optimization changes local rendering, not GitHub API traffic or automatic briefing scope.

## P2 finding

### File-header descriptions use names on generic elements

**Location:** [ReviewFileHeader.tsx](../../components/ReviewFileHeader.tsx:65), source container and line-count span around line 102.

**Category:** Accessibility / semantic markup. **Reference:** WAI-ARIA’s `generic` role prohibits author naming.

The source container and count span use `aria-label` without a role that supports naming. Axe reports these as incomplete checks. Chromium’s accessibility tree currently exposes both names; this audit did **not** observe a missing name in that tree. The markup nevertheless relies on behavior outside the role’s naming contract, so announcement can vary between assistive technologies.

The visible filename, counts, and controls remain available. This is a semantic follow-up, not a demonstrated blocked review task.

**Recommendation:** use an appropriately named group for the source header and normal text, including hidden descriptive text if needed, for line counts. Confirm the result with VoiceOver or another supported screen reader.

**Suggested command:** `$impeccable harden`, followed by `$impeccable polish`.

## Scope and evidence

- **20 primary axe-core 4.14 snapshots**, plus a focused file-header recheck, in visible Electron windows. All report **zero confirmed violations**. Coverage: queue, PR description, review, topics, chat, explainer, appearance settings, Activity, command palette, image comparison, GitHub threads, onboarding, guest/local flow, and an 850px review.
- Light/Dark screenshots were inspected. Separate Chromium checks sample rendered syntax and gutters across all ten code palettes. Raw values and axe incomplete checks are retained in [evidence.json](2026-10-24-final/evidence.json).
- Remaining axe incomplete checks include punctuation-only contrast and Radix controls referencing popups mounted on demand. These are distinguished from the generic-role finding above.
- **153 unit tests, all ten workbench browser suites, explainer browser checks, TypeScript, and targeted ESLint pass.** The macOS arm64 package builds successfully.
- Tests cover keyboard focus, IME input, saved views, notifications, comments, image loading and retries, failure recovery, sign-in fallback, 200% zoomed dialogs, and reduced motion. Touch-related checks use browser emulation or synthetic events, not a physical device.
- GitHub and AI responses are fixture data. Live network behavior, generated artifact quality, physical screen readers, and packaged startup timing remain outside this audit’s evidence.
- GitHub CI initially failed because a prior test required one exact comment color. The first layer now checks rendered contrast instead; subsequent layers were rebased onto that correction. A second CI-only failure came from a fixed pixel offset in the virtual-queue test; it now seeks by mounted row index and passes locally. Neither test correction changes application behavior. Current CI results are available on each PR.

## Positive findings and next steps

The queue keeps the full cached dataset while limiting mounted rows. Small queues retain normal document flow. Theme preferences remain compatible, and contrast checks cover the offered palettes rather than just the default. Task names preserve nested Markdown structure. Dialog and reduced-motion regressions remain intact.

The next narrow pass should resolve the P2 file-header semantics and verify them with a screen reader, then use `$impeccable polish` and repeat the affected audit checks. No further visual redesign is indicated by this audit.

[Topics in Light](2026-10-24-final/final-topics-light.png) · [Review in Dark](2026-10-24-final/final-review-dark.png) · [Explainer in Dark](2026-10-24-final/final-explainer-dark.png)
