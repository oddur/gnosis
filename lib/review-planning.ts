import type { IndexedHunk } from './diff-parse';

/** Shared by single-pass reviews and the planner; categories do not dictate chapters. */
export const CHAPTER_GROUPING_DIRECTIVE = `CHAPTERS: Each topic answers one useful question about the change: a behavior, contract, mechanism, or design decision. Name that change in the title. Choose the number and size of chapters from the evidence; do not aim for a chapter count.
- Keep the implementation, callers, types, configuration, and tests for the same behavior together when they form one understandable explanation. Tests can establish an example or boundary; their presence does not prove they passed or cover every path.
- A chapter may have several steps when they answer the same question. Keep required setup and its effect together unless the setup has an independently important consequence.
- Fewer chapters is not a goal. Split when the reviewer must answer independent questions, trace different mechanisms, or remember too many conditions to explain one topic. A shared subsystem or purpose alone does not make one chapter. Avoid both a tour of files and a single chapter that hides several important ideas.
- Split a topic when it contains independent ideas or is too dense to understand as one step. File, directory, language, and test/implementation boundaries are clues, not chapter boundaries.
- Give tests, schemas, rollout, or documentation their own chapter when they contain an independently important idea. A test-only or documentation-only PR can have a complete story of its own.
- Distinguish the actual change from unchanged supporting behavior. Diff context explains the surroundings; it does not make every shown behavior new. State the scope and exceptions that constrain a claim. Do not generalize a property of one component to the whole system.
- For a refactor, explain the responsibility or structure that changed and the behavior intended to remain stable. Do not invent a behavior change, or assume a move/rename is harmless.

READING ORDER: Start with the smallest amount of context needed to understand the main change. Order later topics by genuine prerequisites. Do not force a types → implementation → consumers → tests → docs sequence. Put supporting evidence beside the behavior it explains.
- dependsOn contains the exact titles of earlier topics needed to understand this one. Leave it empty when there is no prerequisite; sequence alone does not imply dependency.
- Give each changed hunk one primary topic. Refer briefly to a prerequisite instead of explaining its code again. Do not duplicate hunks to force a story or drop difficult code because its purpose is uncertain.
- Ground the grouping in supplied code. A path, hunk heading, or PR description is a clue, not proof of a dependency or behavior. When evidence is incomplete, keep the plan tentative and tell the writer what needs verification.`;

export const PLANNER_EVIDENCE_BUDGET = 80_000;

/** Deterministic, spread-out samples keep one large file from consuming the planner input. */
function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  if (count === 1) return [items[0]];
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * (items.length - 1)) / (count - 1))]);
}

function excerpt(content: string, budget: number) {
  if (content.length <= budget) return { complete: true, excerpts: [{ offset: 0, text: content }] };
  // Offsets are characters in the original hunk, NOT source-line anchors. Writers
  // receive full hunks; these windows are only evidence for choosing their topics.
  const size = Math.floor(budget / 3);
  const starts = [0, Math.floor((content.length - size) / 2), content.length - size];
  return {
    complete: false,
    excerpts: starts.map((offset) => ({ offset, text: content.slice(offset, offset + size) })),
  };
}

/** Pure backend context assembly: uses existing patches and never fetches source. */
export function buildPlannerEvidence(hunks: IndexedHunk[], budget = PLANNER_EVIDENCE_BUDGET): string {
  if (!Number.isInteger(budget) || budget < 2000)
    throw new Error('Planner evidence budget must be at least 2000 characters.');
  const files = new Map<string, IndexedHunk[]>();
  for (const hunk of hunks) {
    const group = files.get(hunk.filePath) ?? [];
    group.push(hunk);
    files.set(hunk.filePath, group);
  }
  const groups = spread([...files.values()], 96);
  const selected: IndexedHunk[] = [];
  // Round-robin files before taking more hunks from any one file. Sample a long
  // file throughout its patch rather than selecting only its first functions.
  const quotas = groups.map(() => 0);
  for (let remaining = 96; remaining > 0; ) {
    let allocated = false;
    for (let i = 0; i < groups.length && remaining > 0; i++) {
      if (quotas[i] >= groups[i].length) continue;
      quotas[i]++;
      remaining--;
      allocated = true;
    }
    if (!allocated) break;
  }
  const samples = groups.map((group, i) => spread(group, quotas[i]));
  for (let round = 0; round < Math.max(0, ...quotas); round++)
    for (const group of samples) if (group[round]) selected.push(group[round]);
  const entries: string[] = [];
  let used = 0;
  const entryBudget = Math.floor((budget - 1000) / Math.max(1, selected.length));
  for (const hunk of selected) {
    let sourceBudget = Math.min(4000, entryBudget);
    let entry = '';
    while (sourceBudget >= 48) {
      entry = JSON.stringify({
        id: hunk.id,
        file: hunk.filePath,
        status: hunk.fileStatus,
        header: hunk.hunkHeader,
        scopeHint: hunk.scopeName,
        ...excerpt(hunk.content, sourceBudget),
      });
      if (entry.length <= entryBudget) break;
      entry = '';
      sourceBudget = Math.floor(sourceBudget / 2);
    }
    if (entry && used + entry.length + 2 <= budget - 1000) {
      entries.push(entry);
      used += entry.length + 2;
    }
  }
  return `<planning_evidence>
Source excerpts for grouping only. The full hunk index defines the changed scope. Missing excerpts are NOT unchanged or low-value code. Incomplete excerpts may start or end inside a line; offsets are character positions within a hunk, not source line numbers. Scope hints come from Git hunk headings, not a verified symbol index. Do not infer test results, complete call graphs, or behavior equivalence from these samples. Writers must verify the plan against their full assigned hunks.
${JSON.stringify({ totalHunks: hunks.length, sampledHunks: entries.length, omittedHunks: hunks.length - entries.length })}
[${entries.join(',\n')}]
</planning_evidence>`;
}
