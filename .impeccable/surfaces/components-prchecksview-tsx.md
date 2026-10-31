---
version: 1
slug: "components-prchecksview-tsx"
primary_target: "components/PrChecksView.tsx"
related_targets: ["components/PrCheckSummary.tsx","components/PrSummary.tsx","components/QueueMetadata.tsx","lib/use-pr-checks.ts","src/pr-checks-service.ts","src/globals.css"]
---

# PR Checks

Mode: Operate. Extend the existing PR overview; preserve DESIGN.md and shared components.

## Direction contract

THESIS: Make failing CI identifiable from the queue and understandable without leaving the PR.

OWN-WORLD: Existing compact tabs, bordered panes, semantic status colors with icons and text, readable Markdown output. No new palette or typefaces.

STORY: Spot a failure, open Checks, select its job, read the failure and annotations, inspect source or request logs, rerun explicitly when permitted.

FIRST VIEWPORT: Summary includes count and named failure shortcuts. Checks uses a compact filter/refresh toolbar over a two-pane workspace. The left lists checks by source PR in stack order, failures first within each PR. The right shows result details, requirements, steps, annotations, and on-demand logs. At narrow widths the panes stack with bounded scrolling.

FORM: Existing-surface extension, user-confirmed nine-question brief. Local cached results first, all check runs and external statuses, revision-aware detail preservation, no eager log downloads. No concept roll required.

FINISH: Ship after finish review and documentation. The existing DESIGN.md remains authoritative; this extension introduces no tokens, visual world, or shipping raster assets.

## Final behavior

Queue status opens Checks. Summary shows result counts and named failure shortcuts. The Checks tab adds an attention count without changing shared navigation.

The toolbar offers All checks, Needs attention, Running, and Refresh. The list groups checks by source PR in stack order, with failures first. Each row shows its name, provider, status, and available duration. Selection uses a muted fill and a blue leading edge.

The detail header stays visible while output scrolls. It identifies the repository, source PR, commit, PR title, check, provider, status, and requirement. Source identity remains available when the list scrolls to another stack member. Required, Optional, and Requirement unknown are distinct labels.

Markdown summaries appear before full output, which starts collapsed. Steps and annotations follow. Annotation actions open source in the app or on GitHub. Logs load only after an explicit action. Rerun controls state that they apply to the workflow run and reflect permission and run state.

Saved results remain useful during refresh failures. New results do not replace the selected evidence automatically. A notice offers View latest results; previous-commit evidence keeps its original identity and disables reruns.

Wide layouts use independently scrolling list and detail panes. At widths of 700px or less, the list sits above the detail pane with bounded scrolling. Controls wrap, names can wrap, and the Activity bar remains visible. The surface uses existing semantic colors, typography, buttons, borders, and focus treatment.

## Reviewed evidence

Finish disposition: **ship**. The final review accepted the sticky source identity header and corrected fixtures. The documenter compared the final captures with DESIGN.md, its sidecar, and the implemented components.

| Capture | Comparison evidence |
| --- | --- |
| [desktop-light](../review/pr-checks/desktop-light.png) | Standalone PR at 1280 × 800: compact two-pane hierarchy, failure selection, readable output, and explicit rerun scope. |
| [summary-light](../review/pr-checks/summary-light.png) | Summary at 1280 × 800: counts and named failures fit the existing readiness area and preserve the author description below. |
| [stack-light](../review/pr-checks/stack-light.png) | Stack at 1280 × 800: aggregate attention count and source PR identity coexist without changing the workbench shell. |
| [stack-scrolled](../review/pr-checks/stack-scrolled.png) | Scrolled stack at 1280 × 800: PR, commit, and check identity remain visible above annotations and the explicit Load log action. |
| [updated-results](../review/pr-checks/updated-results.png) | Updated commit at 1280 × 800: the list reflects the new revision while selected evidence retains its old revision and an explicit update action. |
| [laptop-dark](../review/pr-checks/laptop-dark.png) | Dark theme at 900 × 760: panes retain readable hierarchy, distinct selection, semantic status labels, and restrained borders. |
| [narrow-dark](../review/pr-checks/narrow-dark.png) | Dark theme at 620 × 760: panes stack, source identity remains visible, and toolbar actions fit within the window. |

The detector report at `/tmp/gnosis-pr-checks-detect.json` contains 97 advisory findings, all in preexisting global CSS through line 3025. None targets the appended Checks rules. Existing drift remains outside this extension.

DESIGN.md and `.impeccable/design.json` need no change: their existing rules already cover this surface. Captures are review evidence, not shipping image assets.

## Live job-step clarity

Running steps use a distinct selected surface, spinner, explicit Running label, and a local elapsed timer. Completed steps retain their duration; pending and skipped steps stay visually quiet. Missing timestamps display no invented duration. Job steps precede rerun controls. Fresh job evidence updates the selected header and row, avoiding Queued beside a running step. Active details reuse the checks subscription rather than adding polling; logs remain intact during updates.

Verified with 11 checks unit tests, TypeScript, targeted ESLint, and the checks browser suite. The browser test verifies elapsed timers make no API calls, completion freezes duration, and fresh job state supersedes a queued snapshot. Rendered running-desktop, running-laptop, running-narrow, and finished-narrow captures are in the existing review directory. The test uses software rendering to avoid intermittent Electron compositor capture failures.
