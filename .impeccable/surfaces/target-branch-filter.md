# Target branch filter

Mode: Operate. Ordinary extension of the existing queue filters.

## Surface contract

Reviewers can narrow the queue by a PR's target branch. The labeled text field sits after Author and spans two filter columns.
It uses the existing field styles, theme colors, typography, and focus treatment. The placeholder reads “Any branch”.
An example below the field introduces `release/*`. The existing “How filters work” disclosure explains the full syntax.

The filter matches the whole branch name and preserves case. `*` matches any text, including `/`. `?` matches one character.
A blank value accepts any branch. Normalization trims surrounding whitespace and limits the pattern to 300 characters.

The shared queue model applies the filter to saved views, removable chips, filter counts, and automatic briefing scope or priority.
The target branch and other PR conditions must match the same eligible stack member. The complete stack remains visible.
The filter uses cached PR data and introduces no network behavior.

## Implementation and evidence

The documenter checked these sources and rendered captures on October 27, 2026:

- [QueueFilterPanel](../../components/QueueFilterPanel.tsx): field label, associated help text, syntax disclosure, and existing filter placement.
- [Queue filters](../../lib/queue-filters.ts): normalization, branch matching, stack conditions, chips, and briefing selection.
- [Styles](../../src/globals.css): field width, two-column span, and help-text line height.
- [Browser test](../../tests/target-branch-browser.ts): wildcard filtering, focus retention, empty results, chip removal, and saved-view restoration after reload.

| Capture | Observed result |
| --- | --- |
| [Desktop](../review/target-branch/desktop.png) | The field and example fit the compact filter panel. The queue reports two matching items. |
| [Dark](../review/target-branch/dark.png) | The field and help text follow the existing dark theme. |
| [Narrow](../review/target-branch/narrow.png) | The panel stays within the 800-pixel viewport. The field retains a visible focus ring. |
| [Empty](../review/target-branch/empty.png) | The queue reports zero matches. The entered pattern and Clear filters action remain available. |

These images are application review captures, not shipping raster assets.
The implementation report records 394 passing unit tests, typecheck, targeted lint, and the browser test.
The documenter inspected the browser test source without repeating those checks.
The detector output at `/tmp/gnosis-target-branch-detect.json` contains no findings.

## Disposition

Documentation: **COMPLETE**. No visual drift appeared within the inspected surface.
[DESIGN.md](../../DESIGN.md) and the [design sidecar](../design.json) remain unchanged and authoritative.
This extension requires no new global tokens or visual direction.
