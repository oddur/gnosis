# Stack dependency overview

Mode: Operate. Extend the existing Gnosis review workbench and preserve PRODUCT.md and DESIGN.md.

## Direction contract

THESIS: Make the stack's structure and next merge blocker apparent without conflating GitHub eligibility with the user's review progress.

OWN-WORLD: Existing neutral surfaces, compact controls, entity badges, semantic status colors, system typography, and one-pixel separators. No new visual identity or raster assets.

STORY: Read the stack status, follow a specific blocker to its source PR, inspect each PR in its dependency context, and recheck dependent branches after an update. The user's viewed-file progress is separate from GitHub approval and merge readiness.

FIRST VIEWPORT: A concrete next-step sentence and action precede the PR chain. Linear stacks show the tip above the base branch. Every PR shows branch direction and a textual merge state. Detailed requirements remain in the existing supporting column.

FORM: Code-led extension of the inherited workbench. Branching or incomplete groups show explicit relationships without a false linear rail. The single-PR summary includes an expandable cached stack navigator with the current PR highlighted. Desktop and laptop are shipping targets; narrow windows reflow controls.

FINISH: Inspect rendered desktop/narrow/dark views, verify exact action scope, stale evidence, and sibling navigation; record the finish verdict.

## Implementation evidence

`stackDependencyOrder` checks the actual edge graph before drawing a chain. `stackMergeTarget` uses matching fresh base-branch evidence, so retargeted PRs do not falsely report conflicts with their historical parent. Current merge labels distinguish conflicts, required review, running/failing checks, ready, stale, and unknown. Display labels never authorize a merge.

`StackDependencyChain` is shared by the overview and single-PR context. The context reads local signal snapshots only. `StackOverview` presents a concrete next merge step and preserves file progress, GitHub reviews, and check navigation as separate evidence.

## Verification and finish

All 546 unit tests pass, including chain validation, actual base-target selection, stale evidence, and merge-label cases. Browser suites `--stack-merge-details`, `--stack-layout`, and `--stack-hierarchy` pass. They cover exact conflict-action scope, sibling navigation, current-PR highlighting, and stack density. TypeScript, targeted ESLint, and `git diff --check` pass. The final layout detector reports no findings.

Rendered light, dark, narrow-window, current-PR, and ten-PR views were inspected. Six complete PR rows fit at 1280×800; three fit at 900×600. Captures are in `.impeccable/review/stack-merge-details/` and `.impeccable/review/stack-layout/`.

Independent Impeccable finish review: **disposition: ship**. No material fixes remain. Keep exact per-PR actions, truthful dependency relationships, and the distinction between personal review progress and GitHub readiness. Existing DESIGN.md remains the visual authority.
