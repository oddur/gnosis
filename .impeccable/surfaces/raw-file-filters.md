# Raw diff file filters

Mode: Operate. Code-led extension of the existing Changes and Commits workspace.

## Direction contract

THESIS: Let reviewers remove clearly generated/test noise while keeping hidden review work visible and recoverable.

OWN-WORLD: Preserve the existing neutral workbench, typography, compact buttons, blue focus, and light/dark themes. Use the incumbent popover and entry-menu primitives.

STORY: Open Files, choose independent exclusions, inspect a classification reason, correct it locally, and reveal hidden work before completing review.

FIRST VIEWPORT: A compact Files filter sits beside Diff appearance, showing the hidden count. Its popover contains two counted checkboxes and a short progress explanation. File headers show small type tags and an overflow action for reasons/overrides. Background evidence appears as an explicit Apply action; it never silently removes files.

FORM: Incumbent component extension, seed: none (not applicable). No comp round or new visual world. Selection moves predictably after explicit filtering; hidden stack groups retain reveal controls.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implementation and evidence

The finished surface extends the incumbent review workbench. [DESIGN.md](../../DESIGN.md) and [design.json](../design.json) remain unchanged. The extension uses existing theme variables, compact Button variants, popover behavior, and entry menus. It introduces no shipping raster assets.

[RawFileFilters](../../components/RawFileFilters.tsx) places independent Generated and Test filters beside Diff appearance. Preferences apply to Changes and Commits. File headers show classification tags; the entry menu presents reasons as noninteractive text before the override actions. The menu references this description with `aria-describedby`.

[PrChangesView](../../components/PrChangesView.tsx) retains the full file count and review denominator. Hiding files does not mark them viewed. Empty results and hidden stack groups offer Show hidden files. Background classification changes preserve the visible files until the reviewer selects Apply updated file filters.

The documenter checked implementation, the incumbent design documents, and these rendered review captures on October 27, 2026:

| Evidence | Observed result |
| --- | --- |
| [Desktop](../review/file-filters/desktop.png), [Dark](../review/file-filters/dark.png) | Compact Files control, counted checkboxes, clear focus, and theme-specific popover surfaces follow the existing workbench. |
| [Laptop](../review/file-filters/laptop.png), [Narrow](../review/file-filters/narrow.png) | Toolbar controls wrap and the popover remains inside the viewport. |
| [Classification](../review/file-filters/classification.png) | Reasons remain readable above the override actions. Generated status uses a text tag. |
| [Empty](../review/file-filters/empty.png) | Five hidden files retain the five-file progress denominator; both panes offer recovery. |
| [Stack](../review/file-filters/stack.png) | A fully hidden PR remains identified with a hidden count and reveal action. |
| [Pending](../review/file-filters/pending.png) | Updated evidence has an explicit Apply action and states that visible files remain unchanged. |

These are review captures of the implemented application, not product image assets. This documentation pass checked static evidence and source; it did not repeat the finish review's interaction tests. Existing design drift outside this surface was not changed.

## Final disposition

Finish review: **SHIP**, with all four reported findings resolved, as supplied by the finish reviewer.

The fixes keep classification reasons at full contrast with an accessible menu description, preserve Drafts and the Review PR target when all files are hidden, describe the hidden count accessibly, and use singular text for one hidden file.

Documenter: **COMPLETE**. The implementation matches this surface contract and extends the incumbent visual system. The global design documents remain authoritative; this feature requires no new global tokens or visual direction.

## Extension filtering

The user expanded this feature to include file extensions. The same popover includes a searchable multiple-selection combobox with counts for the current comparison. With an empty selection, all extensions remain visible. Selected suffixes are exclusions, combined with generated/test exclusions: a file is hidden when any exclusion matches. Choices persist across tabs, PRs, and restarts; selected extensions absent from a comparison remain removable with count zero. Files with no suffix have a No extension option. This stays within the incumbent Operate contract.

The documenter checked [FileExtensionFilter](../../components/FileExtensionFilter.tsx) and all six extension captures. [Light](../review/file-filters/extensions-light.png) and [Dark](../review/file-filters/extensions-dark.png) show the existing combobox styling, counted choices, and visible focus. [Laptop](../review/file-filters/extensions-laptop.png) and [Narrow](../review/file-filters/extensions-narrow.png) keep the menu within the viewport. [Empty](../review/file-filters/extensions-empty.png) preserves the full review denominator and recovery actions. [Absent](../review/file-filters/extensions-absent.png) retains a selected extension with count zero in Commits.

The reported browser checks passed keyboard search and Enter selection, combined exclusions, persistence across reloads and tabs, and removal of absent choices. The detector output at `/tmp/gnosis-file-extensions-detect.json` contains no findings. These interaction results come from the finish review; the documenter checked source and captures without repeating them.

Extension finish review: **SHIP**, with no findings. Extension documentation: **COMPLETE**. DESIGN.md and the design sidecar remain unchanged.
