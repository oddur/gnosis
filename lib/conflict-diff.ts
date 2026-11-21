import { chosenText, type BlockProposals, type ConflictModel } from './conflict-blocks';

/** A text's lines; a final line feed ends the last line rather than starting another. */
const lineCount = (text: string) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

/** One conflict's place in the shown text: its lines, and the line its card sits under. */
export interface ConflictDiffBlock {
  index: number;
  /** First and last new line; `end < start` when the conflict shows no lines. */
  start: number;
  end: number;
  /** The new line the conflict's card follows; undefined when the text has no lines. */
  anchor?: number;
}

/**
 * A file's conflicts as the Conflicts view's diff shows them (#445 item 8), against the PR's version of the file. A
 * decided or proposed conflict shows its result. An open conflict shows the base branch's lines in place of the PR's,
 * so the diff reads as its two sides: that is never the result, and its card says Decide.
 */
export function conflictDiffText(
  model: ConflictModel,
  proposals?: BlockProposals
): { after: string; blocks: ConflictDiffBlock[] } {
  let after = '';
  let line = 0;
  const blocks: ConflictDiffBlock[] = [];
  for (const segment of model.segments) {
    if (segment.kind === 'text') {
      after += segment.text;
      line += lineCount(segment.text);
      continue;
    }
    const choice = model.choices[segment.index];
    const proposal = proposals?.[segment.index];
    const text =
      choice === 'proposal' && proposal
        ? proposal.text
        : choice && choice !== 'proposal'
          ? chosenText(segment.block, choice)
          : segment.block.theirs;
    const start = line + 1;
    after += text;
    line += lineCount(text);
    blocks.push({ index: segment.index, start, end: line });
  }
  // A conflict that shows no lines sits under the line before it, or under the first line at the top of the file.
  for (const block of blocks)
    block.anchor = block.end >= block.start ? block.end : block.start > 1 ? block.start - 1 : line ? 1 : undefined;
  return { after, blocks };
}
