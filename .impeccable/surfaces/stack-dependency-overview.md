# Stack dependency overview

Mode: Operate. Extend the existing Gnosis review workbench and preserve PRODUCT.md and DESIGN.md.

## Direction contract

THESIS: Make the stack's structure and next merge blocker apparent without conflating GitHub eligibility with the user's review progress.

OWN-WORLD: Existing neutral surfaces, compact controls, entity badges, semantic status colors, system typography, and one-pixel separators. No new visual identity or raster assets.

STORY: Read the stack status, follow a specific blocker to its source PR, inspect each PR in its dependency context, and recheck dependent branches after an update. The user's viewed-file progress is separate from GitHub approval and merge readiness.

FIRST VIEWPORT: One stack verdict and independently dated merge requirements and check results precede a compact “To merge this stack” action list and a single dependency list. Linear stacks show the tip above the base branch. Each row separates Review status, Checks, and Branch. Each affected PR shows its blocker and remedy without expansion; details contain supporting check results. Required running checks are waiting states, not unspecified failures.

FORM: Code-led extension of the inherited workbench. Branching or incomplete groups show explicit relationships without a false linear rail. The single-PR summary includes an expandable cached stack navigator with the current PR highlighted. Desktop and laptop are shipping targets; narrow windows reflow controls.

FINISH: Inspect rendered desktop/narrow/dark views, verify exact action scope, stale evidence, and sibling navigation; record the finish verdict.

## Implementation evidence

`stackDependencyOrder` validates the dependency chain. `stackMemberStatus` separates merge blockers from check outcomes and optional branch updates. Current-head evidence and freshness are required; unknown requirements stay explicit. GitHub eligibility remains authoritative.

The stack header states whether merging is blocked. The action list links to affected PRs in dependency order, opening their PR overview. The draft group offers one-click “Mark all ready” with inline progress; successful changes are kept if a later PR fails, and Retry only handles the remaining PRs. Optional updates and check failures do not join that list. Review decisions, check outcomes, and branch state use independent columns. Viewed-file progress sits quietly beside branch metadata. Optional cancelled checks use amber and never appear in the blocker list. Ready rows omit redundant detail disclosures.

Each PR shows confirmed blockers, direct actions, and the names of up to two required failing checks. It can disclose up to three results per required/non-blocking group, and more results on request. Actions reuse the existing confirmation flows for draft status and branch updates. Conflict resolution opens the exact PR. Failed jobs and cancelled workflows have different rerun actions, with the workflow scope and current revision checked before submission. Permission reads start only when an action is invoked.

## Verification

Unit tests cover combined blockers, optional cancellations, required checks, unknown policy, and stale revisions. Browser checks cover action scope, lazy permissions, rerun modes, navigation, viewed progress, and light/dark layouts. Six ready PR rows fit at 1280×800; three fit at 900×600. Narrow windows and 200% zoom preserve the content without horizontal page scrolling.

The existing typography, palette, and dependency navigation remain. No raster assets are used. Visual evidence is in `.impeccable/review/stack-merge-details/` and `.impeccable/review/stack-layout/`.

The action-guidance pass adds regression coverage for optional results, waiting checks, incomplete freshness, stale evidence, visible remedies, and keyboard navigation from the action list. Refreshing or opening an action uses the existing authenticated paths; rendering the guidance does not fetch permissions.

The action-guidance pass passed 567 unit tests, the final targeted readiness regressions, TypeScript, targeted lint, and stack status/layout and PR action browser checks. The ready state removes the checklist and emphasizes the existing merge confirmation button. Six ready PR rows fit at 1280×800 and three at 900×600. The scoped design scan found no anti-patterns; existing stylesheet token advisories remain outside this change.
