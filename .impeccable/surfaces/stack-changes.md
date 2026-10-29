# Stack Changes: Combined and By PR

Mode: Operate. Extend the existing laptop review workspace; retain DESIGN.md tokens and composition.

## Confirmed direction

- Job: understand the net result of a stack or inspect each contribution without losing one's place.
- First viewport: the existing file tree and scrolling code, with a compact Combined / By PR switch in the toolbar. Combined names the target branch and top PR. The diff remains the primary content.
- Combined is the initial default; remember the user's last mode across stacks. Individual PRs and other tabs retain their behavior.
- Verify a same-repository linear chain and current-head ancestry. Explain unsupported topology or stale parent ancestry with a By PR action; never choose a tip implicitly.
- Compare the target/tip merge base to the tip. Pin all source revisions. Cache immutable results, preserve each mode's position, and offer Update changes on new commits.
- Separate combined Viewed progress. Label partial coverage persistently, including when all available files are viewed.
- Map comments only with proven coordinate identity, label their source PR, and open that PR to write/reply. All source discussions remain reachable. Review submission explicitly chooses a PR and pins its displayed revision.
- No new visual identity, font, or token changes. Keep file filters, diff controls, images, Markdown previews, and file chat.

## Verification targets

Linear/branching/cross-repository/stale chains; net-zero files; revisions and mode switching; isolated progress; comment attribution; partial/failed/empty/cancelled loads; laptop and narrow layouts; light and dark themes.

## Shipped behavior

- `StackChangesView` adds the compact mode switch and a wrapping comparison context row. It names the target branch, top PR, pinned tip, and common ancestor. `PrChangesView` and `PrFileInspection` retain the existing tree, scrolling diff, filters, previews, file chat, and file actions.
- Combined supports same-repository linear stacks with verified current-head ancestry. Unsupported topology and stale parent ancestry explain the limitation and offer Review by PR. The comparison contains net changes from the target/tip merge base to the pinned tip; reverted changes can disappear.
- Mode preference persists across stacks. Each mode retains its selection and scroll state, reuses cached comparisons, and keeps Viewed progress separate. Refresh preserves a selected file when it remains available. New commits prompt an explicit update; failed updates retain saved code.
- GitHub comparisons have a 300-file cap. Partial coverage stays visible, including the “All available files viewed” state. Loading can be stopped; errors offer retry and By PR recovery.
- Inline discussion mapping requires exact source revision and side identity. Unmapped discussions remain accessible with source PR attribution. Source navigation follows renamed paths; writing and replying open the source PR. Review submission requires an explicit PR choice and pins that PR's displayed revision. The combined comparison never becomes a GitHub review destination.

## Verification record

Finish review disposition: **ship**. All five review sections completed; no material fixes required. The design detector returned no findings (`/tmp/gnosis-stack-detect.json`).

The browser suite in `tests/stack-changes-browser.ts` passed mode switching, cached comparison reuse, separate Viewed progress, preserved file selection on refresh, explicit review targeting, partial coverage, stale-parent failure recovery, and narrow layout checks. Browser fixtures exercise these UI states; live GitHub behavior remains subject to the supported topology and comparison limits above.

Reviewed captures in `.impeccable/review/stack-changes/`: `desktop-light.png`, `desktop-dark.png`, `by-pr.png`, `narrow.png`, `partial.png`, `stale-parent.png`, and `review-target.png`. Desktop captures use 1280 × 800; narrow uses 800 × 800 without page-level horizontal overflow.

This is a local extension of the established workbench. Existing palette, typography, controls, and semantic tokens remain authoritative in DESIGN.md. Known pre-existing metadata drift in DESIGN.md and `.impeccable/design.json` was neither repaired nor adopted as a new rule.
