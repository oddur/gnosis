# PR conflict resolution

Mode: Operate. Extend the established review workbench, retaining DESIGN.md and its existing controls. This is a code-led local addition, not a new visual identity or a comp-led build.

## Confirmed workflow

The user approved in-app merge conflict resolution with Pierre, bundled Mergiraf, and the existing Claude/Codex agents. Work in a private bare Git cache without modifying or checking out the user's repository. Keep automatic results as proposals. Require explicit review and publication to the selected PR branch.

## Direction contract

THESIS: Resolve a blocked PR in the review context, with every automatic proposal still under the reviewer's control.

OWN-WORLD: Existing neutral workbench surfaces, blue focus and selection, compact system controls, familiar file tree and Pierre code rendering. No additional palette or typography system.

STORY: Identify the PR and branch direction, choose or edit each conflict, inspect a proposal, mark files reviewed, inspect the complete branch diff, then explicitly commit and update the PR.

FIRST VIEWPORT: The PR and branch direction sit above a file list and code pane. File actions stay below the code. The bottom-right action opens a final preview; it does not publish. Publishing is a separate action beside the commit message.

FORM: Inherited file-navigation and code-inspection workbench in a protected full-window dialog. Keep code visible after resolving markers, support light/dark themes, and reflow controls at narrow laptop widths. No independent concept roll for this extension.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Verification and limits

Synthetic browser fixture: `.impeccable/review/conflict-resolution/` captures light, dark, editor, proposal, preview, published, and narrow. Desktop is 1280×900; narrow is 760×800. The Electron product ships on desktop; a phone layout is not a shipping target.

Manual editor typing, branch choices, saved drafts, preview/publication separation and stale revisions are exercised. Real Git tests cover clean base changes, two-parent commits, leases, unsupported conflicts, markers, cancellation, account isolation, and publication recovery. The bundled Mergiraf binary runs in its own integration test.

Only regular UTF-8 text conflicts are editable in this version. Structural, binary, rename/delete and oversized conflicts explain the limitation and link to GitHub. Agent proposals use supplied file versions and the user's selected model; project tests are not run. The application explicitly says so before publication.

## Finish evidence

The finish reviewer returned **ship** with no required fixes. The documenter compared the workspace components and conflict styles with `DESIGN.md` and `.impeccable/design.json`. The surface retains the existing palette, compact controls, bordered panes, focus rings, and responsive breakpoints. The design system files remain unchanged because this extension introduces no system change.

The documenter checked two subsequent corrections in source. The heading uses the existing `--type-panel-title` token. Repository, PR, and branch identifiers use `RepositoryBadge`, `PrBadge`, and `BranchBadge`. These corrections resolve both deviations from the documented system. This final check covers those source changes. It does not claim a new browser review.

## Empty preparation states

A user screenshot exposed the ambiguous “0/0 files reviewed / No conflicts remain” state. The corrected surface replaces the empty file editor with an explicit result: Git prepared a clean local merge (review the branch update), or the PR already contains the live base (check latest branches; publication is unavailable). Both state that nothing was committed or pushed. Browser regression captures are `clean-merge.png` and `up-to-date.png`; native Git tests distinguish both states and reject an unnecessary update. Live PR #206 confirmed the root cause: its historical base snapshot was an ancestor, while its live main tip produced two conflicts.

## Contextual conflict guidance

The workspace now shows the sequence **Resolve files → Review update → Commit & push**, the base-to-PR branch direction, and **Local draft · Nothing pushed**. Optional **How to resolve** guidance can be reopened at any time. It explains version choices, the limits of Mergiraf and agent proposals, review, and the final merge commit.

Each file reports **Needs resolution**, **Ready to review**, or **Reviewed**, with the next action beside the code. **Mark reviewed & next** advances to another unreviewed supported file. Automatic proposals report how many files still need conflict resolution and open the comparison when no markers remain. Reviewing an unchanged proposal preserves its source; manual edits clear obsolete proposal notes.

Native Mergiraf tests prove independent JSON edits survive in the final merge and incompatible edits remain blocked. Publication occurs only in temporary local Git fixtures. The browser test covers replayable help, automatic proposal feedback, editing, multi-file progression, and preview/publication separation. New captures: `guide.png` and `files-reviewed.png`; the existing desktop and narrow captures are refreshed. The finish review found two issues: supporting text could collapse the code pane at narrow widths, and dirty reviewed files still appeared complete. Both are fixed and covered by browser assertions and fresh captures (`narrow-guide.png`, `edited-reviewed.png`). The final verdict is **ship**, covering those scored fixes, with no remaining findings. All 541 unit tests passed with no skips; TypeScript, touched-file lint, and the conflict browser flow passed.

The documenter checked the guidance components and final conflict styles against the existing system. The workflow strip uses caption text, neutral colors, and a semibold current step. The optional guide uses control text within a bounded, scrollable region. File status labels and automatic outcome messages preserve the Status Rule. The shared button supplies the next-file action.

The editor and preview retain at least 200px of height. The file pane and dialog scroll when support content exceeds their available space. These dimensions belong to this surface. Existing palette, typography, focus, and border tokens remain authoritative. `DESIGN.md` and `.impeccable/design.json` remain unchanged. This source check identifies no new system change and records no finish verdict for the guidance extension.


## Notifications inside the workspace

A user screenshot exposed floating notifications covering the review action; clicking their close button also dismissed the modal. A real-pointer browser regression reproduced that failure. The workspace now hosts notifications below its heading in reserved space, inside the modal boundary. The notification region is limited to 120px and scrolls when needed. Closing a notification leaves the workspace open; closing the workspace returns pending notifications to the normal app viewport.

Conflict activity carries its workspace URL or session ID. The notification tracker suppresses outcomes already displayed in that workspace, while other PRs and work that completes after leaving still notify. This reuses the existing toast controls and palette. Evidence: `notification.png`, `notification-narrow.png`, actual pointer dismissal and focus checks, host cleanup, and activity notification tests. The full unit suite passes 542 tests without skips; the conflict browser flow and TypeScript check pass.

The finish reviewer found an Activity-drawer positioning override that also affected hosted notifications. The rule now excludes inline hosts. The browser verifies the real Activity drawer case (`notification-activity.png`), including the 120px limit. The final scored verdict is **ship**, with no remaining findings.


## Explicit file stages

The user confirmed three file stages: **Conflicted**, **Resolved**, and **Reviewed**. One shared derivation uses the displayed draft: unsupported conflicts or remaining markers are Conflicted; marker-free code is Resolved; only explicit human acknowledgement of unchanged content makes it Reviewed. Manual edits immediately invalidate the previous review.

The list and selected-file heading share labeled status badges with distinct icons and the existing danger, primary, and success colors. The toolbar counts each stage, with zero counts muted. Helper text explains that Resolved still needs review; the footer names whether resolution or review is blocking the next step. **Mark as reviewed** remains explicit. Bulk proposal controls only appear for multiple files.

Evidence: native stage assertions, real Mergiraf tests, and browser transitions from Conflicted to Resolved to Reviewed and back after editing. Fresh captures include `file-resolved.png`, `file-reviewed.png`, and `edited-reviewed.png`. Existing light, dark, narrow, and notification captures are regenerated. No new design tokens or persistence migration are needed.

The finish reviewer returned **ship** for the three-stage clarification with no required fixes. Ten conflict tests (including native Mergiraf), TypeScript, touched-file lint, and the complete conflict browser flow pass.
