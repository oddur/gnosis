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
