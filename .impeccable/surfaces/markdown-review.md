# Markdown review

Mode: Operate, with Read typography for document content. This surface extends Changes, Commits, and explanation slides.

## Direction contract

THESIS: Let reviewers understand Markdown changes in their rendered structure and return to precise source lines for review actions.

OWN-WORLD: The surface preserves the compact review workbench, sans-serif hierarchy, semantic change colors, blue focus, and both themes.

STORY: Choose Preview, inspect changes with nearby context, reveal more as needed, then read the final document or open its source.

FIRST VIEWPORT: Source and Preview share the file header with Viewed and existing review actions. Show changes and change navigation occupy a compact toolbar.

FORM: This is an extension of existing components. It introduces no new visual world or global tokens.

FINISH: The fresh `markdown_context_finish` and `explanation_md_finish` reviews returned **SHIP** with no material fixes. This document records both extensions and their evidence.

## Interaction contract

[PrFileInspection](../../components/PrFileInspection.tsx) offers Source and Preview for `.md`, `.markdown`, `.mdown`, and `.mkd` files in Changes and Commits. Both views share the existing file identity, Viewed state, and Viewed & next action. Switching views preserves an approximate source position through block and line anchors. Returning from Source keeps blocks in its visible range revealed in Preview.

[MarkdownReviewPreview](../../components/MarkdownReviewPreview.tsx) shows word additions and deletions inside rendered paragraphs. Lists and tables retain their structure. Changed link destinations appear explicitly, even if the link text stays the same. Unique moved blocks carry a Moved label.

Fenced code uses syntax colors and line change indicators. Changed images carry Before and After labels. Changed diagrams retain separate before and after blocks.

Show changes switches between the focused comparison and the full final document. The [context model](../../lib/markdown-review-context.ts) shows changed blocks, one neighboring block on each side, and their heading ancestry. Commented blocks remain visible with neighboring context. Paragraphs, lists, tables, and code fences remain intact. Show more reveals up to three unchanged structural blocks; Show all reveals the remaining gap.

Added, deleted, and source-only files remain fully visible in the comparison. Added and deleted files retain a subtle whole-document tint; redundant whole-document labels are removed. The clean view of a deleted file explains the deletion and points to Show changes. A source-only change displays an Inspect source action.

Previous and Next controls move focus to changed blocks. Section controls open the related source location. Text selection exposes Ask about this. In Changes, writable files also expose Comment in source. This action opens and focuses the related source line, where the existing source comment controls remain available. It does not create a comment from an approximate rendered selection. Commits retain Comment in Changes.

Existing comments appear beside their mapped blocks in the comparison. Comments without a rendered location remain under Source discussions. The clean view also retains these source discussions. Outdated or unrelated revisions remain in the existing Other discussions on this file section.

Source/Preview and Show changes preferences persist through the existing SQLite review-state store. Source remains available during preparation, unsupported content, and preview errors. Retry and Use source provide explicit recovery actions.

### Explanation slides

[ReviewFileHeader](../../components/ReviewFileHeader.tsx) adds the shared [MarkdownViewSwitch](../../components/MarkdownViewSwitch.tsx) to eligible Markdown files in explanation slides. Source and Preview retain the same file identity, Viewed state, and collapse behavior.

[ExplanationMarkdownPreview](../../components/ExplanationMarkdownPreview.tsx) uses only saved topic hunks. Existing, local, and imported explanations can prepare their Markdown preview offline without another file read. The clean view says **Topic excerpts** because the saved sections do not represent the full final document. Changes and Commits retain their whole-file behavior.

[ReviewFileDiscussion](../../components/ReviewFileDiscussion.tsx) maps GitHub comments, local review drafts, and inline insights to preview blocks. Threads without matching source lines retain their existing separate section. Source actions preserve the original side and line, including deleted prose and code. An open comment editor keeps focus and prevents a view switch until the reviewer finishes or cancels the comment.

Explanation previews share Source/Preview and Show changes preferences with Changes and Commits. A failed preference save retains the session choice and offers a retry through the existing storage error flow.

## Layout and visual treatment

The [stylesheet](../../src/globals.css) uses existing background, foreground, border, focus, and semantic status variables. Prose uses the existing reading role within a maximum width of 78ch. Code uses the shared monospace size and line height. Underlines, strike-through, labels, and symbols supplement change colors.

Gaps use muted, caption-sized disclosure controls between thin rules. Expansion focuses the first revealed block. Tables and code blocks scroll horizontally within the document. Images fit their container. The document uses 16px padding at widths of 700px or less. Media comparisons can occupy separate rows at that width. Headers and action groups wrap to preserve the filename and controls in laptop windows. The toolbar remains below the measured sticky file header.

[DESIGN.md](../../DESIGN.md) and [design.json](../design.json) remain authoritative and unchanged. This surface requires no new global design tokens. The detector reports pre-existing CSS color and radius advisories. This extension neither canonizes nor repairs that drift.

## Rendering boundary

The [comparison engine](../../lib/markdown-review-engine.ts) parses Markdown into an AST and sanitizes embedded HTML. It does not evaluate document HTML or MDX. Links and images use the repository, revision, and file directory for each side. The old side also preserves a renamed file path. Heading anchors carry source-specific prefixes.

The [worker build configuration](../../vite.markdown-worker.config.ts) selects Node entry points for Markdown dependencies. The service test builds and executes this production worker, including syntax highlighting.

The [service](../../src/markdown-review-service.ts) runs comparison and syntax work in one Electron worker. Limits cover document length, AST complexity, diff time, queue length, and worker time. The [worker](../../src/markdown-review-worker.ts) bounds its cache by count and estimated bytes. The [renderer cache](../../lib/markdown-review-cache.ts) reuses results and pending requests. File contents reuse the existing full-file cache.

Explanation requests use the same worker and comparison engine. [The excerpt builder](../../lib/explanation-markdown.ts) reconstructs contiguous or overlapping saved sections and preserves their original source coordinates. It marks omitted gaps with **Between saved sections** and does not invent intervening lines. Conflicting saved sections produce an error with Source available for recovery. This path does not fetch full file contents.

## Evidence

The documenter checked the context model, preview, file inspection, appended CSS, and verification logs on October 27, 2026. The finish review verified these application captures:

| Capture | Observed result |
| --- | --- |
| [Folded](../review/markdown-review/folded.png) | Changes retain neighboring context, heading ancestry, and mapped comments; quiet controls mark omitted content. |
| [Expanded](../review/markdown-review/expanded.png) | Revealed structural blocks remain readable within the existing prose hierarchy. |
| [Laptop](../review/markdown-review/laptop.png) | File controls and focused content fit the laptop workbench. |
| [Dark](../review/markdown-review/dark.png) | Semantic change colors and gap controls retain the existing dark theme. |

These captures document the application. They are not shipping image assets. This surface introduces no shipping raster assets.

The browser suite passed against the real backend and worker, including focused context, expansion, source return, clean view, comments, Changes, Commits, and laptop layouts. Its log is `/tmp/gnosis-md-context-browser.log`.

The full unit run passed 408 tests in `/tmp/gnosis-md-context-all-tests.log`. TypeScript and lint passed with empty logs at `/tmp/gnosis-md-context-types.log` and `/tmp/gnosis-md-context-lint.log`. `/tmp/gnosis-md-context-detect.json` contains only pre-existing CSS advisories.

This documentation pass checked the recorded evidence and source. It did not repeat the interaction suites.

### Explanation extension evidence

The documenter checked the explanation components, excerpt builder, worker, shared preferences, stylesheet, and logs on October 27, 2026. The fresh `explanation_md_finish` review returned **SHIP** after these application captures:

| Capture | Observed result |
| --- | --- |
| [Explanation desktop](../review/markdown-review/explanation-desktop.png) | Source/Preview controls and rendered topic changes fit the existing file group. |
| [Explanation context](../review/markdown-review/explanation-context.png) | Saved context and review annotations remain available in Preview. |
| [Explanation source](../review/markdown-review/explanation-source.png) | Source retains its review controls and mapped locations. |
| [Explanation laptop](../review/markdown-review/explanation-laptop.png) | Header controls remain usable in the laptop workspace. |
| [Explanation laptop content](../review/markdown-review/explanation-laptop-content.png) | Excerpt content remains contained within the narrow pane. |

The existing narrow workspace limits reading space. The finish review found no new regression and did not establish this constraint as a new design rule.

The actual-worker browser suite passed in `/tmp/gnosis-explanation-md-browser.log`. Coverage includes explanation previews, GitHub threads, inline insights, deleted-text source focus, cached switches, Viewed, and laptop layouts. The separate thread regression passed in `/tmp/gnosis-explanation-md-threads.log`. The broader explanation-workspace test timed out when closing a review dialog; the same failure occurred on unchanged commit `13cbae2` in an isolated worktree (`/tmp/gnosis-explanation-baseline.log`).

The full unit run passed 410 tests in `/tmp/gnosis-explanation-md-all-tests.log`. TypeScript and lint passed with empty logs at `/tmp/gnosis-explanation-md-types.log` and `/tmp/gnosis-explanation-md-lint.log`. The detector result in `/tmp/gnosis-explanation-md-detect.json` is an empty array. These captures remain review evidence, with no new shipping raster assets.

## Final disposition

Finish reviews: **SHIP**, as reported by `markdown_context_finish` and `explanation_md_finish`. No material fixes remain for these extensions.

Documenter: **COMPLETE**. The implementation matches this extension contract. The global design documents remain unchanged.
