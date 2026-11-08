---
version: 1
slug: "components-explanationreader-tsx"
primary_target: "components/ExplanationReader.tsx"
related_targets: ["src/pages/ReviewPage.tsx","components/SlideView.tsx"]
---

# Paired explanation reader

Mode: Read, with code review actions. Scope: Explanation for stacks, PRs and saved/local reviews. Existing saved explanations work without regeneration.

## Direction contract

THESIS: One scrolling document pairs each explanation section with its code. The user found independent panes disjointed and approved replacing them with section-local text and evidence.

OWN-WORLD: Existing cool neutral surfaces, blue accents, Plus Jakarta Sans prose and Pierre diffs. Preserve light and dark themes.

STORY: Read the overview, follow each section alongside its evidence, inspect and comment, then see remaining files before submitting a review explicitly.

FIRST VIEWPORT: Compact subject header and tabs, section picker and shared Viewed count. Overview leads directly into paired sections. No Inspect code gate, topic checklist, or previous/next footer.

FORM: A single vertical scroll. Prose left, relevant code right. The shorter column sticks within its section; negative sticky offsets keep tall content accessible. A narrow reader, including beside chat, stacks prose then code. File/line links target their own section, including repeated paths. Deferred code mounts before entering view and remains mounted to preserve drafts and expansion. Interactive explanations occupy their section's code column. Seed: none (user-selected structure within incumbent visual system).

FINISH: Verify desktop, laptop, narrow, zoom, comments, diagrams, chat, Viewed progress, and saved positions. Complete fresh review and documentation.

## Behaviors to preserve

One saved reading position per explanation/revision. Section navigation moves the complete text/code pair. Shared Viewed progress remains independent of reading position. Reading or marking Viewed never submits a review. Source PR identity remains in file headers and separate from the PR selected for submission.

No generation or network fetch just to read saved sections. Existing diff excerpts and context expansion remain. At viewport heights at or below 500px, the outer PR page can scroll and the explanation workspace retains usable height. No new system tokens or raster assets.

The persistent toolbar holds Previous/Next section navigation beside the section picker and one Ask a question action. Inline explanations and Diff appearance also live here, rather than in each section. Navigation and actions share one row when space allows and wrap at narrower widths. Sections do not repeat the chat action. Navigation does not mark files Viewed or submit review decisions.

Hardening: optional reading guidance belongs in the overview. No-topic results preserve the summary and offer direct retry/Changes actions. Live generation stages are scoped to the current review, coalesce bursts, pause in hidden tabs, and provide Retry progress on activity failure. Keep navigation focus with any newly opened control; closing chat must not scroll back to its trigger. Batch sticky measurements before style writes and locate sections with logarithmic geometry reads.
