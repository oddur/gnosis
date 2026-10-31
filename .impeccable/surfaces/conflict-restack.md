# Conflict resolution and dependent PR restacking

Mode: Operate. Extend the existing conflict workspace and preserve PRODUCT.md and DESIGN.md.

## Direction contract

THESIS: Resolve a conflict once, then carry the corrected ancestry through dependent PRs without repeating known resolutions or hiding branch changes.

OWN-WORLD: Existing compact workbench typography, branch/PR badges, semantic status colors, shared buttons, and Pierre diffs. No new visual identity.

STORY: Publish the resolved PR, prepare dependent PRs in order, pause for genuinely new decisions, review each proposed branch update, then push all dependent branches together. State explicitly what has and has not been pushed.

FIRST VIEWPORT: A compact confirmation of the resolved PR precedes the current restack task. Prepared updates show source PR, branch ancestry, original/new revisions, remembered-resolution count, and actual diffs. The review count and publication action remain visible while browsing updates.

FORM: Code-led extension of the existing Electron workspace. A private worktree keeps Git and filesystem activity in the backend. New conflicts have explicit Conflicted, Resolved, and Reviewed states, editable results, both source versions, draft persistence on close, and Continue restack. Desktop and laptop are the shipping context; narrow windows reflow metadata.

FINISH: Verify real-Git preparation, rerere reuse, paused-state recovery, branch race guards, atomic publication, and rendered review/pause states. Existing design authority remains unchanged.

## Boundaries

The first version handles a single linear chain of up to 30 dependent PRs in one repository, so all branch writes can be atomic. Each branch may replay at most 500 commits; previews and paused-conflict contents are bounded. Unsupported binary, rename, deletion, and mode conflicts retain an explicit local-Git fallback. Preparation never pushes. Git rerere memory is isolated by account and repository, and remembered changes still require review of the proposed PR update.

## Verification and finish

All 557 unit tests pass. Real-Git integration tests cover isolated rerere memory, latest reviewed resolution replacement, cross-PR reuse, pause/edit/review/resume across service restart, already-updated parent ancestry, atomic push leases, recovery after publication persistence failure, and preservation of paused drafts after source changes. Tests use temporary local remotes; no user PR was rewritten during verification.

The conflict browser suite verifies preparation never publishes, each PR must be marked reviewed, publication sends the exact reviewed targets, and closing a paused editor saves an unreviewed draft. TypeScript, targeted ESLint, and `git diff --check` pass. The layout detector reports no findings.

Rendered evidence: `.impeccable/review/conflict-resolution/restack-desktop.png`, `restack-laptop.png`, `restack-paused.png`, and `restack-published.png`. The review count and push action remain outside the scrolling update list. Independent Impeccable finish review: **disposition: ship**, no material fixes. Preserve the distinction between the published source PR and unpushed dependent changes, explicit review gates, and draft preservation.
