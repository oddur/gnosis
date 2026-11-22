import { parseConflicts } from './conflict-blocks';
import { blockProposals, blockResolutions } from './conflict-carry';
import { hasConflictMarkers, type ConflictFile } from './conflict-resolution';
import { needsNoChoice } from './conflict-verify';

/**
 * A whole-file suggestion (Ask the model, Try structural merge again) offered as proposals, fail closed. Where it splits
 * into the file's conflicts, each conflict still open gets its part as a proposal on its card; a model's is never written
 * into the draft, structural merge's is written there and the checks take it back unless they Merge it. A conflict you
 * decided (a Keep, an edit, a proposal you used) or the checks Merged keeps its text: the suggestion never overrides it,
 * and the note says when it differs. A suggestion that also changes code around the conflicts is offered as a whole-file
 * proposal (Use this result) only while you have decided none of them; otherwise it is refused. The note for the footer.
 */
export function offerSuggestion(file: ConflictFile, output: string, source: 'model' | 'mergiraf'): string {
  /** The engine that made the proposal, as the file's source says. */
  const engine = source === 'model' ? 'agent' : 'mergiraf';
  const segments = parseConflicts(file.original);
  const current = blockResolutions(segments, file.result);
  const conflicts = segments.filter((s) => s.kind === 'conflict');
  // A draft edited around its conflicts can't take anything per conflict without losing your edit.
  if (!current && file.result !== file.original)
    throw new Error(
      'Your draft changes code around its conflicts, so Gnosis didn’t use the suggestion. Reset the file to ask again.'
    );
  /** The conflict's text in the draft, or undefined while it is open. */
  const textOf = (index: number) => current?.[index];
  /**
   * The conflict is settled: you chose it (a Keep, an edit, a proposal you used, text you typed) or the checks Merged its
   * proposal. A proposal nobody chose that the checks didn't Merge is no decision: the suggestion may replace it.
   */
  const settled = (index: number) => {
    const text = textOf(index);
    if (text === undefined) return false;
    if (file.picks?.[index] || file.edits?.[index]) return true;
    const proposal = file.proposals?.[index];
    if (!proposal || text !== proposal.text) return true;
    return needsNoChoice(proposal, file.verdict?.verdict, index);
  };
  const parts = blockProposals(file.original, output, source);
  if (!parts) {
    if (hasConflictMarkers(output)) return 'It left every conflict open.';
    if (conflicts.some((s) => settled(s.index)))
      throw new Error(
        'The suggestion also changes code around conflicts already decided, so Gnosis didn’t use it. Start from the original conflict to ask for the whole file again.'
      );
    // A whole-file answer replaces the per-conflict proposals nobody chose: it is checked as one proposal of its own.
    file.wholeFile = { source, text: output };
    delete file.proposals;
    file.result = file.original;
    file.source = engine;
    file.resolved = false;
    return 'It changes code around the conflicts too: read the whole-file proposal, then use it or choose each conflict.';
  }
  // A new answer per conflict replaces an older whole-file proposal: its parts get their own verdicts.
  delete file.wholeFile;
  const proposals = conflicts.map((s) => file.proposals?.[s.index] ?? null);
  const offered = new Set<number>();
  let kept = 0;
  for (const s of conflicts) {
    const part = parts[s.index];
    if (!part) continue;
    if (settled(s.index)) {
      if (textOf(s.index) !== part.text) kept++;
      continue;
    }
    proposals[s.index] = part;
    offered.add(s.index);
  }
  if (offered.size) {
    file.proposals = proposals;
    file.source = engine;
    // Settled conflicts keep their text. Each offered one is open again, except structural merge's part, which goes in
    // for the checks to read: they take it back unless they Merge it. A model's part waits on its card.
    file.result = segments
      .map((s) =>
        s.kind === 'text'
          ? s.text
          : offered.has(s.index)
            ? source === 'mergiraf'
              ? (proposals[s.index]?.text ?? s.block.raw)
              : s.block.raw
            : (textOf(s.index) ?? s.block.raw)
      )
      .join('');
    file.resolved = false;
  }
  const notes = [
    offered.size
      ? `${offered.size} ${offered.size === 1 ? 'conflict has' : 'conflicts have'} a proposal to check.`
      : '',
    kept
      ? `It differed on ${kept} ${kept === 1 ? 'conflict' : 'conflicts'} already decided; ${kept === 1 ? 'that one keeps its' : 'those keep their'} text.`
      : '',
  ];
  return notes.filter(Boolean).join(' ');
}
