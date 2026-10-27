# Markdown review

Mode: Operate. This surface extends the existing Changes and Commits workspace.

## Direction contract

THESIS: Let reviewers understand Markdown changes in their rendered structure and return to precise source lines for review actions.

OWN-WORLD: The surface preserves the compact review workbench, sans-serif hierarchy, semantic change colors, blue focus, and both themes.

STORY: Choose Preview, inspect editorial changes, read the final document, then ask about selected text or open its source.

FIRST VIEWPORT: Source and Preview share the file header with Viewed and existing review actions. Show changes and change navigation occupy a compact toolbar.

FORM: This is an extension of existing components. It introduces no new visual world or global tokens.

FINISH: The finish reviewer returned **SHIP** after the laptop commit header fix. This document records the implementation and its evidence.

## Interaction contract

[PrFileInspection](../../components/PrFileInspection.tsx) offers Source and Preview for `.md`, `.markdown`, `.mdown`, and `.mkd` files in Changes and Commits. Both views share the existing file identity, Viewed state, and Viewed & next action. Switching views preserves an approximate source position through block and line anchors.

[MarkdownReviewPreview](../../components/MarkdownReviewPreview.tsx) shows word additions and deletions inside rendered paragraphs. Lists and tables retain their structure. Changed link destinations appear explicitly, even if the link text stays the same. Unique moved blocks carry a Moved label.

Fenced code uses syntax colors and line change indicators. Changed images carry Before and After labels. Changed diagrams retain separate before and after blocks.

Show changes switches between the comparison and the final document. Added and deleted files use one document label and a subtle whole-document tint. The clean view of a deleted file explains the deletion and points to Show changes. A source-only change displays an Inspect source action.

Previous and Next controls move focus to changed blocks. Section controls open the related source location. Text selection exposes Ask about this. In Changes, writable files also expose Comment in source. This action opens and focuses the related source line, where the existing source comment controls remain available. It does not create a comment from an approximate rendered selection. Commits retain Comment in Changes.

Existing comments appear beside their mapped blocks in the comparison. Comments without a rendered location remain under Source discussions. The clean view also retains these source discussions. Outdated or unrelated revisions remain in the existing Other discussions on this file section.

Source/Preview and Show changes preferences persist through the existing SQLite review-state store. Source remains available during preparation, unsupported content, and preview errors. Retry and Use source provide explicit recovery actions.

## Layout and visual treatment

The [stylesheet](../../src/globals.css) uses existing background, foreground, border, focus, and semantic status variables. Prose uses the existing reading role within a maximum width of 78ch. Code uses the shared monospace size and line height. Underlines, strike-through, labels, and symbols supplement change colors.

Tables and code blocks scroll horizontally within the document. Images fit their container. The document uses 16px padding at widths of 700px or less. Media comparisons can occupy separate rows at that width. Headers and action groups wrap to preserve the filename and controls in laptop windows. The toolbar remains below the measured sticky file header.

[DESIGN.md](../../DESIGN.md) and [design.json](../design.json) remain authoritative and unchanged. This surface requires no new global design tokens. No applicable context-drift directive was reported. This documentation pass makes no drift repairs.

## Rendering boundary

The [comparison engine](../../lib/markdown-review-engine.ts) parses Markdown into an AST and sanitizes embedded HTML. It does not evaluate document HTML or MDX. Links and images use the repository, revision, and file directory for each side. The old side also preserves a renamed file path. Heading anchors carry source-specific prefixes.

The [worker build configuration](../../vite.markdown-worker.config.ts) selects Node entry points for Markdown dependencies. The service test builds and executes this production worker, including syntax highlighting.

The [service](../../src/markdown-review-service.ts) runs comparison and syntax work in one Electron worker. Limits cover document length, AST complexity, diff time, queue length, and worker time. The [worker](../../src/markdown-review-worker.ts) bounds its cache by count and estimated bytes. The [renderer cache](../../lib/markdown-review-cache.ts) reuses results and pending requests. File contents reuse the existing full-file cache.

## Evidence

The documenter checked source, logs, and these captures on October 27, 2026:

| Capture | Observed result |
| --- | --- |
| [Desktop](../review/markdown-review/desktop.png), [Dark](../review/markdown-review/dark.png) | Compact controls, word edits, inline comments, and visible block focus fit the incumbent workbench. |
| [Clean](../review/markdown-review/clean.png) | Final prose, lists, and tables retain their reading hierarchy without change marks. |
| [Table and code](../review/markdown-review/table-code.png) | Structured cell edits, explicit link destinations, and highlighted code remain readable. |
| [Selection](../review/markdown-review/selection.png), [Source](../review/markdown-review/source.png) | Selection actions appear above the document. Source shows the related line and existing discussion. |
| [Laptop](../review/markdown-review/laptop.png), [Commits](../review/markdown-review/commits.png) | Headers wrap. The commit filename remains visible after the finish-review fix. |
| [Added](../review/markdown-review/added.png), [Deleted](../review/markdown-review/deleted.png) | Whole-document labels and tints distinguish additions and deletions without repeated block labels. |

These captures document the application. They are not shipping image assets. This surface introduces no shipping raster assets.

The supplied browser suite passed against the real backend and worker. Its checks cover cached toggles, source focus at line 3, preference reload, change navigation, Changes, Commits, and laptop filenames. Its log is `/tmp/gnosis-md-browser.log`.

The existing Changes and Commits browser suites also passed. Logs are `/tmp/gnosis-md-existing-changes.log` and `/tmp/gnosis-md-existing-commits.log`.

The full unit run passed 406 tests. The final targeted run passed 16 tests. Logs are `/tmp/gnosis-md-all-tests.log` and `/tmp/gnosis-md-final-tests.log`. TypeScript and lint logs contain no output. The detector returned no findings in `/tmp/gnosis-md-detect.json`.

This documentation pass checked the recorded evidence and source. It did not repeat the interaction suites.

## Final disposition

Finish review: **SHIP**, as reported by the finish reviewer. The laptop commit header finding is resolved.

Documenter: **COMPLETE**. The implementation matches this extension contract. The global design documents remain unchanged.
