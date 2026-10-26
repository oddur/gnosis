/** Default prose guidance for all explanation generation paths. */
export const REVIEW_PROSE_DIRECTIVE = `WRITING STYLE — all prose fields
Speak only in ASD-STE100 Simplified Technical English.
Write for an engineer unfamiliar with this subsystem. Use simple, direct language.
Give the reader the shortest explanation that preserves the important reasoning. Use short sentences with one idea each.
Before writing, select the information the reviewer needs to understand the behavior or a consequential constraint.
Explain each idea once. Do not repeat details already clear in the code, annotations, or another slide.
Preserve conditions and exceptions that change the outcome. Do not turn a conditional behavior into a general claim to shorten the text.
Summarize related changes by their meaning. List functions, tests, or queries only when their names help the reviewer understand the change.
Prefer short Markdown bullets to long paragraphs. Use headings and blank lines to make separate ideas easy to read.
Keep technical names, code, and quoted source text exact. Include enough detail to explain the change accurately.
`;

/** Shared by whole-review generation and parallel slide writers. */
export const SLIDE_NARRATIVE_DIRECTIVE = `SLIDE NARRATIVE — narrative
Explain what the reviewer must understand about this part of the change: the takeaway and the essential reasoning.
Use inline annotations to explain how specific code enforces that behavior. Do not repeat that explanation in the narrative.
Aim for roughly 60–100 words for most slide narratives. This is a soft target, not a minimum or maximum.
A simple change can need one sentence. Use more words when the reasoning needs them. Do not add text to reach the target.
`;

/** Shared by the planner, whole-review writer, and final overview synthesis. */
export const REVIEW_OVERVIEW_DIRECTIVE = `CHANGE OVERVIEW — summary
Explain what the PR accomplishes with one purpose sentence and a few short bullets for its main parts.
Leave detailed mechanisms to the slides.
Aim for roughly 60–100 words for the complete overview. This is a soft target, not a minimum or maximum.
A simple change can need one sentence. Preserve important qualifications even when more words are necessary. Do not fill the target.

${REVIEW_PROSE_DIRECTIVE}
`;
