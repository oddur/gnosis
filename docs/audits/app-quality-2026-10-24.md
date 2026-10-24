# Gnosis app quality audit — 24 October 2026

Audited the polish implementation at `39f9b65` ([PR #120](https://github.com/oddur/gnosis/pull/120)). This report is the next stack layer. It records findings; it does not apply additional UI fixes.

## Implementation integrity verdict

**Pass, with isolated drift.** Gnosis has a coherent review workflow: queue filters, stack membership, source PR identity, file progress, inline explanations, and background Activity serve concrete review tasks. The compact workbench system remains consistent across the main screens. The command palette and shortcut reference now use the shared dialog behavior.

The main remaining visual mismatch is the interactive explanation frame, which still uses the earlier warm palette. Source scanning also finds old color declarations, many of which are overridden or belong to unused components. Those counts are not a count of visible defects.

## Executive summary

**Audit health: 14/20 — Good; address the accessibility gaps.** Functional checks pass, but those checks do not establish WCAG conformance.

Six verified issue groups: **0 P0, 4 P1, 2 P2, 0 P3**. The first four concern contrast, accessible names, and pointer target size. The two follow-ups concern large queues and the explanation frame's palette.

| Dimension | Score /4 | Main evidence |
| --- | ---: | --- |
| Accessibility | 2 | Review navigation and some diff colors fail contrast checks; several names are missing or mismatched. |
| Performance | 3 | Ordinary flows work well. A synthetic 1,000-item queue mounts 17,163 elements and causes a 222 ms main-thread task. |
| Theming | 3 | Both main themes are coherent. The sandboxed explanation frame retains the old warm palette. |
| Responsive design | 3 | Laptop and zoom checks pass, but the file list contains targets below the WCAG 2.2 minimum size and spacing. |
| Implementation integrity | 3 | Shared controls follow the workbench system; legacy styling and the frame palette remain exceptions. |
| **Total** | **14/20** | **Good** |

These scores describe the inspected implementation, not a certification or a benchmark against an earlier audit.

## Scope and method

- Read the active app paths and shared components, plus theme, keyboard, Markdown, highlighting, and explanation-frame code.
- Ran Impeccable's source detector over `src` and `components`, then its rendered detector through a local Electron DevTools connection.
- Captured **24 axe-core 4.14.0 snapshots** in visible Electron 41.2.1 windows, using seeded workbench fixtures. Coverage included queue, filters, single-PR summary, review, topics, chat, interactive explanations, image comparison, GitHub comments, Activity, settings, palette, sign-in, onboarding, and local review.
- Inspected light/dark renders at laptop widths. The existing browser suites also cover stack summaries, saved views, notifications, help, submission, failure/retry states, image expansion, and 200% zoom.
- Used actual Electron keyboard/mouse input in the polish and hardening regressions. Secondary-pointer, cancel, blur, and reduced-motion checks use synthesized events or Chromium emulation. No physical touch device or screen reader was tested.
- Used the app's mock GitHub and AI APIs. No comments, approvals, or credentials were sent to GitHub during the audit.

[Evidence JSON](2026-10-24/evidence.json) contains the snapshot dimensions, raw rule findings, selectors, contrast measurements, source-detector totals, bundle sizes, and queue timing. Duplicate snapshot findings are grouped below by cause.

The modal scans are scoped to the open dialog. An initial whole-document scan reported contrast from underlying diff shadow DOM even while a modal obscured it. Those background results do not describe the modal and were excluded from the modal assessment.

## P1 findings

### A1. Active review navigation text is too faint

**Location:** [TocRail.tsx](../../components/TocRail.tsx), lines 69 and 98–99; [SlideNav.tsx](../../components/SlideNav.tsx), line 63.

**Category:** Accessibility. **Standard:** WCAG 1.4.3, Contrast (Minimum).

In Light, unselected topic names render at **3.46:1**, and the previous-topic title at **3.92:1**. Both are normal-size text and require 4.5:1. These are available navigation controls, so the inactive-control exception does not apply. Hovering makes them clearer, but reviewers must first read them to choose a destination.

The cause is opacity applied to foreground text (`text-foreground/55` and `/60`). Reviewed topic names use an even lower foreground opacity, although this audit did not record a separate contrast ratio for that state.

**Recommendation:** use a full-contrast semantic text token for available destinations. Indicate the selected or reviewed state through weight, background, and the existing checkmark. Verify default, hover, selected, and reviewed states in both themes.

**Suggested command:** `$impeccable colorize` for review navigation.

[Topics screenshot](2026-10-24/topics-light.png)

### A2. Some diff colors fail on change backgrounds

**Location:** [ReviewDiff.tsx](../../components/ReviewDiff.tsx), theme/options construction around lines 102–141; the selected Shiki theme and Pierre diff background combinations.

**Category:** Accessibility. **Standard:** WCAG 1.4.3, Contrast (Minimum).

The `github-dark` fixture produces **2.68:1** for a keyword on the stronger inline-addition background (`#f97583` on `#2f623e`). Other keyword and token combinations measure 3.80:1–4.32:1 on addition/deletion backgrounds. These failures occur in both app themes because code themes are independent of the app theme.

The default Aurora fixture has a narrower issue: two context-line numbers measure **4.45:1** (`#777779` on `#07090f`). Do not generalize the larger GitHub-theme failure to every code theme.

**Recommendation:** validate token colors against context, addition, deletion, and inline-change backgrounds for every offered code theme. Adjust the combinations or offer a verified high-contrast alternative. Preserve the meaning of changed lines and the user's theme choice.

**Suggested command:** `$impeccable colorize` for diff themes.

### A3. Several visible states lack matching accessible names

**Locations:** [ReviewPage.tsx](../../src/pages/ReviewPage.tsx), line 648; [Markdown.tsx](../../components/Markdown.tsx), the shared Markdown component map; [HomePage.tsx](../../src/pages/HomePage.tsx), line 698.

**Category:** Accessibility. **Standards:** WCAG 4.1.2, Name, Role, Value; WCAG 2.5.3, Label in Name.

| Case | Verified behavior | Recommendation |
| --- | --- | --- |
| Review progress | The top progressbar exposes a value but no accessible name. | Name it “Review progress” and expose topic position as value text. |
| Author task lists | Two disabled Markdown checkboxes have no associated name. Their task text is a sibling, not a label. | Associate each task's text with its checkbox, or render an equivalent named, read-only status. Preserve checked state. |
| GitHub account | At wide widths, the button shows the username but its accessible name is only “GitHub account.” | Include the visible username in the accessible name. Keep a clear signed-out name. |

The missing names make status harder to interpret with assistive technology. The account mismatch also prevents a voice-control user from relying on its visible label.

**Suggested command:** `$impeccable harden` for shared names and status semantics.

### A4. Narrative file links are too small and tightly spaced

**Location:** [SlideView.tsx](../../components/SlideView.tsx), the file list around line 583; [FilePathLink.tsx](../../components/FilePathLink.tsx).

**Category:** Responsive design / Accessibility. **Standard:** WCAG 2.5.8, Target Size (Minimum).

In the image-review fixture, three file buttons are **18 px high**, with nearest-target safe spacing of **21.6–22.6 px**. They fail both the 24×24 minimum and its spacing exception. These are separate list entries, not links embedded in a sentence. The result is a cramped pointer target when selecting a nearby file.

**Recommendation:** give each list entry a minimum 24 px hit height or enough separation to satisfy the spacing exception. Preserve the compact appearance; 44 px is not a universal WCAG AA requirement for this desktop interface.

**Suggested command:** `$impeccable adapt` for file-list hit areas.

[Image review screenshot](2026-10-24/image-review-light.png)

## P2 findings

### F1. Large queues render every row

**Location:** [HomePage.tsx](../../src/pages/HomePage.tsx), `group.map(row)` around line 1075 and the four-second queue refresh around line 247.

**Category:** Performance. No WCAG failure claimed.

A fixture with **1,000 standalone PRs** mounted **17,163 DOM elements**. Refresh-to-paint took approximately **388 ms**, including observed main-thread tasks of **222 ms** and **57 ms**. This was a single development-build run on the local Mac, not a production benchmark. The mock returned immediately, so the measurement does not include GitHub latency.

The source confirms that all matching rows mount together. A large backlog can therefore delay interaction even when GitHub data is cached. The four-second local queue poll is not evidence of a four-second GitHub request; the app has a separate cache and request policy.

**Recommendation:** virtualize or incrementally render queue sections while preserving selected-row visibility, stack expansion, keyboard navigation, and scroll restoration. Measure again using the same 1,000-item fixture and a packaged build.

**Suggested command:** `$impeccable optimize` for large work queues.

### T1. Interactive explanations retain the old palette

**Location:** [explainer-document.ts](../../lib/explainer-document.ts), lines 20–26.

**Category:** Theming / Implementation integrity. No contrast failure claimed for the sampled diagram.

The sandbox host defines warm paper, ink, and amber controls independently of the app tokens. In Dark, its canvas is `#211f1c` and its action accent is `#d8a16c`, while the surrounding workbench uses cool neutral surfaces and a blue accent. The frame updates when the app theme changes, but both frame palettes belong to the older design.

**Recommendation:** map the sandbox's semantic host variables to the current light/dark workbench palette. Preserve diagram-specific colors when they encode meaning, and keep the saved-artifact/runtime isolation contract intact.

**Suggested command:** `$impeccable colorize` for the explanation host.

[Explanation screenshot](2026-10-24/exploration-dark.png)

## Detector triage and limits

The source detector returned **99 findings**: 4 font warnings, 83 color advisories, and 12 radius advisories.

- The four font warnings refer to bundled Plus Jakarta Sans faces. This is the explicitly documented application typeface, so they are not defects or a reason to change fonts.
- The 95 design-system advisories include overridden newspaper-era CSS, unused components, semantic status colors, and small optical radius adjustments. They are not 95 confirmed visible problems. The active sandbox palette mismatch is reported separately as T1.
- Axe flags the compact file header's reordered filename/directory text as a label-in-name mismatch. Its accessible name includes the full path and the primary visible filename. This was not counted as a verified defect without a voice-control test.
- “Incomplete” axe results are manual-review requirements, not passes or confirmed failures. These include shadow-DOM contrast and some Radix relationships. Named dialogs and focus behavior received separate keyboard checks.
- Generated diagrams, arbitrary PR Markdown, every optional code theme, and every OS/input configuration were not exhaustively audited. The findings are bounded by the fixtures and explicit source checks above.

## Positive findings to preserve

- No blocked core task was found in the exercised queue-to-review flow.
- The scoped palette and settings checks have no reported axe violations in either theme. Keyboard regressions verify focus containment, restoration, IME handling, and protection from background review shortcuts.
- Sign-in, onboarding, local review, and Activity samples have no reported axe violations. Their failure, retry, and cancellation flows also have browser coverage.
- Single-PR and stack summaries share a stable frame. Images, Mermaid diagrams, and long descriptions remain contained in the tested layouts.
- Reduced motion preserves status and the code-location highlight. The code uses explicit alternatives rather than a global near-zero animation duration.
- Default fonts are bundled. Markdown images load lazily; Mermaid loads dynamically. The packaged renderer has 452 JavaScript chunks totaling 15.19 MB, with a 1.47 MB entry chunk (430 KB gzip). This is installed output, not an initial network transfer; grammar/diagram chunks are separate.
- 142 unit tests, all nine workbench browser suites, explainer browser checks, TypeScript, targeted ESLint, and packaging passed. PR #120's checks passed on Linux, macOS, and Windows.

## Recommended sequence

1. **P1 — `$impeccable colorize`:** fix measured navigation and diff contrast combinations (A1, A2).
2. **P1 — `$impeccable harden`:** name progress and task states; match the visible account label (A3).
3. **P1 — `$impeccable adapt`:** increase file-list target size or spacing (A4).
4. **P2 — `$impeccable optimize`:** reduce the DOM/rendering cost of large queues (F1).
5. **P2 — `$impeccable colorize`:** align the sandbox host palette (T1).
6. **`$impeccable polish`:** verify the fixes together across the full review path.

These follow-ups can run separately or together. Re-run `$impeccable audit` afterward to measure the result.

## Reproduction entry points

```sh
npm test
npm run test:workbench
npm run test:explainer
npx tsc --noEmit
npm run package
.agents/skills/impeccable/scripts/impeccable detect --json src components
```

For rendered inspection, use `tests/fixtures/workbench.html` through Vite in a visible Electron window with a loopback DevTools port. Query variants `?polish`, `?pr-summary`, `?images`, `?threads`, and `?onboarding` seed the cases above. The ordinary fixture uses GitHub Dark code; `?polish` uses Aurora. `tests/polish-browser.ts` records the keyboard, zoom, and reduced-motion interactions.

```sh
.agents/skills/impeccable/scripts/impeccable detect \
  --cdp 9336 --target workbench.html --json
```

Axe snapshots used the WCAG 2 A/AA, 2.1 A/AA, and 2.2 AA rule tags. Use the open dialog as the scan root when inspecting a modal, and inspect underlying diff contrast with the modal closed. Snapshot selectors and measured values are retained in the evidence JSON.
