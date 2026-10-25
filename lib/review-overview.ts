/** Shared by the planner, whole-review writer, and final overview synthesis. */
export const REVIEW_OVERVIEW_DIRECTIVE = `CHANGE OVERVIEW — summary
The overview orients an engineer who has not read the diff. Explain what this change accomplishes and its main parts, one level above implementation mechanics. It is not a changelog or a compressed copy of every topic.
- Start with one short sentence about the concrete purpose or behavioral change. Do not repeat the PR title or use vague claims such as "improves robustness" or "closes trust gaps" without explaining the behavior.
- For a small, single-purpose change, that sentence can be the entire summary. Do not add bullets, headings, notes or a closing sentence to fill a template.
- When there are distinct parts worth orienting the reader to, add a blank line and short Markdown bullets. Start each bullet with a brief bold label, followed by one main idea. Group by responsibility or outcome, not file, commit or topic order. One bullet per topic is not a requirement.
- Keep the level consistent: describe "reject stale confirmations" rather than enumerate every predicate, helper or schema field. Name exact symbols only when needed to understand the scope or a required action. Preserve consequential conditions at the conceptual level (such as ownership and upload identity); the detailed topics explain their exact operands.
- Most bullets should be one short sentence, not a miniature paragraph. Replace lists of checked fields with the governing concept (identity, ownership, freshness or capacity). Leave hash algorithm names, protocol details and guard operands in the topics unless changing that specific detail is the main point. Keep an exact setting name when the reader needs it for a configuration change.
- Select the main idea; do not compress every clause of the source into a bullet. For example, "Checks owner, storage key and generation; deletes only the caller-owned object" becomes "Checks ownership and upload identity, with cleanup limited to the caller's object." This preserves the governing constraints without an implementation inventory. Aim for roughly 12–20 words per bullet when that is sufficient; do not add words to reach that range or omit a material qualification to fit it.
- Include an important compatibility change, deployment action or limitation when supported by the source. Put it in one short labeled sentence when it does not fit a main point. Do not invent an impact or required action.
- Leave routine generated-file updates, lockfiles, regenerated metadata and branch history out unless they affect behavior, compatibility or review scope. Put detailed mechanisms in the review topics and code.
- Use precise, evidence-supported verbs. "Adds membership checks" describes a change; "prevents all unauthorized access" claims a guarantee. Do not claim exhaustive security, correctness or performance from partial evidence.
- Do not duplicate the Review path or Where to focus sections. riskRationale supplies the important review concern separately; do not append generic review advice to summary.
- Use plain words, short sentences and real paragraph/list breaks. Avoid nested lists, tables, decorative headings and sentences packed with several clauses. Bold labels should help scanning, not decorate every noun.
- Before returning, remove any sentence or bullet that repeats another or contributes no useful orientation. No minimum length or bullet count. Enough to grasp the change; nothing to pad it.

Examples of form only; never copy these facts into an unrelated review:
Small change: "Renames the close button from Dismiss to Close without changing its behavior."
Several related changes:
"Bounds background work while keeping foreground requests responsive.\n\n- **Scheduling:** Give visible requests priority over prefetch.\n- **Capacity:** Limit concurrent work and release slots after completion or cancellation."
A configuration removal belongs here only when it matters, e.g. "**Configuration:** Removes the legacy retry setting."
`;
